#!/usr/bin/env node
// LIFE-601 최종 관문 1단계 — 2단계 준비 확인: 실제 마우스가 필요한 단계(가로 끌기 · 백로그 섹션 끌기 · 창 밖 놓기 · 끄는 중 ⌘I)를
// **CDP `Input.dispatchMouseEvent`**(cdp-drag.mjs — 설치본에 코디가 쓸 그 도구)로 대신할 수 있는지 격리 앱에서 본다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-cdp.mjs <ROOT=/tmp/l601g-*> <OUT 파일> <포트>
//
// 격리 앱을 `--remote-debugging-port=<포트>` 로 띄우고(up.sh `L601_EXTRA_ARGS`), 연결은 control 소켓으로 더한 뒤 끌기·키는 전부 CDP 로만 보낸다.
// 판정은 서버 재조회 값(renderer `workRequest`)과 main 로그 쓰기 줄 수. 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'
import { connect, drag, pressKey } from './cdp-drag.mjs'

const [ROOT, OUT, PORT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601g-') || OUT === undefined || !/^\d+$/.test(PORT ?? '')) {
  console.error('사용법: node scripts/l601/q-cdp.mjs /tmp/l601g-<n> <OUT 파일> <포트>')
  process.exit(2)
}
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, JSON.stringify(detail ?? ''))
}
const sh = (args) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8' })
  log(`$ sh ${args.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
  if (run.status !== 0) throw new Error(`${args[0]} 실패`)
}
const js = (code) => evalJs(ROOT, code)
const writeLines = () => {
  try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"work.request"') && /"op":"(changeStatus|setPlacement|reorder)"/.test(line)).length } catch { return null }
}
let connectionId = null
const serverItem = async (key) => {
  const response = await js(`window.corral.workRequest({ requestId: 'q-cdp-' + Date.now(), connectionId: ${JSON.stringify(connectionId)}, call: { op: 'findByKey', key: ${JSON.stringify(key)} } })`)
  return response?.ok ? response.result.item : null
}
const pageOpen = (cdp) => cdp.evaluate(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-cdp ${new Date().toISOString()} ROOT=${ROOT} port=${PORT}`)
let exitCode = 1
let cdp = null
try {
  sh(['scripts/l601/up.sh', ROOT, `L601_EXTRA_ARGS=--remote-debugging-port=${PORT}`])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '앱' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1500, height: 900 })
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_demo', replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  connectionId = added.id
  cdp = await connect(PORT)
  log('CDP 연결', { port: PORT })
  await pressKey(cdp, 'Mod+I')
  await until(() => pageOpen(cdp), { timeoutMs: 10_000, label: 'CDP ⌘I 로 열림' })
  await sleep(1_500)
  judge('CDP 키 ⌘I(Input.dispatchKeyEvent) 로 작업 페이지 열림', await pageOpen(cdp))

  // ① 가로 끌기 CORE-2(core-todo) → core-doing
  const w0 = writeLines()
  const before = (await serverItem('CORE-2'))?.statusKey
  const horizontal = await drag(cdp, { from: '[data-issue-card="CORE-2"]', to: '[data-drop-zone="col:st:core-doing"]' })
  await until(() => js(`!!document.querySelector('[data-toast="moved"]')`), { timeoutMs: 5_000, label: '토스트' }).catch(() => null)
  await sleep(500)
  const after = (await serverItem('CORE-2'))?.statusKey
  judge('CDP 가로 끌기 — 사본 · 쓰기 1 · 토스트 · 서버 재조회 core-todo → core-doing', horizontal.during?.preview === true && before === 'core-todo' && after === 'core-doing' && writeLines() - w0 === 1, { horizontal, before, after, writes: writeLines() - w0 })

  // ② 끄는 중 ⌘I — 닫힘 · 쓰기 0
  const w1 = writeLines()
  const k0 = (await serverItem('CORE-6'))?.statusKey
  const midKey = await drag(cdp, { from: '[data-issue-card="CORE-6"]', to: '[data-drop-zone="col:st:core-doing"]', keyMid: 'Mod+I' })
  await sleep(1_000)
  const closed = !(await pageOpen(cdp))
  judge('CDP 끄는 중 ⌘I — 페이지 닫힘 · 쓰기 0 · 서버 값 그대로', midKey.during?.preview === true && closed && writeLines() === w1 && (await serverItem('CORE-6'))?.statusKey === k0, { midKey, closed, writes: writeLines() - w1, k0 })
  await pressKey(cdp, 'Mod+I')
  await until(() => pageOpen(cdp), { timeoutMs: 10_000, label: '다시 열림' })
  await sleep(800)

  // ③ 창 밖 놓기 — 쓰기 0
  const w2 = writeLines()
  const o0 = (await serverItem('CORE-6'))?.statusKey
  const outside = await drag(cdp, { from: '[data-issue-card="CORE-6"]', to: '[data-drop-zone="col:st:core-doing"]', upOutside: true })
  await sleep(1_000)
  judge('CDP 창 밖 좌표 놓기 — 쓰기 0 · 사본 사라짐 · 서버 값 그대로', outside.during?.preview === true && writeLines() === w2 && !(await js(`!!document.querySelector('.tasks-drag-preview')`)) && (await serverItem('CORE-6'))?.statusKey === o0, { outside, writes: writeLines() - w2 })

  // ④ 백로그 섹션 사이 — 보드 → 백로그(setPlacement) → 서버 backlog
  await ctl(ROOT, { cmd: 'click', selector: '[data-tasks-view-tab="backlog"]' })
  await sleep(800)
  const key = await js(`document.querySelector('[data-backlog-section="board"] [data-issue-row]')?.getAttribute('data-issue-row') ?? null`)
  const w3 = writeLines()
  const backlog = await drag(cdp, { from: `[data-backlog-section="board"] [data-issue-row="${key}"] .tasks-grip`, to: '[data-drop-zone="sec:backlog"]' })
  await until(async () => (await serverItem(key))?.placement === 'backlog', { timeoutMs: 5_000, label: '배치' }).catch(() => null)
  judge('CDP 백로그 섹션 끌기 — 쓰기 1 · 서버 재조회 placement backlog', backlog.during?.preview === true && (await serverItem(key))?.placement === 'backlog' && writeLines() - w3 === 1, { key, backlog, writes: writeLines() - w3 })

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(ROOT, 'shots', 'g-cdp-backlog.png'), Buffer.from(shot.result.data, 'base64'))
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  cdp?.close()
  try { sh(['scripts/l601/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
