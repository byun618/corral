#!/usr/bin/env node
// LIFE-602 수정 6 — 리뷰 r6 의 격리 Electron 원본 빌드 재현(V08 force-other · V23 continuation, `codex-r6-raw/electron-adjacent.mjs`)을 옮겼다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-r6.mjs <force|continuation> <ROOT=/tmp/l602q-*> <OUT 파일>
//
// force(R6-A): CORE-2 본문 BASE BODY → 본문 편집기에 MY OLD DRAFT → 외부(판 없이) 본문 EXTERNAL BODY → 우선순위 높음(충돌 배너) → 「내 값으로 덮기」 → 편집기의 저장.
//   판정: 덮기 직후 서버 본문 EXTERNAL BODY(대조) · 마지막 서버 본문 EXTERNAL BODY · 본문 충돌 배너 · 초안 남음.
// continuation(R6-C): CORE-2 본문 `-\n  [ ] next-line task\n` → 보기의 체크 칸을 누른다(활성이면).
//   판정: 활성인데 아무 일 없는 칸이 아니다 — 활성이면 서버 본문 = 그 칸 글자 하나만 바뀐 `-\n  [x] next-line task\n`.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [MODE, ROOT, OUT] = process.argv.slice(2)
if ((MODE !== 'force' && MODE !== 'continuation') || !ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-r6.mjs <force|continuation> /tmp/l602q-<n> <OUT 파일>')
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

log(`# LIFE-602 q-r6 ${MODE} ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const token = 'mock_l602_r6'
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('연결', added)
  const request = (call) => js(`window.corral.workRequest({ requestId: 'q-r6-' + Date.now(), connectionId: ${JSON.stringify(added.id)}, call: ${JSON.stringify(call)} })`)
  const serverBody = async () => { const got = await request({ op: 'getItem', itemId: 'm-2' }); return got.ok ? { body: got.result.item.body, version: got.result.item.version, priority: got.result.item.priority } : { error: got.error } }
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 CORE-2' })
  const seed = MODE === 'force' ? 'BASE BODY' : '-\n  [ ] next-line task\n'
  log('씨앗', await request({ op: 'updateItem', itemId: 'm-2', fields: { body: seed }, ifVersion: null }).then((r) => ({ ok: r.ok, version: r.ok ? r.result.item.version : null })))
  await click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await until(() => js(`!!document.querySelector('[data-md-rendered]') && !document.querySelector('[data-issue-body-edit]').disabled`), { timeoutMs: 15_000, label: '상세 CORE-2' })
  const idle = () => until(() => js(`!document.querySelector('[data-issue-busy]')`), { everyMs: 20, timeoutMs: 10_000, label: '확인 끝' })
  const screen = () => js(`({ fields: [...document.querySelectorAll('[data-conflict-field]')].map((e) => e.getAttribute('data-conflict-field')), draft: document.querySelector('[data-md-editor] textarea')?.value ?? null, body: document.querySelector('[data-issue-body]').textContent })`)
  if (MODE === 'force') {
    await click('[data-issue-body-edit]')
    await until(() => js(`!!document.querySelector('[data-md-editor] textarea')`), { timeoutMs: 5_000, label: '편집기' })
    await set('[data-md-editor] textarea', 'MY OLD DRAFT')
    const external = await request({ op: 'updateItem', itemId: 'm-2', fields: { body: 'EXTERNAL BODY' }, ifVersion: null })
    log('외부 변경', { ok: external.ok, version: external.ok ? external.result.item.version : null })
    await click('[data-field="priority"]'); await click('[data-priority-row="high"]')
    await until(() => js(`!!document.querySelector('[data-conflict-override]')`), { timeoutMs: 10_000, label: '충돌 배너' })
    log('배너', await screen())
    await click('[data-conflict-override]'); await sleep(300); await idle()
    const afterForce = await serverBody()
    log('덮기 뒤', { server: afterForce, screen: await screen() })
    await click('[data-md-save]'); await sleep(500); await idle()
    const last = await serverBody()
    const shown = await screen()
    log('결과', { server: last, screen: shown })
    judge('대조 — 덮기 직후 서버 본문 EXTERNAL BODY · 우선순위 high', afterForce.body === 'EXTERNAL BODY' && afterForce.priority === 'high', JSON.stringify(afterForce))
    judge('본문 저장 뒤에도 서버 본문 EXTERNAL BODY(외부 본문을 덮지 않음)', last.body === 'EXTERNAL BODY', JSON.stringify(last))
    judge('본문 충돌 배너 · 초안 남음', shown.fields.includes('body') && shown.draft === 'MY OLD DRAFT', JSON.stringify(shown))
  } else {
    const box = await js(`(() => { const e = document.querySelector('[data-md-check]'); return e ? { line: e.getAttribute('data-md-check'), disabled: e.disabled, title: e.title } : null })()`)
    log('체크 칸', box)
    if (box !== null && !box.disabled) { await click('[data-md-check]'); await sleep(300); await idle() }
    const last = await serverBody()
    log('결과', { server: last, screen: await screen() })
    judge('대조 — 보기에 체크 칸이 그려졌다', box !== null, JSON.stringify(box))
    judge('활성인데 아무 일 없는 칸이 아니다 — 활성이면 서버 본문 = 그 칸만 바뀜', box !== null && (box.disabled || last.body === '-\n  [x] next-line task\n'), JSON.stringify({ box, last }))
    judge('칸이 매핑된다(활성 · 저장)', box !== null && !box.disabled && last.body === '-\n  [x] next-line task\n', JSON.stringify({ box, last }))
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
