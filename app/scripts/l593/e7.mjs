// LIFE-593 최종 관문 E7ⓐⓑⓒⓕ — 큰 레포 반응성 수치(앱 실행 1회 = 첫 열기 표본 1). 격리 개발 Electron(iso.sh)에서 레포 하나를 열고:
//   ⓐ 터미널 포커스 ⌘P → 첫 결과 행이 그려질 때까지(첫 열기 1 표본) · 같은 실행 안 다시 열기(Esc → ⌘P) REOPEN 회
//   ⓑ 키 입력 → 결과 갱신 그림: 글자 하나를 보낸 시각(하네스 Date.now) → 대화상자 안 첫 DOM 변화 뒤 다음 rAF(렌더러 Date.now) — 같은 기계 시계
//   ⓒ (QO_TOGGLE 이 있으면) 「무시 파일 포함」 켬 클릭 → 읽는 중 표지(data-quick-open-loading) 가 사라질 때까지 TOGGLES 회(켬 전환마다 새 요청)
//   ⓕ (FILTER 가 있으면) 탐색기 이름 필터 키 입력 → 트리 첫 DOM 변화 뒤 다음 rAF
//   긴 작업: 첫 ⌘P 직전부터 끝까지 전 구간 PerformanceObserver longtask — >100 ms 개수(E7ⓑⓕ 「긴 작업 0 = 전 구간」).
// 입력은 제어 소켓(sendInputEvent) — CGEvent·클립보드 아님.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/e7.mjs <ROOT> <REPO> <OUT.json> <label>   환경: E7_QUERIES='a|b' · E7_FILTER='needle' · E7_TOGGLES=10 · E7_REOPEN=20
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr, pct } from './lib.mjs'

const [root, repo, out, label] = process.argv.slice(2)
const WORKTREE = path.resolve(process.cwd(), '..')
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !(/^\/tmp\/l593f-[^/]+(\/repo)?$/.test(repo ?? '') || repo === WORKTREE) || out === undefined) throw new Error('사용: e7.mjs /tmp/l593g-* <REPO=/tmp/l593f-* | 구현 worktree> OUT.json label')
const QUERIES = (process.env.E7_QUERIES ?? 'explorer-fs|main/index|CommandPalette').split('|')
const FILTER = process.env.E7_FILTER ?? ''
const TOGGLES = Number(process.env.E7_TOGGLES ?? '0')
const REOPEN = Number(process.env.E7_REOPEN ?? '20')
const LIMIT_MS = 100
const result = { at: new Date().toISOString(), label, repo, method: 'sendInputEvent(control socket) · 하네스 Date.now → 렌더러 MutationObserver + rAF Date.now · PerformanceObserver longtask', config: { QUERIES, FILTER, TOGGLES, REOPEN }, samples: {}, summary: {} }
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const stat = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length > 0 ? Math.max(...values) : null })
/** 렌더러 쪽 감시 — target 선택자 아래 첫 변화 뒤 rAF 시각을 window.__e7.done 에. */
const arm = (selector) => q(`(() => { window.__e7?.mo?.disconnect(); const s = { done: null }; const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; s.mo = new MutationObserver(() => { if (s.armed) return; s.armed = true; s.mo.disconnect(); requestAnimationFrame(() => { s.done = Date.now() }) }); s.mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-quick-open-total', 'data-quick-open-row', 'data-explorer-row', 'aria-expanded', 'data-quick-open-state'] }); window.__e7 = s; return true })()`)
const doneAt = () => until(() => q(`window.__e7?.done ?? null`), { timeoutMs: 3000, everyMs: 5, label: '그림' }).then((hit) => hit.value, () => null)
const typeTimed = async (selector, text) => {
  // 가로챈 keyDown(⌘P·⌘A 등) 뒤 첫 글자가 버려지는 하네스 문제 — Shift keyDown 을 먼저.
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  const out = []
  for (const ch of text) {
    // (G40 — '/' 뒤 글자가 모두 버려져 키 표본 19개를 놓쳤다. 글자마다 Shift keyDown 을 먼저 보낸다)
    await ctl(root, { cmd: 'key', keyCode: 'Shift' })
    await arm(selector)
    const t0 = Date.now()
    await ctl(root, { cmd: 'type', text: ch })
    const done = await doneAt()
    const seen = await q(`({ value: document.querySelector('[data-quick-open-input]')?.value ?? document.querySelector('[data-explorer-filter-input]')?.value ?? null, active: String(document.activeElement?.className ?? document.activeElement?.tagName ?? '').slice(0, 40), total: document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? null })`)
    out.push(done === null ? { ch, miss: true, seen } : { ch, ms: done - t0, seen })
    await sleep(120)
  }
  return out
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
  await until(async () => {
    if (await q(`document.activeElement?.classList?.contains('xterm-helper-textarea') === true`)) return true
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 })
    await sleep(150)
    return false
  }, { timeoutMs: 8000, everyMs: 200, label: '터미널 포커스' })
  await giveBack()
  await sleep(1500)
  // 긴 작업 감시 — 전 구간
  await q(`(() => { window.__e7lt?.disconnect(); window.__e7long = []; window.__e7lt = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__e7long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }) }); window.__e7lt.observe({ type: 'longtask' }); return true })()`)
  const firstRowSel = `document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' && document.querySelector('[data-quick-open-row]') !== null`
  const openTimed = async () => {
    await q(`(() => { window.__e7open = null; const mo = new MutationObserver(() => { if (window.__e7open === null && ${firstRowSel}) { mo.disconnect(); requestAnimationFrame(() => { window.__e7open = Date.now() }) } }); mo.observe(document.body, { subtree: true, childList: true, attributes: true }); window.__e7openMo = mo; return true })()`)
    await ctl(root, { cmd: 'key', keyCode: 'Shift' })
    const t0 = Date.now()
    await key('P', ['meta'])
    const at = await until(() => q(`window.__e7open`), { timeoutMs: 20_000, everyMs: 5, label: '⌘P 첫 결과' }).then((hit) => hit.value, () => null)
    return at === null ? null : at - t0
  }
  // ⓐ 첫 열기
  const first = await openTimed()
  result.samples.firstOpenMs = first
  const total = await q(`Number(document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? 0)`)
  result.listTotal = total
  // ⓑ 키 입력 → 결과 그림
  const keys = []
  for (const query of QUERIES) {
    keys.push(...(await typeTimed('[data-quick-open]', query)).map((s) => ({ query, ...s })))
    // (G40·G40b·G40c — ⌘A 가 입력칸 전체 선택을 하지 않아 앞 질의 뒤에 이어 쳐졌다(결과 0 → DOM 변화 없음 → 놓침). 질의 사이는 DOM setter 로 비운다 — 측정 밖)
    await q(`(() => { const el = document.querySelector('[data-quick-open-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(600)
  }
  result.samples.keys = keys
  // ⓒ 무시 파일 포함 켬 → 목록 준비. (G41~G45 — 클릭 직후 「읽는 중」 표지가 붙기 전에 준비로 읽은 표본(4~9 ms)이 섞였다. 렌더러 MutationObserver 로
  //   클릭 뒤 표지가 붙었다가 떨어진 시각을 잰다 — 붙는 것을 못 보면 놓침)
  const toggles = []
  for (let i = 0; i < TOGGLES * 2; i += 1) {
    await q(`(() => { window.__e7t?.mo?.disconnect(); const d = document.querySelector('[data-quick-open]'); const s = { saw: false, done: null }; s.mo = new MutationObserver(() => { const loading = d.hasAttribute('data-quick-open-loading'); if (loading) s.saw = true; else if (s.saw && s.done === null && d.dataset.quickOpenState === 'ready') { s.done = Date.now(); s.mo.disconnect() } }); s.mo.observe(d, { attributes: true, attributeFilter: ['data-quick-open-loading', 'data-quick-open-state'] }); window.__e7t = s; return true })()`)
    const t0 = Date.now()
    await ctl(root, { cmd: 'click', selector: '[data-quick-open-ignored]' })
    const state = await q(`document.querySelector('[data-quick-open-ignored]')?.dataset.quickOpenIgnored ?? null`)
    const done = await until(() => q(`window.__e7t?.done ?? null`), { timeoutMs: 20_000, everyMs: 5, label: '토글 목록' }).then((hit) => hit.value, () => null)
    const totalNow = await q(`Number(document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? 0)`)
    if (state === 'on') toggles.push(done === null ? { miss: true } : { ms: done - t0, total: totalNow })
    await sleep(300)
  }
  result.samples.toggleOnMs = toggles
  if (TOGGLES > 0) {
    // 켬 상태 목록에 node_modules·.git 이 없는지
    const real = fs.realpathSync(repo)
    const on = await q(`window.corral.fileList({ root: ${JSON.stringify(real)}, includeIgnored: true, requestId: 'e7-on' }).then((r) => r.ok ? { count: r.count, nm: r.paths.split('\\0').filter((p) => /(^|\\/)node_modules\\//.test(p)).length, git: r.paths.split('\\0').filter((p) => p.startsWith('.git/')).length } : r)`)
    result.ignoredList = on
  }
  await key('Escape')
  await sleep(500)
  // ⓐ 다시 열기
  const reopen = []
  for (let i = 0; i < REOPEN; i += 1) {
    const ms = await openTimed()
    reopen.push(ms)
    await key('Escape')
    await until(() => q(`!document.querySelector('[data-quick-open]')`), { timeoutMs: 3000, label: '닫힘' })
    await sleep(250)
  }
  result.samples.reopenMs = reopen
  // ⓕ 이름 필터 키 입력 → 트리 그림
  if (FILTER !== '') {
    if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
    await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { timeoutMs: 15_000, label: '탐색기 행' })
    await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-toggle]' })).ok === true, { label: '필터 단추' })
    await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 5000, label: '필터 입력칸' })
    // 목록이 올 때까지(첫 글자 전에 준비 — 키 → 트리 지연만 본다)
    await sleep(3000)
    const filterKeys = []
    for (let round = 0; round < 3; round += 1) {
      filterKeys.push(...(await typeTimed('.explorer-scroll', FILTER)).map((s) => ({ round, ...s })))
      await key('Escape')
      await sleep(600)
    }
    result.samples.filterKeys = filterKeys
  }
  const long = await q(`window.__e7long ?? []`)
  result.longtasks = long
  const ok = (arr) => arr.filter((s) => s !== null && s !== undefined && s.miss !== true)
  result.summary = {
    firstOpenMs: first,
    reopen: stat(reopen.filter((x) => x !== null)),
    keys: { ...stat(ok(keys).map((s) => s.ms)), misses: keys.filter((s) => s.miss).length },
    toggleOn: { ...stat(ok(toggles).map((s) => s.ms)), misses: toggles.filter((s) => s.miss).length },
    filterKeys: result.samples.filterKeys === undefined ? null : { ...stat(ok(result.samples.filterKeys).map((s) => s.ms)), misses: result.samples.filterKeys.filter((s) => s.miss).length },
    longOver100: long.filter((e) => e.ms > LIMIT_MS).length,
    longMax: long.length > 0 ? Math.max(...long.map((e) => e.ms)) : 0,
  }
  console.log(`# summary ${JSON.stringify(result.summary)}`)
  exitCode = first !== null ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
}
process.exit(exitCode)
