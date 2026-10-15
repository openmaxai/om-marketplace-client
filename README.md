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
4. Restart the Agent session once.
5. Check the service: `pm2 logs om-marketplace-client --lines 20`.

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
valid `config.json`.

## Upgrade

`zylos upgrade om-marketplace-client`

## Development

Requires Node.js 20 or newer; no runtime dependencies.

```sh
npm test
```

Tests set `OM_MARKETPLACE_CLIENT_HOME` to a temporary directory and never touch
the real home directory.
