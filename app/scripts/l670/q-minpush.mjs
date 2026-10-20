#!/usr/bin/env node
// LIFE-670 수정 1(r1 M1) — 최소 밀기 폭 넘침 검사. 밀기 임계 바로 위(main = 560 + --w-tasks-body-min)에서 네 보기·필터 줄이 패널 밑으로 잘리지 않는가.
// app/ 에서(먼저 `npm run build`):  node scripts/l670/q-minpush.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
//
// - 앱 사본 = fixture-app.sh(보드 칸 7 · 질의 `jql:` 에 긴 검색 안내). 창이 가려지면 rAF·ResizeObserver 가 멈춰 측정이 무효라
//   `--disable-backgrounding-occluded-windows` 로 띄운다(리뷰 r1 환경 주의).
// - 창 폭은 main 실측으로 맞춘다: 1241 로 연 뒤 main 이 960 이 되게 고쳐 다시 연다. 상세는 보드 카드 CORE-2 로 연 채 보기를 바꾼다.
// - 판정(보기마다, 코디 답 A): .tasks-body.right <= aside.left · 그릇 밖 요소 scrollWidth <= clientWidth 이고 자손 right <= aside.left · 그릇 안 요소는 넘치면 그릇 스크롤 끝에서 자손 right <= aside.left.
//   보드는 칸이 가로 스크롤 그릇(.tasks-scroll) 안에 있는 것이 설계라 그릇만 본다(그릇 right <= aside.left) — 칸 머리·카드는 그릇 안에서 잘린다.
// - 필터 줄은 두 번: 기본 칩 4 · 「이번 주 마감」 칩(리스트 프리셋 week) + 검색 안내(검색어 `jql:x`)를 켠 상태.
// - 그릇 안 행 넘침의 대조: 패널을 닫고 창을 패널 폭만큼 줄여 같은 body 폭에서 같은 행의 scroll/client 폭이 같은지(작업 전과 같은 동작).
// - 전체 스페이스 모드(행에 스페이스 열)도 보드·백로그·리스트를 같은 기준으로 잰다.
// 실제 LA·사용자 키체인·설치본 무접촉. 종료 코드: 0 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, SHOT_DIR, BODY_ARG] = process.argv.slice(2)
// 넷째 인자 = 맞출 body 폭(기본 = --w-tasks-body-min). 수정 2 대조 회차는 480.
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-minpush.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더> [body 폭]')
  process.exit(2)
}
const FIXTURE = `${ROOT}-app`
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const sh = (args, env = {}) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${args.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
  if (run.status !== 0) throw new Error(`${args[0]} 실패`)
}
const js = (code) => evalJs(ROOT, code)
const click = async (selector) => {
  let last = null
  await until(async () => { last = await ctl(ROOT, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 15_000, everyMs: 250, label: selector }).catch(() => null)
  if (!last?.ok) throw new Error(`클릭 실패 ${selector} ${JSON.stringify(last)}`)
}
const shot = async (name) => {
  const result = await ctl(ROOT, { cmd: 'shot', name })
  if (!result.file) { log('shot 실패', result); return }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const target = path.join(SHOT_DIR, `${name}.png`)
  fs.copyFileSync(result.file, target)
  log('copied', { target: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
}
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const mainWidth = () => js(`Math.round(document.querySelector('.tasks-main').getBoundingClientRect().width * 100) / 100`)

// 넘침 측정 — 대상 선택자마다 scroll/client 폭과 보이는 자손의 최대 right. `scroller` 는 그릇 자체(자손 안 봄).
// 판정(코디 답 A, 2026-10-20): 그릇 밖 요소 = scrollWidth <= clientWidth 이고 자손 right <= aside.left(패널 밑 넘침 0).
// 그릇(가장 가까운 overflow-x auto 조상 — .tasks-scroll · .tasks-list-scroll · 백로그 구획) 안 요소의 min-content 넘침은 허용하되 그 그릇을 가로 스크롤 끝으로 보낸 상태에서 자손 right <= aside.left(끝까지 닿음).
// 3회차는 .tasks-backlog min-width:min-content 로 통과했지만 긴 제목까지 min-content 로 잡혀 백로그 전체가 넓어졌다(행 506·전체 624) — 구획 overflow-x:auto 로 바꿨다.
const measure = (targets) => js(`(() => {
  const aside = document.querySelector('[data-issue-detail]')
  const asideLeft = aside ? Math.round(aside.getBoundingClientRect().left) : null
  const limit = asideLeft ?? Math.round(document.querySelector('.tasks-body').getBoundingClientRect().right)
  const body = document.querySelector('.tasks-body').getBoundingClientRect()
  const extent = (el) => {
    let maxRight = Math.round(el.getBoundingClientRect().right); let worst = null
    for (const child of el.querySelectorAll('*')) {
      const c = child.getBoundingClientRect()
      if (c.width === 0 || c.height === 0) continue
      if (c.right > maxRight) { maxRight = Math.round(c.right); worst = (child.className || child.tagName).toString().slice(0, 40) + ':' + (child.textContent || '').trim().slice(0, 20) }
    }
    return { maxRight, worst }
  }
  const out = []
  for (const { selector, scroller } of ${JSON.stringify(targets)}) {
    for (const el of [...document.querySelectorAll(selector)].slice(0, 12)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const key = el.getAttribute('data-issue-row') ?? el.getAttribute('data-issue-card') ?? null
      if (scroller) { out.push({ selector, key, scroller: true, scrollW: el.scrollWidth, clientW: el.clientWidth, right: Math.round(r.right), ok: Math.round(r.right) <= limit }); continue }
      const fits = el.scrollWidth <= el.clientWidth
      const { maxRight, worst } = extent(el)
      // 가장 가까운 가로 스크롤 조상(overflow-x auto/scroll) — 백로그는 구획, 리스트는 .tasks-list-scroll, 그 밖은 .tasks-scroll.
      let box = el.parentElement
      while (box !== null && !['auto', 'scroll'].includes(getComputedStyle(box).overflowX)) box = box.parentElement
      let reach = null
      if (box !== null && (!fits || maxRight > limit)) {
        const saved = box.scrollLeft
        box.scrollLeft = box.scrollWidth
        reach = { scrollLeft: box.scrollLeft, scrollMax: box.scrollWidth - box.clientWidth, maxRight: extent(el).maxRight }
        box.scrollLeft = saved
      }
      const ok = box === null ? fits && maxRight <= limit : (fits && maxRight <= limit) || (reach !== null && reach.maxRight <= limit)
      out.push({ selector, key, inScroller: box !== null, scrollW: el.scrollWidth, clientW: el.clientWidth, right: Math.round(r.right), maxRight, worst, reach, ok })
    }
  }
  return { asideLeft, limit, body: { left: Math.round(body.left), right: Math.round(body.right), width: Math.round(body.width) },
    placement: document.querySelector('.tasks-main')?.dataset.detailLayout ?? null, items: out }
})()`)

// 가독성(수정 2, r2 M-A) — 보이는 행 제목 폭 >= --w-row-title-min · 필터 줄·리스트 툴바 칩이 한 줄(글자 단위 줄바꿈 0, 높이 <= 가장 흔한 칩 높이).
// 줄 수 = 칩 안 텍스트 노드마다 Range client rect 윗변 묶음 수의 최댓값(글자 단위 줄바꿈이면 2 이상).
const readability = () => js(`(() => {
  const min = parseFloat(getComputedStyle(document.querySelector('.tasks-main')).getPropertyValue('--w-row-title-min'))
  const titles = [...document.querySelectorAll('.tasks-body .tasks-row-title')].filter((t) => t.getBoundingClientRect().height > 0)
    .map((t) => ({ key: t.closest('[data-issue-row]')?.getAttribute('data-issue-row') ?? null, width: Math.round(t.getBoundingClientRect().width) }))
  // 텍스트 노드마다 줄 수(윗변이 6px 넘게 다른 rect = 다른 줄)의 최댓값. select·option 글자는 뺀다(닫힌 목록의 option rect 가 엉뚱한 윗변을 준다 — 6회차 오판).
  const lines = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let most = 0
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest('select, option') || node.textContent.trim().length === 0) continue
      const range = document.createRange(); range.selectNodeContents(node)
      const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.top).sort((a, b) => a - b)
      let count = tops.length === 0 ? 0 : 1
      for (let i = 1; i < tops.length; i += 1) if (tops[i] - tops[i - 1] > 6) count += 1
      most = Math.max(most, count)
    }
    return most
  }
  const chips = [...document.querySelectorAll('.tasks-filters > *, .tasks-list-tools > *')]
    .filter((c) => !c.matches('.tasks-head-spacer, .tasks-list-sep') && c.getBoundingClientRect().width > 0)
    .map((c) => ({ text: (c.textContent || '').trim().slice(0, 16), height: Math.round(c.getBoundingClientRect().height), lines: lines(c) }))
  const counts = {}; for (const c of chips) counts[c.height] = (counts[c.height] ?? 0) + 1
  const base = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0)
  const narrowTitles = titles.filter((t) => t.width < min)
  const brokenChips = chips.filter((c) => c.lines > 1 || c.height > base)
  const rows = (sel) => { const tops = new Set([...document.querySelectorAll(sel + ' > *')].filter((c) => c.getBoundingClientRect().width > 0).map((c) => Math.round(c.getBoundingClientRect().top))); return tops.size }
  return { min, base, titles: titles.length, minTitle: titles.length === 0 ? null : Math.min(...titles.map((t) => t.width)), narrowTitles, chips: chips.length, brokenChips,
    filterRows: rows('.tasks-filters'), toolRows: document.querySelector('.tasks-list-tools') ? rows('.tasks-list-tools') : null }
})()`)
const judgeReadable = async (label) => {
  const r = await readability()
  log(`가독성 ${label}`, r)
  // r3 L-I — 토큰을 못 읽으면(NaN) 비교가 늘 거짓이라 통과해 버린다 · 백로그·리스트는 행이 그려져 있어야 한다.
  const needsRows = /backlog|list/.test(label) && !label.startsWith('filters')
  judge(`M-A 가독성 ${label} — 행 제목 ${r.titles}개 모두 >= ${r.min} · 칩 ${r.chips}개 한 줄`, Number.isFinite(r.min) && (!needsRows || r.titles > 0) && r.narrowTitles.length === 0 && r.brokenChips.length === 0 && r.chips > 0,
    JSON.stringify({ minTitle: r.minTitle, narrowTitles: r.narrowTitles, base: r.base, brokenChips: r.brokenChips, filterRows: r.filterRows, toolRows: r.toolRows }))
}

const VIEWS = {
  board: [{ selector: '[data-tasks-scroll="board"]', scroller: true }, { selector: '.tasks-filters' }],
  backlog: [{ selector: '[data-tasks-scroll="backlog"]', scroller: true }, { selector: '.tasks-backlog-head' }, { selector: '[data-tasks-scroll="backlog"] .tasks-row' }],
  list: [{ selector: '.tasks-list-scroll', scroller: true }, { selector: '.tasks-list-tools' }, { selector: '.tasks-list-scroll .tasks-row' }, { selector: '.tasks-list-group' }],
  working: [{ selector: '.tasks-body > *', scroller: true }, { selector: '.tasks-body .tasks-empty, .tasks-body .tasks-working-item' }],
}
const showView = async (view) => {
  await click(`[data-tasks-view-tab="${view}"]`)
  await until(() => js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view') === '${view}'`), { timeoutMs: 5_000, label: `보기 ${view}` })
  await sleep(300)
}
const rowShape = (m) => Object.fromEntries(m.items.filter((item) => item.key !== null).map((item) => [item.key, { scrollW: item.scrollW, clientW: item.clientW }]))
/** 보기 하나 측정·판정 — 밀기 상태여야 한다. */
const checkView = async ({ label, view }) => {
  await showView(view)
  const m = await measure(VIEWS[view])
  log(`측정 ${label}`, m)
  const bad = m.items.filter((item) => !item.ok)
  const scrolled = m.items.filter((item) => item.reach !== null && item.reach !== undefined).map((item) => ({ key: item.key, scrollW: item.scrollW, clientW: item.clientW, reach: item.reach }))
  judge(`M1 ${label} — 밀기 · body.right <= aside.left · 그릇 밖 넘침 0 · 그릇 안 넘침은 스크롤 끝 도달(대상 ${m.items.length}개)`,
    m.placement === 'push' && m.body.right <= m.asideLeft && m.items.length > 0 && bad.length === 0,
    JSON.stringify({ placement: m.placement, body: m.body, asideLeft: m.asideLeft, n: m.items.length, bad, scrolled }))
  await judgeReadable(label)
  await shot(`q-minpush-${label}`)
  return m
}

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-670 q-minpush ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l670/fixture-app.sh', FIXTURE])
  sh(['scripts/l670/up.sh', ROOT, 'L670_EXTRA_ARGS=--disable-backgrounding-occluded-windows'], { L670_APP_DIR: FIXTURE })
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l670_minpush', replaceId: null }).then((r) => ({ ok: r.ok }))`)
  judge('모의 연결 추가(가짜 토큰)', added?.ok === true, JSON.stringify(added))
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 카드 CORE-2' })
  // 양성 대조(환경 L670_UNDO_MA=1): 수정 2 의 눌림 방지 CSS 를 되돌린다 — 가독성 판정이 미달을 내야 한다(판별력 근거, 이 회차의 exit 1 은 기대값).
  if (process.env.L670_UNDO_MA === '1') {
    const undone = await js(`(() => { const st = document.createElement('style'); st.textContent = '.tasks-filters, .tasks-list-tools { flex-wrap: nowrap !important } .tasks-filters > *, .tasks-list-tools > * { flex-shrink: 1 !important; white-space: normal !important } .tasks-row-title { min-width: 0 !important; contain: none !important } .tasks-row > * { flex-shrink: 1 !important }'; document.head.append(st); return true })()`)
    log('양성 대조 — 수정 2 CSS 되돌림 주입', undone)
  }
  const tokens = await js(`(() => { const s = getComputedStyle(document.querySelector('.tasks-main')); return { panel: s.getPropertyValue('--w-issue-detail').trim(), min: s.getPropertyValue('--w-tasks-body-min').trim() } })()`)
  const target = Number.parseFloat(tokens.panel) + (BODY_ARG === undefined ? Number.parseFloat(tokens.min) : Number(BODY_ARG))
  log('토큰', { ...tokens, targetMain: target })
  // 창 폭 맞추기 — 1241 에서 main 을 재고 차이만큼 고친다(사이드바·경계선 실측).
  let windowWidth = 1241
  await ctl(ROOT, { cmd: 'resize-window', width: windowWidth, height: 800 })
  await sleep(400)
  const first = await mainWidth()
  windowWidth = Math.round(windowWidth + (target - first))
  await ctl(ROOT, { cmd: 'resize-window', width: windowWidth, height: 800 })
  await sleep(400)
  const fitted = await mainWidth()
  log('창 맞춤', { first, windowWidth, main: fitted, inner: await js('innerWidth') })
  judge('창 맞춤 — main = 패널 + body 폭', fitted === target, JSON.stringify({ windowWidth, main: fitted, target }))
  // rAF 살아 있음(창 가림 무효 판정) — 500ms 동안 프레임 수.
  const frames = await js(`new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve(n) }; requestAnimationFrame(tick) })`)
  judge('측정 유효 — rAF 가 돈다(창 가림 아님)', frames >= 10, String(frames))

  const openDetail = async () => {
    await showView('board')
    await click('[data-tasks-board] [data-issue-card="CORE-2"]')
    await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-2"]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
    await sleep(300)
  }
  await openDetail()
  const pushed = {}
  for (const view of ['board', 'backlog', 'list', 'working']) pushed[view] = await checkView({ label: view, view })

  // 대조 — 패널을 닫고 창을 줄여 body 를 같은 폭으로: 그릇 안 행 넘침이 작업 전과 같은 모양(행 자체 min-content)인가.
  await click('[data-issue-close]')
  await until(async () => (await js(`!document.querySelector('[data-issue-detail]')`)) === true, { timeoutMs: 5_000, label: '상세 닫기' })
  // 좁은 창에서는 사이드바 폭도 바뀐다 — body 폭을 재며 밀기 때 body 폭(pushed.list.body.width)에 맞춘다(2회차는 391 로 어긋났다).
  const bodyWidth = () => js(`Math.round(document.querySelector('.tasks-body').getBoundingClientRect().width)`)
  let narrow = windowWidth - Number.parseFloat(tokens.panel)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await ctl(ROOT, { cmd: 'resize-window', width: narrow, height: 800 })
    await sleep(500)
    const diff = pushed.list.body.width - (await bodyWidth())
    log('대조 폭 맞춤', { narrow, diff })
    if (diff === 0) break
    narrow += diff
  }
  for (const view of ['backlog', 'list']) {
    await showView(view)
    const m = await measure(VIEWS[view])
    log(`대조 패널 닫음 ${view}`, { windowWidth: narrow, ...m })
    const before = rowShape(pushed[view]); const after = rowShape(m)
    const keys = Object.keys(before)
    const same = keys.length > 0 && keys.every((key) => after[key] !== undefined && after[key].scrollW === before[key].scrollW && after[key].clientW === before[key].clientW)
    judge(`M1 대조 ${view} — 패널 닫은 같은 body 폭(${m.body.width})에서 행 scroll/client 폭이 밀기 때와 같다`, m.placement === 'none' && m.body.width === pushed[view].body.width && same, JSON.stringify({ body: m.body, pushed: before, closed: after }))
    await shot(`q-minpush-control-${view}`)
  }
  await ctl(ROOT, { cmd: 'resize-window', width: windowWidth, height: 800 })
  await sleep(500)

  // 전체 스페이스 모드 — 행에 스페이스 열이 붙는다(추정하지 않고 잰다).
  await click('[data-space-switch]')
  await click('[data-space-row="all"]')
  const switched = await until(() => js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-space') === 'all'`), { timeoutMs: 10_000, label: '전체 스페이스' }).then(() => true).catch(() => false)
  const spaceNow = await js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-space')`)
  judge('전체 스페이스 전환(r2 L-C — 실패면 all-* 회차가 단일 스페이스를 재는 것을 막는다)', switched && spaceNow === 'all', JSON.stringify({ switched, spaceNow }))
  if (!switched) throw new Error('전체 스페이스 전환 실패')
  await showView('board')
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card]')`), { timeoutMs: 15_000, label: '전체 보드 카드' })
  log('전체 보드 카드', await js(`[...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`))
  if ((await js(`!!document.querySelector('[data-issue-detail]')`)) !== true) {
    await click('[data-tasks-board] [data-issue-card]')
    await until(() => js(`!!document.querySelector('[data-issue-detail]')`), { timeoutMs: 10_000, label: '전체 모드 상세' })
    await sleep(300)
  }
  for (const view of ['board', 'backlog', 'list']) await checkView({ label: `all-${view}`, view })

  // 필터 줄 최악 — 리스트 프리셋 week(「이번 주 마감」 칩) + 검색 안내.
  await showView('list')
  await click('[data-tasks-preset="week"]')
  await until(() => js(`!!document.querySelector('[data-filter="due-week"]')`), { timeoutMs: 5_000, label: '이번 주 마감 칩' })
  await click('[data-tasks-search]')
  await ctl(ROOT, { cmd: 'type', text: 'jql:x' })
  const noted = await until(() => js(`!!document.querySelector('[data-search-note]')`), { timeoutMs: 10_000, label: '검색 안내' }).then(() => true).catch(() => false)
  await sleep(300)
  const f = await measure([{ selector: '.tasks-filters' }, { selector: '.tasks-list-tools' }])
  const note = await js(`(() => { const n = document.querySelector('[data-search-note]'); return n ? { text: n.textContent.slice(0, 40), width: Math.round(n.getBoundingClientRect().width), scrollW: n.scrollWidth } : null })()`)
  log('측정 filters-worst', { ...f, note, detailOpen: await js(`!!document.querySelector('[data-issue-detail]')`) })
  const fbad = f.items.filter((item) => !item.ok)
  judge('M1 필터 줄 최악(이번 주 마감 칩 + 검색 안내) — 밀기 · 넘침 0', noted && f.placement === 'push' && fbad.length === 0, JSON.stringify({ noted, note, bad: fbad, asideLeft: f.asideLeft, placement: f.placement }))
  await judgeReadable('filters-worst')
  await shot('q-minpush-filters-worst')

  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l670/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
