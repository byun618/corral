// LIFE-591 닫기·종료 확인 격리 확인(E3ⓐⓑⓒⓖ 맛보기 — 최종 관문 전 구현 확인). 대화상자 답은 제어 소켓 `file-dialog-stub`(OS 창에 입력하지 않는다 — G5).
//   ① 수정된 파일 탭 ⌘W → 취소: 탭·수정 그대로 ② ⌘W → 저장 안 함: 탭 닫힘·디스크 무변경 → ⌘⇧T: 디스크 내용(수정 아님)
//   ③ 다시 수정 → 앱 종료(제어 소켓 `quit-entry` quit = `app.quit()` — 메뉴 Quit·⌘Q 와 같은 함수) → 취소: 앱 살아 있음·터미널 입력·출력 정상·런타임 정리 로그 없음
//   ③' 창 닫기(`quit-entry` close = 창 close — 빨간 닫기 단추) → 취소: 같은 확인
//   ④ 종료 → 저장 안 함: 앱이 끝난다 · 디스크 무변경 · 확인이 정리(app.quit 로그)보다 먼저
// SIGTERM 은 쓰지 않는다 — 첫 신호 뒤 Chromium 이 기본 처리로 되돌려 두 번째 신호는 확인 없이 프로세스를 끝낸다(dev/d2 원자료).
// 사용(app/ 에서, iso.sh 안): node scripts/l591/close-quit.mjs --root /tmp/l591g-x --repo /tmp/l591g-t/repo --out <dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, rel: { type: 'string', default: 'src/sample.ts' } } })
checkRoot(values.root)
if (!/^\/tmp\/l591[^/]*\/repo$/.test(values.repo ?? '')) throw new Error('repo 는 /tmp/l591*/repo')
const root = values.root
const repo = values.repo
const rel = values.rel
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 300)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const tab = () => js(`(() => { const t = document.querySelector('[data-file-tab="${rel}"]'); return t === null ? null : { dirty: t.dataset.fileDirty, active: t.dataset.active } })()`)
const logTags = () => fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const expanded = async (row) => (await js(`document.querySelector('[data-explorer-row="${row}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const openFile = async (target) => {
  const parts = target.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await click(`[data-explorer-row="${target}"]`)
  await until(() => js(`document.querySelector('[data-file-view="${target}"] [data-editor-ready]') !== null`), { label: `editor ${target}` })
}
const edit = async () => {
  await click(`[data-file-view="${rel}"] .view-lines`)
  await key('Up', ['meta'])
  await key('Home')
  await ctl(root, { cmd: 'type', text: 'Q' })
  await until(async () => (await tab())?.dirty === 'true', { label: 'dirty', timeoutMs: 5000 })
}
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
const alive = () => {
  try {
    process.kill(appPid, 0)
    return true
  } catch {
    return false
  }
}

const file = path.join(repo, rel)
const original = fs.readFileSync(file)
const { paneId } = await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await openFile(rel)
await edit()

// ① ⌘W → 취소
await stub(['cancel'])
await key('W', ['meta'])
await sleep(800)
check('E3a-cmdw-cancel-keeps-tab', (await tab())?.dirty === 'true', await tab())
// ② ⌘W → 저장 안 함 → ⌘⇧T
await stub(['discard'])
await key('W', ['meta'])
await until(async () => (await tab()) === null, { label: 'closed', timeoutMs: 5000 })
check('E3b-discard-closes-disk-unchanged', sha(fs.readFileSync(file)) === sha(original), { disk: sha(fs.readFileSync(file)) })
await key('T', ['meta', 'shift'])
await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: 'reopened' })
const reopened = await js(`({ tab: (() => { const t = document.querySelector('[data-file-tab="${rel}"]'); return t?.dataset.fileDirty ?? null })(), first: document.querySelector('[data-file-view="${rel}"] .view-line')?.textContent?.slice(0, 12) ?? null })`)
check('E3g-reopen-disk-content', reopened.tab === 'false' && !String(reopened.first).startsWith('Q'), reopened)
const asked1 = (await stub([])).asked
check('E3b-dialog-asked', JSON.stringify(asked1) === JSON.stringify(['close', 'close']), asked1)

// ③ 다시 수정 → 종료 → 취소
await edit()
await stub(['cancel'])
const beforeQuit = logTags().length
await ctl(root, { cmd: 'quit-entry', via: 'quit' })
await sleep(1500)
const tags = logTags().slice(beforeQuit).map((row) => row.tag)
check('E3c-quit-cancel-alive', alive() && (await tab())?.dirty === 'true', { alive: alive(), tags })
check('E3c-runtime-not-stopped', tags.includes('quit.intercepted') && !tags.some((tag) => /runtime\.(stop|close)|app\.quit/.test(tag)), tags)
// 터미널이 살아 있나 — 터미널 탭으로 가서 herdr 로 글을 보내고 화면에 나오는지.
await click(`[data-main-tab]:not([data-file-tab])`)
await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { label: 'streaming', timeoutMs: 10_000 })
await herdr(root, 'pane.send_text', { pane_id: paneId, text: 'echo l591-alive-$((40+2))\n' })
const echoed = await until(async () => ((await ctl(root, { cmd: 'term-read' })).term?.lines ?? []).join('\n').includes('l591-alive-42'), { label: 'term echo', timeoutMs: 10_000 }).then(() => true, () => false)
check('E3c-terminal-ok-after-cancel', echoed, { echoed })
// ③' 창 닫기 → 취소
await stub(['cancel'])
const beforeClose = logTags().length
await ctl(root, { cmd: 'quit-entry', via: 'close' })
await sleep(1000)
const closeTags = logTags().slice(beforeClose)
check('E3c-window-close-cancel', alive() && closeTags.some((row) => row.tag === 'quit.intercepted' && row.via === 'window-close') && (await js('document.visibilityState')) !== null, closeTags.map((row) => row.tag))

// ④ 종료 → 저장 안 함
await stub(['discard'])
await ctl(root, { cmd: 'quit-entry', via: 'quit' })
const exited = await until(() => !alive(), { label: 'exit', timeoutMs: 15_000 }).then(() => true, () => false)
check('E3c-quit-discard-exits', exited, { exited })
check('E3c-quit-discard-disk-unchanged', sha(fs.readFileSync(file)) === sha(original), { disk: sha(fs.readFileSync(file)) })
// 순서: 막음(quit.intercepted) → 대화상자(저장 안 함) → 확인(quit.confirmed) → 그 뒤에야 끝난다. ⌘Q·app.quit() 경로는 Electron 문서대로 `window-all-closed` 가 오지 않아
// 기존에도 `app.quit` 로그가 없다(수정 파일 없이 같은 입구 — dev/d4) — 그래서 그 태그로 순서를 보지 않는다. 런타임 정리는 로그가 없어, 「취소 뒤 터미널 정상」(③)이 정리 전 확인의 근거다.
const tail = logTags().slice(beforeQuit).map((row) => row.tag)
const at = (tag) => tail.lastIndexOf(tag)
check('E3c-order-confirm-then-quit', at('quit.intercepted') !== -1 && at('quit.intercepted') < at('quit.confirmed') && tail.filter((tag) => tag === 'file.dialog').length >= 3, tail.filter((tag) => /^(quit|file\.dialog)/.test(tag)))
const failed = checks.filter((row) => !row.pass)
writeJson(path.join(values.out, 'close-quit.json'), { rel, checks })
console.log(failed.length === 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(',')}`)
process.exit(failed.length === 0 ? 0 : 1)
