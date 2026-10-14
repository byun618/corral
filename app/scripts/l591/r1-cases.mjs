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
// 수정 r2 (Codex 리뷰 r2 — 리뷰어 `codex-r2-raw/ui-new.mjs`·`unresponsive-cleanup.mjs`·`normal-cleanup.mjs` 조건):
//   bulk-close   (R2-A) 수정 A + 깨끗한 B 를 「다른 탭 닫기」 → 저장 → A 쓰기 지연 중 B 를 편집 → 다시 묻는다(스텁 cancel) → B 탭·수정 유지, 디스크 B 무변경
//   bom-undo     (R2-B) BOM + 선두 U+FEFF 파일에 한 글자 → 외부 변경 → 「디스크 내용으로 되돌리기」 → 실행 취소 → ⌘S → 바이트 efbbbfefbbbf58616c7068610a
//   unresponsive-cleanup (R2-C) Mobile(가짜 Tailscale — `--fake {FAKE}`) 켜고 렌더러 SIGSTOP → 종료 → main 대화상자 취소 → 다시 종료 → 저장 안 함 → 앱 종료 뒤 serve 항목 비어 있음
//   normal-cleanup (대조) 같은 Mobile 상태에서 렌더러 정상 → 종료 → 저장 안 함 → serve 비어 있음
// 수정 r3 (Codex 리뷰 r3 — 리뷰어 `codex-r3-raw/bom-retry-ui.mjs`·`shutdown.mjs` shutdown-late 조건):
//   bom-retry    (R3-A) BOM 파일 편집 → BOM 없는 외부 내용으로 되돌리기 → 실행 취소 → 외부 충돌 → ⌘S(쓰기 FIFO 지연) 중 다시 실행 → 덮어쓰기 → 디스크 efbbbf58616c7068610a
//   shutdown-late / shutdown-late-close (R3-C) Mobile(가짜, serve 제거 지연) 켜고 수정 → 종료(quit | 창 close) 「저장」 → 정리 대기 중 편집 시도 →
//                조용히 사라지는 편집 0(편집이 막혀 모델 = 디스크) · 정리 중 창 숨김
//   shutdown-nodirty (R3-C 같은 결) 수정 없이 종료 → 정리 대기 중 창 숨김
//   ime 는 수정 r2 R2-D 로 전제(조합 시작·미확정 모델·dirty·EditContext·확정 전 composition-end 없음)를 판정에 넣었다 — L591_IME_OMIT_COMPOSITION=1 이 음성 대조(종료 1 이어야 함)
// 사용(app/ 에서, iso.sh 안): node scripts/l591/r1-cases.mjs --case <이름> --root {ROOT} --repo /tmp/l591g-t/repo --out <dir>
/* global fetch, WebSocket -- Node 22+ 내장(CDP 접속) */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'
import { calls, fakeState, setFake } from '../l577/g-lib.mjs'

const { values } = parseArgs({ options: { case: { type: 'string' }, root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, fake: { type: 'string' } } })
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
      // 조합 이벤트는 편집기 API 로 센다(EditContext 경로는 DOM composition 이벤트를 입력 요소에 내지 않는다).
      await ed(`window.l591Ime = []; e.onDidCompositionStart(() => window.l591Ime.push('start')); e.onDidCompositionEnd(() => window.l591Ime.push('end')); e.setPosition({ lineNumber: 1, column: 1 }); e.focus(); return true`)
      const original = fs.readFileSync(file, 'utf8')
      const imeState = async () => ({
        events: await js('window.l591Ime.slice()'),
        model: (await ed('return m.getValue()')).slice(0, 20),
        dirty: await dirtyOf(rel),
        editContext: await js('document.activeElement !== null && "editContext" in document.activeElement && document.activeElement.editContext !== null'),
      })
      // 음성 대조(수정 r2 R2-D) — L591_IME_OMIT_COMPOSITION=1 이면 조합 입력을 빼고 돈다. 그때는 아래 전제 검사가 실패해야 한다(종료 1).
      const omit = process.env.L591_IME_OMIT_COMPOSITION === '1'
      if (!omit) await cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
      // 전제(R2-D): 조합이 실제로 시작됐고(편집기 composition-start · 입력 경로 EditContext) 미확정 글자가 모델에 들어가 수정됨이어야 저장 요청이 「조합 중 저장」 시험이 된다.
      const composing = await settle(async () => {
        const state = await imeState()
        return JSON.stringify(state.events) === '["start"]' && state.model.startsWith('ㅎ') && state.dirty === 'true' && state.editContext === true
      }, 3000)
      check('H-precondition-composing', composing, await imeState())
      await cmdS()
      await sleep(1500)
      const disk1 = fs.readFileSync(file, 'utf8')
      const during = await imeState()
      // 확정 전: 디스크 무변경 · composition-end 없음 · 미확정 글자 그대로 · 수정됨.
      check('H-no-save-while-composing', composing && disk1 === original && JSON.stringify(during.events) === '["start"]' && during.model.startsWith('ㅎ') && during.dirty === 'true', { disk: disk1.slice(0, 20), ...during })
      if (!omit) await cdp('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 })
      await cdp('Input.insertText', { text: '한' })
      await sleep(400)
      await cmdS()
      const saved = await settle(async () => fs.readFileSync(file, 'utf8') === `한${original}` && (await dirtyOf(rel)) === 'false', 4000)
      const events = await js('window.l591Ime.slice()')
      check('H-save-after-commit', composing && saved && JSON.stringify(events) === '["start","end"]', { events, disk: fs.readFileSync(file, 'utf8').slice(0, 20), dirty: await dirtyOf(rel), model: (await ed('return m.getValue()')).slice(0, 20), versions: await ed('return { alt: m.getAlternativeVersionId(), ver: m.getVersionId() }'), writes: logRows().filter((row) => row.tag === 'file.write').map((row) => `${row.ok}:${row.code}`) })
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
  case 'bulk-close': {
    const a = 'r1/multi-a.txt'
    const b = 'r1/multi-b.txt'
    const hook = path.join(root, 'write-hook.json')
    await openFile(b)
    await openFile(a)
    await exposeMonaco()
    await typeAt('FIRST-')
    await until(async () => (await dirtyOf(a)) === 'true', { label: 'dirty a' })
    fs.rmSync(hook, { force: true })
    execFileSync('mkfifo', [hook])
    try {
      await stub(['save', 'cancel'])
      const anchor = await js(`document.querySelector('[data-main-tab]:not([data-file-tab])').dataset.mainTab`)
      await js(`(() => { const el = [...document.querySelectorAll('[data-main-tab]')].find((t) => t.dataset.mainTab === ${JSON.stringify(anchor)}); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 20, button: 2 })) })()`)
      await until(() => js(`document.querySelector('[data-tab-menu-close-others="${anchor}"]') !== null`), { label: 'menu' })
      await js(`document.querySelector('[data-tab-menu-close-others="${anchor}"]').click()`)
      await sleep(300)
      await click(`[data-file-tab="${b}"]`)
      await until(() => js(`document.querySelector('[data-file-view="${b}"] [data-editor-ready]') !== null`), { label: 'b editor' })
      const late = await typeAt('LATE-')
      check('A2-b-edited-while-save-pending', late === 'LATE-base-multi-b.txt' && (await dirtyOf(b)) === 'true' && fs.readFileSync(path.join(repo, a), 'utf8') === 'base-multi-a.txt', { late, dirtyB: await dirtyOf(b) })
      await fsp.writeFile(hook, '{}')
      fs.rmSync(hook, { force: true })
      fs.writeFileSync(hook, '{}')
      await sleep(1500)
      const tabs = await js(`[...document.querySelectorAll('[data-file-tab]')].map((t) => ({ rel: t.dataset.fileTab, dirty: t.dataset.fileDirty }))`)
      const asked = (await stub([])).asked
      const diskA = fs.readFileSync(path.join(repo, a), 'utf8')
      const diskB = fs.readFileSync(path.join(repo, b), 'utf8')
      // 통과 = B 의 새 편집이 살아 있다(탭 열림·수정됨) · 다시 물었다(close 두 번) · A 는 저장됐다 · B 디스크 무변경.
      check('A2-late-member-not-discarded', tabs.some((t) => t.rel === b && t.dirty === 'true') && asked.filter((k) => k === 'close').length === 2 && diskA === 'FIRST-base-multi-a.txt' && diskB === 'base-multi-b.txt', { tabs, asked, diskA, diskB })
    } finally {
      fs.rmSync(hook, { force: true })
    }
    break
  }
  case 'bom-undo': {
    const rel = 'r1/undo-bom.txt'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    await typeAt('X')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    fs.writeFileSync(file, '\ufeffDISK\n')
    await until(() => js(`document.querySelector('[data-external-action="revert"]') !== null`), { label: 'banner', timeoutMs: 5000 })
    await click('[data-external-action="revert"]')
    const reverted = await settle(async () => (await ed('return m.getValue()')) === 'DISK\n' && (await dirtyOf(rel)) === 'false')
    await ed(`e.trigger('keyboard', 'undo', null); return true`)
    const undone = await settle(async () => (await ed('return m.getValue()')) === 'Xalpha\n' && (await dirtyOf(rel)) === 'true')
    await key('S', ['meta'])
    const saved = await settle(async () => (await dirtyOf(rel)) === 'false', 5000)
    const hex = fs.readFileSync(file).toString('hex')
    check('B2-revert-undo-save-bytes', reverted && undone && saved && hex === 'efbbbfefbbbf58616c7068610a', { reverted, undone, saved, hex, expected: 'efbbbfefbbbf58616c7068610a' })
    break
  }
  case 'unresponsive-cleanup':
  case 'normal-cleanup': {
    const fake = values.fake ?? ''
    if (!/^\/tmp\/l591g-f[^/]+$/.test(fake)) throw new Error('--fake 는 /tmp/l591g-f* (가짜 Tailscale 상태 폴더 — 실제 Tailscale 무접촉)')
    setFake(fake, { serve: {}, hang: [] })
    await js(`window.corral.setSettings({ mobileEnabled: true })`)
    await until(async () => (await ctl(root, { cmd: 'mobile-status' })).mobile?.exposure?.kind === 'exposed', { label: 'fake mobile exposed', timeoutMs: 15_000 })
    const exposed = fakeState(fake)
    check('C2-mobile-exposed', Object.keys(exposed?.serve ?? {}).length > 0, { serve: exposed?.serve })
    const rel = 'r1/edit.txt'
    await openFile(rel)
    await exposeMonaco()
    await typeAt('unsaved-')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await sleep(300)
    const before = logRows().length
    let pid = null
    if (name === 'unresponsive-cleanup') {
      const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      pid = Number(table.find((row) => row.includes(`--user-data-dir=${root}/ud`) && row.includes('--type=renderer')).trim().split(/\s+/)[0])
      await stub(['cancel', 'discard'])
    } else await stub(['discard'])
    try {
      if (pid !== null) {
        process.kill(pid, 'SIGSTOP')
        await ctl(root, { cmd: 'quit-entry', via: 'quit' })
        const asked = await settle(() => logRows().slice(before).some((row) => row.tag === 'quit.unresponsive_choice'), 10_000)
        await sleep(300)
        check('C2-cancel-keeps-app-and-mobile', asked && alive() && Object.keys(fakeState(fake)?.serve ?? {}).length > 0, { asked, alive: alive() })
      }
      const mark = calls(fake).length
      await ctl(root, { cmd: 'quit-entry', via: 'quit' })
      const exited = await until(() => !alive(), { label: 'exit', timeoutMs: 20_000 }).then(() => true, () => false)
      await sleep(800)
      const after = fakeState(fake)
      const shutdown = calls(fake).slice(mark).map((row) => row.argv.join(' '))
      check('C2-exit-clears-serve', exited && Object.keys(after?.serve ?? {}).length === 0, { exited, serve: after?.serve, shutdown })
    } finally {
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGCONT')
        } catch {
          /* 이미 끝났다 */
        }
      }
    }
    break
  }
  case 'bom-retry': {
    const rel = 'r1/undo-bom.txt'
    const file = path.join(repo, rel)
    const hook = path.join(root, 'write-hook.json')
    fs.writeFileSync(file, '\ufeffalpha\n')
    await openFile(rel)
    await exposeMonaco()
    await until(async () => (await ed('return m.getValue()')) === 'alpha\n', { label: 'loaded' })
    await typeAt('X')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    fs.writeFileSync(file, 'DISK\n')
    await until(() => js(`document.querySelector('[data-external-action="revert"]') !== null`), { label: 'banner', timeoutMs: 5000 })
    await click('[data-external-action="revert"]')
    await until(async () => (await ed('return m.getValue()')) === 'DISK\n', { label: 'reverted' })
    await ed(`e.trigger('keyboard', 'undo', null); return true`)
    await until(async () => (await ed('return m.getValue()')) === 'Xalpha\n' && (await dirtyOf(rel)) === 'true', { label: 'undone' })
    fs.writeFileSync(file, 'CONFLICT\n')
    fs.rmSync(hook, { force: true })
    execFileSync('mkfifo', [hook])
    try {
      await stub(['overwrite'])
      await key('S', ['meta'])
      await sleep(300)
      await ed(`e.trigger('keyboard', 'redo', null); return true`)
      const during = await ed('return m.getValue()')
      await fsp.writeFile(hook, '{}')
      fs.rmSync(hook, { force: true })
      fs.writeFileSync(hook, '{}')
      const written = await settle(() => fs.readFileSync(file, 'utf8').includes('Xalpha'), 5000)
      await sleep(300)
      const hex = fs.readFileSync(file).toString('hex')
      await ed(`e.trigger('keyboard', 'undo', null); return true`)
      const clean = await settle(async () => (await ed('return m.getValue()')) === 'Xalpha\n' && (await dirtyOf(rel)) === 'false')
      check('A3-retry-uses-snapshot-bom', during === 'DISK\n' && written && hex === 'efbbbf58616c7068610a' && clean, { during, written, hex, expected: 'efbbbf58616c7068610a', cleanAfterUndo: clean, asked: (await stub([])).asked })
    } finally {
      fs.rmSync(hook, { force: true })
    }
    break
  }
  case 'shutdown-late':
  case 'shutdown-late-close':
  case 'shutdown-nodirty': {
    const fake = values.fake ?? ''
    if (!/^\/tmp\/l591g-f[^/]+$/.test(fake)) throw new Error('--fake 는 /tmp/l591g-f* (가짜 Tailscale 상태 폴더 — 실제 Tailscale 무접촉)')
    const rel = 'r1/edit.txt'
    const file = path.join(repo, rel)
    await openFile(rel)
    await exposeMonaco()
    if (name !== 'shutdown-nodirty') {
      await typeAt('BEFORE-')
      await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    }
    setFake(fake, { serve: {}, hang: [] })
    await js(`window.corral.setSettings({ mobileEnabled: true })`)
    await until(async () => (await ctl(root, { cmd: 'mobile-status' })).mobile?.exposure?.kind === 'exposed', { label: 'fake mobile exposed', timeoutMs: 15_000 })
    // 가짜 serve 제거를 멈춰 둔다 — 정리가 Mobile 마감(약 6 s)까지 걸린다(리뷰어 shutdown-late 조건).
    setFake(fake, { hang: ['serve-remove'] })
    await sleep(200)
    await stub(name === 'shutdown-nodirty' ? [] : ['save', 'cancel'])
    const mark = calls(fake).length
    const t0 = Date.now()
    await ctl(root, { cmd: 'quit-entry', via: name === 'shutdown-late-close' ? 'close' : 'quit' })
    if (name !== 'shutdown-nodirty') await until(() => fs.readFileSync(file, 'utf8').startsWith('BEFORE-'), { label: 'saved before cleanup', timeoutMs: 8000 })
    await until(() => calls(fake).slice(mark).some((row) => row.argv.at(-1) === 'off'), { label: 'cleanup started', timeoutMs: 8000 })
    // 정리 대기 중 — 편집을 시도한다(창은 숨겨졌어도 계측은 렌더러에 닿는다).
    const visible = (await ctl(root, { cmd: 'window-visibility', action: 'read' })).visible
    let during = null
    if (name !== 'shutdown-nodirty') {
      await typeAt('LATE-').catch(() => null)
      await sleep(150)
      during = { ms: Date.now() - t0, model: (await ed('return m.getValue()')).slice(0, 30), dirty: await dirtyOf(rel), readOnly: await ed('return e.getOption(window.l591Monaco.editor.EditorOption.readOnly)') }
    }
    const exited = await until(() => !alive(), { label: 'exit', timeoutMs: 20_000 }).then(() => true, () => false)
    // 멈춰 둔 가짜 serve 제거 프로세스는 앱이 끝나도 남는다(PPID 1) — 이 회차의 FAKE 폴더를 env 로 든 것만 찾아 끝낸다(G5 PID 정리).
    const leftovers = execFileSync('ps', ['-axeww', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((row) => row.includes('fake-tailscale.mjs') && row.includes(`FAKE_TAILSCALE_DIR=${fake} `))
      .map((row) => Number(row.trim().split(/\s+/)[0]))
    for (const pid of leftovers) process.kill(pid, 'SIGKILL')
    console.log(JSON.stringify({ fakeLeftoversKilled: leftovers }))
    const disk = fs.readFileSync(file, 'utf8')
    check('C3-window-hidden-during-cleanup', visible === false, { visible })
    if (during !== null) check('C3-no-silent-late-edit', exited && during.model === disk.slice(0, 30) && during.dirty === 'false' && disk.startsWith('BEFORE-'), { during, disk: disk.slice(0, 30), exited })
    else check('C3-exit', exited, { exited, ms: Date.now() - t0 })
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
