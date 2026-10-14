// LIFE-591 수정 r1 회귀(격리 개발 Electron) — Codex 리뷰 r1 지적을 화면 흐름으로 재현한다. 한 회차 = 한 `--case`. 옛 코드(1a670faf6)에서 실패, 고친 코드에서 통과해야 한다.
// 리뷰어 재현 스크립트(`/tmp/l591-review-r1/*.mjs`, 읽기만)의 조건을 옮겼다 — 출처는 case 마다 적는다. Monaco 는 앱이 `window` 에 내놓지 않으므로
// 리뷰어처럼 빌드 산출물의 monaco 청크를 렌더러에서 동적 import 해 같은 모듈 인스턴스를 얻는다(시험 전용 — 제품 코드 무변경).
//   close-race   (R1-A) 닫기 「저장」 의 쓰기 IPC 를 지연(시험 주입 파일을 FIFO 로 — 리뷰어 close-save-race.mjs) → 그 사이 추가 편집 → 탭이 닫히면 디스크 = 추가 편집까지, 닫히지 않으면 수정 유지
//   deleted      (R1-D) 수정 중 디스크에서 삭제 → 터미널 탭 → 돌아오기: 편집기 + 수정 내용 + 「삭제됨」 안내(리뷰어 ui-cases.mjs delete 갈래)
//   md-preview   (R1-E) Markdown 저장(문서 생성) → 미리보기 → 외부 변경 → 2 s 안에 미리보기 갱신(리뷰어 ui-model-cases.mjs)
//   grow         (R1-F) 수정 없는 탭 파일이 20 MB 를 넘게 커짐 → 편집기 읽기 전용 → 다시 작아짐 → 편집 가능(리뷰어 ui-model-cases.mjs large)
//   bom          (R1-G) BOM + 선두 U+FEFF 파일에 한 글자 → ⌘S → 바이트 차이 = 그 한 글자(리뷰어 ui-model-cases.mjs double-bom)
//   ime          (R1-H) CDP Input.imeSetComposition 으로 조합 중 ⌘S → 1.2 s 뒤 디스크 무변경 → 확정 뒤 ⌘S 는 저장(리뷰어 ime-timeout.mjs) — L577_ELECTRON_ARGS=--remote-debugging-port=0 필요
//   unresponsive (R1-I) 렌더러 SIGSTOP → 종료 → main 대화상자(스텁: 첫 회 cancel → 앱 생존, 둘째 discard → 앱 종료)(리뷰어 unresponsive.mjs)
//   bulk-cancel  (R1-J) 터미널 탭 2개 + 수정 파일 탭 → 「다른 탭 닫기」 → 확인 취소 → 탭 하나도 안 닫힘(리뷰어 bulk-cancel.mjs)
// 사용(app/ 에서, iso.sh 안): node scripts/l591/r1-cases.mjs --case <이름> --root {ROOT} --repo /tmp/l591g-t/repo --out <dir>
/* global fetch, WebSocket -- Node 22+ 내장(CDP 접속) */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { case: { type: 'string' }, root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
if (!/^\/tmp\/l591[^/]*\/repo$/.test(values.repo ?? '')) throw new Error('repo 는 /tmp/l591*/repo')
const root = values.root
const repo = values.repo
const name = values.case
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 400)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const settle = (condition, timeoutMs = 3000) => until(condition, { label: 'settle', timeoutMs, everyMs: 50 }).then(() => true, () => false)
const logRows = () => fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
const alive = () => {
  try {
    process.kill(appPid, 0)
    return true
  } catch {
    return false
  }
}
const expanded = async (row) => (await js(`document.querySelector('[data-explorer-row="${row}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const openFile = async (rel) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    await until(() => js(`document.querySelector('[data-explorer-row="${dir}"]') !== null`), { label: `row ${dir}` })
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await until(() => js(`document.querySelector('[data-explorer-row="${rel}"]') !== null`), { label: `row ${rel}` })
  await ctl(root, { cmd: 'dblclick', selector: `[data-explorer-row="${rel}"]` })
  await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: `editor ${rel}` })
}
// 빌드 산출물의 monaco 청크 — 렌더러 페이지(out/renderer/index.html) 기준 상대 경로.
const monacoChunk = fs.readdirSync(path.join(process.cwd(), 'out/renderer/assets')).find((file) => /^monaco-.*\.js$/.test(file))
const exposeMonaco = () => js(`(async () => { window.l591Monaco = (await import('./assets/${monacoChunk}')).monaco; return window.l591Monaco.editor.getEditors().length })()`)
/** 보이는 편집기(파일 뷰 안) 기준으로 식을 돈다 — `e` = 편집기, `m` = 모델. */
const ed = (body) => js(`(() => { const host = document.querySelector('[data-file-editor]'); const e = window.l591Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); const m = e?.getModel() ?? null; ${body} })()`)
const typeAt = (text, where = 'start') =>
  ed(`e.focus(); e.setPosition(${where === 'start' ? '{ lineNumber: 1, column: 1 }' : '{ lineNumber: 1, column: m.getLineMaxColumn(1) }'}); e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} }); return m.getValue()`)
const dirtyOf = (rel) => js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.fileDirty ?? null`)

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })

switch (name) {
  case 'close-race': {
    const rel = 'r1/race.txt'
    const file = path.join(repo, rel)
    const hook = process.env.CORRAL_TEST_WRITE_HOOK_FILE_FOR_CASE ?? path.join(root, 'write-hook.json')
    await openFile(rel)
    await exposeMonaco()
    await typeAt('-first', 'end')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    // main 이 저장마다 시험 주입 파일을 읽는다(`loadTestHooks`) — FIFO 면 쓰는 쪽이 올 때까지 읽기가 막혀 쓰기 IPC 가 응답하지 않는다.
    fs.rmSync(hook, { force: true })
    execFileSync('mkfifo', [hook])
    try {
      await stub(['save'])
      await key('W', ['meta'])
      const asked = await settle(async () => (await stub(['save'])).asked.includes('close'), 3000)
      await stub([])
      const late = await typeAt('-LATE', 'end')
      check('A-dialog-asked-write-pending', asked && fs.readFileSync(file, 'utf8') === 'base', { asked, disk: fs.readFileSync(file, 'utf8'), late })
      await fsp.writeFile(hook, '{}')
      // 첫 저장을 풀어 준 뒤엔 일반 파일로 — FIFO 가 남아 있으면 추가 편집을 따라잡는 다음 저장이 또 막힌다(시험 주입의 한계). 그 사이 다음 저장이 먼저 읽으면
      // 막힌 채로 남고, 그때는 「닫히지 않고 수정 유지」 갈래로 판정된다(어느 쪽이든 추가 편집이 사라지면 실패).
      fs.rmSync(hook, { force: true })
      fs.writeFileSync(hook, '{}')
      await sleep(1500)
      const tabOpen = await js(`document.querySelector('[data-file-tab="${rel}"]') !== null`)
      const disk = fs.readFileSync(file, 'utf8')
      const dirty = await dirtyOf(rel)
      // 통과 = 닫혔다면 디스크에 추가 편집까지 있다 · 닫히지 않았다면 추가 편집이 수정으로 남아 있다(어느 쪽이든 추가 편집이 사라지지 않는다).
      check('A-late-edit-not-lost', tabOpen ? dirty === 'true' && (await ed('return m.getValue()')) === 'base-first-LATE' : disk === 'base-first-LATE', { tabOpen, disk, dirty })
    } finally {
      fs.rmSync(hook, { force: true })
    }
    break
  }
  case 'deleted': {
    const rel = 'r1/del.txt'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    await typeAt('dirty-')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    fs.rmSync(file)
    await until(() => js(`document.querySelector('[data-file-tab="${rel}"]')?.classList.contains('is-deleted') === true`), { label: 'deleted mark', timeoutMs: 5000 })
    await click(`[data-main-tab]:not([data-file-tab])`)
    await until(() => js(`document.querySelector('[data-file-view="${rel}"]') === null`), { label: 'unmounted' })
    await click(`[data-file-tab="${rel}"]`)
    const editor = await settle(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), 4000)
    const view = await js(`(() => { const v = document.querySelector('[data-file-view="${rel}"]'); return v === null ? null : { notices: [...v.querySelectorAll('[data-file-notice]')].map((n) => n.dataset.fileNotice), dirty: v.dataset.fileDirty } })()`)
    const text = editor ? await ed('return m?.getValue() ?? null') : null
    check('D-editor-after-roundtrip', editor && text === 'dirty-survive\n' && view?.dirty === 'true', { editor, text, view })
    check('D-deleted-notice', Array.isArray(view?.notices) && view.notices.includes('deleted') && !view.notices.includes('not_found'), view)
    break
  }
  case 'md-preview': {
    const rel = 'r1/doc.md'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    await typeAt('Z')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await key('S', ['meta'])
    await until(async () => (await dirtyOf(rel)) === 'false', { label: 'saved', timeoutMs: 5000 })
    await click('[data-markdown-toggle="preview"]')
    await until(() => js(`document.querySelector('[data-markdown-preview="${rel}"]')?.dataset.markdownReady === 'true'`), { label: 'preview' })
    const before = await js(`document.querySelector('[data-markdown-preview="${rel}"]').textContent`)
    const t0 = Date.now()
    fs.writeFileSync(file, '# external heading\n')
    const ms = await until(() => js(`document.querySelector('[data-markdown-preview="${rel}"]')?.textContent.includes('external heading') === true`), { label: 'preview update', timeoutMs: 4000, everyMs: 50 }).then(() => Date.now() - t0, () => null)
    check('E-preview-reflects-external-2s', ms !== null && ms <= 2000, { ms, before, after: await js(`document.querySelector('[data-markdown-preview="${rel}"]')?.textContent ?? null`) })
    break
  }
  case 'grow': {
    const rel = 'r1/grow.txt'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    const readOnlyNow = () => ed('return e?.getOption(window.l591Monaco.editor.EditorOption.readOnly) ?? null')
    check('F-start-editable', (await readOnlyNow()) === false, { readOnly: await readOnlyNow() })
    fs.writeFileSync(file, 'large\n'.repeat(Math.ceil((21 * 1024 * 1024) / 6)))
    const grew = await settle(async () => (await readOnlyNow()) === true && (await ed('return m.getValue().length')) > 20 * 1024 * 1024, 6000)
    const typed = await typeAt('X')
    check('F-grown-readonly', grew && !typed.startsWith('X') && (await dirtyOf(rel)) === 'false', { grew, readOnly: await readOnlyNow(), head: typed.slice(0, 12), dirty: await dirtyOf(rel) })
    fs.writeFileSync(file, 'small again\n')
    const shrank = await settle(async () => (await readOnlyNow()) === false && (await ed('return m.getValue()')) === 'small again\n', 6000)
    check('F-shrunk-editable', shrank, { readOnly: await readOnlyNow(), text: (await ed('return m.getValue()')).slice(0, 20) })
    break
  }
  case 'bom': {
    const rel = 'r1/bom.txt'
    const file = path.join(repo, rel)
    const before = fs.readFileSync(file).toString('hex')
    await openFile(rel)
    await exposeMonaco()
    await typeAt('X')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await key('S', ['meta'])
    await until(async () => (await dirtyOf(rel)) === 'false', { label: 'saved', timeoutMs: 5000 })
    const after = fs.readFileSync(file).toString('hex')
    check('G-double-bom-one-char', before === 'efbbbfefbbbf616c7068610a' && after === 'efbbbfefbbbf58616c7068610a', { before, after })
    break
  }
  case 'ime': {
    const rel = 'r1/edit.txt'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    const port = Number(fs.readFileSync(path.join(root, 'ud/DevToolsActivePort'), 'utf8').split('\n')[0])
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((item) => item.type === 'page' && item.url.includes('/out/renderer/'))
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve) => (socket.onopen = resolve))
    let seq = 0
    const pending = new Map()
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { seq += 1; pending.set(seq, { resolve, reject }); socket.send(JSON.stringify({ id: seq, method, params })) })
    const cmdS = async () => {
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 4 })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 4 })
    }
    try {
      await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
      await ed('e.setPosition({ lineNumber: 1, column: 1 }); e.focus(); return true')
      const original = fs.readFileSync(file, 'utf8')
      await cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
      await cmdS()
      await sleep(1500)
      const disk1 = fs.readFileSync(file, 'utf8')
      check('H-no-save-while-composing', disk1 === original, { disk: disk1.slice(0, 20), model: (await ed('return m.getValue()')).slice(0, 20), dirty: await dirtyOf(rel) })
      await cdp('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 })
      await cdp('Input.insertText', { text: '한' })
      await sleep(400)
      await cmdS()
      const saved = await settle(async () => fs.readFileSync(file, 'utf8') === `한${original}` && (await dirtyOf(rel)) === 'false', 4000)
      check('H-save-after-commit', saved, { disk: fs.readFileSync(file, 'utf8').slice(0, 20), dirty: await dirtyOf(rel), model: (await ed('return m.getValue()')).slice(0, 20), versions: await ed('return { alt: m.getAlternativeVersionId(), ver: m.getVersionId() }'), writes: logRows().filter((row) => row.tag === 'file.write').map((row) => `${row.ok}:${row.code}`) })
    } finally {
      socket.close()
    }
    break
  }
  case 'unresponsive': {
    const rel = 'r1/edit.txt'
    await openFile(rel)
    await exposeMonaco()
    await typeAt('unsaved-')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await sleep(300)
    const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    const renderer = table.find((row) => row.includes(`--user-data-dir=${root}/ud`) && row.includes('--type=renderer'))
    const pid = Number(renderer.trim().split(/\s+/)[0])
    await stub(['cancel', 'discard'])
    const before = logRows().length
    process.kill(pid, 'SIGSTOP')
    try {
      await ctl(root, { cmd: 'quit-entry', via: 'quit' })
      const asked = await settle(() => logRows().slice(before).some((row) => row.tag === 'quit.unresponsive'), 10_000)
      await sleep(500)
      check('I-main-dialog-cancel-alive', asked && alive(), { asked, alive: alive(), tags: logRows().slice(before).map((row) => row.tag) })
      await ctl(root, { cmd: 'quit-entry', via: 'quit' })
      const exited = await until(() => !alive(), { label: 'exit', timeoutMs: 20_000 }).then(() => true, () => false)
      check('I-main-dialog-discard-exits', exited, { exited, tags: logRows().slice(before).map((row) => `${row.tag}${row.choice ? ':' + row.choice : ''}`) })
    } finally {
      try {
        process.kill(pid, 'SIGCONT')
      } catch {
        /* 이미 끝났다 */
      }
    }
    break
  }
  case 'bulk-cancel': {
    const rel = 'r1/edit.txt'
    const state = await js('window.corral.getState()')
    const real = fs.realpathSync(repo)
    const worktree = state.repos.flatMap((row) => row.worktrees).find((row) => fs.realpathSync(row.path) === real)
    await js(`window.corral.createRow(${JSON.stringify({ workspaceId: worktree.openWorkspaceId, kind: 'shell', cwd: worktree.path })})`)
    await until(async () => (await js(`document.querySelectorAll('[data-main-tab]:not([data-file-tab])').length`)) >= 2, { label: 'two terminals', timeoutMs: 10_000 })
    await openFile(rel)
    await exposeMonaco()
    await typeAt('bulk-')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const tabsOf = () => js(`[...document.querySelectorAll('[data-main-tab]')].map((t) => ({ id: t.dataset.mainTab, file: t.dataset.fileTab ?? null, dirty: t.dataset.fileDirty ?? null }))`)
    const before = await tabsOf()
    const anchor = before.find((tab) => tab.file === null).id
    await stub(['cancel'])
    await js(`(() => { const el = [...document.querySelectorAll('[data-main-tab]')].find((t) => t.dataset.mainTab === ${JSON.stringify(anchor)}); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 20, button: 2 })) })()`)
    const action = `[data-tab-menu-close-others="${anchor}"]`
    await until(() => js(`document.querySelector(${JSON.stringify(action)}) !== null`), { label: 'menu' })
    await js(`document.querySelector(${JSON.stringify(action)}).click()`)
    await sleep(1500)
    const after = await tabsOf()
    const asked = (await stub([])).asked
    check('J-cancel-closes-nothing', asked.includes('close') && after.length === before.length && after.every((tab) => before.some((row) => row.id === tab.id)), { before, after, asked })
    // 정리 — g-down 이 확인에 막히지 않게 수정 상태를 버린다.
    await stub(['discard'])
    await click(`[data-file-tab="${rel}"]`).catch(() => null)
    await key('W', ['meta'])
    await sleep(500)
    break
  }
  default:
    throw new Error(`모르는 case: ${name}`)
}

const failed = checks.filter((row) => !row.pass)
writeJson(path.join(values.out, `${name}.json`), { case: name, checks })
// 정리 — 남은 수정 문서가 있으면 g-down(종료)이 확인에 막히지 않게 저장 안 함 답을 걸어 둔다.
if (alive()) await stub(['discard', 'discard', 'discard']).catch(() => null)
console.log(failed.length === 0 && checks.length > 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(',')}`)
process.exit(failed.length === 0 && checks.length > 0 ? 0 : 1)
