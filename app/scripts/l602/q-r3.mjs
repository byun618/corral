#!/usr/bin/env node
// LIFE-602 수정 3 — 리뷰 r3 의 격리 Electron 재현(V20 `electron-conflict.mjs` · V17 `electron-sync.mjs`)을 옮겼다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-r3.mjs <conflict|sync> <ROOT=/tmp/l602q-*> <OUT 파일>
//
// conflict(R3-A): CORE-2 본문 편집기에 초안 → 실제 main/IPC 로 별도 updateItem(판 없이)을 보내 서버 본문을 바꿈(판 1→2) → 상세에서 코멘트 ⌘↵ 로
//   단건 재조회를 끝까지 → 초안 그대로 저장. 판정: 서버 본문 = 외부 본문 · 배너 있음 · 배너 칸에 본문 · 편집기·초안 유지.
// sync(R3-D): 모의 지연 400ms 연결에서 CORE-1 자식 생성 → 부모 재조회 중(「확인하는 중…」) 우선순위 높음 → 예약 쓰기가 끝날 때까지 기다림.
//   판정: 재조회 중에 눌렀음(대조) · 서버 우선순위 high · 배너 없음 · 화면 우선순위 높음.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [MODE, ROOT, OUT] = process.argv.slice(2)
if ((MODE !== 'conflict' && MODE !== 'sync') || !ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-r3.mjs <conflict|sync> /tmp/l602q-<n> <OUT 파일>')
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

log(`# LIFE-602 q-r3 ${MODE} ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const token = MODE === 'sync' ? 'mock_l602_delay-400' : 'mock_l602_r3'
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('연결', added)
  const request = (call) => js(`window.corral.workRequest({ requestId: 'q-r3-' + Date.now(), connectionId: ${JSON.stringify(added.id)}, call: ${JSON.stringify(call)} })`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  const card = MODE === 'sync' ? 'CORE-1' : 'CORE-2'
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="${card}"]')`), { timeoutMs: 15_000, label: `보드 ${card}` })
  await click(`[data-tasks-board] [data-issue-card="${card}"]`)
  await until(() => js(`!!document.querySelector('[data-md-rendered]') && !document.querySelector('[data-issue-body-edit]').disabled`), { timeoutMs: 15_000, label: `상세 ${card}` })

  if (MODE === 'conflict') {
    await click('[data-issue-body-edit]')
    await set('[data-md-editor] textarea', 'MY OLD BASE DRAFT')
    const external = await request({ op: 'updateItem', itemId: 'm-2', fields: { body: 'EXTERNAL BODY MUST SURVIVE' }, ifVersion: null })
    log('외부 변경', { ok: external.ok, version: external.ok ? external.result.item.version : null })
    await set('[data-comment-composer] textarea', 'TRIGGER SYNC')
    await js(`document.querySelector('[data-comment-composer] textarea').focus()`)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Enter', modifiers: ['meta'] })
    await until(() => js(`!![...document.querySelectorAll('[data-activity-row="comment"]')].find((e) => e.textContent.includes('TRIGGER SYNC'))`), { timeoutMs: 10_000, label: '코멘트 줄' })
    await until(() => js(`!document.querySelector('[data-issue-busy]')`), { timeoutMs: 10_000, label: '재조회 끝' })
    await sleep(200)
    const draftBeforeSave = await js(`document.querySelector('[data-md-editor] textarea').value`)
    await click('[data-md-save]')
    await sleep(800)
    const server = await request({ op: 'getItem', itemId: 'm-2' })
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, fields: [...document.querySelectorAll('[data-conflict-field]')].map((e) => e.getAttribute('data-conflict-field')), editor: !!document.querySelector('[data-md-editor]'), draft: document.querySelector('[data-md-editor] textarea')?.value ?? null })`)
    const serverItem = server.ok ? { body: server.result.item.body, version: server.result.item.version } : { error: server.error }
    log('결과', { draftBeforeSave, server: serverItem, screen })
    judge('대조 — 저장 전 편집기 초안이 그대로', draftBeforeSave === 'MY OLD BASE DRAFT', draftBeforeSave)
    judge('서버 본문 = 외부 본문(덮이지 않음)', serverItem.body === 'EXTERNAL BODY MUST SURVIVE', JSON.stringify(serverItem))
    judge('충돌 배너 · 칸 = 본문', screen.banner !== null && screen.fields.includes('body'), JSON.stringify(screen))
    judge('편집기·초안 유지', screen.editor && screen.draft === 'MY OLD BASE DRAFT', JSON.stringify(screen))
  } else {
    await click('[data-child-add]')
    await set('[data-child-title]', 'CHILD VIA ELECTRON')
    await js(`document.querySelector('[data-child-title]').focus()`)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Enter' })
    await until(() => js(`!document.querySelector('[data-child-title]')`), { everyMs: 20, timeoutMs: 10_000, label: '자식 보냄' })
    const syncBusy = await js(`!!document.querySelector('[data-issue-busy]')`)
    await click('[data-field="priority"]')
    await click('[data-priority-row="high"]')
    await sleep(2500)
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, priority: document.querySelector('[data-field="priority"]').textContent, busy: !!document.querySelector('[data-issue-busy]') })`)
    const server = await request({ op: 'getItem', itemId: 'm-1' })
    const serverItem = server.ok ? { priority: server.result.item.priority, version: server.result.item.version } : { error: server.error }
    log('결과', { syncBusy, screen, server: serverItem })
    judge('대조 — 부모 재조회 중(확인하는 중…)에 눌렀다', syncBusy === true, String(syncBusy))
    judge('서버 우선순위 high', serverItem.priority === 'high', JSON.stringify(serverItem))
    judge('배너 없음 · 화면 높음', screen.banner === null && screen.priority.includes('높음'), JSON.stringify(screen))
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
