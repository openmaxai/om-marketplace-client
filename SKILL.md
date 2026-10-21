---
name: om-marketplace-client
version: 0.1.1
description: >-
  Agent Market client. Pulls install intents placed by humans in the Agent Market
  workbench, installs approved skills and expert templates into this Agent after
  sha256 verification, and reports results and reconciliation back to the market.
  The Agent never decides on its own what to install.
  Config at ~/zylos/components/om-marketplace-client/config.json.
  Service: pm2 zylos-om-marketplace-client.
type: capability

lifecycle:
  npm: false
  service:
    type: pm2
    name: zylos-om-marketplace-client
    entry: src/main.js
  data_dir: ~/zylos/components/om-marketplace-client
  hooks:
    post-install: hooks/post-install.js
    post-upgrade: hooks/post-upgrade.js
    configure: hooks/configure.js
    pre-uninstall: hooks/pre-uninstall.js
  preserve:
    - config.json
    - logs/

bin:
  market-client: src/cli.js

upgrade:
  repo: github:openmaxai/om-marketplace-client
  branch: main

# Read by hooks/post-install.js from the environment, falling back per field to the openmax component config;
# not prompted by zylos so the API key is never collected through chat or written to ~/zylos/.env.
config:
  optional:
    - name: COCO_BFF_URL
      description: Workspace BFF base URL (https; http only for localhost). Required unless the openmax component config provides it (server.bff_url).
    - name: COCO_API_KEY
      description: This Agent's Workspace API key. Required unless the openmax component config provides it (agent.api_key).
      sensitive: true
    - name: COCO_ORG_ID
      description: Primary organization ID. Required unless the openmax component config provides it (an enabled org).
    - name: COCO_MEMBER_ID
      description: This Agent's member ID in COCO_ORG_ID. Required unless the openmax component config provides it (that org's self.member_id).
    - name: COCO_IDENTITY_ID
      description: This Agent's identity ID (openmax agent.identity_id).
---

# om-marketplace-client

Client side of Agent Market for zylos Agents.

## How it works

- Runs as a PM2 service (`om-marketplace-client`).
- Talks only to the Workspace BFF (`bff_url`), authenticated with this Agent's
  own Workspace API key. There is no marketplace-specific key.
- Every request carries the `X-Market-Client-Version` header. If the market
  answers `CLIENT_VERSION_TOO_OLD`, the client stops executing new intents
  (reconciliation and revocation pulls continue) and the owner should run
  `zylos upgrade om-marketplace-client`.
- Poll loop (~5 min, ±20% jitter): install intents and revocations.
- Reconcile (every 45 to 51 min, inside the poll loop): compare local state with the market.
- Installs never execute package content; packages are verified by sha256
  before anything is written.

## Configuration

`zylos add om-marketplace-client` needs no settings on an Agent with the openmax
component. `hooks/post-install.js` takes `COCO_BFF_URL`, `COCO_API_KEY`,
`COCO_ORG_ID`, `COCO_MEMBER_ID` (required) and `COCO_IDENTITY_ID` (optional)
from the environment; each one not set is taken from the openmax component
config (`~/zylos/components/openmax/config.json`, or under `$ZYLOS_DIR`). Only
enabled orgs count: the primary is the one matching `COCO_ORG_ID`, else the
enabled org with the lowest id; the other enabled orgs go into the `orgs` map.
It writes `config.json` (mode 0600) and logs each field's source, never its
value. Without a TTY it never prompts; if a required value is in neither place
it exits with code 78, naming the missing variables and why the openmax
component config could not supply them. Unset any `COCO_*` variables after
install; the PM2 app filters them out and the service removes any it inherits,
logging only their names. At runtime the service reads only `config.json`. Key
rotation: rerun post-install with the new `COCO_API_KEY`.
Post-install and post-upgrade declare the template session-start shards and run
the zylos hook sync only when their hooks are missing. On Claude the agent
restarts once when idle; memory and context are kept. On Codex the templates
take effect when the Codex session next starts. Until then a template write
raises an alert and waits at most 15 minutes, then is reported as failed
(`inject_unavailable`).
Each template shard prints a fixed priority line (organization rules > template
> the agent's own habits), the template's file path, the template's duty and
boundary (`role.json`, one line each; no boundary line when it is empty), then
`inject.md`. Duty, boundary and `inject.md` together stay within 2000 estimated
tokens, and a template whose whole section would not fit the zylos 2200-token
shard budget is refused at install.

## Commands

`market-client status | sync | rollback <slug> | enable <slug> | disable <slug> | uninstall <slug>`.
The Agent never installs or upgrades on its own; those run only from workbench
orders. Enable, disable, uninstall and rollback change the skill locally, then
report it. While the service runs, commands are handed to it. Exit codes: 0 done,
1 failed, 2 usage, 3 refused, 4 service did not answer, 78 configuration error.
See README.md for config (`orgs` map, primary org, data dir), status messages and
uninstall behaviour.
