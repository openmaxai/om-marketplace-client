# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- A picked-up install or upgrade whose version was revoked is now reported to the
  market as `failed`/`VERSION_REVOKED` after a restart, instead of being closed
  only locally and left running until it timed out: when the stored C-02 answer
  is now revoked or blocked, and when the C-02 replay is refused with 404
  `VERSION_NOT_FOUND` or 409 `VERSION_REVOKED`.
- A 409 `REQUEST_ID_CONFLICT` to a `VERSION_REVOKED` report is only logged; the
  market closing the same request first is expected. Other reports still alert.
- A `failed`/`VERSION_REVOKED` answer to a succeeded install report quarantines
  the landed copy instead of discarding it.

## [0.1.2] - 2026-10-21

### Added
- Each template shard starts with a fixed priority line (organization rules >
  template > the agent's own habits), then the path line, then the template's
  duty and boundary lines from `role.json`, then `inject.md`.
- Bundles at render version 2 carry `role.json` (`{boundary, duty}`); version 1
  bundles are still accepted without it.

### Changed
- `role.json` must be the server's canonical bytes; duty and boundary must be
  single-line with no control characters. Its sha256 is recorded in the slot and
  the shard prints nothing if the file later differs.
- The 2000-token limit covers the duty/boundary lines and `inject.md` together.
  A template write is refused as `inject_too_large` when the full section would
  not fit the shard budget.

### Upgrade Notes

No action needed. Templates installed with 0.1.1 keep working.

## [0.1.1] - 2026-10-21

### Added
- Post-install takes each required setting missing from the environment from the
  openmax component config (`~/zylos/components/openmax/config.json`, or under
  `$ZYLOS_DIR`), so `zylos add om-marketplace-client` needs no settings on an
  Agent with the openmax component. `COCO_*` variables still win per field.
- Only enabled openmax orgs are used. The primary org is the one matching
  `COCO_ORG_ID`, else the enabled org with the lowest id; the other enabled orgs
  are added to the `orgs` map, and entries already in `config.json` are kept.
- Post-install logs the source of each field (names only, never values).

### Changed
- When a required setting is in neither place, post-install still exits 78; the
  message names the missing variables and why the openmax component config could
  not supply them (not found, unreadable, not valid JSON, no enabled org, ...).

### Upgrade Notes

No action needed. Existing `config.json` files are kept.

## [0.1.0] - 2026-10-17

### Added
- Initial release.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add openmaxai/om-marketplace-client
```
