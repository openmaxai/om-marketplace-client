# om-marketplace-client

Agent Market client for zylos Agents. It pulls install intents that a person
placed in the Agent Market workbench, installs the approved skills and expert
templates into this Agent after sha256 verification, and reports the result
back to the market.

Only a person decides what is installed or upgraded: install and upgrade run
only from orders placed in the workbench. Enable, disable, uninstall and
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
5. Restart the Agent session once.
6. Check the service: `pm2 logs zylos-om-marketplace-client --lines 20`.

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
| `starter_message` | `{"enabled": false}` stops this Agent from sending starter messages (default: enabled). Restart the service after changing it. |

## Commands

`market-client` (linked into `~/zylos/bin` on install):

| Command | Effect |
|---|---|
| `status [--json]` | Service state, each org's validity, client version gate, last pulls and reconcile, installed skills and templates, queue and outbox sizes, alerts. Reads files only. |
| `sync` | Runs one poll round now: revocations, orders and outbox resend. Reconcile runs in it only when due (every 45 minutes). |
| `rollback <slug>` | Swaps the version kept by the last upgrade back in (the replaced one is kept instead) and reports `local_rollback` through reconcile. Refused when the kept version is revoked, when the installed version is revoked and quarantined, or while an order or report for the skill is in flight. An interrupted rollback is completed at the next start. |
| `enable <slug>` / `disable <slug>` | Moves the skill into / out of the skills directory, then reports it. A skill disabled because of a revocation cannot be enabled. |
| `uninstall <slug>` | Removes the skill and its kept versions, then reports it. |

`<slug>` may also be the skill id. Exit codes: 0 done, 1 failed, 2 usage,
3 refused or not installed, 4 the running service did not answer within
`--wait <seconds>` (default 900), 78 configuration error. A report the market
could not take yet is kept and resent; the command still exits 0. Ctrl-C or
SIGTERM while a command runs in the CLI itself aborts pending network calls,
lets the current step finish and then exits 130. A second Ctrl-C exits at once
(130); the interrupted step is completed or undone at the next start.

Only one process works on a data directory at a time. When the service is
running, commands other than `status` are handed to it and run between poll
rounds; otherwise the command takes the lock and runs itself. A service
starting meanwhile waits for the lock.

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

## Starter message

After the market accepted the first write of an adopted expert template whose
order carries `starter_message`, the client sends the adopter one plain-text
welcome message from this Agent's own OpenMax IM account. The template text
never reaches the model.

1. The client claims the message with the market (`:claim-starter`). Anything
   but `claimed` (`already_claimed`, `already_shown`, `disabled`,
   `adopter_inactive`) ends it; nothing is sent.
2. The template name, first guide and up to 3 starter tasks are filtered and
   rendered locally: links, markdown links and images, `www.` hosts, bare
   domains (full-width periods included), IP addresses are replaced by
   `[链接已移除]`; `@` becomes `＠`; zero-width, bidi and other control
   characters are removed; one-line fields lose their line breaks; lengths are
   cut (name 40, guide 2000, title 40, prompt 500). Every line of author text
   starts with `｜ ` and the message ends with the fixed line
   `（以上为模板作者提供的内容）`. The line after the greeting is the fixed
   platform safety notice (`SAFETY_NOTICE` in `src/starter/render.js`, Chinese
   and English on one line): client text, never taken from the template, not
   run through the credential rules, exactly once in every message.
3. If any field asks for a credential (the market's rule table; negation is
   not recognised, so warnings such as "never share your password" are refused
   too, and so is a copy of the safety notice), nothing is sent and the result
   is `rejected_content`. Authors leave reminders to the platform notice.
4. The client opens the DM with the adopter (`comm.create_dm`) and checks with
   `comm.get_conversation` and `comm.member_list` that it is a DM with exactly
   this Agent and the adopter; otherwise nothing is sent (`send_failed`).
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
   the adopter's name. Right before the send it checks the DM again and renders
   the message again through the whole pipeline (filter, size fit, credential
   check including the adopter's name, byte limit). A changed content hash, a
   changed DM or any failing step means no send and `send_failed`, and so does
   a check that ends 9 minutes or more after the claim (`too_late`), so no send
   can still run when the market's 10-minute grace ends.
6. One `comm.send`, plain text, no mentions, never retried. A refused send is
   `send_failed`. A send whose outcome is unknown (timeout, server error) is
   not reported at all, so it is not counted as failed.
7. The result is recorded with `:mark-starter-shown`; only the mark is retried.
   A `send_failed` or `rejected_content` result is logged with a short reason
   code (`dm_check_<failure>` such as `dm_check_unreadable_output`,
   `dm_check_timeout` or `dm_check_http_<status>`; `dm_not_one_to_one`,
   `dm_changed`, `dm_busy`, `too_late`, `content_changed`,
   `content_unavailable`, `no_content`, `too_large`, `asks_for_credential`,
   `send_refused_http_<status>`, `interrupted`, `internal_error`). The market
   takes only `result`, so the reason is not sent.

The content is the `starter_content` the market puts on the write order
(`{template_name, first_guide, starter_tasks}`). Without it, without the
openmax component, or when the message does not fit the IM limits, the message
is not claimed; the workbench shows the starter tasks as a card instead. A
message interrupted while sending is not sent again.

The workbench shows the card when the market has no result 10 minutes after the
claim, or the result is `send_failed`. So the adopter may see both the message
and the card when a send's outcome was unknown, or when the client stopped
between a successful send and recording the stage after it. A claim answer the
client cannot read (for example a new `result` value) ends the job without a
send; the card covers it.

Size limits (`src/starter/limits.js`, UTF-8 bytes): the message body at most
16384, any fallback text at most 8192; the IM service refuses a larger message
rather than cutting it. Both are checked before the claim, with room for the
longest adopter name. When the message is too large, the first guide is cut at
a character boundary and ends with `…（完整内容见 Agent 详情）`; when it still
does not fit, nothing is claimed. The message never carries the reserved
metadata keys `agent_run` and `cap_notice`.

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
- Installing or upgrading a skill or template may cause the Agent to restart
  or to pick up the change only in its next session.
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
