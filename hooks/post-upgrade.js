#!/usr/bin/env node
// Keeps the template session-start shard declarations and hooks in place across upgrades.
import { installShards } from './lib/shards.js';

installShards();
process.exit(0);
