# Changelog

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
