#!/usr/bin/env node
// LIFE-702 최종 관문 — D3·D4 격리 GUI 실측(head) · D7 양성 대조(base). app/ 에서(먼저 `npx electron-vite build` 또는 기준 빌드):
//
//   node scripts/l702/gate.mjs <head|base> <ROOT=/tmp/l702g-*> <OUT 파일> <CDP 포트> <캡처 폴더> [앱 폴더]
//
// 1) 모의 LA 서버(fixture-server.mts — 오래된 완료 씨앗) → 2) 격리 앱(up.sh, `--remote-debugging-port`) → 3) LA 연결(가짜 토큰) → ⌘I → corral 스페이스.
// 입력은 전부 렌더러 층: 클릭·키 = 제어 소켓(`sendInputEvent`), 끌기 = CDP `Input.dispatchMouseEvent`(l601/cdp-drag.mjs), 검색 = DOM setter + input 이벤트.
// OS 입력 없음. 판정은 DOM 값 + 모의 서버 상태(`<fixture.url>.state.json`) + 렌더러 `workRequest` 재조회.
// head: ⓐ 보드 ⓑ 백로그 ⓒ 리스트 ⓓ 검색 해제 ⓔ 필터 유지 ⓕ 완료로 끌기 ⓖ 숨긴 이웃 + 순서 이동(모의 출처 CORE — 앱 폴더는 씨앗 사본, seed-app.sh).
// base: ⓐ 만(기준 commit 빌드 — 오래된 완료가 보드에 보여야 양성 대조 통과).
// 끝나면 앱·herdr 세션·모의 서버를 내린다(PID 는 OUT 에). 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'
import { connect } from '../l601/cdp-drag.mjs'

const [MODE, ROOT, OUT, PORT, SHOTS, APP_DIR] = process.argv.slice(2)
if (!['head', 'base'].includes(MODE ?? '') || !ROOT?.startsWith('/tmp/l702g-') || OUT === undefined || !/^\d+$/.test(PORT ?? '') || SHOTS === undefined) {
  console.error('사용법: node scripts/l702/gate.mjs <head|base> /tmp/l702g-<n> <OUT> <포트> <캡처 폴더> [앱 폴더]')
  process.exit(2)
}
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, JSON.stringify(detail ?? ''))
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
  if (!result.file) { log('shot 실패', JSON.stringify(result)); return }
  fs.mkdirSync(SHOTS, { recursive: true })
  const target = path.join(SHOTS, `${MODE}-${name}.png`)
  fs.copyFileSync(result.file, target)
  log('shot', JSON.stringify({ target: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size }))
}

const FAKE_LA_TOKEN = 'life_pat_fixture000000000000000000000000000000000000'
const FAKE_MOCK_TOKEN = 'mock_fixture_token_0000'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CORRAL = uuid(337)
const DONE = uuid(9004)
const OLD = 'LIFE-901'
const RECENT = 'LIFE-902'
const NULL_DONE = 'LIFE-903'
const BACKLOG = 'LIFE-904'
const DRAG = 'LIFE-905'
const OPEN = 'LIFE-600'
const fixtureUrl = path.join(ROOT, 'fixture.url')
const serverState = () => { try { return JSON.parse(fs.readFileSync(`${fixtureUrl}.state.json`, 'utf8')) } catch { return null } }

const cards = () => js(`[...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
const columnCards = (statusKey) => js(`[...document.querySelectorAll('[data-board-column="st:${statusKey}"] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
const columnCount = (statusKey) => js(`document.querySelector('[data-board-column="st:${statusKey}"] .tasks-column-count')?.textContent ?? null`)
const rowsIn = (selector) => js(`[...document.querySelectorAll('${selector} [data-issue-row]')].map((e) => e.getAttribute('data-issue-row'))`)
const typeSearch = (value) => js(`(() => { const input = document.querySelector('[data-tasks-search]'); if (!(input instanceof HTMLInputElement)) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const showView = async (view) => {
  await click(`[data-tasks-view-tab="${view}"]`)
  await until(() => js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view') === '${view}'`), { timeoutMs: 5_000, label: `보기 ${view}` })
  await sleep(400)
}
const chooseSpace = async (key, cardKey) => {
  await click('[data-space-switch]')
  await click(`[data-space-row="${key}"]`)
  await until(() => js(`!!document.querySelector('[data-issue-card="${cardKey}"], [data-issue-row="${cardKey}"]')`), { timeoutMs: 15_000, label: `스페이스 ${key}` })
  await sleep(500)
}

// l601 drag 와 같은 순서(누름 → 문턱 10px → 0.7초 → 놓을 자리 두 번 → 놓음)이되, 좌표를 창 안에 보이는 부분으로 자른다.
// 창 폭 1180 에서 오른쪽 칸이 창 끝에 걸쳐 l601 의 「왼쪽+120」 이 창 밖이 되어 useTaskDrag 가 취소했다(g1-g02).
const dragIn = async (cdp, { from, to, where, lane }) => {
  const point = (selector, mode) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); const right = Math.min(r.right, window.innerWidth - 4); const bottom = Math.min(r.bottom, window.innerHeight - 4); return { x: Math.round((r.left + Math.min(right, r.left + 240)) / 2), y: Math.round(${mode === 'bottom' ? 'bottom - 6' : mode === 'top' ? 'r.top + 3' : 'r.top + Math.min(r.height / 2, 20)'}), innerWidth: window.innerWidth, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] } })()`)
  const mouse = (type, { x, y }, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const start = await point(from, 'mid')
  if (start === null) return { ok: false, reason: `끌 요소 없음 ${from}` }
  await mouse('mousePressed', start, 1)
  await mouse('mouseMoved', { x: start.x + 10, y: start.y }, 1)
  await sleep(700)
  const first = await point(to, where)
  if (first === null) { await mouse('mouseReleased', { x: -10, y: -10 }, 0); return { ok: false, reason: `놓을 요소 없음 ${to}` } }
  await mouse('mouseMoved', first, 1)
  await sleep(300)
  const end = (await point(to, where)) ?? first
  await mouse('mouseMoved', end, 1)
  await sleep(150)
  const during = await cdp.evaluate(`(() => { const l = document.querySelector(${JSON.stringify(lane)}); return { preview: !!document.querySelector('.tasks-drag-preview'), lane: l?.className ?? null } })()`)
  await mouse('mouseReleased', end, 0)
  await sleep(300)
  return { ok: true, start, end, during }
}

let fixtureProc = null
const pids = {}
async function main() {
  log(`# ${path.basename(OUT)} ${new Date().toISOString()} mode=${MODE} ROOT=${ROOT} app=${APP_DIR ?? APP}`)
  log(`head=${spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).stdout.trim()}`)
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  // 1) 모의 LA 서버
  fixtureProc = spawn(process.execPath, ['--import', 'tsx', 'scripts/l702/fixture-server.mts', fixtureUrl], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] })
  pids.fixture = fixtureProc.pid
  fixtureProc.stdout.on('data', (chunk) => log('fixture:', chunk.toString().trim()))
  fixtureProc.stderr.on('data', (chunk) => log('fixture!', chunk.toString().trim()))
  await until(() => fs.existsSync(fixtureUrl) && fs.readFileSync(fixtureUrl, 'utf8').length > 0, { timeoutMs: 30_000, label: '모의 서버' })
  const seeded = serverState()?.issues.filter((issue) => issue.seq >= 901)
  log('씨앗', JSON.stringify(seeded))
  // 2) 격리 앱
  sh(['scripts/l702/up.sh', ROOT], { L702_EXTRA_ARGS: `--remote-debugging-port=${PORT} --disable-backgrounding-occluded-windows`, ...(APP_DIR ? { L702_APP_DIR: APP_DIR } : {}) })
  pids.app = fs.readFileSync(path.join(ROOT, 'app.pid'), 'utf8').trim()
  pids.herdr = fs.readFileSync(path.join(ROOT, 'herdr.pid'), 'utf8').trim()
  log('pids', JSON.stringify(pids))
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  // 3) 연결
  const la = await js(`window.corral.addWorkConnection({ sourceId: 'la', token: '${FAKE_LA_TOKEN}', replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null, error: r.ok ? null : r.error }))`)
  judge('LA 모의 연결 추가(가짜 토큰)', la?.ok === true, la)
  let mockId = null
  if (MODE === 'head') {
    const mock = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: '${FAKE_MOCK_TOKEN}', replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
    judge('모의 출처 연결 추가(ⓖ 무대)', mock?.ok === true, mock)
    mockId = mock?.id ?? null
  }
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(() => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`), { timeoutMs: 10_000, label: '⌘I' })
  await chooseSpace(CORRAL, OPEN)
  if (await js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view')`) !== 'board') await showView('board')
  await until(async () => (await cards())?.includes(RECENT), { timeoutMs: 15_000, label: '보드 카드' })

  // ⓐ 보드
  const board = await cards()
  const doneCards = await columnCards(DONE)
  const doneCount = await columnCount(DONE)
  log('ⓐ 보드 카드', JSON.stringify(board), '완료 칸', JSON.stringify(doneCards), '완료 칸 건수', doneCount)
  await shot('a-board')
  if (MODE === 'base') {
    judge('D7 ⓐ 기준 빌드 — 20일 완료가 보드에 보인다(현행 재현)', board.includes(OLD) && doneCards.includes(OLD), { board, doneCards })
    judge('D7 ⓐ 기준 빌드 — 완료 칸 건수에 20일 완료가 들어간다', String(doneCards.length) === doneCount && doneCards.includes(OLD), { doneCount, doneCards })
    return
  }
  judge('ⓐ 20일 완료 없음', !board.includes(OLD), { board })
  judge('ⓐ 13일·null 완료·열린 일감 있음', [RECENT, NULL_DONE, OPEN, DRAG].every((key) => board.includes(key)), { board })
  judge('ⓐ 백로그 배치는 보드에 없음', !board.includes(BACKLOG), { board })
  judge('ⓐ 완료 칸 건수 = 보이는 카드 수', doneCount === String(doneCards.length), { doneCount, doneCards })

  // ⓑ 백로그
  await showView('backlog')
  const backlogBoard = await rowsIn('[data-backlog-section="board"]')
  const backlogBacklog = await rowsIn('[data-backlog-section="backlog"]')
  const sectionCounts = await js(`[...document.querySelectorAll('[data-backlog-section]')].map((s) => [s.getAttribute('data-backlog-section'), s.querySelector('.tasks-column-count')?.textContent, s.querySelectorAll('[data-issue-row]').length])`)
  log('ⓑ 백로그', JSON.stringify({ backlogBoard, backlogBacklog, sectionCounts }))
  await shot('b-backlog')
  judge('ⓑ 백로그 보기 — 20일 완료 없음 · 13일·null 완료 있음 · 열린 백로그는 백로그 구역', !backlogBoard.includes(OLD) && !backlogBacklog.includes(OLD) && backlogBoard.includes(RECENT) && backlogBoard.includes(NULL_DONE) && backlogBacklog.includes(BACKLOG), { backlogBoard, backlogBacklog })
  judge('ⓑ 구역 건수 = 보이는 행 수', sectionCounts.every(([, count, rows]) => String(rows) === count), { sectionCounts })

  // ⓒ 리스트
  await showView('list')
  const list = await rowsIn('[data-tasks-list]')
  log('ⓒ 리스트', JSON.stringify(list))
  await shot('c-list')
  judge('ⓒ 리스트 보기 — 20일 완료 있음', list.includes(OLD) && list.includes(RECENT), { list })

  // ⓓ 검색 해제
  await showView('board')
  await typeSearch('스무날')
  await sleep(800)
  const searched = await cards()
  log('ⓓ 검색 「스무날」', JSON.stringify(searched))
  await shot('d-search')
  judge('ⓓ 검색어(20일 완료 제목 일부) → 보드에 보임', searched.includes(OLD), { searched })
  await typeSearch('')
  await sleep(800)
  const cleared = await cards()
  log('ⓓ 검색 지움', JSON.stringify(cleared))
  judge('ⓓ 검색어 지우면 다시 숨음', !cleared.includes(OLD) && cleared.includes(RECENT), { cleared })

  // ⓔ 필터·프리셋
  await click('[data-filter="kind"]')
  const kindRows = await js(`[...document.querySelectorAll('[data-tasks-menu="kind"] [role="menuitemcheckbox"]')].map((e) => e.textContent)`)
  log('ⓔ 종류 메뉴', JSON.stringify(kindRows))
  await js(`(() => { const row = [...document.querySelectorAll('[data-tasks-menu="kind"] [role="menuitemcheckbox"]')].find((e) => e.textContent.includes('Task')); row?.click(); return !!row })()`)
  await sleep(600)
  const filtered = await cards()
  log('ⓔ 종류 Task', JSON.stringify(filtered))
  await shot('e-filter')
  judge('ⓔ 필터만 켜면 숨김 유지(종류 Task — 20일 완료도 Task)', !filtered.includes(OLD) && filtered.includes(RECENT), { filtered })
  await click('[data-clear-filters]').catch(async () => { await js(`document.querySelector('[data-clear-filters]')?.click()`) })
  await sleep(600)
  await showView('list')
  const presetButtons = await js(`[...document.querySelectorAll('[data-tasks-preset]')].map((e) => e.getAttribute('data-tasks-preset'))`)
  log('ⓔ 프리셋 단추', JSON.stringify(presetButtons))
  const presetClicked = await js(`(() => { const b = document.querySelector('[data-tasks-preset="week"]') ?? [...document.querySelectorAll('[data-tasks-preset] button, [data-tasks-preset]')].find((e) => /이번 주/.test(e.textContent)); b?.click(); return !!b })()`)
  await sleep(400)
  await showView('board')
  const preset = await cards()
  const presetFilter = await js(`document.querySelector('[data-filter="due-week"]') !== null`)
  log('ⓔ 프리셋 「이번 주 마감」 뒤 보드', JSON.stringify({ presetClicked, presetFilter, preset }))
  judge('ⓔ 프리셋만 켜면 숨김 유지(이번 주 마감 — 20일 완료 없음)', presetClicked && presetFilter && !preset.includes(OLD), { presetClicked, presetFilter, preset })
  await js(`document.querySelector('[data-clear-filters]')?.click()`)
  await sleep(600)
  const reset = await cards()
  log('필터 지움 뒤 보드', JSON.stringify(reset))

  // ⓕ 완료로 끌기
  const cdp = await connect(PORT)
  const before = serverState()
  const listsBefore = before.toolNames.filter((name) => name === 'issue_list').length
  // g1-g02: 완료 칸이 창 오른쪽 끝에 걸쳐 l601 drag 의 놓는 x(칸 왼쪽+120)가 창 밖(1228>1180) → useTaskDrag 가 취소.
  // g1-g03: scrollIntoView 로 당기면 끌기가 시작되지 않았다(preview false). 스크롤하지 않고 놓는 좌표를 창 안에 보이는 영역으로 직접 잡는다(dragIn).
  const dragged = await dragIn(cdp, { from: `[data-tasks-board] [data-issue-card="${DRAG}"]`, to: `[data-board-column="st:${DONE}"] [data-drop-zone]`, where: 'bottom', lane: `[data-board-column="st:${DONE}"]` })
  log('ⓕ 끌기', JSON.stringify(dragged))
  const justAfter = await columnCards(DONE)
  log('ⓕ 놓은 직후 완료 칸', JSON.stringify(justAfter))
  judge('ⓕ 놓은 직후 완료 칸에 보임', justAfter.includes(DRAG), { justAfter })
  await until(() => serverState()?.issues.find((issue) => issue.seq === 905)?.statusId === DONE, { timeoutMs: 10_000, label: '서버 완료 이동' })
  await until(() => serverState().toolNames.filter((name) => name === 'issue_list').length > listsBefore, { timeoutMs: 10_000, label: '재조회' }).catch(() => null)
  await sleep(1500)
  const serverDrag = serverState().issues.find((issue) => issue.seq === 905)
  const afterReload = await columnCards(DONE)
  const listsAfter = serverState().toolNames.filter((name) => name === 'issue_list').length
  log('ⓕ 서버', JSON.stringify(serverDrag), '재조회', listsBefore, '→', listsAfter, '완료 칸', JSON.stringify(afterReload))
  await shot('f-drag-done')
  const ageMs = Date.now() - Date.parse(serverDrag.doneAt ?? '')
  judge('ⓕ 서버 doneAt = 실제 지금(모의 서버 doneClock)', serverDrag.doneAt !== null && ageMs >= 0 && ageMs < 120_000, { doneAt: serverDrag.doneAt, ageMs })
  judge('ⓕ 재조회 뒤에도 완료 칸에 보임', listsAfter > listsBefore && afterReload.includes(DRAG), { listsBefore, listsAfter, afterReload })

  // ⓖ 숨긴 이웃 + 순서 이동 (모의 출처 CORE — 씨앗 사본: CORE-7 g null · CORE-9 g5 20일 · CORE-10 g7 3일)
  await chooseSpace('CORE', 'CORE-7')
  const mockItems = async () => {
    const response = await js(`window.corral.workRequest({ requestId: 'l702-g-' + Date.now(), connectionId: ${JSON.stringify(mockId)}, call: { op: 'listItems', spaceKey: 'CORE', cursor: null } })`)
    return response?.ok ? response.result.items.map((item) => ({ key: item.key, rank: item.rank, statusKey: item.statusKey, category: item.category, doneAt: item.doneAt })) : null
  }
  const ordered = (items) => [...items].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
  const visibleDone = (items) => ordered(items).filter((item) => item.statusKey === 'core-done' && !(item.doneAt !== null && Date.now() - Date.parse(item.doneAt) >= 14 * 86_400_000)).map((item) => item.key)
  const g0 = await mockItems()
  const screen0 = await columnCards('core-done')
  log('ⓖ 시작 서버 순서(전체)', JSON.stringify(ordered(g0)), '화면 완료 칸', JSON.stringify(screen0))
  await shot('g0-core-done')
  judge('ⓖ 무대 — 숨긴 CORE-9 가 보이는 CORE-7·CORE-10 사이(서버 순서), 화면엔 CORE-7·CORE-10', JSON.stringify(ordered(g0).filter((item) => item.statusKey === 'core-done').map((item) => item.key)) === JSON.stringify(['CORE-7', 'CORE-9', 'CORE-10']) && JSON.stringify(screen0) === JSON.stringify(['CORE-7', 'CORE-10']), { screen0 })
  const reorderScene = async ({ label, from, to, where }) => {
    const moved = await dragIn(cdp, { from: `[data-issue-card="${from}"]`, to: `[data-issue-card="${to}"]`, where, lane: '[data-board-column="st:core-done"]' })
    log(`ⓖ ${label} 끌기`, JSON.stringify(moved))
    const optimistic = await columnCards('core-done')
    await sleep(2500)
    const server = await mockItems()
    const serverOrder = ordered(server)
    const index = serverOrder.findIndex((item) => item.key === from)
    const placedAfter = index > 0 ? serverOrder[index - 1].key : null
    const screen = await columnCards('core-done')
    log(`ⓖ ${label} 놓은 직후 화면`, JSON.stringify(optimistic), '서버 전체 순서', JSON.stringify(serverOrder.map((item) => `${item.key}:${item.rank}`)), `서버가 ${from} 을 놓은 자리 = ${placedAfter} 뒤`, '재조회 뒤 화면', JSON.stringify(screen))
    await shot(`g-${label}`)
    judge(`ⓖ ${label} — 재조회 뒤 화면 순서 = 서버 순서의 보이는 완료`, JSON.stringify(screen) === JSON.stringify(visibleDone(server)), { screen, server: visibleDone(server) })
    judge(`ⓖ ${label} — 놓은 직후(낙관) 화면 = 재조회 뒤 화면`, JSON.stringify(optimistic) === JSON.stringify(screen), { optimistic, screen })
    return { placedAfter }
  }
  const g1 = await reorderScene({ label: '1-아래로', from: 'CORE-7', to: 'CORE-10', where: 'bottom' })
  judge('ⓖ 1-아래로 — 서버가 받은 자리 = 보이는 이웃 CORE-10 뒤', g1.placedAfter === 'CORE-10', g1)
  const g2 = await reorderScene({ label: '2-맨위로', from: 'CORE-7', to: 'CORE-10', where: 'top' })
  log('ⓖ 2-맨위로 서버 자리', JSON.stringify(g2))
  cdp.close()
}

let exitCode = 1
try {
  await main()
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 && verdicts.length > 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
} finally {
  try { sh(['scripts/l702/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  if (fixtureProc !== null) { fixtureProc.kill('SIGTERM'); await sleep(800) }
  log('정리 뒤 남은 프로세스', JSON.stringify(spawnSync('sh', ['-c', `pgrep -f -- '--user-data-dir=${ROOT}/ud'; pgrep -f 'l702/fixture-server.mts ${fixtureUrl}'; true`], { encoding: 'utf8' }).stdout.trim()))
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
