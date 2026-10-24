# Changelog

## 0.4.3 — 2026-10-25

- Run the panel's close cleanup off the click message: the cleanup ends Edge and then matches the remaining `msedge.exe` children with a WMI query. When the click arrived as a cross-process `SendMessage`, that query threw `InvalidCastException` from `InterfaceMarshaler.ConvertToNative` via `SecuredIWbemServicesHandler.ExecQuery_`, so the by-profile fallback silently never ran. The panel now hops back onto the message loop with `BeginInvoke` first.
- Log the exception type when the WMI query still fails, instead of only its message.

## 0.4.2 — 2026-10-25

- Implement the panel return hotkey the UI already advertised: the panel registers `Ctrl+Alt+Shift+F12` on its own window (the combination verified in the M0 spike) and posts the switch off `WndProc`, so returning no longer depends on clicking the panel. Registration failure is logged and leaves the buttons working.
- Make the panel's “关闭复验桌面” button match its label: it now runs the `close` cleanup (return, end Edge, drop the Edge profile, delete state) instead of just switching back like the “返回工作桌面” button. The panel gets `--state` from `ensure` and removes its own pid from the state copy so `CloseState` cannot kill it before the profile deletion.
- Document the hotkey in README and `docs/architecture.md`.

## 0.4.1 — 2026-10-24

- Keep the private-desktop handle open until the task process exits; closing it early destroyed an otherwise-unused desktop and made `DeepSeekRuntime.exe` fail with `0xC0000142`.
- Remove the temporary agent-debug output.

## 0.4.0 — 2026-10-24

- Add `/review-desk task <prompt>`: start an isolated DSH headless Agent on the private review desktop.
- Generate a dedicated worker profile (`base` + `headless` + `llm-pi-ai`) under `taskHome`, separate from the desktop profile.
- Pass the task through a UTF-8 file + `cmd` stdin (`PowerShell 5.1` pipe loses Chinese text).
- Read provider `baseURL` from the desktop profile and the API key from config/env/`.credentials.yaml` refs.
- Add 8.3 short-path resolution for DSH installs whose long executable path cannot be launched.
- Add `taskProfile`, `taskHome`, `taskAppPath`, `taskBinPath`, `taskProvider`, `taskModel`, `taskBaseURL`, `taskApiKeyEnv`, `taskApiKey`, `taskTimeoutSeconds`.
- Relay only the worker's final answer; reasoning stays in worker stderr.

## 0.3.0 — 2026-10-24

- Add `/review-desk run <PowerShell>`: execute a task on the private review desktop via `STARTUPINFO.lpDesktop`; the task and its GUI children do not appear on the working desktop.
- Return the task's stdout/stderr and exit code to the DSH session; no desktop switch.
- Add `runTimeoutSeconds` (120) and `runOutputLimit` (20000) config.
- Fix Windows PowerShell 5.1 UTF-8 BOM handling for scripts under non-ASCII paths.

## 0.2.0 — 2026-10-23

- Rename project to `dsh-review-desk`.
- Add `ReviewStore`: collect review packets from `session/event`; capture workspace summary at `turn/end`; never fabricate change types.
- Add `AuditLog`: JSONL actions for prepare/open/return/close.
- Add `/review-desk list`, `show <turn>`, `audit`.
- Keep `prepare` background-only; `open` is the only explicit desktop switch.

## 0.1.0

- Initial host plugin and native helper.
- Private Win32 desktop with Edge app mode and a return panel.
- `ensure` / `open` / `return` / `close` / `status` / `watchdog`.
