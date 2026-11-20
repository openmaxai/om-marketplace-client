# om-marketplace-client

Agent Market client for zylos Agents. It pulls install intents that a person
placed in the Agent Market workbench, installs the approved skills and expert
templates into this Agent after sha256 verification, and reports the result
back to the market.

Only a person decides what is installed or upgraded: install and upgrade run
only from orders placed in the workbench or install requests a person
confirmed (in the workspace, or by the Agent's owner replying in a direct
conversation with the Agent). The Agent can search the market, request an install and, on its
owner's request, submit a new skill or expert template for review. Enable, disable, uninstall and
rollback can also be run locally with `market-client`; the change is made
first and then reported to the market.

## Install

Send this to your Agent:

> Please run `zylos add openmaxai/om-marketplace-client`.

That is all on an Agent with the openmax component: the client takes its
settings from the openmax component config. Other Agents set the `COCO_*`
variables below first.

The short name (`zylos add om-marketplace-client`) works once the component is
listed in the Zylos component registry.

The client is installed automatically the first time the Agent's owner installs
a skill or hires an expert template from Agent Market. It can also be installed
manually with `zylos add openmaxai/om-marketplace-client`.

### Steps

1. On an Agent with the openmax component, nothing needs to be set: the
   post-install hook reads the missing values from the openmax component config
   (`~/zylos/components/openmax/config.json`, or under `$ZYLOS_DIR`). The
   `COCO_*` environment variables below are an optional override; each one that
   is set wins over the openmax value for that field.
2. Run `zylos add openmaxai/om-marketplace-client`.
3. The post-install hook writes
   `~/zylos/components/om-marketplace-client/config.json` (directory 0700,
   file 0600) and logs where each field came from (names only, never values).
   If a required value is neither in the environment nor in the openmax
   component config it stops with exit code 78, names the missing variables and
   says why the openmax component config could not supply them. In an
   interactive terminal it asks for the missing values instead (the API key is
   not echoed). It then declares the
   four `market-template-*` session-start shards. Only while their hooks are
   missing from the runtime's hook file does it run the zylos hook sync. On
   Claude the agent restarts once when idle; memory and context are kept. On
   Codex the templates take effect when the Codex session next starts. Until
   then a template write raises an alert (restart the Codex session, then adopt
   the template again) and waits, holding back later orders of its org. It is
   reported as failed (`inject_unavailable`) before its order expires, after at
   most 15 minutes of waiting (`HOOKS_MAX_DEFERRAL_MS`), or at once when another
   template order of any org is queued behind it. The alert clears once the
   hooks are present. Upgrades do the same.
4. If you set `COCO_*` variables, unset them in that shell
   (`unset COCO_BFF_URL COCO_API_KEY COCO_ORG_ID COCO_MEMBER_ID COCO_IDENTITY_ID`).
   The PM2 app filters them out and the service removes any it still inherits,
   logging only their names.
5. Run `market-client start`. `zylos add --json` (the mode an Agent uses)
   returns before the post-install hook and the service start, so this step
   is required there; after a terminal install it only checks. It runs the
   post-install hook (an existing config.json is kept), starts the PM2 app
   from `ecosystem.config.cjs` when it is not online (or restarts it when the
   hook changed config.json), runs `pm2 save`, waits up to 30 seconds for the
   service to take the state lock, asks it for a poll round and checks that
   its install order pull succeeded. A pull that failed transiently (server
   error, timeout, Retry-After) gets up to 2 more rounds, 15 seconds apart. When
   pm2 does not run the service but another process holds the state lock (a
   service started by hand, or a running `market-client` command), it fails at
   once and starts nothing. It exits 0 only then; otherwise it exits
   1 (78 for a configuration error) and prints the last pull outcome and the
   alerts. The install is complete only when it exits 0.
6. Restart the Agent session once.
7. Check the service: `pm2 logs zylos-om-marketplace-client --lines 20`.

Configuration errors exit with code 78; PM2 does not restart the service on
that code. Fix the configuration, then `pm2 restart zylos-om-marketplace-client`.

## Environment variables

All optional on an Agent with the openmax component. Precedence is per field:
a set variable wins, otherwise the openmax component config value is used.

| Variable | Required | openmax config field | Meaning |
|---|---|---|---|
| `COCO_BFF_URL` | unless the openmax component config provides it | `server.bff_url` | Workspace BFF base URL. Must be `https://`; `http://` only for `localhost` / `127.0.0.1`. No path. |
| `COCO_API_KEY` | unless the openmax component config provides it | `agent.api_key` | This Agent's Workspace API key. Never printed. |
| `COCO_ORG_ID` | unless the openmax component config provides it | primary org's `org_id` | Organization ID the Agent belongs to (the primary org). |
| `COCO_MEMBER_ID` | unless the openmax component config provides it | primary org's `self.member_id` | This Agent's member ID in that organization. |
| `COCO_IDENTITY_ID` | no | `agent.identity_id` | This Agent's identity ID. |

Orgs in the openmax component config count only when `enabled` is not `false`.
The primary org is the one matching `COCO_ORG_ID` when that is set, otherwise
the enabled org with the lowest org id. The other enabled orgs are added to the
`orgs` map (see below); entries already in `config.json` are kept and win.
The openmax component config is read only when it resolves inside the home or
zylos directory and is a regular file owned by the current user.

The running service reads only its own `config.json`, never these variables.
Re-running the post-install hook with no `COCO_*` variables keeps an existing
valid `config.json` (the openmax component config is then not read). A partial
set that the openmax component config cannot complete fails and leaves the file
unchanged.

## Key rotation

Rerun `node ~/zylos/.claude/skills/om-marketplace-client/hooks/post-install.js`
with the new `COCO_API_KEY` set; the other fields come from the environment or
the openmax component config. It rewrites the whole `config.json`. Then unset
the variable and run `pm2 restart zylos-om-marketplace-client`.

If the data directory already exists it must be mode 0700; the hook refuses to
write into a directory that is accessible by group or other.

## Configuration file

`~/zylos/components/om-marketplace-client/config.json` (the data directory;
`OM_MARKETPLACE_CLIENT_HOME` overrides it). Besides the post-install fields:

| Field | Meaning |
|---|---|
| `org_id`, `member_id` | Primary org and this Agent's member id in it. Revocations are pulled through the primary org; state is kept per BFF origin, primary org and member id, so changing the primary org starts from empty state. |
| `orgs` | `{"<org_id>": {"member_id": "<id>"}}`: further orgs whose orders this Agent executes. Post-install adds the other enabled orgs of the openmax component config when the primary org is one of them. `member_id` may be left out; it is then read from the org-scoped token. Orders from an org not listed are not executed and are reported as `org_not_configured`. Edit by hand, then restart the service; post-install keeps the map. |
| `log_level` | `debug`, `info` (default), `warn` or `error`. |
| `storage_emulator_origin` | Development only; accepted only with a loopback `bff_url`. |
| `starter_message` | `{"enabled": false}` stops this Agent from sending starter messages (default: enabled). `{"structured": false}` sends them as plain text (`AGENT_TEXT`, as before 0.7.0) instead of the welcome card (default: true). Restart the service after changing it. |

## Commands

`market-client` (linked into `~/zylos/bin` on install):

| Command | Effect |
|---|---|
| `start` | Runs the post-install hook, starts the service under PM2 when it is not online, runs `pm2 save` and checks that the service pulled install orders from the market (see [Steps](#steps)). Waits up to `--wait` seconds (default 300) for the poll round. |
| `status [--json]` | Service state, each org's validity, client version gate, last pulls and reconcile, installed skills and templates, queue and outbox sizes, alerts. Reads files only. |
| `sync` | Runs one poll round now: revocations, orders and outbox resend. Reconcile runs in it only when due (every 45 minutes). |
| `rollback <slug>` | Swaps the version kept by the last upgrade back in (the replaced one is kept instead) and reports `local_rollback` through reconcile. Refused when the kept version is revoked, when the installed version is revoked and quarantined, or while an order or report for the skill is in flight. An interrupted rollback is completed at the next start. |
| `enable <slug>` / `disable <slug>` | Moves the skill into / out of the skills directory, then reports it. A skill disabled because of a revocation cannot be enabled. |
| `uninstall <slug>` | Removes the skill and its kept versions, then reports it. |

`<slug>` may also be the skill id. Exit codes: 0 done, 1 failed, 2 usage,
3 refused or not installed, 4 the running service did not answer within
`--wait <seconds>` (default 900), 5 `submit-template --dry-run` passed the local
check but the market could not check it, 78 configuration error. A report the market
could not take yet is kept and resent; the command still exits 0. Ctrl-C or
SIGTERM while a command runs in the CLI itself aborts pending network calls,
lets the current step finish and then exits 130. A second Ctrl-C exits at once
(130); the interrupted step is completed or undone at the next start.

Only one process works on a data directory at a time. When the service is
running, commands other than `status` are handed to it and run between poll
rounds; otherwise the command takes the lock and runs itself. A service
starting meanwhile waits for the lock.

### Agent market commands

These call the market directly (no state lock, not handed to the service) for
the primary org, or `--org <org_id>`. All take `--json`. They need market
support for client 0.8.0 (`confirm-install` and `decline-install`: market support for Agent-attested confirmation); an older market answers `CLIENT_VERSION_TOO_OLD`.

| Command | Effect |
|---|---|
| `search [<words>] [--category-id <id>] [--limit 1-20]` | Skills listed for the org and visible to the Agent's owner, minus those already on the Agent, with description, examples, category and latest version. |
| `install-permission` | Who may confirm installs on this Agent in the workspace (`who_can_install`: the owner and org admins); names when the market gives them, else member ids. |
| `request-install <skill> [<skill> <skill>] --reason <text> [--reason <text> ...]` | Creates one install request with 1 to 3 candidates (slug or skill_id; one reason for all or one per skill), `pending_confirmation`, expiring after 24 hours. It replaces the Agent's pending request (that one becomes `superseded`), unless that one is being confirmed or already has orders placed: then it is refused with `INSTALL_PROPOSAL_PENDING` and the old one stays watched. A skill declined in the last 7 days (market default) is refused with `SKILL_RECENTLY_DECLINED`. Nothing is installed: the owner confirms in a direct conversation with the Agent (`confirm-install`), or an org admin installs it manually in the Workspace market. Prints the numbered candidates, a proposal for the owner and, for anyone else, links to the market skill pages (`/market/skills/{skill_id}`) and the Agent's page (`/agents?id={agent_id}`) under the Workspace web base the market reports (`workspace_url`, path kept; a market that does not send it gives only the origin of its `confirm_url`, and links built on that origin miss the Workspace path), or the page names when there is none. The request is recorded in `install-requests.json` in the data dir (last 50). |
| `install-requests [--state <state>]` | The requests recorded by `request-install` (newest 20), each refreshed from the market (the market has no list route for Agents), with the candidates numbered, what was selected and how it was confirmed (`card` or `agent_attested` with the channel and the owner's message), marked as market data. |
| `confirm-install <proposal_id> (all \| <n\|skill_id> ...) --channel workspace\|lark\|telegram\|other [--channel-detail <text>] [--owner-message-id <id>] [--owner-message-file <path> \| --owner-message-text-stdin \| --owner-message-text <text>]` | The Agent attests that its owner chose these candidates in a direct conversation (`confirmed_via: agent_attested`). The selection is matched against the request's candidates only (1-based numbers or skill ids; `all` for every one) and sent with the versions the request pinned and the owner from `install-permission`. At least one of the message id and text is required. `--owner-message-file` reads the reply from a temp file: opened without following a symbolic link and without blocking, it must be a regular file owned by this user, with no other hard link, whose real path is directly in `/tmp` (fixed; `TMPDIR` is not used; `/tmp` must be root-owned, world-writable and sticky), and `--owner-message-text-stdin` from piped stdin (at most 64 KiB, one trailing newline dropped; stdin on a terminal is refused); only one of the three text options may be given. Evidence is sent as received (only values over 4 times the market limit are cut, and the cut value must still have something visible); the market cleans it and cuts it to 64 / 200 / 500 characters. The client applies the same cleaning only to refuse locally evidence with nothing visible left (`test/vectors/evidence-sanitize.json`). The request stays watched, so the orders are pulled within seconds. |
| `decline-install <proposal_id> --channel ... [--owner-message-id <id>] [--owner-message-file <path> \| --owner-message-text-stdin \| --owner-message-text <text>]` | The owner declined in the conversation; same evidence, no skills. The request is no longer watched. |

`confirm-install` and `decline-install` need market and cws-core support for
Agent-attested confirmation. Roll out in this order: market, then cws-core,
then this client. Against an older cws-core the confirm route answers 404; the
client reads the request first, so a 404 on the confirm route is reported as
"not supported yet" and the owner installs manually in the Workspace market. An older
market answers `AGENT_CONFIRM_DISABLED`. The market's minimum client version
is not raised for this feature. Local usage errors (selection, channel,
missing evidence, a repeated option) exit 2.

| Command | What it does |
|---|---|
| `submit-skill <dir> [--personal] [--changelog <text>] [--examples <file>] [--category-id <id>] [--dry-run]` | Packs the directory (top-level `SKILL.md`; `.git` skipped; symbolic links and files that may hold credentials — `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` and other SSH keys, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `credentials*`, and any `.json` up to 1 MiB that is a Google Cloud service-account key (detected by content) — refused and named), checks it with the install-path rules, then uploads it as a new skill. It lands pending review by an org admin (and on the owner's personal shelf); with `--personal` it goes to the owner's personal shelf only, with no review. |
| `submit-template <manifest.json> [--personal] [--changelog <text>] [--category-id <id>] [--icon-preset <id>] [--dry-run]` | Checks the whole manifest against the market's manifest schema (every nested field; all problems at once, each with its JSON pointer) and publishes it as a new expert template, pending review; with `--personal` on the owner's personal shelf only, with no review. `--icon-preset` sets the template's icon to an expert preset (`{kind: "preset", preset_id}` in the request, not in the manifest). With `--dry-run` nothing is submitted: after the local check passes, the market runs every publish check (`templates:validate`) and all its findings are listed; a market that cannot validate for Agents (404 / 405, or `AGENT_UPLOAD_DISABLED`: Agent submissions off or an older market) prints the warning 「市场端校验不可用（未启用 Agent 提交或市场版本过旧），仅完成本地校验」 and exits 5 (`--json`: `ok: false`, `error: market_check_unavailable`, `server_checked: false`). In `--json`, refusals carry `problems: [{source: local\|market, pointer, reason, ...}]`; `template_id` / `template_version_id` name the personal copy with `--personal` and the organization's copy otherwise. |
| `submissions` | Submissions made from this Agent, kept in `submissions.json` in the data dir (last 200; review state as of submission). |

While a request from `request-install` is pending, the service checks it every
15 seconds (±20%; a failed check backs off from 30 seconds up to 5 minutes) and
runs a poll round as soon as it is confirmed, so a confirmation made in the
workspace or with `confirm-install` installs within seconds. It stops when the request is decided, superseded, gone, or expired. The
pending requests are kept as files in `proposal-watch/` in the data dir.

### Expert template manifest

Run `submit-template <file> --dry-run` first: it checks the manifest locally and
with the market and submits nothing. The local check uses
`src/agent/schema/expert-template-manifest.schema.json`, a byte-identical copy
of the market's `docs/schemas/expert-template-manifest.schema.json` (JSON Schema
2020-12) pinned by sha256 and market commit in `src/agent/schema/pin.js`; the
tests fail when the copy and the pin differ, and run the market's shared cases
(`test/vectors/expert-template-manifest.cases.json`). The market's
`docs/expert-template-manifest.md` is the full field reference.

A JSON object; unknown keys are refused (`unknown_field`). Lengths count Unicode
characters. "Text" is a string that is not blank. Instruction fields
(`role.persona`, `role.instructions`, `role.duty`, `role.boundary`,
`first_guide`, `triggers[].prompt`, `sop[].title`, `sop[].steps[]`,
`starter_tasks[].prompt`) must not contain `{{`. A `key` is
`^[a-z][a-z0-9_]{0,31}$`, unique within its list.

| Field | Required | Rules |
|---|---|---|
| `schema_version` | yes | `1` |
| `kind` | yes | `"expert_template"` |
| `id` | yes | slug: lowercase letters and digits separated by single hyphens, at most 64 |
| `version` | no | semver (`1.0.0`, `1.0.0-beta.1`), no build metadata; the market assigns one when absent |
| `role` | yes | `name` text <= 100; `instructions` text <= 32000; `duty` text <= 2000, up to 20 lines, no blank first or last line, no two blank lines in a row; optional `persona` text <= 2000 and `boundary` (as `duty`). Role lines plus the session text must fit 8000 estimated tokens |
| `skills` | yes | <= 20 of `{skill_id, skill_version_id, package_sha256}` (lowercase UUIDs, 64 hex) of listed skill versions; `[]` for none |
| `first_guide` | no | text <= 20000, shown to the adopter only |
| `connectors` | no | <= 10 of `{app, purpose, required}`: `app` `^[a-z][a-z0-9_-]{0,63}$`, `purpose` text <= 2000, `required` boolean |
| `triggers` | no | <= 10 of `{key, title <= 40, prompt <= 1000, schedule: {cron, timezone}}`: 5 cron fields of digits and `* / , -`; `UTC` or an IANA zone |
| `sop` | no | <= 30 of `{key, title <= 200, steps}`: 1 to 30 texts <= 2000 |
| `knowledge` | no | <= 20 of `{key, title <= 200, sha256, size}`: an uploaded knowledge file, 1 to 1048576 bytes |
| `customizable_fields` | no | <= 30 adoption parameters, below |
| `starter_tasks` | no | <= 10 of `{title <= 40, prompt <= 1000}` |
| `card` | no | `{summary <= 500, capabilities?, limitations?, guardrails?, tags?}`: the three lists <= 20 texts <= 200, `tags` <= 4 texts <= 32 |

Adoption parameters `{key, label, type, required, sensitive?, options?, max_len?, default?, include_agents?}`:
`label` text <= 100; `type` is `text`, `long_text`, `enum`, `boolean`,
`integer`, `timezone` or `member`; `options` (1 to 50 unique texts <= 100) only
and always for `enum`; `max_len` (1 to 4000; default 200 for `text`, 4000 for
`long_text`) only for those two; `default` fits the type (`text` one line,
within `max_len`; an `enum` default is one of its options). A `sensitive`
parameter takes no value: not `required`, no `default`. A `member` parameter (a
member of the adopting org, chosen at adoption) has no `default`, is never
sensitive, and `include_agents: true` lets Agents be chosen too.

The icon is not part of the manifest: `--icon-preset <id>` sends
`icon: {kind: "preset", preset_id}` next to the manifest. Expert presets:
`expert-service`, `expert-growth`, `expert-report`, `expert-creative`,
`expert-listing`, `expert-select`, `expert-global`, `expert-compliance`.
Uploaded icons (`{kind: "upload", icon_id}`) are for people in the workspace;
the market refuses them from an Agent.

Only the market checks: NFC, invisible and control characters, credentials
(secret scan), requests for credentials and unsafe instructions in
`first_guide` and starter tasks, text that imitates the client's own lines,
duplicates within lists, an `enum` default outside its options, the token
budget, and everything against stored data (listed skills, knowledge files,
version order, the name on the shelf, an existing template id).

Minimal:

```json
{
  "schema_version": 1,
  "kind": "expert_template",
  "id": "inbox-helper",
  "role": {"name": "Inbox Helper", "instructions": "Triage the inbox every morning.", "duty": "Inbox triage."},
  "skills": []
}
```

Every field:

```json
{
  "schema_version": 1,
  "kind": "expert_template",
  "id": "exec-assistant",
  "version": "1.2.0",
  "role": {
    "name": "Executive Assistant",
    "persona": "A calm, precise assistant.",
    "instructions": "Triage the inbox every morning and draft replies for review.",
    "duty": "Inbox triage.\nScheduling.",
    "boundary": "No payments."
  },
  "first_guide": "Tell me which mailbox to start with.",
  "skills": [
    {"skill_id": "0190b7c4-0000-7000-8000-000000000001", "skill_version_id": "0190b7c4-0000-7000-8000-000000000002",
     "package_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
  ],
  "connectors": [{"app": "gmail", "purpose": "Read the inbox", "required": true}],
  "triggers": [
    {"key": "morning_digest", "title": "Morning digest", "prompt": "Summarise new mail.",
     "schedule": {"cron": "0 8 * * 1-5", "timezone": "Asia/Singapore"}}
  ],
  "sop": [{"key": "triage", "title": "Triage", "steps": ["Read new mail.", "Label it."]}],
  "knowledge": [{"key": "faq", "title": "FAQ", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "size": 12}],
  "customizable_fields": [
    {"key": "lang", "label": "Language", "type": "enum", "required": true, "options": ["en", "zh"], "default": "en"},
    {"key": "signature", "label": "Signature", "type": "text", "required": false, "max_len": 50},
    {"key": "notes", "label": "Notes", "type": "long_text", "required": false},
    {"key": "api_token", "label": "API token", "type": "text", "required": false, "sensitive": true},
    {"key": "digest_size", "label": "Digest size", "type": "integer", "required": false, "default": 10},
    {"key": "cc_me", "label": "CC me", "type": "boolean", "required": false, "default": true},
    {"key": "zone", "label": "Time zone", "type": "timezone", "required": false, "default": "Asia/Singapore"},
    {"key": "approver", "label": "Approver", "type": "member", "required": true, "include_agents": false}
  ],
  "starter_tasks": [{"title": "Triage today", "prompt": "Triage today's inbox."}],
  "card": {
    "summary": "Keeps your inbox under control.",
    "capabilities": ["Triage mail"],
    "limitations": ["No calls"],
    "guardrails": ["Drafts only"],
    "tags": ["office", "mail"]
  }
}
```

The market's `templates:validate` for Agents also needs the cws-core route for
Agent clients; until it is there, `--dry-run` warns and exits 5 after the local check.

`submit-skill` does not keep file modes: installs write every file 0600 and
never execute package content, so a skill runs its scripts through an
interpreter (`bash scripts/run.sh`).

Refusals exit 3 with a message the Agent can relay: name already taken (the
Agent creates only new skills and templates), no active owner, client too
old, rate limits (with the wait from `Retry-After`), validation and scan
results with the file, line or JSON pointer. Text the market echoes back
(`detail`, a matched sentence) is quoted as market data, not instructions.
Network and server errors are
retried twice (all these calls are replay-safe) and then exit 1.

### Status messages

- `suspended`: this Agent's membership in that org is suspended. Its orders
  are not pulled; for the primary org nothing is pulled at all. Retried hourly
  and resumed automatically.
- `invalid`: the Agent has left that org. Ask the org admin to re-add it, or
  change the primary org. Installed content is left as it is.
- `client version: TOO OLD`: the market requires a newer client (or its skill
  policy differs from the pinned one). New orders are not executed; revocations
  and reconcile continue. Run `zylos upgrade om-marketplace-client`.
- `revocations ... STALE`: no successful revocation pull for over 24 hours.
- Alerts stay listed until the condition clears.

## Local skill report

The client tells the market which skills this Agent has that the market did not
install, so the owner sees them under "My skills". It reports **metadata only**:

| Field | Value |
|---|---|
| `location_id` | The skill's directory name under the skills directory (one segment, never a path). |
| `name` | `name` from the SKILL.md frontmatter, if any (at most 64 characters). |
| `version` | `version` from the SKILL.md frontmatter as written, if any (at most 64 characters). |
| `source` | `zylos_component` (a skill installed as a zylos component), `git` (the directory has `.git`) or `local`. |

The request also carries the scan time and whether the list was cut. File
contents, the SKILL.md body and description, absolute paths, git remotes and
file hashes are never sent.

- Only first-level directories of `~/zylos/.claude/skills` that contain a
  SKILL.md are listed. `market--*` directories (market-managed), names starting
  with `.`, symbolic links and names outside `[A-Za-z0-9._-]` (up to 128
  characters) are skipped. Links are never followed and only the first 64 KiB
  of SKILL.md is read, for the frontmatter.
- A skill whose directory name, `name` or `version` looks like a credential
  (the market's credential rules) is left out.
- At most the first 1000 entries the skills directory lists are read, and at
  most 200 skills (and 64 KiB) are sent; beyond that the list is marked as
  truncated.
- It is sent to each configured org with that org's token and member id: once
  after start, then every 45 to 51 minutes. A list equal to the last one the
  org accepted is not sent again, except every 12 hours. A list the market
  refused is sent again only after 12 hours. One org failing does not
  affect the other orgs, pulling or reconcile.
- An Agent configured for several orgs has one skills directory, so every org
  receives the same list: the Agent's owner in one org can see the directory
  names of skills used for another org. This is accepted product behaviour.
- The market shows the list only; it is never used to decide visibility,
  installs or reconcile.

## Template activation

Template content reaches the Agent only through the `market-template-*`
session-start shards, so a template write, upgrade or uninstall takes effect
when a session next starts. The client does not wait for that to happen by
chance. It is always on; there is no setting to turn it off.

1. After the market accepted the write (or the uninstall that took a template
   out of its slot), the change is recorded as pending activation:
   `{pending_since, targets: [{adoption_id, rendered_sha256}], removed:
   [adoption_id]}`. There is one record per Agent; later changes merge into it,
   so changes close together share one session. The record survives restarts.
2. Every 30 seconds, apart from the 5-minute poll round, the client checks
   whether it may ask for a new session. All of these must hold: the runtime
   status file (`~/zylos/activity-monitor/agent-status.json`) was written less
   than 60 seconds ago and shows `state` idle, `health` ok (or no health
   field), `active_tools` 0 and `idle_seconds` at least 300, in two
   consecutive checks; no earlier request is still in the control queue; no OpenMax
   conversation has a turn that openmax's activity index (`runs/active.json`)
   still lists: an open run, or one closed by its reply while its turn lasts
   (10 minutes at most; a turn that ended is no longer listed). Without the
   openmax CLI, or with no activity index, no turn is seen and the runtime
   status alone decides (logged once); the last automatic request was 30
   minutes ago or more; fewer than 4 were made this UTC day. A missing or stale
   status file means no request. The 30-minute cooldown applies only after a
   request that brought a session: a retry after an unconfirmed request (step
   5) is exempt from the 30 minutes and the 4, so automatic requests are at
   most 4 a day plus up to 12 retries a day. Requests for a starter message (see
   [Starter message](#starter-message) below) follow their own rules and are
   counted apart: they neither use the 4 automatic requests nor wait for the
   30-minute cooldown, and automatic requests do not use theirs.
   A record holding a write the user ordered (every write order: a hire, an
   update or a switch; the market creates write orders only for these) takes
   the quick path in the same way, on a budget of its own: asked for as soon as
   the Agent has been idle 30 seconds with no open turn and no request of the
   record is in flight, at least 2 minutes apart (changes closer together share
   one request), at most 3 in any 60 minutes and 12 per UTC day. It neither
   waits for the 30-minute cooldown nor uses the 4 automatic requests. Past that
   budget the record falls back to the automatic rules above. A removal alone
   keeps the automatic rules.
3. The request goes to the zylos control queue: "Agent Market templates were
   updated and the market client has verified, from the injected template
   hashes, that the current session does not match them. Start a new session
   now with the new-session skill. Do not check whether one is needed.", held
   until the Agent is idle, without an ack suffix, with a 6-hour ack deadline
   (the control queue gives up a request not delivered by then; a delivered
   one is marked done at once). The Agent starts the session through its
   new-session skill. The client keeps the control id and follows it with
   `c4-control.js get`; while it is pending or running no other request is
   made, and one still pending when the change is confirmed is withdrawn
   (`ack`). A control id older than 24 hours is given up (acked, best effort)
   whatever its state. An enqueue that timed out counts as made. Requests are
   made one at a time.
4. At every session start the first shard writes `injected.json` in the data
   directory: `{at, items: [{adoption_id, rendered_sha256}]}`, the templates
   that session was given (`rendered_sha256` is the bundle sha256, the same
   value the client reports on the write result). Writing it never fails the
   shard. A session that started after the last change, requested or not
   (a restart, a context rollover), confirms the record when it lists every
   target with its sha256 and none of the removed adoptions. The client then
   reports `template_activated` for each target through the reconcile report,
   at once. A target missing from the session or listed with another sha256 is
   reported as `template_inject_missing` instead and not retried.
5. Only a session start shown in `injected.json` confirms a request; the
   Agent's own view of whether it has the template is never relied on. A
   request not followed by a session within 5 minutes of its delivery is made
   again (a retry) as soon as the Agent is idle as in step 2, without the
   30-minute cooldown and apart from the 4 automatic requests, at most 12
   retries per UTC day. A change merged while no session followed the last
   request (for example a hire right after a removal) gets the same retry.
   At most 3 requests per change. Then the alert
   `template_activation_stuck` is raised and starter messages held for the
   change are released at once (see [Starter message](#starter-message)); the
   record stays pending and a later session still confirms it. A record pending for 24 hours raises
   `template_activation_pending_24h`.
6. A rewrite of the bundle the current session already shows needs no session;
   it is reported as activated at once.
7. Templates adopted before 0.6.0 are seeded once at the first start of 0.6.0
   (their slots get the bundle sha256). They never cause a request; the next
   session that shows them confirms them.

Reports that must not wait for the periodic reconcile run (`template_activated`,
`template_inject_missing` from a session check, and `revoked_disabled` when a
revocation is applied) are queued in the client state and sent at once in a
reconcile request of their own. One that is not delivered is sent again first
by the next poll round, also after a restart; one the market answered
(`recorded` or `skipped`) or refused is dropped. When a market refuses a batch
with 400 without naming the item (for example a market that does not know an
item kind), the items are sent again one by one (at most 5 per flush; the
rest wait for the next), so only the refused one is lost. Items a 400 named
are dropped and the rest resent once. At most 200 items are queued (the oldest are dropped first), and an
item not delivered for 7 days is dropped. A report never carries both
`template_activated` and `template_inject_missing` for one adoption, and once
`template_inject_missing` was reported for an adoption, an activation of it
still waiting is dropped.

## Starter message

After the market accepted the first write of an adopted expert template whose
order carries `starter_message`, the client sends the recipient one welcome
message from this Agent's own OpenMax IM account. The recipient is the
order's `starter_recipient_member_id` (the Agent's owner, recorded by the
market when the expert was hired); a market that does not send it means the
adopter (`adopted_by_member_id`), as before. In the steps below, "the
recipient" is that member. The template text never
reaches the model. With openmax 2.32.0 or later it is sent as the welcome card
(see step 6); the web chat draws the card from the template, and the message
text is shown wherever the card is not.

The message should reach the adopter after the template is in the Agent's
session, so the starter tasks run against it:

- A new-session request still on its way (in the control queue, or delivered
  less than 5 minutes ago with no session started since) is joined: the
  message is held until the session has the template. So adoptions close
  together share one request. When that request brings no session, the
  session is asked for again as below.
- Otherwise, when the Agent has been idle for 30 seconds with no open OpenMax
  turn at that moment, the client asks for a new session at once (see
  [Template activation](#template-activation)) and holds the message the same
  way. These requests are not subject to the automatic 30-minute cooldown or
  the 4 automatic requests a day. They have their own budget: at least 2
  minutes between two, at most 12 per UTC day (loop protection).
- When the Agent is busy (runtime status not idle for 30 seconds, a tool
  running, health not ok, or an OpenMax turn open), or that budget does not
  allow a request (within 2 minutes of the last one, or 12 made today), the
  message is held until the session has the template. The 30-second check
  asks for the session on the starter budget as soon as the Agent has been
  idle 30 seconds and the 2 minutes have passed, or by the automatic rules once
  the 12 are used. This hold is ended by the confirmation, by the adoption no
  longer waiting (removed, revoked, reported as inject missing), by the
  change raising `template_activation_stuck`, or after 24 hours at the latest, and the message is then handled as below.
  An Agent that stays busy the whole time therefore gets the message up to 24
  hours late; it is then sent without a new session.
- When the runtime status file is missing or stale, or the OpenMax turn state
  cannot be read, no session can be asked for, so the message is handled at
  once, as before.

The hold is kept in the client state with the message job, so a restart
during it neither loses nor repeats the message. The claim always comes right
before the send, after any hold: the 8- and 9-minute limits below count from
the claim, and so does the market's 10-minute grace, so a hold of any length
never ends in `too_late` or `send_failed`. While the message is held it is not
claimed yet; the workbench shows the fallback card for an unclaimed message, as
it did during the earlier 3-minute hold, and stops showing it at the claim.
The message is still sent at most once (the claim, and the client message id
`mkt-starter-<adoption_id>`).

1. The client claims the message with the market (`:claim-starter`). Anything
   but `claimed` (`already_claimed`, `already_shown`, `disabled`,
   `adopter_inactive`) ends it; nothing is sent.
2. The template name, first guide and up to 3 starter tasks are filtered and
   rendered locally: links, markdown links and images, `www.` hosts, bare
   domains (full-width periods included), IP addresses are replaced by
   `[链接已移除]`; `@` becomes `＠`; zero-width, bidi and other control
   characters are removed; one-line fields lose their line breaks; lengths are
   cut (name 40, guide 2000, title 40, prompt 500). Without a first guide the
   message opens with the system line `已聘用「<name>」，生效后就能用`. Any
   author text (first guide, starter tasks or both) sits under one line
   `来自模板「<name>」的作者：`. A template with neither a guide nor starter
   tasks gets the system line only.
   Every line of author text starts with `｜ ` and author text is followed by
   the fixed line `（以上为模板作者提供的内容）`. The last line is the fixed
   platform safety notice (`SAFETY_NOTICE` in `src/starter/render.js`, Chinese
   and English on one line): client text, never taken from the template, not
   run through the credential rules, exactly once in every message.
3. If any field asks for a credential (the market's rule table; negation is
   not recognised, so warnings such as "never share your password" are refused
   too, and so is a copy of the safety notice), nothing is sent and the result
   is `rejected_content`. Authors leave reminders to the platform notice.
4. The client opens the DM with the recipient (`comm.create_dm`) and checks with
   `comm.get_conversation` and `comm.member_list` that it is a DM with exactly
   this Agent and the recipient; otherwise nothing is sent (`send_failed`).
   Each of these read-only calls is tried once more after a failure that is
   not a refusal (unreadable output, timeout, server error). Trace lines the
   openmax CLI prints to stdout (`[rpc] ...`, `[token] ...`, any `[name] `
   prefix) are skipped and the trailing JSON answer is read.
5. The send waits while a message into that DM would be taken as a run's
   reply: the client asks the openmax component's own activity store and run
   selection (`src/lib/activity/run-store.js`, `reply.js` `selectRun`, the code
   `comm.send` uses), so an open run, or a run closed by a reply within the
   last 10 minutes, holds the message back. It is checked every 30 seconds; 8
   minutes after the claim it is given up as `send_failed` with no send made.
   With openmax 2.32.0 or later (`OPENMAX_NORUN_MIN_VERSION`), whose `comm.send`
   takes `noRun`, the client skips the wait and sends with `noRun: true`.
   While waiting, the client keeps only ids, the `starter_content` and its
   sha256 (canonical JSON, recorded at the claim); never the rendered text or
   the recipient's name. When a confirmation to the adopter follows (step 8),
   the recipient's cleaned display name is kept in the job from the final
   render until the confirmation is sent, and is deleted with the job. Right before the send it checks the DM again and renders
   the message again through the whole pipeline (filter, size fit, credential
   check including the recipient's name, byte limit). A changed content hash, a
   changed DM or any failing step means no send and `send_failed`, and so does
   a check that ends 9 minutes or more after the claim (`too_late`), so no send
   can still run when the market's 10-minute grace ends.
6. One `comm.send`, no mentions. With openmax 2.32.0 or later
   (`OPENMAX_STRUCTURED_MIN_VERSION`) and `starter_message.structured` not
   `false`, the pre-built body is `type: AGENT_STRUCTURED` with the same text
   in `content.body.text`, `metadata: {market_starter_tasks: {schema:
   "market.starter-tasks.v1", adoption_id}}` and `fallback_text`, and the
   client message id is `mkt-starter-<adoption_id>`. The openmax CLI sends a
   pre-built body as given (since 2.18) without checking metadata or the
   fallback text, so the client refuses the reserved metadata keys and a
   fallback text over 8192 bytes itself. When that send is refused for
   certain (an HTTP 4xx other than 408 and 429, or the client's own refusal),
   the refusal is logged and the message is sent once more as plain text
   (`AGENT_TEXT`, id `mkt-starter-<adoption_id>-text`), if that can still
   start within the 9-minute deadline. Otherwise, and on an older or
   unreadable openmax version, it is sent as plain text (`AGENT_TEXT`, id
   `cmsg_<uuidv7>`) exactly as before 0.7.0. No other send is retried. A
   refused send is `send_failed`. A send whose outcome is unknown (timeout,
   server error, unreadable output, or a restart during the send) is never
   sent again. The client stores the send's client message id before the
   send and looks the message up in the DM (`comm.get_messages`, newest
   first, at most 5 pages, back to 5 minutes before the send). Found: the
   result is `sent`. Not found once the pages reach that time or the start of
   the DM, and the send started at least 60 seconds ago: `send_failed`
   (reason `send_lost`). The lookup is repeated every 30 seconds; when it still
   cannot tell 10 minutes after the send, the job is dropped unreported. The
   market takes the first mark whenever it comes, so a `sent` found after its
   10-minute grace still removes the fallback card shown meanwhile.
7. The result is recorded with `:mark-starter-shown`; only the mark is retried.
   A `send_failed` or `rejected_content` result is logged with a short reason
   code (`dm_check_<failure>` such as `dm_check_unreadable_output`,
   `dm_check_timeout` or `dm_check_http_<status>`; `dm_not_one_to_one`,
   `dm_changed`, `dm_busy`, `too_late`, `content_changed`,
   `content_unavailable`, `no_content`, `too_large`, `asks_for_credential`,
   `send_refused_http_<status>`, `send_lost`, `interrupted`, `internal_error`). The market
   takes only `result`, so the reason is not sent.
8. When the recipient is not the adopter (an org admin hired the expert on
   someone else's Agent) and the result is `sent`, the adopter gets one short
   plain-text confirmation in their own DM with this Agent, after the same DM
   check: `已为 {owner} 的 Agent 聘用「{expert}」` and, after a blank line,
   `Hired “{expert}” for {owner}'s Agent` (`renderHired` in
   `src/starter/render.js`; the owner's name is the cleaned name used in the
   greeting). It is sent as `AGENT_TEXT` with client message id
   `mkt-hired-<adoption_id>`, at most once: it waits like step 5 while the
   adopter's DM has a run (up to 8 minutes), and any failure, an unknown
   outcome or a restart during the send ends it without another try.

The content is the `starter_content` the market puts on the write order
(`{template_name, first_guide, starter_tasks}`). Without it, without the
openmax component, or when the message does not fit the IM limits, the message
is not claimed; the workbench shows the starter tasks as a card instead. A
message interrupted while sending is not sent again; it is looked up as above.

The workbench shows the card when the market has no result 10 minutes after the
claim, or the result is `send_failed`. So the adopter may see both the message
and the card when a send's outcome stayed unknown, or when the client stopped
between a successful send and recording the stage after it. A claim answer the
client cannot read (for example a new `result` value) ends the job without a
send; the card covers it.

Size limits (`src/starter/limits.js`, UTF-8 bytes): the message body at most
16384, any fallback text at most 8192; the IM service refuses a larger message
rather than cutting it. The fallback text of the welcome card is the whole
message when it fits 8192 bytes; otherwise its first guide is cut for that
size as described below (the tasks are kept), and if even that does not fit,
the message itself is cut at a character boundary and ends with the same
suffix. Both are checked before the claim, with room for the
longest adopter name. When the message is too large, the first guide is cut at
a character boundary and ends with `…（完整内容见 Agent 详情）`; when it still
does not fit, nothing is claimed. The message never carries the reserved
metadata keys `agent_run`, `cap_notice` and `context`.

The credential rules mirror the market's `internal/domain/credentialask.go`.
`test/fixtures/credential_requests.tsv` is the market's
`internal/domain/testdata/credential_requests.tsv` up to its `# private` line,
byte for byte; the rows after that line are kept in the market repository
only. Its sha256 and row counts are pinned in
`test/starter-credential.test.js`. To sync, copy that part of the file, update
the pins and the rules together, and run
`MARKET_REPO=<cws-marketplace clone> npm test` to compare with the market
directly and to run the private rows through the client rules. CI cannot reach the market repository, so run this before every
release. With `OPENMAX_DIR=<zylos-openmax checkout>` the run check is also
tested against the real openmax run selection.

Release checklist:
- `MARKET_REPO=<cws-marketplace clone> npm test` before every release.
- `OPENMAX_DIR=<zylos-openmax checkout at that version> node --test test/starter-im.test.js`
  against each new openmax version, since the run check loads openmax's own
  activity modules.

## Operational notes

- One container per data directory. A lock file under `state/` admits one
  process per data directory, but processes in different PID namespaces cannot
  see each other, so two containers that both run the client as PID 1 would
  each treat the other's lock as their own stale lock.
- Installing or upgrading a skill may cause the Agent to restart or to pick up
  the change only in its next session. A template write, upgrade or uninstall
  also takes effect at the next session start, but the client asks an idle
  Agent for that session itself; see [Template activation](#template-activation).
- Revoked versions are moved to `quarantine/` and never deleted; the revoked
  set is never cleared.

## Uninstall

`zylos uninstall om-marketplace-client` runs the pre-uninstall hook, which:

1. stops the service;
2. removes the four `market-template-*` shard declarations (only those whose
   JSON equals what this client declares) and runs the zylos hook sync. The
   sync may restart the Agent once; memory and context are kept. A sync that
   did not finish is redone by the next run of the hook;
3. waits for the state lock (15 seconds, then one SIGTERM to the holder only
   when its pid, start time and boot id match the lock, and up to 5 more
   seconds). If the lock cannot be taken, skills and templates are left in
   place and the hook ends here;
4. moves every market-managed skill and template into `quarantine/` in the
   data directory and clears the template slots;
5. reports `client_uninstalled` (which also clears the local skill list) to
   each configured org (at most 10 seconds).

Failures are logged and never block the uninstall. Keep the data directory (no
`--purge`) to keep the quarantined content and the revoked set.

## Upgrade

`zylos upgrade om-marketplace-client`

## Development

Requires Node.js 20 or newer; no runtime dependencies.

```sh
npm test
```

Tests set `OM_MARKETPLACE_CLIENT_HOME` to a temporary directory and never touch
the real home directory.
