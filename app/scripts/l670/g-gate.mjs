#!/usr/bin/env node
// LIFE-670 최종 관문(격리 회차) — 모의 출처·가짜 토큰·창 노출 플래그(--disable-backgrounding-occluded-windows). app/ 에서(먼저 `npm run build`):
//
//   node scripts/l670/g-gate.mjs <모드> <ROOT=/tmp/l670q-*> <OUT 파일> <샷 폴더> [추가]
//
// p1        네 보기(보드·백로그·리스트·작업 중) × 패널/전체/닫힘 rect · 캡처(보드 3장 + 나머지 보기 패널 1장씩) ·
//           열린 상세 복원(ui-prefs detail = 맨 오른쪽 칸 카드 CORE-5 → 같은 userData 로 재기동 → 자료 도착 뒤 카드 rect) · detailFull 복원
// p2        패널 연 채 ⓐ 다른 카드 클릭 → 상세 전환 ⓑ 맨 오른쪽 칸 카드 → 옆 칸 놓기 ⓒ 왼쪽 칸 카드 → 맨 오른쪽 칸에 놓기(자동 스크롤 도달 끌기)
// p3        선택 맞춤 — 밀기: 패널 밑 자리 카드(여백 >= 12 · 조상 스크롤 0) · 이미 보이는 카드(scrollLeft 불변) · 데이터 갱신 재렌더(불변)
//           덮기 폴백(창 1100): 중간 칸·맨 오른쪽 칸 카드 right <= aside.left
// p4        임계 경계 스윕 — main 960 전후(창 폭 실측 환산) 양방향 700ms · 경계 양쪽 20샘플(40ms)
// p5        자동 스크롤 판별력 — 끌지 않을 때 0 · 끝 닿기 전 띠 밖 정지(+400ms) · 띠 안 놓기 뒤 정지(+500ms·사본 0) · 도달 끌기(끝 → 맨 오른쪽 칸 놓기) · 세로(창 높이 400)
// baseline  [추가 = 앱 사본 폴더, 라벨] 창 760 · 패널 닫음 · 백로그/리스트 — 행 제목 폭·필터 줄 높이·캡처(기준 commit 대조 기록 — 판정 아님)
//
// 끌기는 원 마우스(raw-mouse). sendInputEvent 는 렌더러 입력 큐로 비동기라 eval 전에 잠깐 기다린다.
// 패널 밑(덮기·밀기 그릇 밖) 카드는 hit-test 로 누를 수 없어 카드 요소에 DOM click 을 보낸다(리뷰 프로브와 같은 방식) — 그렇게 고른 회차는 로그에 `domClick` 으로 적는다.
// 실제 LA·사용자 키체인·설치본 무접촉. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import fs from 'node:fs'
import path from 'node:path'
import { session, ctl, sleep, until } from './q-lib.mjs'

const MODES = ['p1', 'p2', 'p3', 'p4', 'p5', 'baseline']
const [MODE, ROOT, OUT, SHOT_DIR, EXTRA, LABEL] = process.argv.slice(2)
if (!MODES.includes(MODE) || !ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined || (MODE === 'baseline' && (EXTRA === undefined || LABEL === undefined))) {
  console.error(`사용법: node scripts/l670/g-gate.mjs <${MODES.join('|')}> /tmp/l670q-<n> <OUT 파일> <샷 폴더> [baseline: <앱 사본> <라벨>]`)
  process.exit(2)
}
const s = session({ root: ROOT, out: OUT, shotDir: SHOT_DIR })
const { js, log, judge, click, shot } = s
const TOKEN = 'mock_l670_gate_transition-any'

const layout = () => js(`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } }
  const main = document.querySelector('.tasks-main'); const aside = document.querySelector('[data-issue-detail]')
  return { view: document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view'), placement: main?.dataset.detailLayout ?? null, detail: aside?.getAttribute('data-issue-detail') ?? null,
    full: aside?.classList.contains('is-full') ?? null, main: r(main), body: r(document.querySelector('.tasks-body')), aside: r(aside) }
})()`)
const cardRect = (key) => js(`(() => { const c = document.querySelector('[data-tasks-board] [data-issue-card="${key}"]')?.getBoundingClientRect(); return c ? { left: Math.round(c.left), right: Math.round(c.right), top: Math.round(c.top), bottom: Math.round(c.bottom), x: Math.round(c.left + 24), y: Math.round(c.top + c.height / 2) } : null })()`)
const boardScroll = () => js(`(() => { const b = document.querySelector('[data-tasks-scroll="board"]'); const r = b.getBoundingClientRect(); return { left: b.scrollLeft, max: b.scrollWidth - b.clientWidth, rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } } })()`)
const ancestors = () => js(`[document.querySelector('.tasks-main'), document.querySelector('.tasks-page'), document.documentElement].map((e) => [e.scrollLeft, e.scrollTop])`)
const columns = () => js(`[...document.querySelectorAll('[data-tasks-board] [data-drop-zone^="col:"]')].map((z) => { const r = z.getBoundingClientRect(); return { zone: z.getAttribute('data-drop-zone'), left: Math.round(r.left), right: Math.round(r.right), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 30)), cards: [...z.querySelectorAll('[data-issue-card]')].map((c) => c.getAttribute('data-issue-card')) } })`)
const item = (connectionId, itemId) => js(`window.corral.workRequest({ requestId: 'g-${Date.now()}', connectionId: '${connectionId}', call: { op: 'getItem', itemId: '${itemId}' } }).then((r) => r.ok ? { status: r.result.item.statusKey, placement: r.result.item.placement, priority: r.result.item.priority } : r)`)
const mouse = (type, x, y) => ctl(ROOT, { cmd: 'raw-mouse', type, x, y })
const path8 = async (from, to, steps = 8) => { for (let i = 1; i <= steps; i += 1) { await mouse('mouseMove', Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps)); await sleep(40) } }
const resize = async (width, height = 800) => { await ctl(ROOT, { cmd: 'resize-window', width, height }); await sleep(600) }
const openCard = async (key) => {
  await click(`[data-tasks-board] [data-issue-card="${key}"]`)
  await until(() => js(`!!document.querySelector('[data-issue-detail="${key}"]')`), { timeoutMs: 10_000, label: `상세 ${key}` })
  await sleep(400)
}
const domSelect = async (key) => {
  await js(`(() => { document.querySelector('[data-tasks-board] [data-issue-card="${key}"]').click(); return true })()`)
  await until(() => js(`!!document.querySelector('[data-issue-detail="${key}"]')`), { timeoutMs: 10_000, label: `상세 ${key}` })
  await sleep(500)
  log('domClick', key)
}
const closeDetail = async () => {
  if (!(await js(`!!document.querySelector('[data-issue-detail]')`))) return
  await click('[data-issue-close]')
  await until(async () => (await js(`!document.querySelector('[data-issue-detail]')`)) === true, { timeoutMs: 5_000, label: '상세 닫기' })
  await sleep(300)
}
const setScroll = (left) => js(`(() => { const b = document.querySelector('[data-tasks-scroll="board"]'); b.scrollLeft = ${left}; return b.scrollLeft })()`)
const fixtureLog = () => { const p = path.join(`${ROOT}-app`, 'out/main/index.js'); return fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null }

/** 왼쪽 카드를 오른쪽 띠로 끌어 끝까지 자동 스크롤 → 대상 칸으로 옮겨 놓기. 대상 = 끝에서 보이는 칸 zone. */
async function reachDrag({ key, targetZone, connectionId, itemId }) {
  await setScroll(0)
  await sleep(200)
  const from = await cardRect(key)
  const sc = await boardScroll()
  const band = { x: sc.rect.right - 8, y: from.y }
  const before = await item(connectionId, itemId)
  await mouse('mouseDown', from.x, from.y)
  await path8(from, band)
  const t0 = Date.now()
  const reached = await until(async () => { const now = await boardScroll(); return now.left === now.max }, { timeoutMs: 15_000, everyMs: 50, label: '끝 닿음' }).then(() => true).catch(() => false)
  const ms = Date.now() - t0
  const cols = await columns()
  const target = cols.find((c) => c.zone === targetZone)
  const drop = target ? { x: Math.max(target.x, sc.rect.left + 60), y: target.y } : band
  await path8(band, drop, 4)
  await sleep(250)
  const over = await js(`document.querySelector('.tasks-column.is-over')?.getAttribute('data-board-column') ?? null`)
  await mouse('mouseUp', drop.x, drop.y)
  await sleep(800)
  const after = await item(connectionId, itemId)
  const end = await boardScroll()
  return { key, from, band, reached, ms, drop, over, before, after, end, target }
}

const modes = {
  async p1() {
    const connectionId = await s.boot({ token: TOKEN })
    await resize(1280)
    await openCard('CORE-2')
    const shots = { board: ['push', 'full', 'closed'], backlog: ['push'], list: ['push'], working: ['push'] }
    for (const view of ['board', 'backlog', 'list', 'working']) {
      await s.showView(view)
      if (!(await js(`!!document.querySelector('[data-issue-detail]')`))) { await s.showView('board'); await openCard('CORE-2'); await s.showView(view) }
      const push = await layout()
      judge(`P1 ${view} 패널 — body.right <= aside.left · body 폭 = main − 560`, push.placement === 'push' && push.body.right <= push.aside.left && push.body.width === push.main.width - 560, JSON.stringify(push))
      if (shots[view].includes('push')) await shot(`g-p1-${view}-push`)
      await click('[data-issue-full]')
      await until(() => js(`document.querySelector('[data-issue-detail]')?.classList.contains('is-full') === true`), { timeoutMs: 5_000, label: '전체' })
      await sleep(300)
      const full = await layout()
      judge(`P1 ${view} 전체 — aside.left == main.left · body 폭 = main`, full.placement === 'full' && full.aside.left === full.main.left && full.body.width === full.main.width, JSON.stringify(full))
      if (shots[view].includes('full')) await shot(`g-p1-${view}-full`)
      await click('[data-issue-full]')
      await until(() => js(`document.querySelector('[data-issue-detail]')?.classList.contains('is-full') === false`), { timeoutMs: 5_000, label: '패널로' })
      await closeDetail()
      const closed = await layout()
      judge(`P1 ${view} 닫힘 — 원복(body 폭 = main 폭)`, closed.placement === 'none' && closed.aside === null && closed.body.width === closed.main.width, JSON.stringify(closed))
      if (shots[view].includes('closed')) await shot(`g-p1-${view}-closed`)
      await s.showView('board'); await openCard('CORE-2')
    }
    // 열린 상세 복원 — 맨 오른쪽 칸(칸 없는 상태) CORE-5(m-6)
    await closeDetail()
    const prefsFile = path.join(ROOT, 'ud/ui-prefs.json')
    const edit = (patch) => { const text = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); text.tasksPage = { ...text.tasksPage, ...patch }; fs.writeFileSync(prefsFile, JSON.stringify(text)); log('ui-prefs', text.tasksPage) }
    s.sh(['scripts/l670/down.sh', ROOT])
    edit({ view: 'board', detailFull: false, detail: { connectionId, itemId: 'm-6' } })
    await s.relaunch()
    // 재기동 창은 기본 크기(1180)라 ⌘I(자료 받기) 전에 1280 으로 맞춘다 — 1회차는 이걸 빠뜨려 덮기 조건에서 쟀다(g-p1-1.txt).
    await resize(1280)
    await s.openPage()
    await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-5"]') && !!document.querySelector('[data-tasks-board] [data-issue-card="CORE-5"]')`), { timeoutMs: 15_000, label: '복원 상세·카드' })
    await sleep(800)
    const restored = { ...(await layout()), card: await cardRect('CORE-5'), scroll: await boardScroll() }
    log('복원 직후', restored)
    judge('P1 열린 상세 복원 — 맨 오른쪽 칸 카드 CORE-5 가 body 안(card.right <= aside.left · card.left >= body.left)', restored.placement === 'push' && restored.card !== null && restored.card.right <= restored.aside.left && restored.card.left >= restored.body.left, JSON.stringify(restored))
    await shot('g-p1-restore-detail')
    s.sh(['scripts/l670/down.sh', ROOT])
    edit({ detailFull: true, detail: { connectionId, itemId: 'm-2' } })
    await s.relaunch()
    await resize(1280)
    await s.openPage()
    await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-2"]')`), { timeoutMs: 15_000, label: '복원 상세 CORE-2' })
    await sleep(500)
    const full = await layout()
    judge('P1 detailFull 복원 — 재기동 뒤 전체 모드로 열림', full.placement === 'full' && full.full === true && full.aside.left === full.main.left, JSON.stringify(full))
    await shot('g-p1-restore-full')
  },

  async p2() {
    const connectionId = await s.boot({ token: TOKEN })
    await resize(1280)
    await openCard('CORE-2')
    await click('[data-tasks-board] [data-issue-card="CORE-1"]')
    const switched = await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-1"]')`), { timeoutMs: 10_000, label: '상세 CORE-1' }).then(() => true).catch(() => false)
    judge('P2ⓐ 패널 연 채 다른 카드(CORE-1) 클릭 → 상세 전환', switched && (await layout()).placement === 'push', JSON.stringify(await layout()))
    // ⓑ 맨 오른쪽 칸(칸 없는 상태) CORE-5 → 옆 칸(Done)
    const sc = await boardScroll()
    await setScroll(sc.max)
    await sleep(300)
    const cols = await columns()
    const last = cols.at(-1); const prev = cols.at(-2)
    const from = await cardRect(last.cards[0])
    const before = await item(connectionId, 'm-6')
    const drop = { x: Math.max(prev.x, (await boardScroll()).rect.left + 60), y: prev.y }
    await mouse('mouseDown', from.x, from.y); await path8(from, drop); await sleep(250)
    const over = await js(`document.querySelector('.tasks-column.is-over')?.getAttribute('data-board-column') ?? null`)
    await mouse('mouseUp', drop.x, drop.y); await sleep(800)
    const after = await item(connectionId, 'm-6')
    log('ⓑ', { last: last.zone, prev: prev.zone, card: last.cards[0], drop, over, before, after })
    judge('P2ⓑ 맨 오른쪽 칸 카드 CORE-5 → 옆 칸 Done 놓기 · 출처 값 변경', last.cards[0] === 'CORE-5' && before.status === 'core-legal' && after.status === 'core-done' && over === 'st:core-done', JSON.stringify({ before, after, over }))
    await shot('g-p2-b')
    // ⓒ 왼쪽 칸(To Do) 카드 CORE-6 → 맨 오른쪽 칸(이제 Done)에 — 자동 스크롤로 끝까지 끌어 놓는다.
    // 1회차는 CORE-4(In Review)를 골랐는데 스크롤 0 에서 그 카드는 패널 밑(x 836..)이라 mouseDown 이 패널에 떨어져 끌기가 시작되지 않았다(g-p2-1.txt).
    const now = await columns()
    const reach = await reachDrag({ key: 'CORE-6', targetZone: now.at(-1).zone, connectionId, itemId: 'm-7' })
    log('ⓒ', reach)
    judge('P2ⓒ 왼쪽 칸 카드 CORE-6 → 맨 오른쪽 칸(Done)에 놓기 · 출처 값 변경', now.at(-1).zone === 'col:st:core-done' && reach.reached && reach.from.right <= (await layout()).aside.left && reach.before.status === 'core-todo' && reach.after.status === 'core-done', JSON.stringify({ target: now.at(-1).zone, reached: reach.reached, before: reach.before, after: reach.after, over: reach.over }))
    await shot('g-p2-c')
  },

  async p3() {
    const connectionId = await s.boot({ token: TOKEN })
    await resize(1280)
    await openCard('CORE-2')
    await setScroll(0); await sleep(200)
    const pre = { card: await cardRect('CORE-4'), lay: await layout() }
    await domSelect('CORE-4')
    const post = { card: await cardRect('CORE-4'), lay: await layout(), scroll: await boardScroll(), anc: await ancestors() }
    log('밀기 · 패널 밑 자리 카드', { pre, post })
    judge('P3 밀기 — 패널 밑 자리 카드 CORE-4(선택 전 right > aside.left) → body 안 · 오른쪽 여백 >= 12', pre.card.right > pre.lay.aside.left && post.card.left >= post.lay.body.left && post.lay.body.right - post.card.right >= 12, JSON.stringify({ before: pre.card, after: post.card, body: post.lay.body, asideLeft: post.lay.aside.left }))
    judge('조상 스크롤 0 — scrollIntoView 뒤 .tasks-main · .tasks-page · documentElement', post.anc.every(([x, y]) => x === 0 && y === 0), JSON.stringify(post.anc))
    await shot('g-p3-push-under-panel')
    // 이미 보이는 카드
    const s0 = (await boardScroll()).left
    const visible = await cardRect('CORE-4')
    await click('[data-tasks-board] [data-issue-card="CORE-4"]') // 같은 카드 = 닫힘 → 다시
    await sleep(300)
    await click('[data-tasks-board] [data-issue-card="CORE-4"]')
    await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-4"]')`), { timeoutMs: 10_000, label: '상세 CORE-4 다시' })
    await sleep(400)
    const s1 = (await boardScroll()).left
    judge('P3 이미 보이는 카드 선택 → scrollLeft 불변', s1 === s0, JSON.stringify({ s0, s1, card: visible }))
    // 데이터 갱신 재렌더 — 사용자가 옮긴 스크롤에 끌려오지 않는다
    const moved = await setScroll(s0 + 300)
    await sleep(200)
    const beforeItem = await item(connectionId, 'm-4')
    await click('[data-issue-detail="CORE-4"] [data-field="priority"]')
    const target = beforeItem.priority === 'high' ? 'low' : 'high'
    await click(`[data-priority-row="${target}"]`)
    const saved = await until(async () => (await item(connectionId, 'm-4')).priority === target, { timeoutMs: 10_000, label: '우선순위 저장' }).then(() => true).catch(() => false)
    await sleep(800)
    const s2 = (await boardScroll()).left
    judge('P3 데이터 갱신(우선순위 저장 → 재렌더) 뒤 scrollLeft 불변', saved && s2 === moved, JSON.stringify({ moved, s2, saved, priority: [beforeItem.priority, target] }))
    // 덮기 폴백
    await closeDetail()
    await resize(1100)
    await setScroll(0); await sleep(200)
    const lay = await layout()
    const pre2 = await cardRect('CORE-4')
    await domSelect('CORE-4')
    const mid = { card: await cardRect('CORE-4'), lay: await layout() }
    log('덮기 · 중간 칸', { pre: pre2, ...mid })
    judge('P3 덮기 폴백(창 1100) — 중간 칸 카드 CORE-4 → right <= aside.left', mid.lay.placement === 'overlay' && mid.card.right <= mid.lay.aside.left, JSON.stringify({ before: pre2, after: mid.card, asideLeft: mid.lay.aside.left, mainBefore: lay.main }))
    await shot('g-p3-overlay-mid')
    await closeDetail(); await setScroll(0); await sleep(200)
    await domSelect('CORE-5')
    const end = { card: await cardRect('CORE-5'), lay: await layout(), scroll: await boardScroll() }
    judge('P3 덮기 폴백 — 맨 오른쪽 칸 카드 CORE-5 → right <= aside.left (r2 L-A)', end.lay.placement === 'overlay' && end.card.right <= end.lay.aside.left, JSON.stringify(end))
    await shot('g-p3-overlay-last')
  },

  async p4() {
    await s.boot({ token: TOKEN })
    await resize(1241)
    await openCard('CORE-2')
    const mainW = async () => js(`document.querySelector('.tasks-main').getBoundingClientRect().width`)
    const base = await mainW()
    const w960 = Math.round(1241 + (960 - base))
    await resize(w960)
    const check = await mainW()
    log('경계 창 폭', { base, w960, main: check })
    const samples = []
    const widths = [w960 - 3, w960 - 2, w960 - 1, w960, w960 + 1, w960 + 2, w960 + 3]
    for (const width of [...widths, ...[...widths].reverse()]) {
      await ctl(ROOT, { cmd: 'resize-window', width, height: 800 })
      await sleep(700)
      samples.push({ width, main: await mainW(), placement: (await layout()).placement })
    }
    log('스윕', samples)
    const consistent = samples.every((sample) => sample.placement === (sample.main >= 960 ? 'push' : 'overlay'))
    judge('P4 경계 스윕 — 오름·내림 모두 main >= 960 ⇔ push', consistent && samples.some((x) => x.placement === 'push') && samples.some((x) => x.placement === 'overlay'), JSON.stringify(samples))
    for (const [width, expect] of [[w960, 'push'], [w960 - 1, 'overlay']]) {
      await ctl(ROOT, { cmd: 'resize-window', width, height: 800 })
      await sleep(700)
      const got = []
      for (let i = 0; i < 20; i += 1) { got.push((await layout()).placement); await sleep(40) }
      judge(`P4 창 ${width}(main ${await mainW()}) 20샘플 떨림 0 — 모두 ${expect}`, got.every((value) => value === expect), JSON.stringify(got))
    }
  },

  async p5() {
    const connectionId = await s.boot({ token: TOKEN })
    await resize(1280)
    await openCard('CORE-2')
    await setScroll(0); await sleep(200)
    const sc = await boardScroll()
    const bandX = sc.rect.right - 8
    // 끌지 않을 때 — 띠 위 포인터 이동만
    for (const y of [300, 320, 340]) { await mouse('mouseMove', bandX, y); await sleep(60) }
    await sleep(300)
    const idle = (await boardScroll()).left
    judge('P5 끌지 않을 때 띠 위 포인터 이동 → 스크롤 0', idle === 0, String(idle))
    // 판별력 — CORE-6(To Do) 를 오른쪽 띠로
    const from = await cardRect('CORE-6')
    await mouse('mouseDown', from.x, from.y)
    await path8(from, { x: bandX, y: from.y })
    await sleep(150)
    const s1 = (await boardScroll()).left
    await mouse('mouseMove', Math.round((sc.rect.left + sc.rect.right) / 2), from.y)
    await sleep(100)
    const s2 = (await boardScroll()).left
    await sleep(400)
    const s3 = (await boardScroll()).left
    judge('P5 띠 밖으로 나가면 정지 — 끝 닿기 전(+400ms 불변)', s1 > 0 && s2 < sc.max && s3 === s2, JSON.stringify({ s1, s2, s3, max: sc.max }))
    await mouse('mouseMove', bandX, from.y)
    await until(async () => (await boardScroll()).left > s3 + 100, { timeoutMs: 5_000, everyMs: 30, label: '다시 밀림' }).catch(() => null)
    await mouse('mouseUp', bandX, from.y)
    await sleep(60)
    const s4 = (await boardScroll()).left
    await sleep(500)
    const s5 = (await boardScroll()).left
    const previews = await js(`document.querySelectorAll('.tasks-drag-preview').length`)
    judge('P5 띠 안에서 놓은 뒤 정지 — 끝 닿기 전(+500ms 불변) · 사본 0', s4 > s3 && s4 < sc.max && s5 === s4 && previews === 0, JSON.stringify({ s3, s4, s5, max: sc.max, previews }))
    log('첫 끌기 놓은 결과(띠 안 놓기 — 그 자리 칸)', await item(connectionId, 'm-7'))
    // 도달 끌기 — 먼저 칸 없는 상태 열을 비우지 않고, 끝에서 보이는 맨 오른쪽 「놓을 수 있는」 칸(Done)으로
    const cols = await columns()
    const target = [...cols].reverse().find((c) => c.zone !== 'col:st:__unmapped')
    const reach = await reachDrag({ key: 'CORE-2', targetZone: target.zone, connectionId, itemId: 'm-2' })
    log('도달 끌기', reach)
    judge(`P5 도달 끌기 — CORE-2(To Do) 를 오른쪽 띠로 끝까지(${reach.ms}ms) → ${target.zone} 놓기 1건`, reach.reached && reach.end.left === reach.end.max && reach.before.status === 'core-todo' && reach.after.status === 'core-done', JSON.stringify({ reached: reach.reached, ms: reach.ms, before: reach.before, after: reach.after, over: reach.over, end: reach.end }))
    await shot('g-p5-reach')
    // 세로 — 리스트 행은 끌기 손잡이가 없다(TasksViews: 리스트 IssueRow handle=null). 세로 그릇 끌기는 백로그 보기(.tasks-scroll)로 본다.
    await resize(1280, 400)
    await s.showView('backlog')
    // 보드에서 끝까지 민 가로 스크롤이 백로그 그릇에 남아 손잡이가 그릇 밖이었다(g-p5-2 진단 grip.x 148 < 281) — 가로를 0 으로 두고 시작한다.
    log('백로그 진입 때 가로 스크롤(보드에서 이월)', await js(`(() => { const b = document.querySelector('[data-tasks-scroll="backlog"]'); const was = b.scrollLeft; b.scrollLeft = 0; return was })()`))
    await sleep(200)
    const vsc = await js(`(() => { const b = document.querySelector('[data-tasks-scroll="backlog"]'); const r = b.getBoundingClientRect(); return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight, rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } } })()`)
    const grip = await js(`(() => { const g = document.querySelector('[data-tasks-scroll="backlog"] [data-issue-row] .tasks-grip').getBoundingClientRect(); return { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) } })()`)
    await mouse('mouseDown', grip.x, grip.y)
    await path8(grip, { x: Math.round((vsc.rect.left + vsc.rect.right) / 2), y: vsc.rect.bottom - 6 })
    await sleep(300)
    log('세로 진단', { vsc, grip, inner: await js('innerHeight'), drag: await js(`({ previews: document.querySelectorAll('.tasks-drag-preview').length, locked: document.querySelector('[data-tasks-scroll="backlog"] [data-issue-row] .tasks-grip')?.className ?? null, row: document.querySelector('[data-tasks-scroll="backlog"] [data-issue-row]')?.getAttribute('data-issue-row') })`) })
    const v1 = await js(`document.querySelector('[data-tasks-scroll="backlog"]').scrollTop`)
    await mouse('mouseMove', Math.round((vsc.rect.left + vsc.rect.right) / 2), Math.round((vsc.rect.top + vsc.rect.bottom) / 2))
    await sleep(100)
    const v2 = await js(`document.querySelector('[data-tasks-scroll="backlog"]').scrollTop`)
    await sleep(400)
    const v3 = await js(`document.querySelector('[data-tasks-scroll="backlog"]').scrollTop`)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
    await mouse('mouseUp', Math.round((vsc.rect.left + vsc.rect.right) / 2), Math.round((vsc.rect.top + vsc.rect.bottom) / 2))
    judge('P5 세로(창 높이 400, 백로그) — 아래 띠에서 scrollTop 증가 · 띠 밖 정지', vsc.max > 0 && v1 > 0 && v3 === v2, JSON.stringify({ v0: vsc.top, max: vsc.max, v1, v2, v3 }))
  },

  async baseline() {
    await s.boot({ token: TOKEN, fixture: EXTRA })
    await resize(760)
    const out = {}
    for (const view of ['backlog', 'list']) {
      await s.showView(view)
      await sleep(400)
      out[view] = await js(`(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { width: Math.round(b.width), height: Math.round(b.height) } }
        const sel = '${view}' === 'list' ? '[data-tasks-scroll="list"]' : '[data-tasks-scroll="backlog"]'
        const box = document.querySelector(sel)
        return { main: r(document.querySelector('.tasks-main')), body: r(document.querySelector('.tasks-body')), filters: r(document.querySelector('.tasks-filters')),
          tools: document.querySelector('.tasks-list-tools') ? r(document.querySelector('.tasks-list-tools')) : null,
          scroll: { scrollW: box.scrollWidth, clientW: box.clientWidth },
          titles: [...box.querySelectorAll('[data-issue-row]')].map((row) => [row.getAttribute('data-issue-row'), Math.round(row.querySelector('.tasks-row-title').getBoundingClientRect().width)]) }
      })()`)
      log(`${LABEL} ${view}`, out[view])
      await shot(`g-baseline-${LABEL}-${view}`)
    }
    judge(`기록 — ${LABEL} 창 760 패널 닫음 백로그·리스트 측정 완료(판정 아님)`, out.backlog.titles.length > 0 && out.list.titles.length > 0, JSON.stringify(out))
  },
}

await s.finish(async () => {
  log('mode', MODE, 'fixture out mtime', fixtureLog())
  await modes[MODE]()
})
