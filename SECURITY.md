# Security policy

## Scope

`dsh-review-desk` isolates **UI**, not security boundaries.

- The private desktop runs in the same Windows logon session and with the same user token as the default desktop.
- It does not prevent another process from reading the same files, network, or DSH session store.
- The native helper does not read DSH session content.
- `/review-desk run` executes arbitrary PowerShell with the current user's full token and filesystem/network access. It is a convenience for verification tasks, **not** a sandbox. Do not run untrusted commands with it.
- The host plugin does not write tool output, tool argument values, tokens, or session text to audit logs by default. The `run` audit entry keeps only a 200-character command prefix.

## Supported versions

| Version | Supported |
|---|---|
| 0.3.x | yes |
| 0.2.x | yes |
| 0.1.x | no |

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub Security Advisories on this repository:

<https://github.com/HalfDone03/dsh-review-desk/security/advisories/new>

Include:

- affected version;
- Windows version;
- reproduction steps;
- impact;
- whether the issue crosses the UI-isolation boundary or is only a UI disruption.

Do not include real tokens, cookies, or private session content.

## Known non-issues

- The private desktop has no taskbar and is absent from `Win+Tab`; that is by design.
- A program on the default desktop can still enumerate windows or processes; this plugin is not an anti-cheat or anti-malware boundary.
- Focus restoration after returning is best-effort; it is not a security guarantee.
