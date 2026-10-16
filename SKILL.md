---
name: om-marketplace-client
version: 0.1.0
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

# Read by hooks/post-install.js from the environment; not prompted by zylos so the
# API key is never collected through chat or written to ~/zylos/.env.
config:
  optional:
    - name: COCO_BFF_URL
      description: Workspace BFF base URL (https; http only for localhost). Required by post-install.
    - name: COCO_API_KEY
      description: This Agent's Workspace API key. Required by post-install.
      sensitive: true
    - name: COCO_ORG_ID
      description: Organization ID this Agent belongs to. Required by post-install.
    - name: COCO_MEMBER_ID
      description: This Agent's member ID in COCO_ORG_ID. Required by post-install.
    - name: COCO_IDENTITY_ID
      description: This Agent's identity ID.
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

`hooks/post-install.js` reads `COCO_BFF_URL`, `COCO_API_KEY`, `COCO_ORG_ID`,
`COCO_MEMBER_ID` (required) and `COCO_IDENTITY_ID` (optional) from the
environment and writes `config.json` (mode 0600). Without a TTY it never
prompts and exits with code 78 naming any missing variable. Unset the `COCO_*`
variables after install; the PM2 app filters them out and the service removes
any it inherits, logging only their names. At runtime the service reads only
`config.json`. Key rotation: rerun post-install with the complete variable set.
Post-install and post-upgrade declare the template session-start shards and run
the zylos hook sync only when their hooks are missing: the agent restarts once
when idle; memory and context are kept.

## Commands

`market-client status | sync | rollback <slug> | enable <slug> | disable <slug> | uninstall <slug>`.
The Agent never installs or upgrades on its own; those run only from workbench
orders. Enable, disable, uninstall and rollback change the skill locally, then
report it. While the service runs, commands are handed to it. Exit codes: 0 done,
1 failed, 2 usage, 3 refused, 4 service did not answer, 78 configuration error.
See README.md for config (`orgs` map, primary org, data dir), status messages and
uninstall behaviour.
