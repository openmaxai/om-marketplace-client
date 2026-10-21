# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
