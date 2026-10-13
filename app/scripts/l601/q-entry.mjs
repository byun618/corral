#!/usr/bin/env node
// LIFE-601 빠른 층 「핵심 진입점 1회」 — 격리 개발 앱에서 작업 페이지를 열어 보드가 그려지는지. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-entry.mjs <ROOT=/tmp/l601q-*> <OUT 파일>
//
// 흐름: 앱 기동(모의 출처 — up.sh) → 모의 연결 추가(렌더러 IPC, 가짜 토큰) → ⌘I(앱 내부 sendInputEvent — OS 입력 아님) → 보드
//       → 칸·점선 칸·막힘 배지·덮기(사이드바 보임 · 메인 영역 숨김) → **실제 마우스 경로 가로 끌기 1회**(raw-mouse = webContents.sendInputEvent
//       mouseDown/Move/Up — 렌더러의 mousedown/move/up 처리기를 그대로 지난다) → 쓰기·토스트·서버 재조회 값(수정 r1 R1-A)
//       → ⌘I 닫기 → 사이드바 「작업」 으로 다시 열기 → **끄는 중 ⌘I 로 닫기 = 쓰기 0**(수정 r2 R2-K) → **창 밖 놓기 = 쓰기 0**(R3-F) → 보기 4 → **flip 응답 역전 순서 둘 = 서버 순서**(R3-A) → Esc 닫기 → 정리.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐.
// 격자 요청 수(`stream.sync` 로그 줄 · control counters)는 **관측만** 남긴다 — 판정은 최종 관문(C1, 양성 대조와 함께)이 한다.
// 종료 코드: 0 판정 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601q-') || OUT === undefined) {
  console.error('사용법: node scripts/l601/q-entry.mjs /tmp/l601q-<n> <OUT 파일>')
  process.exit(2)
}
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const sh = (args) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8' })
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
const syncLines = () => {
  try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"stream.sync"')).length } catch { return null }
}
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-entry ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  judge('C1 진입점 — 사이드바 「작업」 버튼(data-tasks-open) 있음', true)

  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l601_demo', replaceId: null }).then((r) => ({ ok: r.ok, kind: r.ok ? null : r.error.kind, spaces: r.ok ? (r.connection.spaces ?? []).map((s) => s.key) : null }))`)
  log('addWorkConnection', added)
  judge('모의 연결 추가(가짜 토큰) — 스페이스 CORE·WEB·EMPTY', added?.ok === true && ['CORE', 'WEB', 'EMPTY'].every((key) => added.spaces.includes(key)), JSON.stringify(added))

  const before = { sync: syncLines(), counters: (await ctl(ROOT, { cmd: 'counters' })).counters ?? null }
  log('관측(격자 요청 — 판정 아님) 열기 전', before)

  // ⌘I — 앱 내부 입력 이벤트(webContents.sendInputEvent). 키 레지스트리 → useKeybindings 경로.
  const keyed = await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  log('key ⌘I', keyed)
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card]')`), { timeoutMs: 15_000, label: '보드 카드' })
  judge('C1 ⌘I 로 작업 페이지 열림', await pageOpen())

  const board = await js(`(() => ({
    columns: [...document.querySelectorAll('[data-board-column]')].map((e) => e.getAttribute('data-board-column')),
    bands: [...document.querySelectorAll('[data-board-band]')].map((e) => e.getAttribute('data-board-band')),
    cards: [...document.querySelectorAll('[data-issue-card]')].map((e) => e.getAttribute('data-issue-card')),
    unmapped: [...document.querySelectorAll('[data-board-column="st:__unmapped"] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card')),
    blocked: [...document.querySelectorAll('[data-issue-blocked]')].map((e) => e.closest('[data-issue-card]')?.getAttribute('data-issue-card') + ' ' + e.textContent),
    space: document.querySelector('[data-space-switch]')?.textContent ?? null,
  }))()`)
  log('board', board)
  judge('C6 보드 — 분류 밴드 3 + 칸 없는 상태 밴드(합계 분리, R1-Q) · 상태 칸 4(워크플로 순서) + 점선 칸', JSON.stringify(board.bands) === '["todo","in_progress","done","unmapped"]' && JSON.stringify(board.columns) === '["st:core-todo","st:core-doing","st:core-review","st:core-done","st:__unmapped"]', JSON.stringify({ bands: board.bands, columns: board.columns }))
  judge('C6 칸 없는 상태의 작업(CORE-5)이 점선 칸에', JSON.stringify(board.unmapped) === '["CORE-5"]')
  judge('C6·E1 막힘 배지 — CORE-6 「막힘 · CORE-2」(완료 막은 쪽 CORE-7 은 셈하지 않음) · CORE-4 「막힘 · CORE-3」', board.blocked.includes('CORE-6 막힘 · CORE-2') && board.blocked.includes('CORE-4 막힘 · CORE-3'), JSON.stringify(board.blocked))
  judge('C6 백로그 배치(CORE-3·CORE-8)는 보드에 없다', !board.cards.includes('CORE-3') && !board.cards.includes('CORE-8'), JSON.stringify(board.cards))

  const cover = await js(`(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).visibility : null }
    const content = document.querySelector('[data-main-area-content]')
    return { sidebar: vis('.sidebar'), mainContent: content ? getComputedStyle(content).visibility : null, inert: content?.hasAttribute('inert') ?? null, page: vis('[data-tasks-page]'), tasksButtonPressed: document.querySelector('[data-tasks-open]')?.getAttribute('aria-pressed') }
  })()`)
  log('cover', cover)
  judge('C1 덮기 — 메인 영역 내용 visibility:hidden + inert · 사이드바는 보임 · 페이지 보임', cover.sidebar === 'visible' && cover.mainContent === 'hidden' && cover.inert === true && cover.page === 'visible', JSON.stringify(cover))
  const shot = await ctl(ROOT, { cmd: 'shot', name: 'l601-board' })
  log('shot', { ...shot, file: shot.file?.replaceAll(ROOT, '<ROOT>') })

  // R1-A — 실제 마우스 경로 가로 끌기 1회. 모의 출처는 허용 전이만(allowed)이라 놓기 전에 허용 전이를 받을 시간을 둔다(받기 전엔 흐림).
  const connectionId = await js(`window.corral.getWorkSettings().then((s) => s.connections[0].id)`)
  const serverStatus = (key) => js(`window.corral.workRequest({ requestId: 'q-entry-' + Date.now(), connectionId: ${JSON.stringify(connectionId)}, call: { op: 'findByKey', key: ${JSON.stringify(key)} } }).then((r) => (r.ok && r.result.op === 'findByKey' ? r.result.item?.statusKey ?? null : 'error:' + (r.ok ? 'shape' : r.error.kind)))`)
  const center = (selector, bottom) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(${bottom ? 'r.bottom - 6' : 'r.y + r.height / 2'}) } })()`)
  const serverBefore = await serverStatus('CORE-2')
  const from = await center('[data-issue-card="CORE-2"]', false)
  const to = await center('[data-drop-zone="col:st:core-doing"]', true)
  log('drag 좌표', { from, to, serverBefore })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from.x + 10, y: from.y })
  await sleep(250)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...to })
  await sleep(400)
  const during = await js(`({ gap: !!document.querySelector('[data-board-column="st:core-doing"] [data-drop-gap]'), column: document.querySelector('[data-board-column="st:core-doing"]')?.className ?? null })`)
  log('끄는 중', during)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...to })
  await until(() => js(`!!document.querySelector('[data-toast="moved"]')`), { timeoutMs: 5_000, label: '이동 토스트' }).catch(() => null)
  const dropped = await js(`({ column: document.querySelector('[data-issue-card="CORE-2"]')?.closest('[data-board-column]')?.getAttribute('data-board-column') ?? null, toast: document.querySelector('[data-toast]')?.getAttribute('data-toast') ?? null, toastText: document.querySelector('[data-toast]')?.textContent ?? null })`)
  const serverAfter = await serverStatus('CORE-2')
  log('놓은 뒤', { ...dropped, serverAfter })
  judge('C7·R1-A 실제 마우스 가로 끌기 — 놓는 동안 틈 · 카드가 그 칸 · 이동 토스트 · 서버 재조회 core-todo → core-doing',
    during.gap === true && dropped.column === 'st:core-doing' && dropped.toast === 'moved' && serverBefore === 'core-todo' && serverAfter === 'core-doing',
    JSON.stringify({ during, dropped, serverBefore, serverAfter }))

  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(async () => !(await pageOpen()), { timeoutMs: 10_000, label: '⌘I 로 닫힘' })
  const closedCover = await js(`(() => { const c = document.querySelector('[data-main-area-content]'); return { mainContent: c ? getComputedStyle(c).visibility : null, inert: c?.hasAttribute('inert') ?? null } })()`)
  judge('C1 ⌘I 로 닫힘 — 메인 영역 다시 보임', closedCover.mainContent === 'visible' && closedCover.inert === false, JSON.stringify(closedCover))

  await click('[data-tasks-open]')
  await until(pageOpen, { timeoutMs: 10_000, label: '사이드바 버튼으로 열림' })
  judge('C1 사이드바 「작업」 으로 다시 열림 · 보드 그대로', await js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-1"]')`))

  // 수정 r2(R2-K) — 실제 마우스로 끄는 중 ⌘I 로 닫으면 끌기가 취소되고, 닫힌 뒤 mouseup 은 쓰기를 보내지 않는다.
  // 쓰기 수 = main 로그 `work.request` 의 쓰기 op 줄 — 앞의 CORE-2 끌기가 1줄 이상 남겼어야 한다(세는 방법의 양성 대조).
  const writeLines = () => {
    try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"work.request"') && /"op":"(changeStatus|setPlacement|reorder)"/.test(line)).length } catch { return null }
  }
  const cancelBefore = { writes: writeLines(), server: await serverStatus('CORE-1') }
  const from2 = await center('[data-issue-card="CORE-1"]', false)
  const to2 = await center('[data-drop-zone="col:st:core-doing"]', true)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from2 })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from2.x + 10, y: from2.y })
  await sleep(250)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...to2 })
  await sleep(400)
  const dragging = await js(`!!document.querySelector('.tasks-drag-preview')`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(async () => !(await pageOpen()), { timeoutMs: 10_000, label: '끄는 중 ⌘I 로 닫힘' })
  const previewGone = await js(`!document.querySelector('.tasks-drag-preview')`)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...to2 })
  await sleep(1_000)
  const cancelAfter = { writes: writeLines(), server: await serverStatus('CORE-1') }
  log('끄는 중 ⌘I', { from2, to2, dragging, previewGone, cancelBefore, cancelAfter })
  judge('C7·R2-K 끄는 중 ⌘I → 페이지 닫힘 · 사본 사라짐 · mouseup 뒤 쓰기 0 · 서버 재조회 값 그대로(쓰기 줄 세기 양성 대조 ≥1)',
    dragging === true && previewGone === true && typeof cancelBefore.writes === 'number' && cancelBefore.writes >= 1 && cancelAfter.writes === cancelBefore.writes
      && typeof cancelBefore.server === 'string' && !cancelBefore.server.startsWith('error') && cancelAfter.server === cancelBefore.server,
    JSON.stringify({ dragging, previewGone, cancelBefore, cancelAfter }))
  await click('[data-tasks-open]')
  await until(pageOpen, { timeoutMs: 10_000, label: '다시 열림' })

  // 수정 r3(R3-F) — 끌어서 칸 위까지 간 뒤 **창 밖 좌표**에서 놓으면 취소 — 쓰기 0 · 서버 값 그대로.
  const outBefore = { writes: writeLines(), server: await serverStatus('CORE-1') }
  const from3 = await center('[data-issue-card="CORE-1"]', false)
  const to3 = await center('[data-drop-zone="col:st:core-todo"]', true)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from3 })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from3.x + 10, y: from3.y })
  await sleep(250)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...to3 })
  await sleep(400)
  const draggingOut = await js(`!!document.querySelector('.tasks-drag-preview')`)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', x: -10, y: -10 })
  await sleep(1_000)
  const outAfter = { writes: writeLines(), server: await serverStatus('CORE-1'), preview: await js(`!!document.querySelector('.tasks-drag-preview')`) }
  log('창 밖 놓기', { from3, to3, draggingOut, outBefore, outAfter })
  judge('C7·R3-F 창 밖 좌표 mouseup → 쓰기 0 · 사본 사라짐 · 서버 재조회 값 그대로',
    draggingOut === true && outAfter.preview === false && typeof outBefore.writes === 'number' && outAfter.writes === outBefore.writes && outAfter.server === outBefore.server,
    JSON.stringify({ draggingOut, outBefore, outAfter }))

  const viewChecks = {}
  for (const [tab, selector] of [['backlog', '[data-tasks-backlog] [data-backlog-section="backlog"] [data-issue-row="CORE-3"]'], ['list', '[data-tasks-list] [data-issue-row="CORE-1"]'], ['working', '[data-tasks-working], [data-tasks-empty="working"]'], ['board', '[data-tasks-board]']]) {
    await click(`[data-tasks-view-tab="${tab}"]`)
    viewChecks[tab] = await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), { timeoutMs: 10_000, label: tab }).then(() => true).catch(() => false)
  }
  log('views', viewChecks)
  // C9 — 커서가 켜진 모의 출처(쪽 크기 6): 리스트 「더 불러오기」 가 다음 쪽(CORE-7·CORE-8)을 실제로 붙인다.
  await click('[data-tasks-view-tab="list"]')
  const beforeMore = await js(`document.querySelectorAll('[data-tasks-list] [data-issue-row]').length`)
  await click('[data-tasks-more-button]')
  const more = await until(() => js(`!!document.querySelector('[data-tasks-list] [data-issue-row="CORE-8"]')`), { timeoutMs: 10_000, label: '다음 쪽' }).then(() => true).catch(() => false)
  const afterMore = await js(`({ rows: document.querySelectorAll('[data-tasks-list] [data-issue-row]').length, bar: document.querySelector('[data-tasks-more]')?.getAttribute('data-tasks-more') ?? null })`)
  judge('C9 리스트 「더 불러오기」 = 출처의 다음 커서 — 다음 쪽이 붙고 줄이 사라진다', more && afterMore.rows > beforeMore && afterMore.bar === null, JSON.stringify({ beforeMore, afterMore }))
  await click('[data-tasks-view-tab="board"]')
  judge('보기 4 전환 — 백로그(두 섹션) · 리스트 · 작업 중(없음 빈 상태 포함) · 보드', Object.values(viewChecks).every(Boolean), JSON.stringify(viewChecks))

  // 수정 r3(R3-A) — 응답 배달 뒤집기(`mock_transition-any_flip-2000`: 서버는 받은 순서로 곧바로 적용, 홀수 번째 응답만 2초 늦음)로 토큰을 바꾼 뒤,
  // (transition-any 로 끌기 시작 때 허용 전이 조회가 끼지 않게 — 끼면 홀짝이 어긋나 응답이 뒤집히지 않는다)
  // 백로그 보드 섹션에서 서로 다른 카드 순서 변경 둘(A = 아래 끝으로 · B = 위 끝으로)을 보낸다. 앞 응답이 늦어 B 응답이 먼저 온다.
  // 끝난 뒤 화면 순서 = 서버 재조회 순서(전 쪽을 다시 읽어 화면에 있는 키만 비교).
  const ask = (call) => js(`window.corral.workRequest({ requestId: 'q-entry-' + Date.now() + Math.random(), connectionId: ${JSON.stringify(connectionId)}, call: ${JSON.stringify(call)} })`)
  const replaced = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_transition-any_flip-2000', replaceId: ${JSON.stringify(connectionId)} }).then((r) => ({ ok: r.ok, generation: r.ok ? r.connection.generation : null }))`)
  log('flip 토큰으로 교체', replaced)
  await click('[data-tasks-view-tab="backlog"]')
  await sleep(4_500)
  // 출처 요청 순번 맞추기 — 곧바로 답한 요청(짝수) 다음이 늦는 홀수다. 그래서 다음 첫 쓰기(A)의 응답이 늦는다.
  for (let index = 0; index < 3; index += 1) {
    const started = Date.now()
    await ask({ op: 'getItem', itemId: 'm-1' })
    if (Date.now() - started < 1_000) break
  }
  const shownRows = () => js(`[...document.querySelectorAll('[data-backlog-section="board"] [data-issue-row]')].map((e) => e.dataset.issueRow)`)
  const dragEdge = async ({ key, edge }) => {
    const grip = await center(`[data-backlog-section="board"] [data-issue-row="${key}"] .tasks-grip`, false)
    // 놓는 자리 = 섹션의 첫 행 위쪽 끝 / 마지막 행 아래쪽 끝(행 중점 기준 번호가 맨 앞·맨 뒤가 되게).
    const dest = await js(`(() => { const rows = [...document.querySelectorAll('[data-backlog-section="board"] [data-issue-row]')]; const r = rows[${edge === 'bottom' ? 'rows.length - 1' : '0'}].getBoundingClientRect(); return { x: Math.round(r.x + 200), y: Math.round(${edge === 'bottom' ? 'r.bottom - 2' : 'r.top + 2'}) } })()`)
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...grip })
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: grip.x + 10, y: grip.y })
    await sleep(80)
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...dest })
    await sleep(120)
    // 끄는 동안 틈이 행을 밀어내므로 그 자리에서 한 번 더 잰다(맨 아래 끝이 틈 높이만큼 내려간다).
    const settled = await js(`(() => { const rows = [...document.querySelectorAll('[data-backlog-section="board"] [data-issue-row]')]; const r = rows[${edge === 'bottom' ? 'rows.length - 1' : '0'}].getBoundingClientRect(); return { x: Math.round(r.x + 200), y: Math.round(${edge === 'bottom' ? 'r.bottom - 2' : 'r.top + 2'}) } })()`)
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...settled })
    await sleep(120)
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...settled })
    await sleep(150)
    return { grip, dest, settled }
  }
  const initial = await shownRows()
  // 리뷰 r3 재현과 같은 모양 — A = 끝에서 두 번째를 맨 아래로(afterId = 마지막 카드), B = 그 마지막 카드를 맨 위로.
  // 옛 코드는 늦게 온 A 응답에서 의도(마지막 카드 뒤)를 다시 적용해, 맨 위로 간 B 바로 뒤로 A 가 끌려 올라갔다.
  const moveA = initial.at(-2)
  const moveB = initial.at(-1)
  const dragA = await dragEdge({ key: moveA, edge: 'bottom' })
  const afterA = await shownRows()
  const dragB = await dragEdge({ key: moveB, edge: 'top' })
  const afterB = await shownRows()
  const serverBoard = async () => {
    const all = []
    let cursor = null
    for (let page = 0; page < 10; page += 1) {
      const response = await ask({ op: 'listItems', spaceKey: 'CORE', cursor })
      if (!response?.ok) return null
      all.push(...response.result.items)
      cursor = response.result.nextCursor
      if (cursor === null) break
    }
    return all.filter((entry) => entry.placement === 'board').map((entry) => entry.key)
  }
  let final = null
  await until(async () => {
    const screen = await shownRows()
    const server = await serverBoard()
    final = { screen, server: server?.filter((key) => screen.includes(key)) ?? null }
    return final.server !== null && JSON.stringify(final.screen) === JSON.stringify(final.server)
  }, { timeoutMs: 20_000, everyMs: 1_000, label: '화면 = 서버 순서' }).catch(() => null)
  // 뒤집힘 양성 대조 — IPC 응답 기록에서 순서 쓰기 응답이 B → A 순으로 왔는가.
  const replies = (() => {
    try {
      return fs.readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"op":"reorder"'))
        .map((line) => JSON.parse(line).value?.result?.item?.key ?? null)
    } catch { return null }
  })()
  log('응답 뒤집힌 순서 둘', { initial, moveA, moveB, dragA, dragB, afterA, afterB, replies, final })
  judge('C7·C8·R3-A 다른 카드 순서 변경 둘(flip 응답 역전 — IPC 기록 B→A) — 둘 다 옮겨졌고 끝나면 화면 순서 = 서버 재조회 순서',
    JSON.stringify(replies) === JSON.stringify([moveB, moveA]) && initial.length >= 3 && afterA.at(-1) === moveA && afterB[0] === moveB && final !== null && JSON.stringify(final.screen) === JSON.stringify(final.server),
    JSON.stringify({ initial, afterA, afterB, replies, final }))
  log('shot', await ctl(ROOT, { cmd: 'shot', name: 'l601-reorder-flip' }))
  await click('[data-tasks-view-tab="board"]')

  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await until(async () => !(await pageOpen()), { timeoutMs: 10_000, label: 'Esc 로 닫힘' })
  judge('C4 Esc 로 닫힘', !(await pageOpen()))

  await sleep(500)
  const after = { sync: syncLines(), counters: (await ctl(ROOT, { cmd: 'counters' })).counters ?? null }
  log('관측(격자 요청 — 판정 아님) 열고 닫기 3회 뒤', after)
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l601/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
