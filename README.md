# om-marketplace-client

Agent Market client for zylos Agents. It pulls install intents that a person
placed in the Agent Market workbench, installs the approved skills and expert
templates into this Agent after sha256 verification, and reports the result
back to the market.

> Status: scaffold. Configuration and the service skeleton are in place;
> install, download, and reconciliation logic is not implemented yet.

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
   missing values instead (the API key is not echoed).
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

## One instance per data directory

A lock file under `state/` admits one running client per data directory. Do not
share a data directory between containers: processes in different PID
namespaces cannot see each other, so two containers that both run the client
as PID 1 would each treat the other's lock as their own stale lock.

## Upgrade

`zylos upgrade om-marketplace-client`

## Development

Requires Node.js 20 or newer; no runtime dependencies.

```sh
npm test
```

Tests set `OM_MARKETPLACE_CLIENT_HOME` to a temporary directory and never touch
the real home directory.
