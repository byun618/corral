#!/usr/bin/env node
// LIFE-602 수정 4 — 리뷰 r4 의 격리 Electron 재현(V17 undo · V18 resolution, `codex-r4-raw/electron-boundaries.mjs`)을 옮겼다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-r4.mjs <undo|resolution> <ROOT=/tmp/l602q-*> <OUT 파일>
//
// undo(R4-A): 실제 main/IPC 로 CORE-2 본문을 `- [ ] ORIGINAL\n` 로 → 상세에서 체크 → 별도 요청으로 `- [x] ORIGINAL\nREMOTE NEW PARAGRAPH`(판 없이) →
//   코멘트 ⌘↵ 로 부수 재조회 → 화면에 새 문단 확인 → 토스트 「체크 칸」 되돌리기. 판정: 화면에 새 문단이 보였음(대조) · 서버 본문에 새 문단 · 배너 있음.
// resolution(R4-B): CORE-4(In Review) 상태 메뉴 열기 → 별도 요청으로 core-done/completed → 열린 메뉴에서 취소함.
//   판정: 서버 completed · 상태 쓰기 요청 1회(IPC 기록) · 배너 있음.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [MODE, ROOT, OUT] = process.argv.slice(2)
if ((MODE !== 'undo' && MODE !== 'resolution') || !ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-r4.mjs <undo|resolution> /tmp/l602q-<n> <OUT 파일>')
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
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const set = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return e.value })()`)

log(`# LIFE-602 q-r4 ${MODE} ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const token = 'mock_l602_r4'
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('연결', added)
  const request = (call) => js(`window.corral.workRequest({ requestId: 'q-r4-' + Date.now(), connectionId: ${JSON.stringify(added.id)}, call: ${JSON.stringify(call)} })`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  const card = MODE === 'undo' ? 'CORE-2' : 'CORE-4'
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="${card}"]')`), { timeoutMs: 15_000, label: `보드 ${card}` })
  if (MODE === 'undo') log('씨앗', await request({ op: 'updateItem', itemId: 'm-2', fields: { body: '- [ ] ORIGINAL\n' }, ifVersion: null }).then((r) => ({ ok: r.ok, version: r.ok ? r.result.item.version : null })))
  await click(`[data-tasks-board] [data-issue-card="${card}"]`)
  await until(() => js(`!!document.querySelector('[data-md-rendered]') && !document.querySelector('[data-issue-body-edit]').disabled`), { timeoutMs: 15_000, label: `상세 ${card}` })

  if (MODE === 'undo') {
    await click('[data-md-check]')
    await until(() => js(`!![...document.querySelectorAll('[data-toast="moved"]')].find((e) => e.textContent.includes('체크 칸'))`), { timeoutMs: 10_000, label: '체크 토스트' })
    const external = await request({ op: 'updateItem', itemId: 'm-2', fields: { body: '- [x] ORIGINAL\nREMOTE NEW PARAGRAPH' }, ifVersion: null })
    log('외부 변경', { ok: external.ok, version: external.ok ? external.result.item.version : null })
    await set('[data-comment-composer] textarea', 'TRIGGER SYNC')
    await js(`document.querySelector('[data-comment-composer] textarea').focus()`)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Enter', modifiers: ['meta'] })
    await until(() => js(`document.querySelector('[data-issue-body]').textContent.includes('REMOTE NEW PARAGRAPH')`), { timeoutMs: 10_000, label: '새 문단 보임' })
    await until(() => js(`!document.querySelector('[data-issue-busy]')`), { timeoutMs: 10_000, label: '재조회 끝' })
    const before = await js(`document.querySelector('[data-issue-body]').textContent`)
    const clicked = await js(`(() => { const row = [...document.querySelectorAll('[data-toast="moved"]')].find((e) => e.textContent.includes('체크 칸')); if (!row) return false; row.querySelector('[data-toast-undo]').click(); return true })()`)
    await sleep(800)
    const server = await request({ op: 'getItem', itemId: 'm-2' })
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, fields: [...document.querySelectorAll('[data-conflict-field]')].map((e) => e.getAttribute('data-conflict-field')), body: document.querySelector('[data-issue-body]').textContent })`)
    const serverItem = server.ok ? { body: server.result.item.body, version: server.result.item.version } : { error: server.error }
    log('결과', { before, clicked, server: serverItem, screen })
    judge('대조 — 되돌리기 전 화면에 새 문단 · 되돌리기 눌림', before.includes('REMOTE NEW PARAGRAPH') && clicked === true, JSON.stringify({ before, clicked }))
    judge('서버 본문에 외부 새 문단 남음', typeof serverItem.body === 'string' && serverItem.body.includes('REMOTE NEW PARAGRAPH'), JSON.stringify(serverItem))
    judge('충돌 배너 · 칸 = 본문', screen.banner !== null && screen.fields.includes('body'), JSON.stringify(screen))
  } else {
    await click('[data-issue-status]')
    await until(() => js(`!!document.querySelector('[data-status-resolution="cancelled"]')`), { timeoutMs: 10_000, label: '상태 메뉴' })
    const external = await request({ op: 'changeStatus', itemId: 'm-4', statusKey: 'core-done', resolution: 'completed', ifVersion: null })
    log('외부 변경', { ok: external.ok, version: external.ok ? external.result.item.version : null, resolution: external.ok ? external.result.item.resolution : null })
    await click('[data-status-resolution="cancelled"]')
    await sleep(800)
    const server = await request({ op: 'getItem', itemId: 'm-4' })
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, fields: [...document.querySelectorAll('[data-conflict-field]')].map((e) => e.getAttribute('data-conflict-field')), status: document.querySelector('[data-issue-status]').textContent })`)
    const serverItem = server.ok ? { statusKey: server.result.item.statusKey, resolution: server.result.item.resolution, version: server.result.item.version } : { error: server.error }
    // 화면이 보낸 상태 쓰기 응답 수 — 격리 IPC 기록(<ROOT>/ipc-trace.ndjson)의 workRequest 응답 중 성공 changeStatus 또는 거절(ok:false). 외부·판정 요청은 requestId 'q-r4-' 로 뺀다.
    const trace = (await import('node:fs')).readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"channel":"corral:workRequest"') && !line.includes('"requestId":"q-r4-') && (line.includes('"op":"changeStatus"') || line.includes('"ok":false')))
    log('결과', { server: serverItem, screen, uiChangeStatusLines: trace.length })
    judge('서버 갈래 completed(외부 완료함 보존)', serverItem.resolution === 'completed', JSON.stringify(serverItem))
    judge('충돌 배너 · 칸 = 상태', screen.banner !== null && screen.fields.includes('status'), JSON.stringify(screen))
    judge('화면 상태 쓰기 요청 1회(자동 재시도 없음)', trace.length === 1, String(trace.length))
  }
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l602/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
