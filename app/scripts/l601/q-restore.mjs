#!/usr/bin/env node
// LIFE-601 최종 관문 1단계 — C3 상태 복원(격리). app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-restore.mjs <ROOT=/tmp/l601g-*> <OUT 파일>
//
// ① 닫고 다시 열기: 리스트에서 「더 불러오기」(받은 쪽) · 검색어 · 스크롤을 둔 채 ⌘I 닫기·열기 → 그대로.
// ② 재시작: 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본을 바꾸고 → 앱을 실제로 끈다(down.sh — SIGTERM, app.quit 경로) → 같은 userData 로 다시 띄워 → ⌘I →
//    값 대조(전/뒤 JSON). 검색어·스크롤은 재시작 뒤 남지 않는 것이 정상(C3 — 같은 실행 안에서만).
// 값은 화면(DOM)과 ui-prefs 파일(`<ROOT>/ud/ui-prefs.json`) 둘 다에서 읽는다. 설치본 재시작은 2단계 몫.
// 결과 JSON = <OUT>.json. 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601g-') || OUT === undefined) {
  console.error('사용법: node scripts/l601/q-restore.mjs /tmp/l601g-<n> <OUT 파일>')
  process.exit(2)
}
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass, detail })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, JSON.stringify(detail ?? ''))
}
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
const toggle = async (want) => {
  if ((await pageOpen()) === want) return
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(async () => (await pageOpen()) === want, { timeoutMs: 10_000, label: want ? '열림' : '닫힘' })
  await sleep(600)
}
const settled = async () => {
  await until(async () => !(await q('[data-tasks-loading]')) && !(await q('[data-tasks-refreshing]')), { timeoutMs: 15_000, everyMs: 200, label: '불러오기 끝' }).catch(() => null)
  await sleep(400)
}
const setInput = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const setSelect = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
const clickText = (selector, text) => js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true })()`)
const prefsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'ud/ui-prefs.json'), 'utf8')).tasksPage ?? null } catch (error) { return `읽기 실패 ${error}` } }
/** 화면에서 읽는 상태 — 보기에 따라 없는 칸은 null. */
const screen = () => js(`(() => ({
  space: document.querySelector('[data-space-switch]')?.textContent?.trim() ?? null,
  view: document.querySelector('[data-tasks-view-tab][aria-selected="true"]')?.getAttribute('data-tasks-view-tab') ?? null,
  filters: [...document.querySelectorAll('[data-filter]')].map((e) => [e.getAttribute('data-filter'), e.getAttribute('aria-pressed'), e.textContent.trim()]),
  sort: document.querySelector('[data-tasks-sort]')?.value ?? null,
  group: document.querySelector('[data-tasks-group]')?.value ?? null,
  density: document.querySelector('[data-tasks-density]')?.getAttribute('data-tasks-density') ?? null,
  defaultPreset: document.querySelector('[data-preset-default]')?.closest('[data-tasks-preset]')?.getAttribute('data-tasks-preset') ?? null,
  query: document.querySelector('[data-tasks-search]')?.value ?? null,
  scroll: document.querySelector('[data-tasks-scroll="list"]')?.scrollTop ?? null,
  rows: [...document.querySelectorAll('[data-tasks-list] [data-issue-row]')].map((e) => e.getAttribute('data-issue-row')),
}))()`)
const PERSISTED = ['space', 'view', 'filters', 'sort', 'group', 'density', 'defaultPreset']
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]))

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-restore ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
const result = {}
try {
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => q('[data-tasks-open]'), { timeoutMs: 30_000, label: '앱' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1300, height: 460 })
  log('connect', await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_demo', replaceId: null }).then((r) => r.ok)`))
  await toggle(true)
  await settled()

  // ① 닫고 다시 열기 — 받은 쪽 · 검색어 · 스크롤
  await click('[data-tasks-view-tab="list"]')
  await sleep(300)
  await click('[data-tasks-more-button]')
  await until(async () => !(await q('[data-tasks-more]')), { timeoutMs: 8_000, label: '전부 받음' }).catch(() => null)
  await setInput('[data-tasks-search]', 'CORE')
  await sleep(500)
  await js(`(() => { const s = document.querySelector('[data-tasks-scroll="list"]'); s.scrollTop = 50; s.dispatchEvent(new Event('scroll')); return s.scrollTop })()`)
  await sleep(300)
  const closeBefore = await screen()
  await toggle(false)
  await toggle(true)
  await settled()
  const closeAfter = await screen()
  result.reopen = { before: closeBefore, after: closeAfter }
  judge('C3 닫고 다시 열기 — 스페이스·보기·필터·검색어·정렬·그룹·밀도·스크롤·받은 행 그대로',
    closeBefore.rows.length > 6 && closeBefore.scroll > 0 && closeBefore.query === 'CORE' && JSON.stringify(closeAfter) === JSON.stringify(closeBefore),
    { before: { ...closeBefore, rows: closeBefore.rows.length }, after: { ...closeAfter, rows: closeAfter.rows.length } })
  await setInput('[data-tasks-search]', '')

  // ② 재시작 — 기본값과 다른 값으로 바꾼다.
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', button: 'right', ...(await js(`(() => { const r = document.querySelector('[data-tasks-preset="blocked"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)) })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', button: 'right', ...(await js(`(() => { const r = document.querySelector('[data-tasks-preset="blocked"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)) })
  await sleep(300)
  await setSelect('[data-tasks-sort]', 'due')
  await setSelect('[data-tasks-group]', 'priority')
  await click('[data-tasks-density]')
  await click('[data-filter="priority"]')
  const pickedPriority = await clickText('[data-tasks-menu="priority"] [role="menuitemcheckbox"]', '보통')
  await click('[data-filter="priority"]').catch(() => null)
  // (막힘 필터는 켜지 않는다 — WEB 에서 빈 상태가 되면 리스트 도구(정렬·그룹)가 그려지지 않아 화면에서 못 읽는다.)
  await click('[data-space-switch]')
  await click('[data-space-row="WEB"]')
  await settled()
  await sleep(800)
  const restartBefore = await screen()
  const fileBefore = prefsFile()
  await ctl(ROOT, { cmd: 'flush-storage' }).catch(() => null)
  log('재시작 전', { screen: restartBefore, file: fileBefore, pickedPriority })
  sh(['scripts/l601/down.sh', ROOT, 'herdr'])
  const appGone = spawnSync('pgrep', ['-f', `--user-data-dir=${ROOT}/ud`], { encoding: 'utf8' }).stdout.trim()
  log('끈 뒤 남은 앱 프로세스', appGone === '' ? '없음' : appGone)
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => q('[data-tasks-open]'), { timeoutMs: 30_000, label: '다시 띄운 앱' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1300, height: 460 })
  await sleep(1_500)
  await toggle(true)
  await settled()
  await sleep(800)
  const restartAfter = await screen()
  const fileAfter = prefsFile()
  result.restart = { before: restartBefore, after: restartAfter, fileBefore, fileAfter, appGone }
  const changed = restartBefore.view === 'list' && restartBefore.sort === 'due' && restartBefore.group === 'priority' && restartBefore.density === 'compact' && restartBefore.defaultPreset === 'blocked'
    && restartBefore.space?.includes('Web') && restartBefore.filters.some(([id, pressed]) => id === 'priority' && pressed === 'true')
  judge('C3 재시작(앱을 끄고 같은 userData 로 다시) — 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본 그대로(화면 · ui-prefs 파일)',
    changed && pickedPriority === true && appGone === '' && JSON.stringify(pick(restartAfter, PERSISTED)) === JSON.stringify(pick(restartBefore, PERSISTED)) && JSON.stringify(fileAfter) === JSON.stringify(fileBefore),
    { before: pick(restartBefore, PERSISTED), after: pick(restartAfter, PERSISTED), file: fileAfter })
  judge('C3 재시작 뒤 검색어는 남지 않는다(같은 실행 안에서만 — 정상)', restartAfter.query === '', { query: restartAfter.query })
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  fs.writeFileSync(path.resolve(`${OUT}.json`), JSON.stringify({ ...result, verdicts }, null, 2))
  try { sh(['scripts/l601/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
