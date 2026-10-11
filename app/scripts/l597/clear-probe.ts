import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend } from '../../src/main/adapter/index.js'
const sock = `${process.env.HOME}/.config/herdr-dev/sessions/l577g-l597f-z1/herdr.sock`
const b = new TerminalBackend(sock)
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 8000 })
const epoch = await b.epoch(ctx())
const pane = (await b.list(epoch, ctx())).find((p) => p.paneId === 'w1:p1')!
const sess = async () => (await b.agentInfo(pane, ctx())).session?.value ?? null
const before = await sess()
await b.send(pane, '/clear', ctx()); await delay(500); await b.send(pane, '\r', ctx())
const t0 = Date.now()
const seen: { ms: number; changed: boolean }[] = []
for (let i = 0; i < 40; i += 1) { const s = await sess(); seen.push({ ms: Date.now() - t0, changed: s !== before }); if (s !== before) break; await delay(500) }
console.log(JSON.stringify({ beforeLen: before?.length ?? null, firstChangeMs: seen.find((x) => x.changed)?.ms ?? null, polls: seen.length }))
