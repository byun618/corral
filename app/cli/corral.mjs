#!/usr/bin/env node
import process from 'node:process'
import { runCli } from '../out/runtime/cli.mjs'
await runCli(process.argv.slice(2))
