#!/usr/bin/env node
// LIFE-602 수정 5(범위 축소) — 리뷰 r5 의 격리 Electron 원본 빌드 재현(V12 roundtrip · V13 own-body, `codex-r5-raw/electron-adjacent.mjs`)을 옮겼다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-r5.mjs <roundtrip|ownbody> <ROOT=/tmp/l602q-*> <OUT 파일>
//
// roundtrip(R5r-A): CORE-4 완료함 → 별도 요청으로 갈래 취소함(판 없이) → 코멘트 ⌘↵ 재조회 → 우선순위 높음 → 보통 → 처음 상태 토스트의 되돌리기(있으면 누름).
//   판정: 재조회 뒤 화면에 취소함(대조) · 상태 되돌리기 토스트 없음 · 서버 갈래 cancelled.
// ownbody(R5r-B): CORE-2 본문 `- [ ] FIRST\n` → 체크 → 편집기로 `- [x] FIRST\nLATER OWN PARAGRAPH` 저장 → 「체크 칸」 토스트의 되돌리기(있으면 누름).
//   판정: 체크 칸 토스트 없음 · 서버 본문에 뒤 문단.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [MODE, ROOT, OUT] = process.argv.slice(2)
if ((MODE !== 'roundtrip' && MODE !== 'ownbody') || !ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-r5.mjs <roundtrip|ownbody> /tmp/l602q-<n> <OUT 파일>')
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

log(`# LIFE-602 q-r5 ${MODE} ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const token = 'mock_l602_r5'
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('연결', added)
  const request = (call) => js(`window.corral.workRequest({ requestId: 'q-r5-' + Date.now(), connectionId: ${JSON.stringify(added.id)}, call: ${JSON.stringify(call)} })`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  const card = MODE === 'ownbody' ? 'CORE-2' : 'CORE-4'
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="${card}"]')`), { timeoutMs: 15_000, label: `보드 ${card}` })
  if (MODE === 'ownbody') log('씨앗', await request({ op: 'updateItem', itemId: 'm-2', fields: { body: '- [ ] FIRST\n' }, ifVersion: null }).then((r) => ({ ok: r.ok, version: r.ok ? r.result.item.version : null })))
  await click(`[data-tasks-board] [data-issue-card="${card}"]`)
  await until(() => js(`!!document.querySelector('[data-md-rendered]') && !document.querySelector('[data-issue-body-edit]').disabled`), { timeoutMs: 15_000, label: `상세 ${card}` })

  const idle = () => until(() => js(`!document.querySelector('[data-issue-busy]')`), { everyMs: 20, timeoutMs: 10_000, label: '확인 끝' })
  // 토스트의 되돌리기 — 있으면 누르고 true(고치기 전 재현), 없으면 false.
  const pressUndo = (label) => js(`(() => { const row = [...document.querySelectorAll('[data-toast="moved"]')].find((e) => e.textContent.includes(${JSON.stringify(label)})); const button = row?.querySelector('[data-toast-undo]'); if (!button) return false; button.click(); return true })()`)
  if (MODE === 'roundtrip') {
    await click('[data-issue-status]')
    await until(() => js(`!!document.querySelector('[data-status-resolution="completed"]')`), { timeoutMs: 10_000, label: '상태 메뉴' })
    await click('[data-status-resolution="completed"]'); await sleep(150); await idle()
    const external = await request({ op: 'changeStatus', itemId: 'm-4', statusKey: 'core-done', resolution: 'cancelled', ifVersion: null })
    log('외부 변경', { ok: external.ok, version: external.ok ? external.result.item.version : null, resolution: external.ok ? external.result.item.resolution : null })
    await set('[data-comment-composer] textarea', 'TRIGGER SYNC')
    await js(`document.querySelector('[data-comment-composer] textarea').focus()`)
    await ctl(ROOT, { cmd: 'key', keyCode: 'Enter', modifiers: ['meta'] })
    await until(() => js(`document.querySelector('[data-issue-status]').textContent.includes('취소함')`), { timeoutMs: 10_000, label: '취소함 보임' })
    await idle()
    const before = await js(`document.querySelector('[data-issue-status]').textContent`)
    for (const priority of ['high', 'medium']) {
      await click('[data-field="priority"]'); await click(`[data-priority-row="${priority}"]`); await sleep(150); await idle()
    }
    const pressed = await pressUndo('CORE-4 →')
    await sleep(800)
    const server = await request({ op: 'getItem', itemId: 'm-4' })
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, status: document.querySelector('[data-issue-status]').textContent, priority: document.querySelector('[data-field="priority"]').textContent })`)
    const serverItem = server.ok ? { statusKey: server.result.item.statusKey, resolution: server.result.item.resolution, priority: server.result.item.priority, version: server.result.item.version } : { error: server.error }
    log('결과', { before, pressed, server: serverItem, screen })
    judge('대조 — 재조회 뒤 화면에 취소함', before.includes('취소함'), before)
    judge('상태 되돌리기 토스트 없음(소멸)', pressed === false, String(pressed))
    judge('서버 갈래 cancelled(외부 갈래 보존) · 우선순위 medium', serverItem.resolution === 'cancelled' && serverItem.statusKey === 'core-done' && serverItem.priority === 'medium', JSON.stringify(serverItem))
  } else {
    await click('[data-md-check="1"]'); await sleep(150); await idle()
    await click('[data-issue-body-edit]')
    await set('[data-md-editor] textarea', '- [x] FIRST\nLATER OWN PARAGRAPH')
    await click('[data-md-save]')
    await until(() => js(`!document.querySelector('[data-md-editor]')`), { timeoutMs: 10_000, label: '편집기 닫힘' })
    await idle()
    const pressed = await pressUndo('체크 칸')
    await sleep(800)
    const server = await request({ op: 'getItem', itemId: 'm-2' })
    const screen = await js(`({ banner: document.querySelector('[data-issue-conflict]')?.textContent ?? null, body: document.querySelector('[data-issue-body]').textContent, toasts: [...document.querySelectorAll('[data-toast]')].map((e) => e.textContent) })`)
    const serverItem = server.ok ? { body: server.result.item.body, version: server.result.item.version } : { error: server.error }
    log('결과', { pressed, server: serverItem, screen })
    judge('체크 칸 되돌리기 토스트 없음', pressed === false && !screen.toasts.some((text) => text.includes('체크 칸')), JSON.stringify({ pressed, toasts: screen.toasts }))
    judge('서버 본문 = 체크 + 뒤 문단', serverItem.body === '- [x] FIRST\nLATER OWN PARAGRAPH', JSON.stringify(serverItem))
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
