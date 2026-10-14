#!/usr/bin/env node
// LIFE-601 최종 관문 1단계 — C13 디자인 대조(격리). app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-design.mjs <ROOT=/tmp/l601g-*> <OUT 파일>
//
// 01-criteria C13 의 T2 범위 `data-*` 전부가 **어느 상태에서든** 화면에 나오는지 스크립트로 본다 — 보기·상태를 바꿔 가며(배너 셋 · 빈 상태 · 불러오는 중 ·
// 토스트 · 작업 중 줄) 상태마다 DOM 을 훑고, 한 번도 안 나온 선택자 = 미달. 음성 대조: `L601_EXTRA_SELECTOR=<선택자>` 를 목록에 더하면(없는 선택자) 실패해야 한다.
// 캡처(격리 — **네이티브가 아님**, 설치본 캡처는 2단계): 보기 4 · 칸 없는 상태 점선 칸 · 「· 받은 것」 진행 · 끄는 중 흐림 + 이유 · 작업 중 줄(시간).
// (배너 3 · 빈 상태 · 백로그 탭 흐림 캡처는 q-final 이 같은 이름 규칙으로 남긴다.) 결과 JSON = <OUT>.json. 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601g-') || OUT === undefined) {
  console.error('사용법: node scripts/l601/q-design.mjs /tmp/l601g-<n> <OUT 파일>')
  process.exit(2)
}
/** 01-criteria C13 T2 범위(freeze 0871632) — 값이 붙은 것은 그 값까지. */
const T2 = [
  '[data-tasks-open]', '[data-tasks-page]', '[data-tasks-views]', '[data-space-switch]', '[data-tasks-search]', '[data-tasks-close]', '[data-tasks-filters]',
  '[data-filter="kind"]', '[data-filter="priority"]', '[data-filter="blocked"]', '[data-filter="working"]', '[data-clear-filters]',
  '[data-tasks-banner="auth"]', '[data-tasks-banner="forbidden"]', '[data-tasks-banner="offline"]', '[data-tasks-loading]', '[data-tasks-empty]',
  '[data-tasks-board]', '[data-board-band]', '[data-board-column]', '[data-issue-card]', '[data-issue-blocked]', '[data-tasks-backlog]', '[data-backlog-section]',
  '[data-issue-row]', '[data-tasks-list]', '[data-tasks-working]', '[data-working-item]', '[data-working-worktree]', '[data-toast]', '[data-toast-undo]',
]
const EXTRA = process.env.L601_EXTRA_SELECTOR ?? null
const SELECTORS = EXTRA === null ? T2 : [...T2, EXTRA]
const log = recorder(path.resolve(OUT))
const sh = (args) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8' })
  log(`$ sh ${args.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
  if (run.status !== 0) throw new Error(`${args[0]} 실패`)
}
const js = (code) => evalJs(ROOT, code)
const q = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`)
const click = async (selector) => {
  let last = null
  await until(async () => { last = await ctl(ROOT, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: selector }).catch(() => null)
  if (!last?.ok) throw new Error(`클릭 실패 ${selector} ${JSON.stringify(last)}`)
}
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const settled = async () => {
  await until(async () => !(await q('[data-tasks-loading]')) && !(await q('[data-tasks-refreshing]')), { timeoutMs: 15_000, everyMs: 200, label: '불러오기 끝' }).catch(() => null)
  await sleep(500)
}
const shots = []
const shot = async (name) => { const r = await ctl(ROOT, { cmd: 'shot', name: `g-design-${name}` }); shots.push(name); return r.file?.replaceAll(ROOT, '<ROOT>') ?? null }
const center = (selector) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(r.y + Math.min(r.height / 2, 20)) } })()`)

/** 상태 하나에서 선택자마다 있는지 — 처음 본 상태 이름을 남긴다. */
const seen = new Map()
const scan = async (state) => {
  const found = await js(`${JSON.stringify(SELECTORS)}.filter((s) => !!document.querySelector(s))`)
  for (const selector of found) if (!seen.has(selector)) seen.set(selector, state)
  log(`훑기 ${state}`, `${found.length}/${SELECTORS.length}`)
}
let connectionId = null
const connect = async (token) => {
  const result = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: ${JSON.stringify(connectionId)} }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('connect', { token, ok: result?.ok })
  connectionId = result?.id ?? connectionId
  await sleep(500)
}

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-design ${new Date().toISOString()} ROOT=${ROOT} extra=${EXTRA ?? '-'}`)
let exitCode = 1
try {
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => q('[data-tasks-open]'), { timeoutMs: 30_000, label: '앱' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1500, height: 900 })
  await scan('닫힘(사이드바)')
  // 작업 중 줄 — 브랜치 이름에 키(CORE-1)가 든 레포를 열어 둔다.
  const repo = path.join(ROOT, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'CORE-1-review', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.email=l601@example.invalid', '-c', 'user.name=l601', 'commit', '-q', '--allow-empty', '-m', 'init'])
  log('add-repo', (await ctl(ROOT, { cmd: 'add-repo', root: repo })).ok)
  await sleep(800)
  log('open', await js(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(repo)}, path: ${JSON.stringify(repo)}, isLinked: false }).then((r) => r.ok ?? r)`))
  await sleep(2_000)
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '열림' })
  await scan('연결 없음')
  await connect('mock_delay-1500')
  await until(() => q('[data-tasks-loading]'), { timeoutMs: 8_000, everyMs: 100, label: '불러오는 중' }).catch(() => null)
  await scan('불러오는 중(delay-1500)')
  await settled()
  await connect('mock_demo')
  await settled()
  await scan('보드')
  const board = await shot('board')
  const partial = await js(`[...document.querySelectorAll('[data-progress-partial]')].map((e) => e.closest('[data-issue-card]')?.getAttribute('data-issue-card'))`)
  const unmapped = await js(`[...document.querySelectorAll('[data-board-band="unmapped"] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
  log('보드 — 받은 것 진행 · 점선 칸', { board, partial, unmapped })
  // 끄는 중 흐림 + 이유 — 허용 전이 밖 칸.
  const from = await center('[data-issue-card="CORE-2"]')
  const to = await js(`(() => { const r = document.querySelector('[data-drop-zone="col:st:core-done"]').getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.bottom - 6) } })()`)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from.x + 10, y: from.y })
  await sleep(700)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...to })
  await sleep(500)
  const dim = await js(`(() => { const c = document.querySelector('[data-board-column="st:core-done"]'); return { cls: c?.className ?? null, reason: c?.querySelector('[data-column-reason]')?.textContent ?? null, opacity: c ? getComputedStyle(c).opacity : null } })()`)
  const dragging = await shot('dragging-dim')
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', x: -10, y: -10 })
  await sleep(400)
  log('끄는 중 흐림', { dim, dragging })
  // 토스트 + 되돌리기 — 허용 칸으로 한 번.
  const from2 = await center('[data-issue-card="CORE-2"]')
  const to2 = await js(`(() => { const r = document.querySelector('[data-drop-zone="col:st:core-doing"]').getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.bottom - 6) } })()`)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from2 })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from2.x + 10, y: from2.y })
  await sleep(700)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...to2 })
  await sleep(400)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...to2 })
  await until(() => q('[data-toast-undo]'), { timeoutMs: 5_000, label: '토스트' }).catch(() => null)
  await scan('토스트')
  await shot('toast')
  // 필터(지우기 단추) · 빈 상태(필터)
  await click('[data-filter="blocked"]')
  await sleep(400)
  await scan('필터 켬')
  await click('[data-clear-filters]')
  for (const view of ['backlog', 'list', 'working']) {
    await click(`[data-tasks-view-tab="${view}"]`)
    await settled()
    await scan(`보기 ${view}`)
    await shot(`view-${view}`)
  }
  const working = await js(`[...document.querySelectorAll('[data-working-item]')].map((e) => e.textContent)`)
  log('작업 중 줄', working)
  await click('[data-tasks-view-tab="board"]')
  for (const [kind, token] of [['auth', 'mock_fault-auth'], ['forbidden', 'mock_fault-forbidden'], ['offline', 'mock_fault-network']]) {
    await connect(token)
    await until(() => q(`[data-tasks-banner="${kind}"]`), { timeoutMs: 8_000, label: kind }).catch(() => null)
    await scan(`배너 ${kind}`)
  }
  const missing = SELECTORS.filter((selector) => !seen.has(selector))
  const table = SELECTORS.map((selector) => ({ selector, firstSeen: seen.get(selector) ?? null }))
  log('선택자별 처음 본 상태', table)
  const pass = missing.length === 0 && partial.length > 0 && unmapped.length > 0 && dim.reason !== null && Number(dim.opacity) < 1
  log(`[판정] C13 T2 data-* ${SELECTORS.length - missing.length}/${SELECTORS.length} 존재 · 받은 것 진행 ${partial.length} · 점선 칸 ${unmapped.length} · 끄는 중 흐림 ${dim.opacity} — ${pass ? '통과' : '미달'}`, missing.join(' ') || '없는 것 0')
  fs.writeFileSync(path.resolve(`${OUT}.json`), JSON.stringify({ selectors: table, missing, partial, unmapped, dim, working, shots }, null, 2))
  exitCode = pass ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l601/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
