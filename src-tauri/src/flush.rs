// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::State;

/// How a quit handshake ended.
#[derive(Debug, PartialEq, Eq)]
pub enum FlushOutcome {
  /// Every armed window acked; safe to exit.
  Completed,
  /// A window took too long; the caller exits anyway as a safety valve.
  TimedOut,
  /// A window vetoed the quit (e.g. an unsaved document); do not exit.
  Cancelled,
}

#[derive(Default)]
struct GateState {
  pending: HashSet<String>,
  cancelled: bool,
  // Bumped on every arm and disarm so a waiter can tell whether the handshake
  // it is blocked on is still the current one. A re-entrant quit (one Cmd+Q
  // dispatched twice) would otherwise let a stale waiter wake to a clean gate
  // and misread empty-pending as Completed, exiting past a veto.
  generation: u64,
}

/// Coordinates a quit handshake: armed with the window labels we expect to ack,
/// drained as acks arrive, vetoable by any window, and waited on with a hard
/// timeout so a stuck window can never block exit.
#[derive(Default)]
pub struct FlushGate {
  state: Mutex<GateState>,
  done: Condvar,
}

impl FlushGate {
  /// Arm the gate with the window labels we expect to ack this handshake, and
  /// return the generation the caller must pass to `wait` so a superseded
  /// handshake's waiter can recognise it no longer owns the gate.
  pub fn arm(&self, labels: HashSet<String>) -> u64 {
    let mut state = self.state.lock().unwrap();
    state.pending = labels;
    state.cancelled = false;
    state.generation += 1;
    state.generation
  }

  /// Record an ack from `label`; wake the waiter once the last one lands.
  pub fn ack(&self, label: &str) {
    let mut state = self.state.lock().unwrap();
    state.pending.remove(label);
    if state.pending.is_empty() {
      self.done.notify_all();
    }
  }

  /// Veto the quit; wakes the waiter immediately even if acks are outstanding.
  pub fn cancel(&self) {
    let mut state = self.state.lock().unwrap();
    state.cancelled = true;
    self.done.notify_all();
  }

  /// Clear all state so a late/stale ack or cancel can't affect a later quit.
  /// Bumps the generation too, so any waiter still blocked on the disarmed
  /// handshake wakes to a mismatch instead of a spuriously clean gate.
  pub fn disarm(&self) {
    let mut state = self.state.lock().unwrap();
    state.pending.clear();
    state.cancelled = false;
    state.generation += 1;
  }

  /// Block until every armed label acks, a window cancels, or `timeout`
  /// elapses. A cancel wins over completion even if all acks already landed.
  /// `generation` is the value returned by the `arm` that opened this
  /// handshake: if the gate has since been re-armed or disarmed by another
  /// handshake, this waiter no longer owns the gate and returns Cancelled so
  /// it never exits on a superseded handshake's behalf.
  pub fn wait(&self, generation: u64, timeout: Duration) -> FlushOutcome {
    let state = self.state.lock().unwrap();
    let (state, result) = self
      .done
      .wait_timeout_while(state, timeout, |s| {
        s.generation == generation && !s.cancelled && !s.pending.is_empty()
      })
      .unwrap();
    if state.generation != generation || state.cancelled {
      FlushOutcome::Cancelled
    } else if result.timed_out() {
      FlushOutcome::TimedOut
    } else {
      FlushOutcome::Completed
    }
  }
}

#[tauri::command]
pub fn flush_ack(gate: State<FlushGate>, label: String) {
  gate.ack(&label);
}

#[tauri::command]
pub fn flush_cancel(gate: State<FlushGate>) {
  gate.cancel();
}

#[cfg(test)]
mod tests {
  use super::*;

  fn labels(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn completes_when_all_acked() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a", "b"]));
    gate.ack("a");
    gate.ack("b");
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Completed
    );
  }

  #[test]
  fn empty_arm_completes_immediately() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&[]));
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Completed
    );
  }

  #[test]
  fn times_out_when_ack_missing() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a"]));
    assert_eq!(
      gate.wait(gen, Duration::from_millis(20)),
      FlushOutcome::TimedOut
    );
  }

  #[test]
  fn unknown_ack_does_not_complete() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a"]));
    gate.ack("zzz");
    assert_eq!(
      gate.wait(gen, Duration::from_millis(20)),
      FlushOutcome::TimedOut
    );
  }

  #[test]
  fn cancel_vetoes_quit() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a"]));
    gate.cancel();
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Cancelled
    );
  }

  #[test]
  fn cancel_wins_after_partial_ack() {
    // One window acked, another vetoes: the whole quit must be cancelled.
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a", "b"]));
    gate.ack("a");
    gate.cancel();
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Cancelled
    );
  }

  #[test]
  fn stale_ack_after_cancel_is_harmless() {
    let gate = FlushGate::default();
    let gen = gate.arm(labels(&["a"]));
    gate.cancel();
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Cancelled
    );
    gate.disarm();
    // A late ack from the previous handshake must not affect the next quit.
    gate.ack("a");
    let gen = gate.arm(labels(&["b"]));
    gate.ack("b");
    assert_eq!(
      gate.wait(gen, Duration::from_millis(50)),
      FlushOutcome::Completed
    );
  }

  #[test]
  fn reentrant_double_arm_never_falsely_completes() {
    use std::sync::Arc;
    // Models one Cmd+Q dispatched twice: two handshakes arm the same gate,
    // each spawns a waiter, then a single window vetoes. Neither waiter may
    // report Completed, which would exit past the veto and drop unsaved edits.
    let gate = Arc::new(FlushGate::default());
    let gen1 = gate.arm(labels(&["a"]));
    let g1 = Arc::clone(&gate);
    let w1 = std::thread::spawn(move || g1.wait(gen1, Duration::from_millis(200)));
    // Second dispatch re-arms while the first waiter is still blocked.
    let gen2 = gate.arm(labels(&["a"]));
    assert_ne!(gen1, gen2);
    let g2 = Arc::clone(&gate);
    let w2 = std::thread::spawn(move || g2.wait(gen2, Duration::from_millis(200)));
    gate.cancel();
    assert_eq!(w1.join().unwrap(), FlushOutcome::Cancelled);
    assert_eq!(w2.join().unwrap(), FlushOutcome::Cancelled);
  }

  #[test]
  fn waiter_after_peer_cancel_and_disarm_does_not_complete() {
    use std::sync::Arc;
    // The exact pre-fix race: handshake #1 vetoes and its Cancelled branch
    // disarms the gate; only then does handshake #2's waiter get to run. The
    // gate now looks clean (pending empty, cancelled false) but #2 must read
    // its stale generation and return Cancelled, never Completed.
    let gate = Arc::new(FlushGate::default());
    let _gen1 = gate.arm(labels(&["a"]));
    let gen2 = gate.arm(labels(&["a"]));
    gate.cancel();
    gate.disarm();
    let g = Arc::clone(&gate);
    let late = std::thread::spawn(move || g.wait(gen2, Duration::from_millis(50)));
    assert_eq!(late.join().unwrap(), FlushOutcome::Cancelled);
  }
}
