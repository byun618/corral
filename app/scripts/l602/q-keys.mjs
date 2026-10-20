#!/usr/bin/env node
// LIFE-602 수정 1 R1-F — 격리 Electron 에서 실제 키 입력(제어 소켓 `key` = webContents.sendInputEvent keyDown/keyUp — App 의 전역 처리기·
// main `before-input-event`(menuKeyShortcut) 를 그대로 지난다)으로 편집기 단축키가 편집기에 닿는지. 리뷰 `browser-keys.mjs` 를 옮겼다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-keys.mjs <ROOT=/tmp/l602q-*> <OUT 파일>
//
// 판정: 본문 편집기에서 `alpha` 를 고르고 ⌘B → `**alpha**` · ⌘⇧I → `_alpha_` · ⌘E → `` `alpha` `` · ⌘K → `[alpha](https://)` ·
//       코멘트 입력 ⌘↵ → 코멘트 줄 생김 · 대조(무회귀): 편집 칸 밖(body)에서 ⌘B = 사이드바 접힘 바뀜.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-keys.mjs /tmp/l602q-<n> <OUT 파일>')
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
const clickJs = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const sidebarCollapsed = () => js(`!!document.querySelector('.sidebar-column.is-collapsed')`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-602 q-keys ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l602_keys', replaceId: null }).then((r) => r.ok)`)

  // 대조 먼저 — 편집 칸 밖(포커스 body)에서 ⌘B 는 사이드바를 접는다(기존 바인딩).
  const before = await sidebarCollapsed()
  await js(`document.activeElement?.blur?.()`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'B', modifiers: ['meta'] })
  await sleep(300)
  const after = await sidebarCollapsed()
  await ctl(ROOT, { cmd: 'key', keyCode: 'B', modifiers: ['meta'] })
  await sleep(300)
  const restored = await sidebarCollapsed()
  judge('대조 — 편집 칸 밖 ⌘B = 사이드바 접기(바뀌고 다시 눌러 되돌아옴)', before !== after && restored === before, JSON.stringify({ before, after, restored }))

  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-1"]')`), { timeoutMs: 15_000, label: '보드 CORE-1' })
  await clickJs('[data-tasks-board] [data-issue-card="CORE-1"]')
  await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-1"] [data-md-rendered]') && !document.querySelector('[data-issue-body-edit]').disabled`), { timeoutMs: 10_000, label: '상세 CORE-1' })
  await clickJs('[data-issue-body-edit]')
  await until(() => js(`!!document.querySelector('[data-md-editor] textarea')`), { timeoutMs: 5_000, label: '편집기' })
  const expected = { B: '**alpha**', I: '_alpha_', E: '`alpha`', K: '[alpha](https://)' }
  for (const [keyCode, modifiers] of [['B', ['meta']], ['I', ['meta', 'shift']], ['E', ['meta']], ['K', ['meta']]]) {
    await js(`(() => { const e = document.querySelector('[data-md-editor] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, 'alpha'); e.dispatchEvent(new Event('input', { bubbles: true })); e.focus(); e.setSelectionRange(0, 5) })()`)
    const sidebar0 = await sidebarCollapsed()
    const sent = await ctl(ROOT, { cmd: 'key', keyCode, modifiers })
    await sleep(200)
    const result = await js(`({ text: document.querySelector('[data-md-editor] textarea')?.value ?? null, focus: document.activeElement?.tagName ?? null, palette: !!document.querySelector('[data-command-palette]') })`)
    const sidebar1 = await sidebarCollapsed()
    log('key', { keyCode, modifiers, sent: sent.ok, result, sidebarSame: sidebar0 === sidebar1 })
    judge(`편집기 ⌘${modifiers.includes('shift') ? '⇧' : ''}${keyCode} → ${expected[keyCode]} · 사이드바·팔레트 그대로`, result.text === expected[keyCode] && sidebar0 === sidebar1 && result.palette === false, JSON.stringify(result))
  }
  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await until(() => js(`!document.querySelector('[data-md-editor]')`), { timeoutMs: 5_000, label: '편집기 닫힘' })

  // 코멘트 입력 ⌘↵
  const rows0 = await js(`document.querySelectorAll('[data-activity-row="comment"]').length`)
  await js(`(() => { const e = document.querySelector('[data-comment-composer] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, 'q-keys 코멘트'); e.dispatchEvent(new Event('input', { bubbles: true })); e.focus() })()`)
  await ctl(ROOT, { cmd: 'key', keyCode: 'Enter', modifiers: ['meta'] })
  await until(() => js(`document.querySelectorAll('[data-activity-row="comment"]').length > ${rows0}`), { timeoutMs: 5_000, label: '코멘트 줄' }).catch(() => null)
  const rows1 = await js(`document.querySelectorAll('[data-activity-row="comment"]').length`)
  judge('코멘트 입력 ⌘↵ → 코멘트 줄 하나 늘어남', rows1 === rows0 + 1, JSON.stringify({ rows0, rows1 }))

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
