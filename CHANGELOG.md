# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.2] - 2026-11-20

### Changed
- Starter message: the source line `来自模板「<name>」的作者：` above author
  text is gone. The first guide, or the system line when there is none, opens
  the message; author lines keep their `｜ ` prefix and the end line.

## [0.12.1] - 2026-11-20

### Changed
- Starter message: one intro only. Without a first guide the message starts
  with `已聘用「<name>」，生效后就能用`. Any author text (first guide, starter
  tasks or both) sits under one line `来自模板「<name>」的作者：`. The greeting
  line is gone and the platform safety notice is now the last line.
- Starter message: a template with neither a first guide nor starter tasks is
  now claimed and sent (system line and safety notice only), and the hired
  confirmation still goes to the adopter when the adopter is not the owner.

### Fixed
- Template activation: a new-session request during whose confirm wait (5 minutes
  from delivery) the runtime reported a model API problem (status `health` not
  `ok`: rate limited, unavailable, authentication failed) and no session followed
  no longer counts toward the 3 requests per change. A shared quota running out
  or an API outage therefore no longer drives every Agent waiting for activation
  into `template_activation_stuck` (and releases its held starter message early);
  the change is asked for again once the runtime is healthy and idle. A problem
  while the request is still queued or after the wait, or on a change already
  stuck, gives nothing back. At most 12 such requests are given back per UTC day
  (`api_error_refunds`); past that they count as before (#66).

## [0.12.0] - 2026-11-20

### Added
- `submit-template` checks the whole manifest against the market's manifest
  schema (JSON Schema 2020-12, vendored byte-identical in
  `src/agent/schema/` and pinned by sha256 and market commit; the tests fail
  when the copy drifts from the pin). Every nested field is checked and every
  problem is reported at once with its JSON pointer, in the human output and
  as `problems` in `--json`.
- `submit-template --dry-run` asks the market to run every publish check
  (`templates:validate`) once the local check passes, lists everything it
  reports and submits nothing. When the market cannot check (Agent
  submissions off, or a market or cws-core without that route for Agents) it
  warns that only the local check ran and exits 5 (`server_checked: false`).
- `submit-template --icon-preset <id>` sets the template's icon to an expert
  preset (`icon: {kind: "preset", preset_id}` next to the manifest).
- A refused `submit-template` lists every manifest problem when the market
  sends them (`errors`); older markets' single reason reads as before.
- SKILL.md and README.md: manifest format reference with a minimal and a
  full example.

### Fixed
- The local check refused a `duty` / `boundary` on several lines, which the
  market accepts (up to 20 lines).

## [0.11.1] - 2026-11-19

### Fixed
- Hired confirmation: the Chinese and English lines are now separated by a
  blank line, so web chat Markdown no longer joins them into one line.
- Template activation: a template update or switch the user ordered no longer
  waits for the automatic idle path (5 minutes idle, 30-minute cooldown, 4 a
  day). Like a hire with a starter message, its new session is asked for as
  soon as the Agent has been idle 30 seconds with no open OpenMax turn, on a
  budget of its own: at least 2 minutes apart, at most 3 in any 60 minutes and
  12 per UTC day (`update_requests`). Past that budget the change falls back
  to the automatic rules. Every write order counts as user-ordered: the market
  creates them only for a hire, an update or a switch. A removal alone keeps
  the automatic rules.
- Template activation: when the openmax CLI is missing, the client now logs
  once that OpenMax turns are not checked before a new session is requested.
  README describes the turn check as it works: only a turn openmax's activity
  index still lists counts, not every turn of the last 10 minutes.

## [0.11.0] - 2026-11-18

### Changed
- Starter message: the welcome message goes to the Agent's owner, the
  `starter_recipient_member_id` the market now puts on the write order,
  instead of always the adopter. When an org admin hired the expert on
  someone else's Agent, the admin gets one short plain-text confirmation in
  their own DM with the Agent instead (`已为 {owner} 的 Agent 聘用「{expert}」`
  / `Hired “{expert}” for {owner}'s Agent`, client message id
  `mkt-hired-<adoption_id>`, at most once). A market that does not send the
  field keeps the old behaviour: the message goes to the adopter and no
  confirmation is sent.

## [0.10.1] - 2026-11-18

### Fixed
- Template activation: the new-session request is now an instruction. It
  tells the Agent that the client has verified from the injected template
  hashes that the current session does not match the templates, to start a new
  session now with the new-session skill and not to check whether one is
  needed. SKILL.md says the same. An Agent that judged the template already
  loaded and started no session used to delay the change by 30 minutes or
  more.
- Template activation: a request not followed by a session (no newer
  `injected.json`) is made again 5 minutes after its delivery instead of 15,
  once the Agent is idle, and such a retry no longer waits for the 30-minute
  cooldown or uses the 4 automatic requests a day: the cooldown applies only
  after a request that brought a session. Automatic requests are thus at most
  4 a day plus up to 12 retries a day; at most 3 requests per change as before. A change
  merged while no session followed the last request (for example a hire
  right after a removal) is asked for by the same retry, so it no longer
  waits for the cooldown. Only a session start in `injected.json` confirms a
  request.
- Starter message: the message is held until the template is in a session
  also when it joined a request already on its way or asked for one itself;
  that hold used to end after 3 minutes, so the welcome card could arrive long
  before the template took effect (for example a hire right after a
  removal). When the joined request brings no session, the client asks again
  on the starter budget. When the change raises `template_activation_stuck`
  (3 requests without a session), its held messages are released at once
  instead of waiting for the 24-hour limit. The 24-hour hold limit, and sending at once when no
  session can be asked for (runtime status or turn state unreadable, enqueue
  refused), are unchanged.

## [0.10.0] - 2026-11-18

### Added
- `submit-skill` and `submit-template` take `--personal`: the skill or
  template goes to the owner's personal shelf only (usable by the owner at
  once, no review, not submitted to the organization), as when the owner
  uploads it as personal in the workbench. Without it nothing changes: it is
  submitted to the organization for review (and is on the owner's personal
  shelf meanwhile). Needs a market that supports Agent personal submissions.
  An older market is recognised only by its unknown-field refusal (400
  `VALIDATION_FAILED`, field `body`) on the first call (skill prepare,
  template publish): reported as `PERSONAL_UNSUPPORTED`, nothing submitted,
  not retried, with a suggested owner reply; any other 400 is reported as
  usual. A personal request not answered as personal with no review is
  reported as `PERSONAL_NOT_CONFIRMED` (something may already be submitted;
  not retried; the owner checks 「我的 › 我创建的」).
- The submit commands end with a suggested reply to the owner;
  `--json` adds `owner_reply` and `scope` (`personal` / `org`). For
  templates `template_id` / `template_version_id` name the personal copy
  with `--personal` and the organization's copy otherwise;
  `personal_template_id` / `personal_template_version_id` are recorded too.
  `submissions` shows personal ones as `personal shelf only`.
- SKILL.md: before submitting, the Agent maps what the owner said to
  `--personal` (个人, 仅自己可见) or the default (组织), and asks the owner
  when it is not stated.

## [0.9.1] - 2026-11-18

### Fixed
- Manual install links (market skill pages and the Agent's page) are built
  on the market's `workspace_url`, the Workspace web base with its path
  (for example `https://host/workspace`), instead of the bare origin, which
  led to 404 pages. The proposal view field `workspace_origin` is renamed
  `workspace_url` (also in `--json`). A market that does not send
  `workspace_url` still gives only the origin of its `confirm_url`, so its
  links keep missing the Workspace path until that market is upgraded;
  with neither, the pages are named instead.

## [0.9.0] - 2026-11-18

### Added
- `market-client confirm-install <proposal_id> (all | <n|skill_id> ...)`
  and `decline-install <proposal_id>`: when the Agent's owner replies to an
  install request in a direct conversation with the Agent (Workspace or a
  channel DM), the Agent confirms or declines it as `agent_attested`, with
  `--channel workspace|lark|telegram|other`, optional `--channel-detail` and
  the owner's reply as `--owner-message-id` and/or `--owner-message-text`
  (or `--owner-message-file` with a regular file of this user directly in
  `/tmp`, or `--owner-message-text-stdin`; at most 64 KiB,
  a terminal stdin is refused) (at least one). The selection is matched
  against the request's candidates only (numbers or skill ids) and sent with
  the versions the request pinned; the owner comes from `install-permission`.
  Evidence is sent as received; the market cleans and caps it, and the
  client refuses locally evidence with nothing visible left after the same
  cleaning (shared vectors in `test/vectors/evidence-sanitize.json`).
  Channel, evidence, selection and a missing owner are checked before
  anything is sent. A confirmed request stays watched so its orders are
  pulled within seconds; a declined one is no longer watched.
- Rollout order: market, then cws-core, then this client. Against an older
  cws-core the confirm route answers 404, reported as "not supported yet";
  an older market answers `AGENT_CONFIRM_DISABLED`. The market's minimum
  client version is not raised for this feature.
- Messages for `AGENT_ATTESTATION_REFUSED` (`not_owner`, `owner_changed`),
  `AGENT_CONFIRM_DISABLED` `attested_off` (chat confirmation turned off in
  the market), `INSTALL_PROPOSAL_STALE`, `INSTALL_PROPOSAL_NOT_PENDING` and
  `VALIDATION_FAILED` fields. Where a person has to install instead (chat
  confirmation off or not supported, not the owner, no owner), the command
  prints what to tell them with links to the Workspace market skill pages
  (`/market/skills/{skill_id}`) and the Agent's page (`/agents?id=`), or
  names the pages when the Workspace origin is unknown.

### Changed
- The Agent no longer shows a confirm link: `request-install` and
  `install-requests` print no `confirm_url` (the page does not exist); the
  proposal view keeps only the Workspace origin taken from it.
- Local usage errors of the Agent market commands (bad arguments or
  options) exit 2 as documented, not 3. A repeated option other than
  `--reason` is a usage error.
- `request-install` and `install-requests` number the candidates (1 to 3)
  with name and a one-line purpose; `request-install` prints a ready
  proposal for the owner (`owner_prompt` in `--json`) and what to tell
  anyone else (`not_owner_reply`, `manual_install`).
  `install-requests` shows how a request was confirmed (`card` or
  `agent_attested` with the channel and the owner's message).
- `AGENT_CONFIRM_DISABLED` without a reason means a client bug or an older
  market: report it, do not retry. `AGENT_OWNER_REQUIRED` on install
  requests says only an org admin can install, in the Workspace market.
- SKILL.md: the Agent proposes in its owner's conversation with numbered
  candidates and reply options, acts only on its owner's own new reply in a
  direct conversation (never a group chat or another member), passes that
  reply verbatim in a file (or a heredoc with a random delimiter), tells anyone else that the owner confirms in chat
  and admins can install in the Workspace market, and reports what was
  installed and what was not selected.

## [0.8.0] - 2026-11-17

### Added
- `market-client start`: runs the post-install hook (an existing config is
  kept), starts the `zylos-om-marketplace-client` pm2 service when it is not
  online (or restarts it when the hook changed the config), runs `pm2 save`,
  asks the service for a poll round (up to 2 more after a transient failure)
  and exits 0 only when the service runs and its install order pull succeeded.
  It fails without starting anything when another process that pm2 does not
  run holds the state lock. `zylos add --json`, the mode Agents
  use, returns before the post-install hook and the service start, so an
  Agent-run install left the service stopped until someone started it and
  hires failed with `AGENT_NO_CLIENT`. SKILL.md `next-steps` now tells the
  Agent to run `market-client start` and to report the install as done only
  when it exits 0.
- `market-client search`: search the skills listed for the organization.
- `market-client install-permission`: who may confirm installs on this Agent
  in the workspace (the owner, org admins), with display names when the
  market gives them.
- The service checks each pending install request every ~15 seconds (backing
  off on errors, stopping when it is decided or expires) and pulls the
  install orders as soon as it is confirmed in the workspace.
- `market-client request-install`: propose 1 to 3 skills for this Agent;
  nothing is installed until a person (owner or org admin) confirms on the
  card in the workspace. A new request replaces the pending one, but is
  refused while the previous one is being confirmed or installed; a skill
  declined in the last 7 days is refused. The market's confirm link is shown
  when given. `install-requests` refreshes the requests recorded locally.
- `market-client submit-skill` and `submit-template`: submit a new skill (a
  directory with `SKILL.md`, packed and checked locally; files that may hold
  credentials, including service-account JSON keys found by content, refuse
  the package) or a new expert
  template manifest. Submissions land pending review. `--dry-run` runs the
  local checks only. `submissions` lists what this Agent submitted.
- Refusals from these commands are explained (name taken, no owner, client
  too old, rate limits with the wait, validation and scan results).

### Changed
- SKILL.md tells the Agent about the Agent Market: search when a task needs a
  capability it lacks, propose up to 3 skills, and send the user to the
  workspace to confirm (the Agent never confirms); create skills and
  templates only at the owner's request. User-facing phrasing is given in
  Chinese.
- Market problem responses keep the registered fields that explain a refusal
  (`field`, `rule`, `rule_class`, `sentence`, `file`, `skill_md_rule`,
  `expected_slug`, `queue_limit`, ...); they are shown to the Agent, not
  logged. Text the market echoes back is quoted as market data.

### Fixed
- Starter message: when the Agent is busy at adoption time (not idle for 30
  seconds, a tool running, or an OpenMax turn open), the message is no longer
  sent at once. It is held until the template is in a session, as when the
  starter budget allows no request (24 hours at most, kept across restarts,
  before the claim). Once the Agent is idle the client asks for a new session
  on the starter budget. An Agent busy for 24 hours gets the message then,
  without a new session. Without a readable runtime status or turn state the
  message is still sent at once.
- Starter message: a send whose outcome is unknown (timeout, server error,
  unreadable output, or a restart during the send) is now looked up in the DM
  by its client message id. Found, it is marked `sent`; surely absent 60
  seconds after the send, it is marked `send_failed` (reason `send_lost`).
  When the lookup cannot tell within 10 minutes, the job is dropped unmarked
  as before. Previously such a send was never marked, so the workbench showed
  the fallback card 10 minutes after the claim even when the message had
  arrived.
- Service: a configuration error at start-up now ends the process with exit
  code 78 after the error is logged. Under pm2 the process used to stay online
  with only the exit code set, so pm2 never stopped it and an unconfigured
  client looked running. Any other start-up error (for example an I/O or
  permission error on the state directory) now exits with code 1, so pm2
  restarts the service instead of stopping it. CLI commands keep their exit
  codes.

## [0.7.1] - 2026-11-17

### Fixed
- Starter message: a template adopted within 30 minutes of the last
  new-session request no longer gets its starter message before the template
  is in the Agent's session. The new-session request for a starter message is
  no longer subject to the automatic 30-minute cooldown. It has its own budget
  instead: at least 2 minutes between two and at most 12 per UTC day, counted
  apart from the 4 automatic requests a day (neither uses the other's). An
  adoption written while a request is still on its way joins it, so adoptions
  close together share one request.
- When no request may be made for it, the starter message is held until the
  template is in a session (at most 24 hours) instead of being sent at once.
  The client asks for the session as soon as the 2-minute interval has passed,
  or by the automatic rules once the 12 are used. The hold is kept in the
  client state, so it survives a restart. It comes before the claim, so the
  send deadline and the market's 10-minute grace still count from the claim.

## [0.7.0] - 2026-11-17

### Changed
- Starter message: with openmax 2.32.0 or later it is sent as the welcome card,
  an `AGENT_STRUCTURED` message with the same text, metadata
  `market_starter_tasks: {schema: "market.starter-tasks.v1", adoption_id}`, a
  fallback text and client message id `mkt-starter-<adoption_id>`. The fallback
  text is the whole message up to 8192 bytes; a longer one is cut at a
  character boundary with the truncation suffix. With an older or unreadable
  openmax version the message is sent as plain text exactly as in 0.6.1.
- When the welcome card is refused for certain (HTTP 4xx other than 408 and
  429, or refused by the client), the refusal is logged and the message is sent
  once as plain text with id `mkt-starter-<adoption_id>-text`. A server error,
  timeout or unreadable answer is not retried, as before.
- The client refuses the metadata key `context` and a fallback text over 8192
  bytes itself, since openmax 2.32 does not check them.

### Added
- `starter_message.structured` in `config.json` (default `true`); `false` sends
  the starter message as plain text, as in 0.6.1.

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
