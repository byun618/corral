// 스모크 — 앱이 격리 세션에 붙어 pane 하나를 실제로 그리는지 본다. 판정 항목은 아니다.

import { startApp, tidySession, sleep, playFixture, rowText, writeRaw } from './lib.mjs'

const paneId = await tidySession()
console.log('pane', paneId)
await playFixture(paneId, '01-log.sh')

const app = await startApp({ name: 'smoke' })
await sleep(1000)
await app.selectPane(paneId)
await sleep(2500)

const state = await app.state()
console.log('terminal state', JSON.stringify(state.state.terminal))
const dump = await app.dump()
if (!dump.ok || !dump.dump.ok) {
  console.error('dump 실패', JSON.stringify(dump).slice(0, 400))
} else {
  const d = dump.dump
  console.log('grid', d.cols, 'x', d.rows, 'baseY', d.baseY, 'unicode', d.unicodeVersion)
  for (let y = 0; y < Math.min(12, d.rows); y++) console.log(String(y).padStart(2), JSON.stringify(rowText(d.grid[y], d.cols)))
}
const shot = await app.shot('smoke')
console.log('shot', JSON.stringify(shot))
writeRaw('00-smoke.json', { state: state.state.terminal, dump: dump.dump ? { cols: dump.dump.cols, rows: dump.dump.rows, baseY: dump.dump.baseY } : null })
await app.stop()
process.exit(0)
