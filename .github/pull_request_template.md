## What
<!-- One-line summary of the change. -->

## Why
<!-- The problem or requirement this addresses; link the issue if there is one. -->

## How
<!-- Notable implementation choices, if any. -->

## Test
- [ ] `npm test` passes locally
- [ ] New or changed behaviour is covered by tests
<!-- Anything tested by hand, and how. -->

## Security and compliance
- [ ] No secrets, tokens or credentials in code, tests, fixtures or commit history
- [ ] No new third-party dependency, or the new dependency is justified below and its licence is compatible with MIT
- [ ] Untrusted input (server responses, package contents, file paths) is validated before use
- [ ] Changes to install, download or file-write paths keep checksum verification and path confinement
- [ ] CI is green: tests, SAST (semgrep) and secret scan (gitleaks)

## Rollout
- [ ] No breaking change, or the breaking change and its migration are described below
<!-- Client and server compatibility, configuration changes, rollback steps. -->
