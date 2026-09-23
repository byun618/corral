// LIFE-410 02-kickoff item 2 — the measurement that decides the sender-proof means.
//
// Question: does the shell herdr starts inside a pane carry an environment variable naming that
// pane, and is its value the same string corral's `list()` reports as `paneId`? If it is, a CLI
// call made from inside the pane can state which pane it came from and the runtime can compare it
// with the Dispatch target (means ⓐ). If it is not, the proof has to travel in the preamble as a
// per-Dispatch launch token (means ⓑ).
//
// Nothing is submitted to a provider here: the pane runs /bin/sh and is only asked to dump its own
// environment. The whole run lives under /tmp/l410-claude-*.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('sender-proof', { expectedChecks: 2 })
try {
  await f.startBackend()
  await f.serve()
  await f.registerRepo()

  const observed = await f.check('PROBE-the-pane-shell-names-its-own-pane', async () => {
    const pane = await f.pane('l410-probe')
    // The shell writes its own environment to a file in the fixture root. Reading the file rather
    // than the screen keeps the answer free of terminal rendering.
    const dump = path.join(f.root, 'pane-env.txt')
    await f.cli(['terminal', 'send', '--terminal', pane.handle, '--text', `env | sort > ${dump}`, '--enter'])
    await f.until(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('PATH='), 'pane env dump')
    const text = fs.readFileSync(dump, 'utf8')
    const entries = Object.fromEntries(text.split('\n').filter(line => /^HERDR/.test(line)).map(line => {
      const cut = line.indexOf('=')
      return [line.slice(0, cut), line.slice(cut + 1)]
    }))
    const listed = await f.cli(['terminal', 'list'])
    const row = listed.result.terminals.find(entry => entry.handle === pane.handle)
    assert.ok(row, 'the pane corral just created must appear in terminal list')
    const matches = Object.entries(entries).filter(([, value]) => value === row.paneId).map(([name]) => name)
    return { herdrEnv: entries, corralPaneId: row.paneId, corralPtyId: row.ptyId, corralEpoch: row.epoch,
      namesMatchingPaneId: matches, paneEnvNames: Object.keys(entries) }
  })

  await f.check('PROBE-record-the-means-this-supports', async () => {
    const usable = observed.namesMatchingPaneId.length > 0
    f.record('sender-proof-probe', { ...observed, meansAvailable: usable ? 'a-pane-env' : 'b-launch-token' })
    // Not an assertion about which answer is right — either answer decides the design. The check
    // exists so the run cannot exit 0 without having written the evidence down.
    assert.ok(fs.existsSync(path.join(f.raw, 'sender-proof-probe.json')))
    return { meansAvailable: usable ? 'a-pane-env' : 'b-launch-token', namesMatchingPaneId: observed.namesMatchingPaneId }
  })
} finally { await f.cleanup() }
