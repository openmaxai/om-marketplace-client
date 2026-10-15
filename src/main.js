#!/usr/bin/env node
import { main } from './app.js';

process.exitCode = await main();
