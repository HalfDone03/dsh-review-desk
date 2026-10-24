# Changelog

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
