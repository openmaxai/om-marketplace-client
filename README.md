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

> Please run `zylos add om-marketplace-client`.

New Workspace-native Agents get the client during provisioning; no action is
needed for them.

### Steps

1. Make sure the `COCO_*` environment variables below are set for the shell
   that runs the install (Workspace-native Agents receive the same values as
   the openmax component).
2. Run `zylos add om-marketplace-client`.
3. The post-install hook writes
   `~/zylos/components/om-marketplace-client/config.json` (directory 0700,
   file 0600). If a required variable is missing it stops with a non-zero exit
   and names the missing variable. In an interactive terminal it asks for the
   missing values instead (the API key is not echoed). It then declares the
   four `market-template-*` session-start shards. Only while their hooks are
   missing from the runtime's hook file does it run the zylos hook sync; the
   agent restarts once when idle; memory and context are kept. Upgrades do the
   same.
4. Unset the `COCO_*` variables in that shell
   (`unset COCO_BFF_URL COCO_API_KEY COCO_ORG_ID COCO_MEMBER_ID COCO_IDENTITY_ID`).
   The PM2 app filters them out and the service removes any it still inherits,
   logging only their names.
5. Restart the Agent session once.
6. Check the service: `pm2 logs zylos-om-marketplace-client --lines 20`.

Configuration errors exit with code 78; PM2 does not restart the service on
that code. Fix the configuration, then `pm2 restart zylos-om-marketplace-client`.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `COCO_BFF_URL` | yes | Workspace BFF base URL. Must be `https://`; `http://` only for `localhost` / `127.0.0.1`. No path. |
| `COCO_API_KEY` | yes | This Agent's Workspace API key. Never printed. |
| `COCO_ORG_ID` | yes | Organization ID the Agent belongs to. |
| `COCO_MEMBER_ID` | yes | This Agent's member ID in that organization. |
| `COCO_IDENTITY_ID` | no | This Agent's identity ID. |

The running service reads only its own `config.json`, never these variables.
Re-running the post-install hook with no `COCO_*` variables keeps an existing
valid `config.json`. A partial set fails and leaves the file unchanged.

## Key rotation

Rerun `node ~/zylos/.claude/skills/om-marketplace-client/hooks/post-install.js`
with all required `COCO_*` variables set (including the new `COCO_API_KEY`); it
rewrites the whole `config.json`. Then unset the variables and run
`pm2 restart zylos-om-marketplace-client`.

If the data directory already exists it must be mode 0700; the hook refuses to
write into a directory that is accessible by group or other.

## Configuration file

`~/zylos/components/om-marketplace-client/config.json` (the data directory;
`OM_MARKETPLACE_CLIENT_HOME` overrides it). Besides the post-install fields:

| Field | Meaning |
|---|---|
| `org_id`, `member_id` | Primary org and this Agent's member id in it. Revocations are pulled through the primary org; state is kept per BFF origin, primary org and member id, so changing the primary org starts from empty state. |
| `orgs` | `{"<org_id>": {"member_id": "<id>"}}`: further orgs whose orders this Agent executes. `member_id` may be left out; it is then read from the org-scoped token. Orders from an org not listed are not executed and are reported as `org_not_configured`. Edit by hand, then restart the service; post-install keeps the map. |
| `log_level` | `debug`, `info` (default), `warn` or `error`. |
| `storage_emulator_origin` | Development only; accepted only with a loopback `bff_url`. |

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
lets the current step finish and then exits 130.

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
5. reports `client_uninstalled` to each configured org (at most 10 seconds).

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
