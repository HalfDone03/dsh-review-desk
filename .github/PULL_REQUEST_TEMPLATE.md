## What changed

<!-- One or two sentences. -->

## Why

<!-- Link the issue or describe the user problem. -->

## Verification

```text
node scripts/check.mjs
node scripts/selftest.mjs
```

<!-- Add helper or DSH integration commands if relevant. -->

## Invariants

- [ ] `prepare` / `ensure` still never calls `SwitchDesktop`
- [ ] No automatic `open`
- [ ] No tool argument values, tool output, tokens, or session text in audit/review data
- [ ] Docs updated if behavior or config changed
