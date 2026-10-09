// 한 회차: 화면에서 글자열을 찾아 (⌘ 여부) 클릭하고 전후 관측을 한 행(NDJSON)으로 남긴다.
// 사용: node click.mjs <회차 id> <찾을 글자열> <meta:true|false> [nth=0] [열 오프셋=0] [기록 파일]
import fs from 'node:fs'
import { ROOT, termRead, locate, clickCell, openLog, httpLog, cdpTargets, counters, installCounters, pause } from './lib.mjs'
const [id, text, metaArg, nthArg = '0', offArg = '0', out = `${ROOT}/clicks.ndjson`] = process.argv.slice(2)
const meta = metaArg === 'true'
await installCounters()
const term = await termRead()
const at = locate(term, text, Number(nthArg))
if (at === null) {
  const rec = { id, text, meta, error: 'not found', lines: term.lines.filter((l) => l.trim()) }
  fs.appendFileSync(out, `${JSON.stringify(rec)}\n`)
  console.log(JSON.stringify(rec).slice(0, 2000))
  process.exit(1)
}
const target = { row: at.row, col: at.col + Number(offArg) }
const t0 = Date.now()
const before = { log: openLog().length, http: httpLog().length, targets: await cdpTargets(), c: await counters() }
const click = await clickCell({ ...target, meta })
await pause(2500)
const logNew = openLog().slice(before.log)
const httpNew = httpLog().slice(before.http)
const after = { targets: await cdpTargets(), c: await counters() }
// 앱(pane)이 받은 입력 — 진단 실행의 onData 링(term-read inputs). SGR 마우스 리포트(ESC [ < b;x;y M/m)만 센다.
const termAfter = await termRead()
const inputsNew = (termAfter.inputs ?? []).filter((input) => input.at >= t0)
const sgr = inputsNew.flatMap((input) => [...input.data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map((m) => m[0].slice(1)))
const rec = {
  id, at: new Date().toISOString(), input: 'renderer-synthetic(eval: mousemove→mousedown/up on .xterm-screen)', text, meta, cell: target, click,
  mainLog: logNew.map((l) => JSON.parse(l)),
  httpHits: httpNew.map((l) => JSON.parse(l)),
  rendererOpenCallsNew: after.c.open.slice(before.c.open.length), confirmNew: after.c.confirm - before.c.confirm, l565: after.c.l565,
  cdpTargetsBefore: before.targets.length, cdpTargetsAfter: after.targets.length, targetsAfter: after.targets,
  rowText: term.lines[at.row],
  appInputSgr: sgr, appInputCount: inputsNew.length,
}
fs.appendFileSync(out, `${JSON.stringify(rec)}\n`)
console.log(JSON.stringify({ id, mainLog: rec.mainLog.map((m) => `${m.tag}:${m.url ?? JSON.stringify(m)}`), http: rec.httpHits.map((h) => h.url), rOpen: rec.rendererOpenCallsNew, confirm: rec.confirmNew, l565: rec.l565, targets: `${rec.cdpTargetsBefore}->${rec.cdpTargetsAfter}`, hover: click.hover, appSgr: sgr }))
