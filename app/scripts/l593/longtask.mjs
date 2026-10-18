// LIFE-593 수정 r1 R1-C-10 — 큰 목록(20만 fixture)에서 렌더러 긴 작업(>100 ms — Chromium `longtask` 기준 50 ms 중 100 ms 초과만 센다)을 잰다.
//   ⓑ ⌘P: 터미널 포커스에서 ⌘P 를 누른 순간 → 목록 도착·색인 → 질의를 한 글자씩 → 마지막 키 입력 뒤 결과가 그려질 때까지. 첫 열기(캐시 없음)다.
//   ⓕ 이름 필터: 탐색기 트리 포커스에서 ⌥⌘F 를 누른 순간 → 목록 도착·필터 트리 → 한 글자씩 → 마지막 키 입력 뒤 걸러진 트리까지.
// 구간 안 긴 작업(>100 ms) 0 이어야 통과(종료 0). 입력은 제어 소켓(sendInputEvent) — CGEvent·클립보드 아님.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/longtask.mjs <ROOT=/tmp/l593g-*> <REPO=/tmp/l593f-200k> <OUT.json>
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, repo, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !/^\/tmp\/l593f-[^/]+$/.test(repo ?? '') || out === undefined) throw new Error('사용: longtask.mjs /tmp/l593g-* /tmp/l593f-* OUT.json')
const LIMIT_MS = 100
const QUERY = 'file_12_3'
const result = { at: new Date().toISOString(), repo, limitMs: LIMIT_MS, query: QUERY, method: 'PerformanceObserver longtask · sendInputEvent (control socket)', phases: {} }
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const startObserver = () =>
  q(`(() => { window.__l593lt?.disconnect(); window.__l593long = []; window.__l593lt = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__l593long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }) }); window.__l593lt.observe({ type: 'longtask' }); return performance.now() })()`)
const longIn = (from, to) => q(`(window.__l593long ?? []).filter((e) => e.start + e.ms >= ${from} && e.start <= ${to})`)
const typeSlow = async () => {
  const keyAt = []
  for (const char of QUERY) {
    keyAt.push(await q('performance.now()'))
    await ctl(root, { cmd: 'type', text: char })
    await sleep(150)
  }
  return keyAt
}
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root, { repo })
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
  const termFocused = () => q(`document.activeElement?.classList?.contains('xterm-helper-textarea') === true`)
  await until(async () => {
    if (await termFocused()) return true
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 })
    await sleep(150)
    return termFocused()
  }, { timeoutMs: 8_000, everyMs: 200, label: '터미널 포커스' })
  await giveBack()
  await sleep(1500)

  // ⓑ ⌘P — 첫 열기(목록 캐시 없음)
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  const openAt = await startObserver()
  await key('P', ['meta'])
  await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? true : null`), { timeoutMs: 20_000, label: '⌘P 준비' })
  const readyAt = await q('performance.now()')
  const keyAt = await typeSlow()
  await until(() => q(`(() => { const r = document.querySelector('[data-quick-open-row]')?.dataset.quickOpenRow ?? ''; return r.includes('file_12_3') ? true : null })()`), { timeoutMs: 10_000, label: '⌘P 결과' })
  const endAt = await q('performance.now()')
  await sleep(300)
  const total = await q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? null`)
  const longQuick = await longIn(openAt, endAt)
  result.phases.quickOpen = { openAt, readyMs: Math.round(readyAt - openAt), keys: keyAt.length, lastKeyMs: Math.round(keyAt.at(-1) - openAt), endMs: Math.round(endAt - openAt), total, longtasks: longQuick, over: longQuick.filter((e) => e.ms > LIMIT_MS) }
  console.log('# quickOpen', JSON.stringify(result.phases.quickOpen))
  await key('Escape')
  await sleep(500)

  // ⓕ 이름 필터
  const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { timeoutMs: 15_000, label: '탐색기 행' })
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: '[data-explorer-row="src"]' })
    await sleep(300)
    return q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
  }, { timeoutMs: 6_000, label: '트리 포커스' })
  await giveBack()
  await sleep(800)
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  const filterAt = await startObserver()
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 5_000, label: '필터 입력칸' })
  const filterKeys = await typeSlow()
  await until(() => q(`[...document.querySelectorAll('[data-explorer-row]')].some((e) => e.dataset.explorerRow.includes('file_12_3')) ? true : null`), { timeoutMs: 20_000, label: '걸러진 트리' })
  const filterEnd = await q('performance.now()')
  const longFilter = await longIn(filterAt, filterEnd)
  const status = await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? null`)
  result.phases.filter = { openAt: filterAt, keys: filterKeys.length, lastKeyMs: Math.round(filterKeys.at(-1) - filterAt), endMs: Math.round(filterEnd - filterAt), status, longtasks: longFilter, over: longFilter.filter((e) => e.ms > LIMIT_MS) }
  console.log('# filter', JSON.stringify(result.phases.filter))
  result.checks = { quickOpen: result.phases.quickOpen.over.length === 0, filter: result.phases.filter.over.length === 0 }
  exitCode = Object.values(result.checks).every(Boolean) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
}
process.exit(exitCode)
