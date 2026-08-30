# Debug Automation Harness

A debug-only TCP harness that lets an AI orchestrator drive the app end to end.
It is **doubly gated**: the Rust module is compiled only under
`debug_assertions`, and even then the listener starts only when
`NOTE_N_PAD_AUTOMATION=1`. Release builds contain none of it.

## Launch

```sh
NOTE_N_PAD_AUTOMATION=1 npm run tauri dev
```

Optional: `NOTE_N_PAD_AUTOMATION_PORT=45678` (default). The listener binds
`127.0.0.1:<port>` and serves one client at a time; open as many sequential
connections as you like.

## Protocol

Line-delimited JSON over TCP. One request line in, one response line out.

Request: `{"id": <u64>, "cmd": "<name>", ...params}`
Response: `{"id": <u64>, "ok": true, "data": <value>}`
or `{"id": <u64>, "ok": false, "error": "<message>"}`

## Commands

| cmd             | params        | data                                             |
| --------------- | ------------- | ------------------------------------------------ |
| `list_windows`  | —             | `[{label, title, focused}, ...]`                 |
| `store_list`    | —             | the NoteStore contents (array of note snapshots) |
| `new_sticky`    | —             | the created note snapshot                        |
| `focus`         | `label`       | `null`                                           |
| `window_number` | `label`       | macOS NSWindow number (i64); errors elsewhere    |
| `eval`          | `label`, `js` | the completion value of `js` run in that window  |
| `quit`          | —             | `null` (triggers the flush-then-exit handshake)  |

`eval` runs the source with `eval()` (expressions and statement lists both work),
awaits a promise result, and reports the value back through an internal
`automation_result` command with a ~3 s timeout.

**`eval` only works under `npm run tauri dev`.** There the page comes from Vite
and no CSP is applied. A bundled build — including `tauri build --debug`, which
still has the harness compiled in — serves the page through Tauri's asset
protocol under `script-src 'self'`, and the `eval()` call is blocked. Every other
command works in a bundled debug build; only `eval` does not. Relaxing the CSP to
get it back changes the thing under test, so prefer `tauri dev` when the
measurement needs `eval` at all.

In DEV builds each editor window also exposes `window.__auto`:

- `typeText(text)` — insert at the cursor
- `getContent()` — current editor text
- `getTitle()` — window title (sticky: first line; document: filename)
- sticky only: `clickPin()`, `setPaper(name)`, `openCloseFlow()`

So `{"cmd":"eval","label":"note-…","js":"__auto.getContent()"}` reads a sticky's
text, and `"__auto.typeText('hello')"` types into it.

## Driver script

```sh
node scripts/auto.mjs '{"id":1,"cmd":"list_windows"}'
node scripts/auto.mjs --repl   # one JSON request per stdin line
```

## Screenshot recipe (macOS)

Get a window's number, then capture just that window:

```sh
node scripts/auto.mjs '{"id":1,"cmd":"window_number","label":"note-<id>"}'
screencapture -l <windowNumber> out.png
```

`screencapture -l` needs Screen Recording permission for the launching terminal
(System Settings → Privacy & Security → Screen Recording).
