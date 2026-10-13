#!/usr/bin/env node
// LIFE-601 빠른 층 「핵심 진입점 1회」 — 격리 개발 앱에서 작업 페이지를 열어 보드가 그려지는지. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-entry.mjs <ROOT=/tmp/l601q-*> <OUT 파일>
//
// 흐름: 앱 기동(모의 출처 — up.sh) → 모의 연결 추가(렌더러 IPC, 가짜 토큰) → ⌘I(앱 내부 sendInputEvent — OS 입력 아님) → 보드
//       → 칸·점선 칸·막힘 배지·덮기(사이드바 보임 · 메인 영역 숨김) → ⌘I 닫기 → 사이드바 「작업」 으로 다시 열기 → 보기 4 → Esc 닫기 → 정리.
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
  judge('C6 보드 — 밴드 3 · 상태 칸 4(워크플로 순서) + 점선 칸', JSON.stringify(board.bands) === '["todo","in_progress","done"]' && JSON.stringify(board.columns) === '["st:core-todo","st:core-doing","st:core-review","st:core-done","st:__unmapped"]', JSON.stringify(board.columns))
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

  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(async () => !(await pageOpen()), { timeoutMs: 10_000, label: '⌘I 로 닫힘' })
  const closedCover = await js(`(() => { const c = document.querySelector('[data-main-area-content]'); return { mainContent: c ? getComputedStyle(c).visibility : null, inert: c?.hasAttribute('inert') ?? null } })()`)
  judge('C1 ⌘I 로 닫힘 — 메인 영역 다시 보임', closedCover.mainContent === 'visible' && closedCover.inert === false, JSON.stringify(closedCover))

  await click('[data-tasks-open]')
  await until(pageOpen, { timeoutMs: 10_000, label: '사이드바 버튼으로 열림' })
  judge('C1 사이드바 「작업」 으로 다시 열림 · 보드 그대로', await js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-1"]')`))

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
