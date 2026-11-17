# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-11-17

### Fixed
- Starter message: lines are now separated by a blank line, so a Markdown (GFM)
  chat renderer shows the greeting, the notice, each guide line and each starter
  task on its own line instead of one paragraph. Plain-text channels only see
  extra spacing. Trailing backslashes and spaces are dropped from author lines,
  and the author's own blank lines are dropped.

## [0.6.0] - 2026-11-15

### Added
- Template activation: a template write, upgrade or uninstall takes effect at
  the next session start; the client now asks for that session itself. Once
  the Agent has been idle for 5 minutes (two checks 30 seconds apart, fresh
  runtime status file, no open OpenMax turn), it enqueues a new-session request
  on the zylos control queue, at most every 30 minutes and 4 times a day.
  Changes close together share one request. Always on; there is no setting.
- The first template shard writes `injected.json` at every session start,
  naming the templates and bundle sha256s that session was given. A session
  that shows every change, requested or natural, is reported as
  `template_activated` through the reconcile report; one that does not show a
  template is reported as `template_inject_missing`. A request without a
  session within 15 minutes is made again, at most 3 times, then the alert
  `template_activation_stuck` is raised and the client keeps watching.
- Urgent reconcile items are sent at once in their own request, kept in the
  client state until the market answered them, and resent first by the next
  poll round. The queue holds at most 200 items and drops items not delivered
  for 7 days; a batch refused with 400 without an item index is resent item by
  item, at most 5 per flush.
- New-session requests are followed in the control queue by their id: none is
  made while the runtime health is not ok or an earlier request is still
  queued, a request no longer needed is withdrawn, a timed-out enqueue counts
  as made, and requests are made one at a time. Requests carry a 6-hour ack
  deadline, and a control id older than 24 hours is given up.
- Templates adopted before 0.6.0 are seeded once and confirmed by the next
  session that shows them, without a request.
- The alert `template_activation_pending_24h` is raised for a change pending
  24 hours. A rewrite of a bundle the current session already shows is
  reported as activated at once.

### Changed
- Starter message: when the Agent has been idle for 30 seconds with no open
  turn at write time, the new session is requested at once and the message
  waits until the session has the template, at most 3 minutes.
- A revoke applied to an installed skill is reported as `revoked_disabled` at
  once instead of with the next periodic reconcile run.
- Template slots record the bundle sha256 of the adoption.

## [0.5.4] - 2026-11-10

### Fixed
- Starter message: the openmax CLI prints `[token] ...` lines to stdout when it
  refreshes its token, so the DM check could fail as unreadable output and the
  message was reported as send_failed. The client now skips every `[name] `
  trace line and reads the trailing JSON answer.

### Changed
- Starter message: the read-only DM-check calls (`create_dm`,
  `get_conversation`, `member_list`) are tried once more after a failure that
  is not a refusal (unreadable output, timeout, server error). `comm.send` is
  still never retried. A send is no longer started 9 minutes or more after the
  claim, so a slow DM check cannot run past the market's 10-minute grace.
- Starter message: a send_failed or rejected_content result is logged with a
  short reason code (for example `dm_check_unreadable_output`,
  `dm_not_one_to_one`, `send_refused_http_400`, `interrupted`), and IM errors
  keep the CLI's error text, redacted. The reason stays local: the market's
  `:mark-starter-shown` accepts only `result`.

## [0.5.3] - 2026-11-07

### Changed
- Starter message: with openmax 2.32.0 or later the message is sent at once
  with `noRun: true` instead of waiting for the DM to have no open run.

## [0.5.2] - 2026-11-07

### Fixed
- Starter message: create_dm answers with the conversation nested under
  `conversation`, so the client found no conversation id and reported the
  message as send_failed without sending it. The id is now read from
  `conversation.id`, with a bare conversation still accepted.

## [0.5.1] - 2026-11-07

### Fixed
- Starter message: the openmax CLI could print request trace lines to stdout
  before its JSON answer, so the DM check failed as unreadable output and the
  message was reported as send_failed. The client now turns the trace off for
  its CLI calls and skips such lines when reading the answer.

## [0.5.0] - 2026-11-06

### Added
- Every starter message carries a fixed platform safety notice, in Chinese and
  English on one line, right after the greeting. It is client text, never
  taken from the template and not run through the credential rules; a copy of
  it in a template field is refused as a credential request.

### Fixed
- Credential rules: Chinese clause boundary also at ASCII punctuation, colon,
  enumeration comma and white space, as in the market.

### Upgrade Notes

No action needed. The market does not require this version.

## [0.4.0] - 2026-11-05

### Changed
- One expert template may now have up to 8000 estimated tokens (duty and
  boundary lines plus `inject.md`), up from 2000. A template that does not fit
  one 2200-token zylos shard is split across the four `market-template-*`
  shards; every part starts with the priority line and carries
  `(part k of n)`. Cuts prefer paragraph, then line, then word breaks and never
  fall inside the generated `customizations.json` file-list line. Each shard
  stays within the zylos budget next to the zylos header.
- Shards print the mapped templates in slot order instead of one slot per
  shard. A write whose parts would not fit next to the other mapped templates is
  reported as `CLIENT_INTERNAL` (`slots_full`).
- The market serves templates over 2000 tokens only to this version or later.

## [0.3.0] - 2026-11-05

### Added
- Starter message: after the market accepts the first write of an adopted
  expert template whose order carries `starter_message`, the client claims the
  message (`:claim-starter`), filters and renders the template's first guide
  and starter tasks as plain text, checks that the DM is exactly this Agent and
  the adopter, sends it once through the openmax component's IM and records the
  result (`:mark-starter-shown`). A credential request in the content is never
  sent (`rejected_content`). A send is never retried; only the mark is.
- The starter message content is read from `starter_content` on the write
  order; without it the message is not claimed. The message is kept within
  16384 UTF-8 bytes (fallback text 8192): a first guide that does not fit is
  cut with `…（完整内容见 Agent 详情）`, and a message that still does not fit
  is not claimed.
- The starter message is held back while the openmax activity store shows a
  run in that DM (open, or closed by a reply within 10 minutes), checked every
  30 seconds for up to 8 minutes after the claim; then it is reported as
  `send_failed` without a send. A send with an unknown outcome is not reported.
  While waiting only ids, the content and its sha256 from the claim are kept;
  the message is rendered again through the whole pipeline before the send,
  and is not sent (`send_failed`) when the content changed or a step fails.
- Links are removed after any length cut, so a cut cannot re-create an address
  or split `[链接已移除]`; Unicode-form domains are removed too.
- Credential rules: spaced-out single letters are joined from three letters on
  ("c a t"), as in the market.
- `starter_message.enabled` in `config.json` turns the starter message off on
  this Agent.

### Upgrade Notes

No action needed. Starter messages are sent only for templates adopted after
the upgrade, and only on an Agent with the openmax component.

## [0.2.0] - 2026-11-04

### Added
- Local skill report (C-16): the skills in the skills directory that the market
  did not install are reported to each configured org as metadata only
  (directory name, frontmatter `name` and `version`, source `zylos_component`,
  `git` or `local`). Sent after start and with reconcile; an unchanged list is
  sent again every 12 hours. `market--*`, dot directories, links and
  directories without SKILL.md are skipped; at most 1000 directory entries are
  looked at and at most 200 items sent. Names that look like credentials are
  never sent.

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
- A template write answered `stale` by C-15 (first deploy or upgrade) is no
  longer kept: its slot is cleared, the new content is quarantined, and C-11 is
  pulled at once.

### Upgrade Notes

No action needed. The first local skill report is sent after the service restarts.

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
