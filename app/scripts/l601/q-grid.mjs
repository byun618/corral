#!/usr/bin/env node
// LIFE-601 최종 관문 1단계 — C1 격자 요청 0 격리 측정 + 양성 대조. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-grid.mjs <ROOT=/tmp/l601g-*> <OUT 파일> [cover-control]
//
// 계측 = 격자를 herdr 로 실제로 보내는 마지막 관문(`GroupSession` — `resize request` debug 줄 `kind`=viewer|attach 와 control `counters.gridRequests`).
// `stream.sync`(렌더러가 선언한 격자 수신)는 보조 관측. 격리 앱(up.sh — CORRAL_CONTROL_SOCKET 이 있어 corralLogger 가 debug 줄을 남긴다)에서:
//   임시 git 레포 하나를 더하고 열어 pane 을 둘로 나눔(보이는 터미널 2) → 기준 N0 → ⌘I 열기·닫기 10회(매 회 DOM 으로 열림·닫힘 확인) → N1
//   통과선: `resize request` 증가 0 · gridRequests 증가 0. 구간 안 `kind=attach` 줄·stream 재연결이 있으면 그 회차 무효(다시, 최대 3회 — 무효도 남긴다).
//   양성 ① 창 크기 1회 변경 → 는다 · 양성 ② pane 줌(⌘⇧Z, 강제 전송) → gridRequests 는 늘고 stream.sync 는 그대로.
// `cover-control` = 양성 ③ 실행: `.main-area-content.is-covered` 를 `display:none` 으로 바꾼 **사본 빌드**에서 돌린다 — 여닫기에서 늘어야 통과(덮기 방식이 판별된다).
// 결과 JSON = <OUT>.json. 종료 코드: 0 판정 통과 · 1 미달 · 2 사용법.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, MODE] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601g-') || OUT === undefined || (MODE !== undefined && MODE !== 'cover-control')) {
  console.error('사용법: node scripts/l601/q-grid.mjs /tmp/l601g-<n> <OUT 파일> [cover-control]')
  process.exit(2)
}
const control = MODE === 'cover-control'
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
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const lines = () => { try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n') } catch { return [] } }
/** 지금까지의 계측 — 줄 수(kind 별) · gridRequests 합 · stream.sync 줄 · 재연결/attach 표지. */
const measure = async () => {
  const all = lines()
  const resize = all.filter((line) => line.includes('resize request'))
  const counters = (await ctl(ROOT, { cmd: 'counters' })).counters ?? []
  return {
    at: all.length,
    resizeViewer: resize.filter((line) => line.includes('"kind":"viewer"')).length,
    resizeAttach: resize.filter((line) => line.includes('"kind":"attach"')).length,
    resizeAll: resize.length,
    gridRequests: counters.reduce((sum, entry) => sum + (entry.gridRequests ?? 0), 0),
    streamSync: all.filter((line) => line.includes('"tag":"stream.sync"')).length,
    reconnect: all.filter((line) => /"tag":"stream\.(reconnect|open|close|refocus)"|reconnect/.test(line)).length,
  }
}
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((key) => key !== 'at').map((key) => [key, b[key] - a[key]]))

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-grid ${new Date().toISOString()} ROOT=${ROOT} mode=${control ? 'cover-control(사본 빌드 display:none)' : 'product'} APP=${APP.replaceAll(process.env.HOME ?? '~', '~')}`)
const css = fs.readFileSync(path.join(APP, 'src/renderer/src/components/tasks.css'), 'utf8').split('\n').find((line) => line.includes('.main-area-content.is-covered')) ?? null
log('덮기 규칙(이 빌드의 소스)', css)
let exitCode = 1
const result = { mode: control ? 'cover-control' : 'product', css, rounds: [], positives: {} }
try {
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '앱' })
  // 임시 레포(ROOT 아래) — 열어서 pane 을 둘로.
  const repo = path.join(ROOT, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.email=l601@example.invalid', '-c', 'user.name=l601', 'commit', '-q', '--allow-empty', '-m', 'init'])
  log('add-repo', await ctl(ROOT, { cmd: 'add-repo', root: repo }))
  await sleep(800)
  log('open', await js(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(repo)}, path: ${JSON.stringify(repo)}, isLinked: false })`))
  await until(() => js(`document.querySelectorAll('.term-host').length >= 1`), { timeoutMs: 20_000, label: '터미널' })
  await sleep(1_000)
  const paneId = await js(`window.corral.getState().then((s) => s.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.paneId)))[0] ?? null)`)
  await js(`window.corral.selectPane({ paneId: ${JSON.stringify(paneId)} })`)
  await sleep(400)
  log('split', await js(`window.corral.splitPane({ paneId: ${JSON.stringify(paneId)}, direction: 'right' })`))
  await until(() => js(`document.querySelectorAll('.term-host').length >= 2`), { timeoutMs: 15_000, label: '터미널 2' }).catch(() => null)
  await sleep(2_000)
  const panes = await js(`[...document.querySelectorAll('.term-host')].map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), visible: getComputedStyle(e).visibility } })`)
  log('보이는 터미널', panes)
  const shotBefore = await ctl(ROOT, { cmd: 'shot', name: 'g-grid-panes' })
  log('shot', shotBefore.file?.replaceAll(ROOT, '<ROOT>'))
  // 포커스 = 터미널(⌘I 가 터미널 포커스 중에도 앱에 온다).
  await js(`document.querySelector('.term-host textarea')?.focus()`)
  const focus = await js(`document.activeElement?.className ?? null`)
  log('포커스', focus)

  // 10회 여닫기 — 무효(attach·재연결)면 다시(최대 3회).
  let valid = null
  for (let round = 1; round <= 3 && valid === null; round += 1) {
    await sleep(1_000)
    const n0 = await measure()
    const states = []
    for (let index = 0; index < 10; index += 1) {
      await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
      await until(pageOpen, { timeoutMs: 5_000, label: `열림 ${index + 1}` }).catch(() => null)
      const opened = await pageOpen()
      await sleep(250)
      await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
      await until(async () => !(await pageOpen()), { timeoutMs: 5_000, label: `닫힘 ${index + 1}` }).catch(() => null)
      const closed = !(await pageOpen())
      states.push({ opened, closed })
      await sleep(250)
    }
    await sleep(1_000)
    const n1 = await measure()
    const window = lines().slice(n0.at, n1.at)
    const attach = window.filter((line) => line.includes('"kind":"attach"') || /reconnect/.test(line)).length
    const allToggled = states.every((state) => state.opened && state.closed)
    const entry = { round, n0, n1, delta: delta(n0, n1), states, attach, allToggled, invalid: attach > 0 || !allToggled }
    result.rounds.push(entry)
    log(`여닫기 10회 회차 ${round}`, entry)
    if (!entry.invalid) valid = entry
  }
  if (control) {
    judge('C1 양성 ③ 덮기를 display:none 으로 바꾼 사본 빌드 — 여닫기 10회에서 resize request·gridRequests 가 는다', valid !== null && valid.delta.resizeAll > 0 && valid.delta.gridRequests > 0, valid?.delta)
  } else {
    judge('C1 ⌘I 여닫기 10회(매 회 열림·닫힘 DOM 확인 · 터미널 2개 보임 · 무효 회차 제외) — resize request 증가 0 · gridRequests 증가 0', valid !== null && panes.length >= 2 && valid.delta.resizeAll === 0 && valid.delta.gridRequests === 0 && valid.n0.gridRequests > 0, { panes: panes.length, delta: valid?.delta, base: valid?.n0 })
    // 양성 ①
    const r0 = await measure()
    await ctl(ROOT, { cmd: 'resize-window', width: 1300, height: 820 })
    await sleep(1_500)
    const r1 = await measure()
    result.positives.resize = delta(r0, r1)
    judge('C1 양성 ① 같은 계측 · 창 크기 1회 변경 → resize request·gridRequests 가 는다', r1.resizeAll > r0.resizeAll && r1.gridRequests > r0.gridRequests, result.positives.resize)
    // 양성 ②
    await js(`document.querySelector('.term-host textarea')?.focus()`)
    await sleep(300)
    const z0 = await measure()
    await ctl(ROOT, { cmd: 'key', keyCode: 'Z', modifiers: ['meta', 'shift'] })
    await sleep(1_500)
    const z1 = await measure()
    const zoomed = await js(`window.corral.getState().then((s) => s.terminalGroups.map((g) => g.zoomedPaneId))`)
    result.positives.zoom = { ...delta(z0, z1), zoomed }
    judge('C1 양성 ② pane 줌(⌘⇧Z, 강제 전송) → gridRequests 는 늘고 stream.sync 는 그대로(보조 관측의 사각)', z1.gridRequests > z0.gridRequests && z1.streamSync === z0.streamSync, result.positives.zoom)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Z', modifiers: ['meta', 'shift'] })
    await sleep(500)
  }
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
