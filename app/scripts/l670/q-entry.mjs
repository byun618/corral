#!/usr/bin/env node
// LIFE-670 빠른 층 「격리 진입점 1회」 — 패널 모드 밀기(P1 rect)와 패널 연 채 맨 오른쪽 칸 카드 끌어 놓기(P2ⓑ 1건). app/ 에서(먼저 `npm run build`):
//
//   node scripts/l670/q-entry.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
//
// 흐름: 앱 사본(fixture-app.sh — 보드 칸 7개) → 격리 기동(l670/up.sh, 모의 출처·가짜 토큰 `transition-any`) → 창 1280×800 → ⌘I
//       → 카드 클릭 → P1 rect(`body.right <= aside.left`, 폭 = main − 560) → 보기 가로 스크롤 끝 → 맨 오른쪽 칸 카드를 왼쪽 옆 칸으로
//       원 마우스(mouseDown→mouseMove 여러 번→mouseUp) 끌기 → 출처 재조회로 상태 변경 1건 → 패널 캡처 → ⤢ 전체 rect·캡처 → 정리.
// 놓을 점 = 옆 칸 놓기 영역(`[data-drop-zone]` 목록)의 세로 가운데 · 왼쪽 자동 스크롤 띠 밖(1~4회차는 목록 아래 경계 y 라 영역 밖에 놓였다 — 원자료 q-entry-1..4).
// 가로 스크롤 끝으로 보내기는 eval 로 그릇 scrollLeft 를 끝으로 둔다(사용자의 트랙패드 가로 스크롤 대신 — 측정 대상은 그 뒤 rect·끌기).
// 실제 LA·사용자 키체인·설치본 무접촉. 종료 코드: 0 판정 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, SHOT_DIR] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-entry.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더>')
  process.exit(2)
}
const FIXTURE = `${ROOT}-app`
const TOKEN = 'mock_l670_transition-any'
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
  log('shot', { ...result, file: result.file?.replaceAll(ROOT, '<ROOT>') })
  if (result.file) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const target = path.join(SHOT_DIR, `${name}.png`)
    fs.copyFileSync(result.file, target)
    log('copied', { target: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
  }
}
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
// 레이아웃 측정 — main·body·scroll·aside 사각형과 배치 상태.
const layout = () => js(`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } }
  const main = document.querySelector('.tasks-main')
  const scroll = document.querySelector('[data-tasks-scroll="board"]')
  return { placement: main?.dataset.detailLayout ?? null, push: main?.classList.contains('is-detail-push') ?? null, window: innerWidth,
    main: r(main), body: r(document.querySelector('.tasks-body')), scroll: r(scroll), aside: r(document.querySelector('[data-issue-detail]')),
    scrollLeft: scroll?.scrollLeft ?? null, scrollMax: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
    columns: [...document.querySelectorAll('[data-tasks-board] [data-drop-zone^="col:"]')].map((z) => z.getAttribute('data-drop-zone')) }
})()`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-670 q-entry ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l670/fixture-app.sh', FIXTURE])
  sh(['scripts/l670/up.sh', ROOT], { L670_APP_DIR: FIXTURE })
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const resized = await ctl(ROOT, { cmd: 'resize-window', width: 1280, height: 800 })
  log('resize-window', resized)
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: '${TOKEN}', replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('addWorkConnection', added)
  judge('모의 연결 추가(가짜 토큰)', added?.ok === true, JSON.stringify(added))

  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 카드 CORE-2' })
  await sleep(300)
  const closed = await layout()
  log('닫힘 배치', closed)
  judge('격리 조건 — 창 폭 1280 · 보드 칸 6개 이상', closed.window === 1280 && closed.columns.length >= 6, JSON.stringify({ window: closed.window, columns: closed.columns }))

  // P1 — 카드 클릭 → 패널 모드 밀기
  await click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-2"] [data-issue-title]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
  await sleep(300)
  const pushed = await layout()
  log('패널 배치', pushed)
  judge('P1 패널 모드 밀기 — body.right <= aside.left · body 폭 = main − 560 · aside 560',
    pushed.placement === 'push' && pushed.body.right <= pushed.aside.left && pushed.body.width === pushed.main.width - 560 && pushed.aside.width === 560,
    JSON.stringify({ placement: pushed.placement, main: pushed.main, body: pushed.body, aside: pushed.aside, closedBody: closed.body }))

  // P2ⓑ — 가로 스크롤 끝 → 맨 오른쪽 칸 카드를 왼쪽 옆 칸으로 끌어 놓기
  await js(`(() => { const s = document.querySelector('[data-tasks-scroll="board"]'); s.scrollLeft = s.scrollWidth; return s.scrollLeft })()`)
  await sleep(200)
  const scrolled = await layout()
  const lastZone = scrolled.columns.at(-1)
  const prevZone = scrolled.columns.at(-2)
  const geo = await js(`(() => {
    const last = document.querySelector('[data-drop-zone="${lastZone}"]'); const prev = document.querySelector('[data-drop-zone="${prevZone}"]')
    const card = last?.querySelector('[data-issue-card]'); const c = card?.getBoundingClientRect(); const p = prev?.getBoundingClientRect(); const l = last?.getBoundingClientRect()
    return { card: card?.getAttribute('data-issue-card') ?? null, cardAt: c ? { x: Math.round(c.left + 24), y: Math.round(c.top + c.height / 2) } : null,
      prev: p ? { left: Math.round(p.left), right: Math.round(p.right), x: Math.round(p.left + p.width / 2), y: Math.round(p.top + p.height / 2), top: Math.round(p.top), height: Math.round(p.height) } : null,
      last: l ? { left: Math.round(l.left), right: Math.round(l.right) } : null }
  })()`)
  log('끌기 기하', { scrollLeft: scrolled.scrollLeft, scrollMax: scrolled.scrollMax, lastZone, prevZone, ...geo, asideLeft: scrolled.aside?.left })
  judge('P2 맨 오른쪽 칸이 패널 왼쪽에 보인다(가로 스크롤 끝)', geo.last !== null && geo.last.right <= scrolled.aside.left && scrolled.scrollLeft === scrolled.scrollMax && scrolled.scrollMax > 0, JSON.stringify({ last: geo.last, asideLeft: scrolled.aside?.left, scrollLeft: scrolled.scrollLeft, scrollMax: scrolled.scrollMax }))
  const before = await js(`window.corral.workRequest({ requestId: 'l670-before', connectionId: '${added.id}', call: { op: 'getItem', itemId: 'm-6' } }).then((r) => r.ok ? r.result.item.statusKey : JSON.stringify(r))`)
  if (geo.card === null || geo.cardAt === null || geo.prev === null) throw new Error('끌 카드·놓을 칸이 없다')
  // 놓을 점은 보기 왼쪽 자동 스크롤 띠(40px, P5) 밖으로 — 띠 안에서 멈추면 놓기 전에 칸이 밀린다(1회차 원자료 q-entry-1.txt).
  const drop = { x: Math.min(geo.prev.right - 10, Math.max(geo.prev.x, scrolled.scroll.left + 60)), y: geo.prev.y }
  log('놓을 점', drop)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', x: geo.cardAt.x, y: geo.cardAt.y })
  const steps = 8
  for (let index = 1; index <= steps; index += 1) {
    const x = Math.round(geo.cardAt.x + ((drop.x - geo.cardAt.x) * index) / steps)
    const y = Math.round(geo.cardAt.y + ((drop.y - geo.cardAt.y) * index) / steps)
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x, y })
    await sleep(40)
  }
  // sendInputEvent 는 렌더러 입력 큐로 비동기 배달된다 — eval 이 큐를 앞지르지 않게 잠깐 기다린다(5회차 진단이 끌기 전 상태를 읽었다).
  await sleep(250)
  const hovering = await js(`(() => {
    const col = document.querySelector('[data-drop-zone="${prevZone}"]')?.closest('[data-board-column]')
    const hit = document.elementFromPoint(${drop.x}, ${drop.y})
    return { previews: document.querySelectorAll('.tasks-drag-preview').length, column: col?.className ?? null, reason: col?.querySelector('[data-column-reason]')?.textContent ?? null,
      hit: hit ? (hit.closest('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? hit.className) : null }
  })()`)
  log('끄는 중', hovering)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', x: drop.x, y: drop.y })
  const moved = await until(() => js(`!!document.querySelector('[data-drop-zone="${prevZone}"] [data-issue-card="${geo.card}"]')`), { timeoutMs: 10_000, label: '놓은 칸에 카드' }).then(() => true).catch(() => false)
  await sleep(500)
  const after = await js(`window.corral.workRequest({ requestId: 'l670-after', connectionId: '${added.id}', call: { op: 'getItem', itemId: 'm-6' } }).then((r) => r.ok ? r.result.item.statusKey : JSON.stringify(r))`)
  const trace = (() => { try { return fs.readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8').split('\n').filter((line) => line.includes('changeStatus')).length } catch { return -1 } })()
  const scrollAfter = await js(`document.querySelector('[data-tasks-scroll="board"]').scrollLeft`)
  log('끌기 결과', { scrollAfter, card: geo.card, from: lastZone, to: prevZone, previewWhileDragging: hovering, movedInDom: moved, before, after, traceChangeStatusLines: trace })
  judge('P2ⓑ 패널 연 채 맨 오른쪽 칸 카드 → 옆 칸 놓기 · 출처 값 변경 1건', geo.card === 'CORE-5' && moved && before === 'core-legal' && after === 'core-done' && trace >= 1, JSON.stringify({ card: geo.card, before, after, moved, trace }))
  await shot('q-entry-panel')

  // 전체 모드 — 덮기 그대로
  await click('[data-issue-full]')
  await until(() => js(`document.querySelector('[data-issue-full]')?.getAttribute('data-issue-full') === 'full'`), { timeoutMs: 5_000, label: '전체' })
  await sleep(300)
  const full = await layout()
  log('전체 배치', full)
  judge('P1 전체 모드는 덮기 — aside.left = main.left · 밀기 없음 · body 폭 = main 폭', full.placement === 'full' && full.push === false && full.aside.left === full.main.left && full.body.width === full.main.width, JSON.stringify({ placement: full.placement, main: full.main, body: full.body, aside: full.aside }))
  await shot('q-entry-full')
  await click('[data-issue-full]')
  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await until(async () => (await js(`!document.querySelector('[data-issue-detail]')`)) === true, { timeoutMs: 5_000, label: 'Esc 상세 닫기' })
  const reclosed = await layout()
  judge('P1 닫으면 원복 — body 폭 = main 폭', reclosed.placement === 'none' && reclosed.body.width === reclosed.main.width && reclosed.body.width === closed.body.width, JSON.stringify({ body: reclosed.body, main: reclosed.main }))

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
