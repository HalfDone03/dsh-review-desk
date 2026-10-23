# Changelog

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
