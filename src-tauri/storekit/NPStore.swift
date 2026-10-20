// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// StoreKit behind a C interface, for the sandboxed store build only. Each call
// blocks its calling thread, never the main thread, until the store answers or
// its timeout passes. Tasks write only into an `Answer` they own; the calling
// thread copies out of it into the caller's buffer, so a task that finishes
// after a timeout writes nowhere the caller can see.
import AppKit
import Foundation
import StoreKit

/// One task's result, handed to the thread waiting for it.
private final class Answer<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private let done = DispatchSemaphore(value: 0)
  private var value: Value?

  func set(_ value: Value) {
    lock.lock()
    self.value = value
    lock.unlock()
    done.signal()
  }

  /// The result, or nil when `timeoutMs` passes first; nil `timeoutMs` waits
  /// for as long as the task takes.
  func wait(timeoutMs: UInt32?) -> Value? {
    if let timeoutMs {
      if done.wait(timeout: .now() + .milliseconds(Int(timeoutMs))) == .timedOut {
        return nil
      }
    } else {
      done.wait()
    }
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// Run `body` as a detached task and wait for its result.
private func blockOn<Value>(
  _ timeoutMs: UInt32?,
  _ body: @escaping @Sendable () async -> Value
) -> Value? {
  let answer = Answer<Value>()
  Task.detached {
    answer.set(await body())
  }
  return answer.wait(timeoutMs: timeoutMs)
}

/// Empty the caller's buffer, so it holds a string whatever the outcome.
private func clear(_ buf: UnsafeMutablePointer<CChar>, _ len: UInt) {
  if len > 0 {
    buf[0] = 0
  }
}

/// Copy `text` into `buf`, NUL-terminated and cut at a UTF-8 boundary when it
/// does not fit. Returns whether all of it fit.
private func write(_ text: String, _ buf: UnsafeMutablePointer<CChar>, _ len: UInt) -> Bool {
  guard len > 0 else {
    return false
  }
  let bytes = Array(text.utf8)
  var count = min(bytes.count, Int(len) - 1)
  if count < bytes.count {
    while count > 0 && bytes[count] & 0xC0 == 0x80 {
      count -= 1
    }
  }
  for i in 0..<count {
    buf[i] = CChar(bitPattern: bytes[i])
  }
  buf[count] = 0
  return count == bytes.count
}

/// 1 owned, 0 not owned, -1 timeout, -2 error.
@_cdecl("np_store_owned")
public func npStoreOwned(_ productID: UnsafePointer<CChar>, _ timeoutMs: UInt32) -> Int32 {
  let id = String(cString: productID)
  let code = blockOn(timeoutMs) { () async -> Int32 in
    // Every environment counts: the store's reviewers buy in the sandbox.
    for await result in Transaction.currentEntitlements {
      if case .verified(let transaction) = result, transaction.productID == id {
        return 1
      }
    }
    return 0
  }
  return code ?? -1
}

/// The code and version of an app transaction read.
private func originalCode(_ result: VerificationResult<AppTransaction>) -> (Int32, String) {
  switch result {
  case .verified(let transaction):
    if transaction.environment == .production {
      return (1, transaction.originalAppVersion)
    }
    return (3, "")
  case .unverified:
    return (0, "")
  }
}

/// Write an original read's version into `buf` and return its code.
private func finishOriginal(
  _ read: (Int32, String),
  _ buf: UnsafeMutablePointer<CChar>,
  _ len: UInt
) -> Int32 {
  let (code, version) = read
  if code == 1 && !write(version, buf, len) {
    return -3
  }
  return code
}

/// 1 verified production (version in `buf`), 3 verified other environment,
/// 0 unverified, -1 timeout, -2 thrown, -3 too long. Never prompts.
@_cdecl("np_store_original")
public func npStoreOriginal(
  _ buf: UnsafeMutablePointer<CChar>,
  _ len: UInt,
  _ timeoutMs: UInt32
) -> Int32 {
  clear(buf, len)
  let read = blockOn(timeoutMs) { () async -> (Int32, String) in
    do {
      return originalCode(try await AppTransaction.shared)
    } catch {
      return (-2, "")
    }
  }
  guard let read else {
    return -1
  }
  return finishOriginal(read, buf, len)
}

/// The codes of `np_store_original` without -1. May ask the user to sign in,
/// so it has no timeout.
@_cdecl("np_store_refresh_original")
public func npStoreRefreshOriginal(_ buf: UnsafeMutablePointer<CChar>, _ len: UInt) -> Int32 {
  clear(buf, len)
  let read = blockOn(nil) { () async -> (Int32, String) in
    do {
      return originalCode(try await AppTransaction.refresh())
    } catch {
      return (-2, "")
    }
  }
  return finishOriginal(read ?? (-2, ""), buf, len)
}

/// Starts the one listener for store updates; later calls do nothing.
private final class Watch: @unchecked Sendable {
  static let shared = Watch()
  private let lock = NSLock()
  private var started = false

  func start(_ id: String, _ callback: @escaping @convention(c) () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    if started {
      return
    }
    started = true
    Task.detached {
      for await result in Transaction.updates {
        if case .verified(let transaction) = result, transaction.productID == id {
          await transaction.finish()
          callback()
        }
      }
    }
  }
}

/// Call `callback`, with no data, after each verified update of the product.
@_cdecl("np_store_watch")
public func npStoreWatch(
  _ productID: UnsafePointer<CChar>,
  _ callback: @escaping @convention(c) () -> Void
) {
  Watch.shared.start(String(cString: productID), callback)
}

/// 1 ok (price in `buf`), -1 timeout, -2 error or no such product, -3 too long.
@_cdecl("np_store_price")
public func npStorePrice(
  _ productID: UnsafePointer<CChar>,
  _ buf: UnsafeMutablePointer<CChar>,
  _ len: UInt,
  _ timeoutMs: UInt32
) -> Int32 {
  clear(buf, len)
  let id = String(cString: productID)
  let read = blockOn(timeoutMs) { () async -> String? in
    let products = try? await Product.products(for: [id])
    return products?.first { $0.id == id }?.displayPrice
  }
  guard let read else {
    return -1
  }
  guard let price = read else {
    return -2
  }
  return write(price, buf, len) ? 1 : -3
}

/// 1 bought (verified and finished), 2 cancelled, 3 pending, 0 unverified,
/// -2 error. `window` is an NSWindow the caller keeps alive for the call; the
/// sheet attaches to it where the system can do that. No timeout: the user may
/// take as long as they like.
@_cdecl("np_store_purchase")
public func npStorePurchase(
  _ productID: UnsafePointer<CChar>,
  _ window: UnsafeMutableRawPointer?
) -> Int32 {
  // The purchase runs on the main actor; waiting for it there never returns.
  if Thread.isMainThread {
    return -2
  }
  let id = String(cString: productID)
  let windowBits = UInt(bitPattern: window)
  let code = blockOn(nil) { @MainActor () async -> Int32 in
    let products = try? await Product.products(for: [id])
    guard let product = products?.first(where: { $0.id == id }) else {
      return -2
    }
    let result: Product.PurchaseResult
    do {
      if #available(macOS 15.2, *), let pointer = UnsafeMutableRawPointer(bitPattern: windowBits) {
        let window = Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
        result = try await product.purchase(confirmIn: window)
      } else {
        result = try await product.purchase()
      }
    } catch {
      return -2
    }
    switch result {
    // Every environment counts: the store's reviewers buy in the sandbox.
    case .success(.verified(let transaction)):
      await transaction.finish()
      return 1
    case .success(.unverified):
      return 0
    case .userCancelled:
      return 2
    case .pending:
      return 3
    @unknown default:
      return -2
    }
  }
  return code ?? -2
}

/// 1 ok, 2 cancelled, -2 error. May ask the user to sign in, so it has no
/// timeout.
@_cdecl("np_store_sync")
public func npStoreSync() -> Int32 {
  let code = blockOn(nil) { () async -> Int32 in
    do {
      try await AppStore.sync()
      return 1
    } catch StoreKitError.userCancelled {
      return 2
    } catch {
      return -2
    }
  }
  return code ?? -2
}
