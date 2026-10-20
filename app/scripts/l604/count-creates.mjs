#!/usr/bin/env node
// LIFE-604 R1-G ② — 격리 앱에서 출처 만들기 호출 수를 센다(C9 「연타 = 1회」). 격리 Electron 에서는 모의 출처의 `createCalls` 를 볼 수 없어
// main 로그(CORRAL_LOG = <ROOT>/ud/corral.ndjson)의 `work.request` 줄 중 `op: createItem` 만 센다 — service.request 가 출처 답을 받을 때마다 한 줄(성공·실패 모두).
//   node scripts/l604/count-creates.mjs <corral.ndjson> [--since <ISO 시각>]   → {"count":n,"lines":m,...} · exit 0 (읽기 실패 1)
//   node scripts/l604/count-creates.mjs --self-test                         → 양성 대조: 만들기 2줄 + 다른 줄이 섞인 임시 로그 = 2 여야 exit 0
// 주의: 로그 줄은 응답이 온 뒤에 쓰인다 — 확정 전(late) 회차는 아직 안 센다. 「1회」 판정은 확정 뒤에 센다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function countCreates({ text, since = null }) {
  let count = 0
  let lines = 0
  let parsed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    let row = null
    try { row = JSON.parse(line) } catch { continue }
    parsed += 1
    if (row?.tag !== 'work.request' || row.op !== 'createItem') continue
    if (since !== null && typeof row.ts === 'string' && row.ts < since) continue
    count += 1
  }
  return { count, lines, parsed }
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l604-count-'))
  const file = path.join(dir, 'corral.ndjson')
  const rows = [
    { ts: '2026-10-16T00:00:00.000Z', tag: 'work.request', op: 'listItems', ok: true },
    { ts: '2026-10-16T00:00:01.000Z', tag: 'work.request', op: 'createItem', ok: true },
    { ts: '2026-10-16T00:00:02.000Z', tag: 'work.request', op: 'getCreateMeta', ok: true },
    { ts: '2026-10-16T00:00:03.000Z', tag: 'work.request', op: 'createItem', ok: false, errorKind: 'rejected' },
  ]
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\nnot json\n')
  const all = countCreates({ text: fs.readFileSync(file, 'utf8') })
  const since = countCreates({ text: fs.readFileSync(file, 'utf8'), since: '2026-10-16T00:00:02.000Z' })
  fs.rmSync(dir, { recursive: true })
  const pass = all.count === 2 && since.count === 1 && all.lines === 5
  console.log(JSON.stringify({ selfTest: pass ? 'pass' : 'fail', all, since }))
  return pass ? 0 : 1
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') process.exit(selfTest())
const file = args[0]
if (file === undefined) { console.error('쓰기: count-creates.mjs <corral.ndjson> [--since <ISO>] | --self-test'); process.exit(2) }
const sinceAt = args.indexOf('--since')
let text
try { text = fs.readFileSync(file, 'utf8') } catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); process.exit(1) }
console.log(JSON.stringify({ ok: true, file, ...countCreates({ text, since: sinceAt === -1 ? null : args[sinceAt + 1] ?? null }) }))
