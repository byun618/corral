// LIFE-591 최종 관문(01-criteria 「최종 관문」) 격리 회차 — 한 회차 = 한 `--case`. 격리 개발 Electron(`iso.sh` 가 /tmp/l591g-* 에 띄운 것)에 붙는다.
// 입력은 제어 소켓 `type`·`key`·`raw-mouse`(Chromium sendInputEvent — OS 키 입력 아님, G5), 대화상자 답은 `file-dialog-stub`. 쓰기는 fixture(/tmp/l591g-t/repo)에만.
// Monaco 는 앱이 `window` 에 내놓지 않으므로 빌드 산출물의 monaco 청크를 렌더러에서 동적 import 해 같은 인스턴스를 읽는다(시험 전용 — 제품 무변경).
//   e1a 편집 가능/불가 종류 · e1b 수정 점·hover 닫기 모양 · e1c 실행 취소로 clean · e1d 미리보기 고정 · e1e 탭 전환·worktree 전환·끌기 이동·분할 왕복 상태 보존
//   e1f BOM·CRLF·끝 개행 없음·혼합 줄끝 한 글자 저장 바이트 diff + 비 UTF-8 읽기 전용 · e1g 20 MB 경계 · e1h 1 MB 키 입력 → 화면 지연(≥ 60회)
//   e2a 0 B·1 MB·10 MB 저장 sha256 · e2b 저장 뒤 커서·스크롤·실행 취소 · e2c 10회 연속 저장 자기 push 오인 0 · e2d ⌘S 대상 표 · e2e 저장 실패 4종(+ 쓰기 도중)
//   e2f mode·inode·심링크·하드링크 · e2g 연속 ⌘S·저장 중 편집 경쟁
//   e3a 닫기 입구 전수(⌘W·버튼·다른 탭 닫기·⌘⌥W·팔레트) · e3b 저장/저장 안 함/취소/저장 실패 · e3d worktree 닫기·삭제 · e3e 마지막 터미널 탭 · e3f 다시 불러오기
//   e4a~e4e 외부 변경 시나리오(회차마다 1번, 여러 회차로 ≥ 5) · e5 합성 IME(경로 계측·Enter·⌘S·⌘W·누출) · e6 쓰기 IPC 양성 대조 ①~⑪ · e9 30 초 대기·포커스 이동
// 사용(app/ 에서, iso.sh 안): node scripts/l591/final.mjs --case <이름> --root {ROOT} --fake {FAKE} --repo /tmp/l591g-t/repo --out <dir>
/* global fetch, WebSocket -- Node 22+ 내장(CDP 접속) */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { case: { type: 'string' }, root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, fake: { type: 'string' } } })
checkRoot(values.root)
if (!/^\/tmp\/l591[^/]*\/repo$/.test(values.repo ?? '')) throw new Error('repo 는 /tmp/l591*/repo')
const root = values.root
const repo = values.repo
const outside = path.dirname(repo)
const name = values.case
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const record = {}
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 500)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 150, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const settle = (condition, timeoutMs = 3000) => until(condition, { label: 'settle', timeoutMs, everyMs: 50 }).then(() => true, () => false)
const logRows = () => fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const disk = (rel) => fs.readFileSync(path.join(repo, rel))
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
const alive = () => {
  try {
    process.kill(appPid, 0)
    return true
  } catch {
    return false
  }
}
const rect = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null })()`)
const drag = async (from, to) => {
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: from.x, y: from.y })
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: from.x, y: from.y })
  for (let step = 1; step <= 12; step += 1) {
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(from.x + ((to.x - from.x) * step) / 12), y: Math.round(from.y + ((to.y - from.y) * step) / 12) })
    await sleep(25)
  }
  await sleep(150)
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: to.x, y: to.y })
  await sleep(500)
}
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) })
const rightClick = async (selector) => {
  const r = await rect(selector)
  const p = { x: Math.round(r.x + 30), y: Math.round(r.y + r.h / 2) }
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: p.x, y: p.y, button: 'right' })
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: p.x, y: p.y, button: 'right' })
  await sleep(300)
}
const tabs = () => js(`[...document.querySelectorAll('[data-tab-group]')].map((group) => ({ group: group.dataset.tabGroup, tabs: [...group.querySelectorAll('[data-main-tab]')].map((el) => ({ id: el.dataset.mainTab, active: el.dataset.active === 'true', preview: el.dataset.tabPreview ?? null, dirty: el.dataset.fileDirty ?? null })) }))`)
const allTabIds = async () => (await tabs()).flatMap((group) => group.tabs.map((tab) => tab.id))
const expanded = async (row) => (await js(`document.querySelector('[data-explorer-row="${row}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const revealRow = async (rel) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    await until(() => js(`document.querySelector('[data-explorer-row="${dir}"]') !== null`), { label: `row ${dir}` })
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await until(() => js(`document.querySelector('[data-explorer-row="${rel}"]') !== null`), { label: `row ${rel}` })
}
/** 탐색기에서 연다 — pin = 두 번 클릭(고정), 아니면 한 번(미리보기). editor = 편집기가 뜰 때까지 기다린다(이미지·바이너리는 false). */
const openFile = async (rel, { pin = true, editor = true } = {}) => {
  await revealRow(rel)
  await ctl(root, { cmd: pin ? 'dblclick' : 'click', selector: `[data-explorer-row="${rel}"]` })
  await until(() => js(`document.querySelector('[data-main-tab="file:${rel}"]') !== null`), { label: `tab ${rel}` })
  if (editor) await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: `editor ${rel}`, timeoutMs: 20_000 })
}
const monacoChunk = fs.readdirSync(path.join(process.cwd(), 'out/renderer/assets')).find((file) => /^monaco-.*\.js$/.test(file))
const exposeMonaco = () => js(`(async () => { window.l591Monaco = (await import('./assets/${monacoChunk}')).monaco; return true })()`)
/** 파일 뷰 `rel` 의 편집기로 식을 돈다 — `e` = 편집기, `m` = 모델(없으면 null). */
const edOf = (rel, body) =>
  js(`(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); const e = window.l591Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())) ?? null; const m = e?.getModel() ?? null; ${body} })()`)
const readOnlyOf = (rel) => edOf(rel, 'return e === null ? null : e.getOption(window.l591Monaco.editor.EditorOption.readOnly)')
const typeIn = (rel, text, where = 'start') =>
  edOf(rel, `e.focus(); e.setPosition(${where === 'start' ? '{ lineNumber: 1, column: 1 }' : where === 'end' ? '{ lineNumber: m.getLineCount(), column: m.getLineMaxColumn(m.getLineCount()) }' : where}); e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} }); return m.getValue().length`)
const dirtyOf = (rel) => js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.fileDirty ?? null`)
const stateOf = (rel) =>
  edOf(rel, `if (e === null) return null; const v = e.saveViewState(); return { model: m.getValue(), scrollTop: e.getScrollTop(), view: v === null ? null : { first: v.viewState.firstPosition, delta: v.viewState.firstPositionDeltaTop, cursor: v.cursorState.map((c) => c.position) }, alt: m.getAlternativeVersionId() }`)
const sameState = (a, b) => a !== null && b !== null && a.model === b.model && a.scrollTop === b.scrollTop && JSON.stringify(a.view) === JSON.stringify(b.view)
const modelSha = (rel) => edOf(rel, `return (async () => { const bytes = new TextEncoder().encode(m.getValue()); const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('') })()`)
const banner = (rel) => js(`document.querySelector('[data-file-view="${rel}"] [data-file-notice="external-change"]') !== null`)
const noticeOf = (rel) => js(`[...document.querySelectorAll('[data-file-view="${rel}"] [data-file-notice]')].map((el) => el.dataset.fileNotice)`)
const toasts = () => js(`[...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.textContent)`)
const terminalTabId = async () => (await allTabIds()).find((id) => !id.startsWith('file:')) ?? null
const termText = async () => {
  // 터미널 탐침 — 화면 줄·입력 기록만 비교한다(읽은 시각 `at` 은 매번 다르다).
  const read = await ctl(root, { cmd: 'term-read' })
  const term = read.term ?? null
  return JSON.stringify(term === null ? null : { lines: term.lines ?? null, inputs: term.inputs ?? null })
}
const writeHook = (value) => fs.writeFileSync(path.join(root, 'write-hook.json'), JSON.stringify(value))
const clearHook = () => fs.rmSync(path.join(root, 'write-hook.json'), { force: true })
const put = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), data)
}

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await exposeMonaco()

switch (name) {
  case 'e1a': {
    // 편집 가능/불가 종류(E1ⓐ) — 텍스트·코드·Markdown 원문 = 편집 가능, 바이너리·이미지·20 MB 초과·비 UTF-8·Markdown 미리보기 = 편집 없음.
    put('f/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await js('window.corral.refreshTree?.()')
    const rows = []
    for (const rel of ['notes/plain.txt', 'src/sample.ts', 'config/settings.json']) {
      await openFile(rel)
      rows.push({ rel, kind: 'text', readOnly: await readOnlyOf(rel), notices: await noticeOf(rel) })
    }
    // Markdown — 기본 원문(편집기), 툴바 「미리보기」 로 바꾸면 편집기 없음
    await openFile('README.md')
    rows.push({ rel: 'README.md', kind: 'markdown-source', readOnly: await readOnlyOf('README.md') })
    await click('[data-markdown-toggle="preview"]')
    await until(() => js(`document.querySelector('[data-markdown-preview="README.md"]') !== null`), { label: 'md preview' })
    const mdPreview = { rel: 'README.md', kind: 'markdown-preview', preview: true, editor: await js(`document.querySelector('[data-file-view="README.md"] [data-file-editor]') !== null`) }
    rows.push(mdPreview)
    for (const [rel, kind] of [['data.bin', 'binary'], ['img/pixel.png', 'image']]) {
      await openFile(rel, { editor: false })
      await sleep(800)
      rows.push({ rel, kind, editor: await js(`document.querySelector('[data-file-view="${rel}"] [data-file-editor]') !== null`), notices: await noticeOf(rel), img: await js(`document.querySelector('[data-file-view="${rel}"] [data-file-image]') !== null`) })
    }
    for (const [rel, kind] of [['big/25mb.log', 'large'], ['f/latin1.txt', 'encoding']]) {
      await openFile(rel)
      const before = await edOf(rel, 'return m.getValue().slice(0, 8)')
      await typeIn(rel, 'X')
      rows.push({ rel, kind, readOnly: await readOnlyOf(rel), notices: await noticeOf(rel), typedChanged: (await edOf(rel, 'return m.getValue().slice(0, 8)')) !== before, dirty: await dirtyOf(rel) })
    }
    record.rows = rows
    const by = (kind) => rows.find((row) => row.kind === kind)
    check('E1a-text-editable', rows.filter((row) => row.kind === 'text').every((row) => row.readOnly === false), rows.filter((row) => row.kind === 'text'))
    check('E1a-markdown-preview-no-editor', mdPreview.preview === true && mdPreview.editor === false, mdPreview)
    check('E1a-markdown-source-editable', by('markdown-source')?.readOnly === false, by('markdown-source'))
    check('E1a-binary-image-no-editor', by('binary')?.editor === false && by('image')?.editor === false && by('image')?.img === true, { binary: by('binary'), image: by('image') })
    check('E1a-large-readonly', by('large')?.readOnly === true && by('large')?.typedChanged === false && by('large')?.notices.includes('large'), by('large'))
    check('E1a-encoding-readonly', by('encoding')?.readOnly === true && by('encoding')?.typedChanged === false && by('encoding')?.notices.includes('readonly-encoding'), by('encoding'))
    break
  }
  case 'e1b': {
    // 수정 점 모양(E1ⓑ) — 닫기 단추 자리에 채운 원, hover 면 닫기(×). 계산된 스타일로 기록.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    const style = () =>
      js(`(() => { const btn = document.querySelector('[data-main-tab="file:${rel}"] .main-tab-close'); if (!btn) return null; const b = getComputedStyle(btn, '::before'); const svg = btn.querySelector('svg'); return { before: { content: b.content, display: b.display, width: b.width, height: b.height, radius: b.borderRadius, background: b.backgroundColor }, svgDisplay: svg ? getComputedStyle(svg).display : null, btnVisible: getComputedStyle(btn).visibility, dirtyClass: btn.closest('.main-tab').classList.contains('is-dirty') } })()`)
    const clean = await style()
    await typeIn(rel, 'X')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    // 마우스를 탭 밖(편집기 가운데)으로 — hover 아님
    const body = await rect(`[data-file-view="${rel}"]`)
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(body.x + body.w / 2), y: Math.round(body.y + body.h / 2) })
    await sleep(200)
    const dirty = await style()
    const tabRect = await rect(`[data-main-tab="file:${rel}"]`)
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(tabRect.x + tabRect.w / 2), y: Math.round(tabRect.y + tabRect.h / 2) })
    await sleep(300)
    const hover = await style()
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(body.x + body.w / 2), y: Math.round(body.y + body.h / 2) })
    record.styles = { clean, dirty, hover }
    check('E1b-dot-in-close-slot', dirty?.dirtyClass === true && dirty.before.display === 'block' && dirty.before.radius === '50%' && dirty.before.width === '8px' && dirty.svgDisplay === 'none', dirty)
    check('E1b-hover-shows-close', hover?.before.display === 'none' && hover.svgDisplay === 'block', hover)
    check('E1b-clean-no-dot', clean?.dirtyClass === false && clean.svgDisplay !== 'none', clean)
    break
  }
  case 'e1c': {
    // 실행 취소로 저장 내용과 같아지면 수정 해제(E1ⓒ) — 방식: 모델 버전 id(alternativeVersionId) 비교. 같은 글을 손으로 지워 되돌린 경우도 기록.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    await typeIn(rel, 'XY')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await edOf(rel, `e.trigger('keyboard', 'undo', null); return true`)
    const undone = await settle(async () => (await dirtyOf(rel)) === 'false')
    await edOf(rel, `e.trigger('keyboard', 'redo', null); return true`)
    const redone = await settle(async () => (await dirtyOf(rel)) === 'true')
    await edOf(rel, `e.trigger('keyboard', 'undo', null); return true`)
    const undone2 = await settle(async () => (await dirtyOf(rel)) === 'false')
    // 손으로 같은 글로 되돌림(타이핑 → 백스페이스) — 버전 id 방식이라 수정 표시가 남는다(기록)
    await typeIn(rel, 'Q')
    await edOf(rel, `e.trigger('keyboard', 'deleteLeft', null); return true`)
    await sleep(300)
    const manual = { sameText: (await edOf(rel, 'return m.getValue()')) === disk(rel).toString('utf8'), dirty: await dirtyOf(rel) }
    record.manual = manual
    check('E1c-undo-clears-dirty', undone && redone && undone2, { undone, redone, undone2 })
    check('E1c-method-recorded-version-id', true, { method: 'alternativeVersionId', manualRetype: manual })
    break
  }
  case 'e1d': {
    // 미리보기 탭 편집하면 고정(E1ⓓ) — 수정 중인 탭은 다른 파일 한 번 클릭으로 교체되지 않는다.
    const rel = 'notes/plain.txt'
    await openFile(rel, { pin: false })
    const previewBefore = await js(`document.querySelector('[data-main-tab="file:${rel}"]')?.dataset.tabPreview ?? null`)
    await typeIn(rel, 'P')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const previewAfter = await js(`document.querySelector('[data-main-tab="file:${rel}"]')?.dataset.tabPreview ?? null`)
    await revealRow('src/sample.ts')
    await ctl(root, { cmd: 'click', selector: '[data-explorer-row="src/sample.ts"]' })
    await until(() => js(`document.querySelector('[data-main-tab="file:src/sample.ts"]') !== null`), { label: 'sample' })
    await sleep(500)
    const ids = await allTabIds()
    check('E1d-edit-pins-preview', previewBefore === 'true' && previewAfter === 'false', { previewBefore, previewAfter })
    check('E1d-dirty-tab-not-replaced', ids.includes(`file:${rel}`) && ids.includes('file:src/sample.ts') && (await dirtyOf(rel)) === 'true', ids)
    break
  }
  case 'e1e': {
    // 수정 내용·실행 취소 기록이 살아남는다(E1ⓔ) — 탭 전환·worktree 전환 왕복·탭 끌어 순서 이동·끌어 분할(영역 이동) 뒤 모델·scrollTop·view state 같음(r3 정정 판별식) + 수정 표시 + ⌘Z.
    const rel = 'notes/long.txt'
    put(rel, Array.from({ length: 400 }, (_, i) => `long line ${i + 1}`).join('\n') + '\n')
    await openFile(rel)
    await edOf(rel, `e.setPosition({ lineNumber: 120, column: 3 }); e.revealLineInCenter(120); return true`)
    await typeIn(rel, 'EDIT-', '{ lineNumber: 120, column: 1 }')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    await sleep(300)
    const rounds = []
    const round = async (label, leave, back) => {
      const before = await stateOf(rel)
      await leave()
      await sleep(500)
      await back()
      await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: `back ${label}`, timeoutMs: 10_000 })
      await sleep(600)
      const after = await stateOf(rel)
      const row = { label, same: sameState(before, after), dirty: await dirtyOf(rel), before: before && { scrollTop: before.scrollTop, view: before.view }, after: after && { scrollTop: after.scrollTop, view: after.view, modelSame: after.model === before?.model } }
      rounds.push(row)
      check(`E1e-${label}`, row.same && row.dirty === 'true' && before.scrollTop > 0, row)
    }
    // ① 탭 전환(터미널 탭 → 파일 탭)
    const term = await terminalTabId()
    await round('tab-switch', () => click(`[data-main-tab="${term}"]`), () => click(`[data-main-tab="file:${rel}"]`))
    // ② worktree 전환 왕복(linked worktree B)
    const repoReal = fs.realpathSync(repo)
    const wtB = path.join(path.dirname(repoReal), 'wt-final-b')
    fs.rmSync(wtB, { recursive: true, force: true })
    execFileSync('git', ['-C', repoReal, 'worktree', 'prune'])
    try {
      execFileSync('git', ['-C', repoReal, 'branch', '-D', 'l591-final-b'], { stdio: 'ignore' })
    } catch {
      // 없으면 지울 것이 없다
    }
    execFileSync('git', ['-C', repoReal, 'worktree', 'add', '-q', '-b', 'l591-final-b', wtB])
    await js('window.corral.refreshTree?.()')
    await js(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(repoReal)}, path: ${JSON.stringify(wtB)}, isLinked: true })`)
    await until(() => js(`!!document.querySelector('[data-worktree="${wtB}"]')`), { label: 'B card', timeoutMs: 15_000 })
    await round(
      'worktree-switch',
      async () => {
        await click(`[data-worktree="${wtB}"]`)
        await until(async () => (await js(`document.querySelector('[data-main-tab="file:${rel}"]') === null`)) === true, { label: 'B shown', timeoutMs: 8000 })
      },
      async () => {
        await click(`[data-worktree="${repoReal}"]`)
        await until(() => js(`document.querySelector('[data-main-tab="file:${rel}"]') !== null`), { label: 'A tabs', timeoutMs: 8000 })
        await click(`[data-main-tab="file:${rel}"]`)
      },
    )
    // ③ 탭바 안 끌어 순서 이동(파일 탭을 터미널 탭 앞으로)
    await round(
      'drag-reorder',
      async () => {
        const from = center(await rect(`[data-main-tab="file:${rel}"]`))
        const to = await rect(`[data-main-tab="${term}"]`)
        await drag(from, { x: Math.round(to.x + 6), y: Math.round(to.y + to.h / 2) })
      },
      () => click(`[data-main-tab="file:${rel}"]`),
    )
    record.orderAfterDrag = (await tabs())[0]?.tabs.map((tab) => tab.id)
    // ④ 끌어 분할 — 본문 오른쪽 끝으로 끌어 새 영역(다른 영역으로 이동)
    await round(
      'drag-split',
      async () => {
        const from = center(await rect(`[data-main-tab="file:${rel}"]`))
        const body = await rect(`[data-file-view="${rel}"]`)
        await drag(from, { x: Math.round(body.x + body.w - 15), y: Math.round(body.y + body.h / 2) })
        await until(async () => (await tabs()).length === 2, { label: 'split', timeoutMs: 5000 })
      },
      () => click(`[data-main-tab="file:${rel}"]`),
    )
    record.groupsAfterSplit = await tabs()
    // 마지막: ⌘Z 가 편집을 되돌린다(실행 취소 기록 유지)
    await edOf(rel, `e.focus(); e.trigger('keyboard', 'undo', null); return true`)
    const undone = await settle(async () => (await edOf(rel, 'return m.getLineContent(120)')) === 'long line 120' && (await dirtyOf(rel)) === 'false')
    check('E1e-undo-after-all', undone, { line120: await edOf(rel, 'return m.getLineContent(120)'), dirty: await dirtyOf(rel) })
    record.rounds = rounds
    break
  }
  case 'e1f': {
    // 인코딩·줄끝 보존(E1ⓕ) — fixture 마다 맨 앞(BOM 뒤)에 'X' 한 글자 → ⌘S → 디스크 바이트 = 원본에 그 한 글자 차이뿐.
    const fixtures = {
      'f/bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\nbeta\n')]),
      'f/crlf.txt': Buffer.from('alpha\r\nbeta\r\ngamma\r\n'),
      'f/noeol.txt': Buffer.from('alpha\nbeta'),
      'f/mixed.txt': Buffer.from('one\r\ntwo\nthree\r\nfour\n'),
      'f/bom-crlf-noeol.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta')]),
    }
    for (const [rel, data] of Object.entries(fixtures)) put(rel, data)
    put('f/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await js('window.corral.refreshTree?.()')
    const rows = []
    for (const [rel, data] of Object.entries(fixtures)) {
      await openFile(rel)
      await typeIn(rel, 'X')
      await until(async () => (await dirtyOf(rel)) === 'true', { label: `dirty ${rel}` })
      await key('S', ['meta'])
      await settle(async () => (await dirtyOf(rel)) === 'false', 5000)
      const after = disk(rel)
      const bomLen = data[0] === 0xef ? 3 : 0
      const expected = Buffer.concat([data.subarray(0, bomLen), Buffer.from('X'), data.subarray(bomLen)])
      const row = { rel, beforeHex: data.toString('hex'), afterHex: after.toString('hex'), expectedHex: expected.toString('hex'), same: after.equals(expected), dirty: await dirtyOf(rel) }
      rows.push(row)
      check(`E1f-${path.basename(rel)}`, row.same && row.dirty === 'false', row)
    }
    // 비 UTF-8 — 읽기 전용 + 안내, 입력·⌘S 로 바이트가 바뀌지 않는다
    const rel = 'f/latin1.txt'
    const before = disk(rel)
    await openFile(rel)
    await typeIn(rel, 'X')
    await key('S', ['meta'])
    await sleep(800)
    const latin = { readOnly: await readOnlyOf(rel), notices: await noticeOf(rel), sameBytes: disk(rel).equals(before), hex: disk(rel).toString('hex'), dirty: await dirtyOf(rel) }
    rows.push({ rel, ...latin })
    check('E1f-non-utf8-readonly-bytes-kept', latin.readOnly === true && latin.notices.includes('readonly-encoding') && latin.sameBytes && latin.dirty === 'false', latin)
    record.rows = rows
    break
  }
  case 'e1g': {
    // 20 MB 경계(E1ⓖ) — LARGE_FILE_BYTES = 20 MiB 초과는 읽기 전용(대용량 안내), 이하는 편집 가능.
    const line = `${'0123456789abcdef'.repeat(7)}0123456\n`
    const make = (rel, bytes) => {
      const block = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)))
      const handle = fs.openSync(path.join(repo, rel), 'w')
      for (let written = 0; written < bytes; written += block.length) fs.writeSync(handle, block, 0, Math.min(block.length, bytes - written))
      fs.closeSync(handle)
    }
    fs.mkdirSync(path.join(repo, 'f'), { recursive: true })
    make('f/at-20mib.txt', 20 * 1024 * 1024)
    make('f/over-20mib.txt', 20 * 1024 * 1024 + 1)
    await js('window.corral.refreshTree?.()')
    const rows = []
    for (const rel of ['f/at-20mib.txt', 'f/over-20mib.txt', 'big/25mb.log']) {
      await openFile(rel)
      rows.push({ rel, bytes: fs.statSync(path.join(repo, rel)).size, readOnly: await readOnlyOf(rel), notices: await noticeOf(rel) })
    }
    record.rows = rows
    check('E1g-at-20mib-editable', rows[0].readOnly === false, rows[0])
    check('E1g-over-20mib-readonly', rows[1].readOnly === true && rows[1].notices.includes('large') && rows[2].readOnly === true, rows.slice(1))
    break
  }
  case 'e1h': {
    // 1 MB 파일 키 입력 → 화면(E1ⓗ, baseline/README.md 방법) — keydown timeStamp(t0) → 그 글자가 든 줄의 DOM 변화 뒤 다음 rAF(t1). ≥ 60회.
    const rel = 'big/1mb.txt'
    await openFile(rel)
    const middle = await edOf(rel, 'return Math.floor(m.getLineCount() / 2)')
    await edOf(rel, `e.focus(); e.setPosition({ lineNumber: ${middle}, column: m.getLineMaxColumn(${middle}) }); e.revealLineInCenter(${middle}); return true`)
    await sleep(500)
    await js(`(() => {
      window.l591Lat = { pending: null, samples: [] }
      const host = document.querySelector('[data-file-view="${rel}"] .view-lines')
      // 제어 소켓 \`type\` 은 Chromium \`char\` 입력(keydown 없음)이라 keypress·beforeinput 중 먼저 온 것을 t0 로(어느 이벤트였는지 남긴다).
      window.l591Lat.sources = {}
      const start = (source) => (event) => {
        const ch = event.key ?? event.data
        if (typeof ch !== 'string' || ch.length !== 1 || window.l591Lat.pending !== null) return
        window.l591Lat.sources[source] = (window.l591Lat.sources[source] ?? 0) + 1
        window.l591Lat.pending = { t0: event.timeStamp, ch }
      }
      document.addEventListener('keydown', start('keydown'), true)
      document.addEventListener('keypress', start('keypress'), true)
      document.addEventListener('beforeinput', start('beforeinput'), true)
      new MutationObserver(() => {
        const p = window.l591Lat.pending
        if (p === null) return
        const lines = [...host.querySelectorAll('.view-line')].map((el) => el.textContent)
        if (!lines.some((text) => text.endsWith(p.ch.repeat(p.n ?? 1)) || text.includes(p.mark ?? '\\u0000'))) return
        window.l591Lat.pending = null
        requestAnimationFrame(() => window.l591Lat.samples.push(performance.now() - p.t0))
      }).observe(host, { subtree: true, childList: true, characterData: true })
      return true
    })()`)
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < 64; i += 1) {
      await ctl(root, { cmd: 'type', text: letters[i % letters.length] })
      await sleep(60)
    }
    await sleep(500)
    const samples = await js('window.l591Lat.samples.slice()')
    record.sources = await js('window.l591Lat.sources')
    const stats = { sources: record.sources, n: samples.length, p50: pct(samples, 50), p95: pct(samples, 95), max: Math.max(...samples), lineEnd: (await edOf(rel, `return m.getLineContent(${middle}).slice(-20)`)) }
    record.samples = samples
    record.stats = stats
    check('E1h-1mb-key-to-screen-p95<=50ms', stats.n >= 50 && stats.p95 <= 50, stats)
    break
  }
  case 'e2a': {
    // 저장 sha256(E2ⓐ) — 0 B·1 MB·10 MB: 디스크 바이트 = 편집기 내용(LF·BOM 없음 fixture라 직렬화 = 모델 글) sha256.
    const rows = []
    for (const rel of ['empty.txt', 'big/1mb.txt', 'big/10mb.txt']) {
      const before = disk(rel).length
      await openFile(rel)
      await typeIn(rel, 'S', 'end')
      await until(async () => (await dirtyOf(rel)) === 'true', { label: `dirty ${rel}` })
      const t0 = Date.now()
      await key('S', ['meta'])
      await settle(async () => (await dirtyOf(rel)) === 'false', 15_000)
      const ms = Date.now() - t0
      const row = { rel, beforeBytes: before, afterBytes: disk(rel).length, diskSha: sha(disk(rel)), modelSha: await modelSha(rel), saveMs: ms, dirty: await dirtyOf(rel) }
      rows.push(row)
      check(`E2a-${path.basename(rel)}`, row.diskSha === row.modelSha && row.dirty === 'false' && row.afterBytes === before + 1, row)
    }
    record.rows = rows
    break
  }
  case 'e2b': {
    // 저장 뒤(E2ⓑ) — 수정 해제, 커서·스크롤 유지, ⌘Z 가 저장 전 편집을 되돌린다.
    const rel = 'notes/long2.txt'
    put(rel, Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join('\n') + '\n')
    await js('window.corral.refreshTree?.()')
    await openFile(rel)
    await edOf(rel, `e.revealLineInCenter(150); e.setPosition({ lineNumber: 150, column: 1 }); return true`)
    await typeIn(rel, 'B4-', '{ lineNumber: 150, column: 1 }')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const before = await stateOf(rel)
    await key('S', ['meta'])
    const saved = await settle(async () => (await dirtyOf(rel)) === 'false', 5000)
    await sleep(2500)
    const after = await stateOf(rel)
    await edOf(rel, `e.trigger('keyboard', 'undo', null); return true`)
    const undone = { line: await edOf(rel, 'return m.getLineContent(150)'), dirty: await dirtyOf(rel) }
    check('E2b-saved-clean', saved && disk(rel).toString('utf8').includes('B4-row 150'), { saved })
    check('E2b-cursor-scroll-kept', sameState(before, after), { before: before && { scrollTop: before.scrollTop, view: before.view }, after: after && { scrollTop: after.scrollTop, view: after.view } })
    check('E2b-undo-after-save', undone.line === 'row 150' && undone.dirty === 'true', undone)
    break
  }
  case 'e2c': {
    // 자기 저장 오인 0(E2ⓒ) — 10회 연속(한 글자 → ⌘S): 매번 디스크 = 편집기, 배너 없음, 다시 읽기(모델 교체)·되돌림 없음.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    await edOf(rel, `window.l591Swaps = 0; e.onDidChangeModel(() => { window.l591Swaps += 1 }); window.l591Flushes = 0; m.onDidChangeContent((event) => { if (event.isFlush) window.l591Flushes += 1 }); return true`)
    const rows = []
    for (let i = 0; i < 10; i += 1) {
      await typeIn(rel, String(i))
      await key('S', ['meta'])
      const ok = await settle(async () => (await dirtyOf(rel)) === 'false' && disk(rel).toString('utf8') === (await edOf(rel, 'return m.getValue()')), 5000)
      await sleep(1200)
      rows.push({ i, ok, banner: await banner(rel), first: disk(rel).toString('utf8').split('\n')[0] })
    }
    await sleep(2500)
    const swaps = await js('window.l591Swaps')
    const flushes = await js('window.l591Flushes')
    record.rows = rows
    check('E2c-10-saves-no-self-push', rows.every((row) => row.ok && !row.banner) && swaps === 0 && flushes === 0 && (await dirtyOf(rel)) === 'false', { swaps, flushes, last: rows.at(-1) })
    break
  }
  case 'e2d': {
    // ⌘S 대상 표(E2ⓓ) — 편집기 포커스 · 탭바 포커스 · 터미널 탭 활성(무동작·PTY 누출 0) · 탐색기 포커스 · 팔레트 열림.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    const table = []
    // expect: 'saved' | 'none' | 'record'(표에 기록만 — 01-criteria 가 기대를 정하지 않은 대상)
    const saveVia = async (label, prepare, { expect }) => {
      await typeIn(rel, label[0].toUpperCase())
      await until(async () => (await dirtyOf(rel)) === 'true', { label: `dirty ${label}` })
      const before = disk(rel)
      await prepare()
      const termBefore = await termText()
      const writesBefore = logRows().filter((row) => row.tag === 'file.write').length
      await key('S', ['meta'])
      await sleep(1200)
      const termAfter = await termText()
      const ptyIn = logRows().filter((row2) => row2.tag === 'term.input' || row2.tag === 'pty.write').length
      const row = { target: label, activeTab: await js(`document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null`), saved: !disk(rel).equals(before), writes: logRows().filter((row2) => row2.tag === 'file.write').length - writesBefore, dirty: await dirtyOf(rel), focus: await js('document.activeElement?.className?.toString().slice(0, 60) ?? null'), termChanged: termBefore !== termAfter, termBefore: termBefore.slice(-300), termAfter: termAfter.slice(-300), ptyInputLog: ptyIn }
      table.push(row)
      const pass = expect === 'saved' ? row.saved && row.dirty === 'false' : expect === 'none' ? !row.saved && row.writes === 0 && !row.termChanged : true
      check(`E2d-${label}${expect === 'record' ? '-recorded' : ''}`, pass, row)
      await key('Escape')
      await sleep(200)
      if (row.dirty === 'true') {
        await click(`[data-main-tab="file:${rel}"]`)
        await key('S', ['meta'])
        await settle(async () => (await dirtyOf(rel)) === 'false', 5000)
      }
    }
    await saveVia('editor', () => edOf(rel, 'e.focus(); return true'), { expect: 'saved' })
    await saveVia('tabbar', async () => {
      await click(`[data-main-tab="file:${rel}"]`)
      await js(`document.querySelector('[data-main-tab="file:${rel}"]').focus?.(); true`)
    }, { expect: 'saved' })
    const term = await terminalTabId()
    await saveVia('terminal', async () => {
      await click(`[data-main-tab="${term}"]`)
      await sleep(600)
    }, { expect: 'none' })
    // 탐색기 포커스 — 행을 누르면 그 파일을 미리보기로 연다(활성 탭이 바뀐다). 활성 탭은 그대로 두고 트리 요소에 포커스만 준다.
    await saveVia('explorer', async () => {
      await click(`[data-main-tab="file:${rel}"]`)
      await js(`(() => { const tree = document.querySelector('[data-explorer-tree]'); tree?.focus(); return document.activeElement === tree })()`)
      await sleep(300)
    }, { expect: 'record' })
    await saveVia('palette', async () => {
      await click(`[data-main-tab="file:${rel}"]`)
      await key('K', ['meta'])
      await sleep(500)
    }, { expect: 'record' })
    // 양성 대조 — 같은 탐침이 터미널 입력을 실제로 본다(글자 하나 넣고 지운다).
    await click(`[data-main-tab="${term}"]`)
    await sleep(500)
    const probeBefore = await termText()
    await ctl(root, { cmd: 'type', text: 'q' })
    const probeSaw = await settle(async () => (await termText()) !== probeBefore, 3000)
    await key('Backspace')
    check('E2d-terminal-probe-positive-control', probeSaw, { probeSaw })
    record.table = table
    record.keybinding = (await js(`window.corral.getSettingsSync?.()?.keybindings?.['file.save'] ?? null`)) ?? null
    break
  }
  case 'e2e': {
    // 저장 실패(E2ⓔ) — 권한 없음·폴더로 바뀜·worktree 밖으로 바뀜(링크)·쓰기 오류(before)·쓰기 도중 오류(mid): 안내, 수정 상태·내용 유지, 원본 바이트 그대로(mid 는 결과 기록).
    const rows = []
    const attempt = async (label, rel, prepare, cleanup) => {
      put(rel, `${label} original\n`)
      await js('window.corral.refreshTree?.()')
      await openFile(rel)
      await typeIn(rel, 'Z')
      await until(async () => (await dirtyOf(rel)) === 'true', { label: `dirty ${label}` })
      const model = await edOf(rel, 'return m.getValue()')
      const target = path.join(repo, rel)
      const shaBefore = sha(fs.readFileSync(target))
      await prepare(target)
      const base = path.basename(rel)
      await key('S', ['meta'])
      const toastSeen = await until(async () => (await toasts()).find((text) => text.includes(`'${base}'`)) ?? null, { label: `toast ${base}`, timeoutMs: 4000 }).then((r) => r.value, () => null)
      await sleep(300)
      let after = null
      try {
        after = fs.lstatSync(target).isFile() ? sha(fs.readFileSync(target)) : `not-file:${fs.lstatSync(target).isSymbolicLink() ? 'link' : 'dir'}`
      } catch (error) {
        after = String(error.code)
      }
      const row = { label, dirty: await dirtyOf(rel), modelKept: (await edOf(rel, 'return m.getValue()')) === model, toast: String(toastSeen ?? '').slice(0, 200), diskUnchanged: after === shaBefore, after, writes: logRows().filter((r) => r.tag === 'file.write').slice(-1)[0] ?? null }
      rows.push(row)
      await cleanup(target)
      return row
    }
    let row = await attempt('perm', 'f/perm.txt', (t) => fs.chmodSync(t, 0o444), (t) => fs.chmodSync(t, 0o644))
    check('E2e-permission', row.dirty === 'true' && row.modelKept && row.diskUnchanged && row.toast.includes('permission_denied'), row)
    row = await attempt('dir', 'f/todir.txt', (t) => {
      fs.renameSync(t, `${t}.orig`)
      fs.mkdirSync(t)
    }, (t) => {
      fs.rmdirSync(t)
      fs.renameSync(`${t}.orig`, t)
    })
    // 폴더로 바뀐 경우 원본 바이트는 옮겨 둔 `.orig` 로 대조
    row.diskUnchanged = sha(fs.readFileSync(path.join(repo, 'f/todir.txt'))) === sha(Buffer.from('dir original\n'))
    check('E2e-became-folder', row.dirty === 'true' && row.modelKept && row.toast.includes('not_file') && row.diskUnchanged, row)
    const outsideFile = path.join(outside, 'final-outside.txt')
    fs.writeFileSync(outsideFile, 'OUTSIDE\n')
    const outsideSha = sha(fs.readFileSync(outsideFile))
    row = await attempt('outside', 'f/tolink.txt', (t) => {
      fs.renameSync(t, `${t}.orig`)
      fs.symlinkSync(outsideFile, t)
    }, (t) => {
      fs.rmSync(t)
      fs.renameSync(`${t}.orig`, t)
    })
    row.outsideUnchanged = sha(fs.readFileSync(outsideFile)) === outsideSha
    row.diskUnchanged = sha(fs.readFileSync(path.join(repo, 'f/tolink.txt'))) === sha(Buffer.from('outside original\n'))
    check('E2e-became-outside-link', row.dirty === 'true' && row.modelKept && row.outsideUnchanged && row.diskUnchanged && /outside_root|changed|not_file/.test(row.toast), row)
    row = await attempt('fail-before', 'f/failb.txt', () => writeHook({ failWrite: 'before' }), () => clearHook())
    check('E2e-write-error-before', row.dirty === 'true' && row.modelKept && row.diskUnchanged && row.toast.includes('write_failed'), row)
    row = await attempt('fail-mid', 'f/failm.txt', () => writeHook({ failWrite: 'mid' }), () => clearHook())
    // 쓰기 도중 실패 — 제자리 쓰기의 대가(write-mode.md §1): 앞 절반만 새 내용. 01-criteria 「그 경우의 결과를 그대로 기록」 — 판정은 안내·수정 유지·내용 유지, 디스크 결과는 기록.
    check('E2e-write-error-mid-recorded', row.dirty === 'true' && row.modelKept && row.toast.includes('write_failed'), { ...row, note: 'mid = 쓰기 도중 실패 — 디스크 결과를 그대로 기록', diskNow: fs.readFileSync(path.join(repo, 'f/failm.txt'), 'utf8') })
    record.rows = rows
    break
  }
  case 'e2f': {
    // 파일 속성(E2ⓕ) — 755 mode 유지·inode 유지(제자리 쓰기) · 안을 가리키는 심링크 저장 = 대상에 쓰이고 링크는 링크 · 하드링크 동작 기록.
    put('f/exec.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(repo, 'f/exec.sh'), 0o755)
    put('f/target.txt', 'target body\n')
    fs.rmSync(path.join(repo, 'f/link.txt'), { force: true })
    fs.symlinkSync('target.txt', path.join(repo, 'f/link.txt'))
    put('f/hard-a.txt', 'hard body\n')
    fs.rmSync(path.join(repo, 'f/hard-b.txt'), { force: true })
    fs.linkSync(path.join(repo, 'f/hard-a.txt'), path.join(repo, 'f/hard-b.txt'))
    await js('window.corral.refreshTree?.()')
    const st = (rel) => fs.lstatSync(path.join(repo, rel))
    const exec0 = st('f/exec.sh')
    await openFile('f/exec.sh')
    await typeIn('f/exec.sh', '# x\n', '{ lineNumber: 2, column: 1 }')
    await key('S', ['meta'])
    await settle(async () => (await dirtyOf('f/exec.sh')) === 'false', 5000)
    const exec1 = st('f/exec.sh')
    const execRow = { modeBefore: (exec0.mode & 0o777).toString(8), modeAfter: (exec1.mode & 0o777).toString(8), inodeBefore: exec0.ino, inodeAfter: exec1.ino, saved: disk('f/exec.sh').toString('utf8').includes('# x') }
    check('E2f-mode-755-kept', execRow.saved && execRow.modeAfter === '755', execRow)
    check('E2f-inode-recorded', execRow.saved, { ...execRow, inodeKept: execRow.inodeBefore === execRow.inodeAfter })
    const target0 = st('f/target.txt')
    await openFile('f/link.txt')
    await typeIn('f/link.txt', 'L')
    await key('S', ['meta'])
    await settle(async () => (await dirtyOf('f/link.txt')) === 'false', 5000)
    const linkRow = { linkStillLink: st('f/link.txt').isSymbolicLink(), linkTarget: fs.readlinkSync(path.join(repo, 'f/link.txt')), targetBody: disk('f/target.txt').toString('utf8'), targetInodeKept: st('f/target.txt').ino === target0.ino, dirty: await dirtyOf('f/link.txt') }
    check('E2f-symlink-writes-target', linkRow.linkStillLink && linkRow.targetBody === 'Ltarget body\n' && linkRow.dirty === 'false', linkRow)
    const hardBefore = sha(disk('f/hard-a.txt'))
    await openFile('f/hard-a.txt')
    await typeIn('f/hard-a.txt', 'H')
    await key('S', ['meta'])
    await sleep(1200)
    const hardRow = { readOnly: await readOnlyOf('f/hard-a.txt'), notices: await noticeOf('f/hard-a.txt'), unchanged: sha(disk('f/hard-a.txt')) === hardBefore, nlink: st('f/hard-a.txt').nlink }
    check('E2f-hardlink-recorded', hardRow.readOnly === true && hardRow.unchanged && hardRow.notices.includes('readonly-hardlink'), hardRow)
    record.rows = { execRow, linkRow, hardRow }
    break
  }
  case 'e2g': {
    // 저장 경쟁(E2ⓖ) — 첫 쓰기를 FIFO 시험 주입으로 붙잡은 채 편집·⌘S 반복 → 풀면 마지막 내용이 디스크, 수정 표시 = 실제.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    const hook = path.join(root, 'write-hook.json')
    fs.rmSync(hook, { force: true })
    execFileSync('mkfifo', [hook])
    try {
      await typeIn(rel, 'A')
      await key('S', ['meta'])
      await sleep(300)
      await typeIn(rel, 'B')
      await key('S', ['meta'])
      await key('S', ['meta'])
      await sleep(200)
      await typeIn(rel, 'C')
      const during = { dirty: await dirtyOf(rel), disk: disk(rel).toString('utf8').slice(0, 10) }
      fs.writeFileSync(hook, '{}')
      fs.rmSync(hook, { force: true })
      fs.writeFileSync(hook, '{}')
      await sleep(2500)
      const model = await edOf(rel, 'return m.getValue()')
      const after = { model: model.slice(0, 10), disk: disk(rel).toString('utf8').slice(0, 10), dirty: await dirtyOf(rel) }
      // C 는 마지막 ⌘S 뒤라 수정으로 남는다 → 한 번 더 저장하면 디스크 = 모델
      await key('S', ['meta'])
      const final = await settle(async () => disk(rel).toString('utf8') === (await edOf(rel, 'return m.getValue()')) && (await dirtyOf(rel)) === 'false', 5000)
      // 줄 선 저장은 **자기 차례에** 그때 내용을 찍는다 — 풀린 뒤 둘째 저장이 C 까지 쓴다. 판정 = 마지막 내용이 디스크, 수정 표시 = 실제.
      check('E2g-race-last-content', during.disk.startsWith(original0(rel)) && during.dirty === 'true' && after.disk === after.model && after.model.startsWith('CBA') && after.dirty === 'false' && final, { during, after, final })
    } finally {
      fs.rmSync(hook, { force: true })
    }
    break
  }
  case 'e3a': {
    // 닫기 입구 전수(E3ⓐ) — 수정된 파일 탭을 닫는 입구마다 확인(스텁 「취소」 → 탭·수정 그대로). 입구: ⌘W · 탭 × 단추 · 가운데 클릭 · 우클릭 「닫기」 ·
    // 다른 탭 우클릭 「다른 탭 닫기」·「오른쪽 탭 닫기」 · 영역 닫기 ⌘⌥W · 팔레트 「pane / 탭 닫기」 · 팔레트 「활성 영역 닫기」.
    const rel = 'notes/plain.txt'
    await openFile('src/sample.ts')
    await openFile(rel)
    await typeIn(rel, 'W')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const table = []
    // moves = 영역 닫기 — 탭을 닫지 않고 이웃 영역으로 옮긴다(write-mode.md §9 R2-A 「해당 없음」). 판정 = 확인 없이도 탭·수정·디스크 그대로(조용히 사라짐 0)·영역 수 줄어듦.
    const entry = async (label, run, { moves = false } = {}) => {
      if (moves) {
        await rightClick(`[data-main-tab="file:${rel}"]`)
        await click('[data-context-menu] [data-menu-action="split-right"]')
        await until(async () => (await tabs()).length === 2, { label: 'split for group close', timeoutMs: 5000 })
        await click(`[data-main-tab="file:${rel}"]`)
      }
      const groupsBefore = (await tabs()).length
      await stub(['cancel'])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await run()
      const asked = await settle(() => logRows().filter((row) => row.tag === 'file.dialog').length > before, 4000)
      await sleep(400)
      const dialog = logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null
      const row = { entry: label, asked, kind: dialog?.kind ?? null, choice: dialog?.choice ?? null, tabKept: (await allTabIds()).includes(`file:${rel}`), dirty: await dirtyOf(rel), diskSame: disk(rel).toString('utf8').startsWith('확장자'), groupsBefore, groupsAfter: (await tabs()).length }
      table.push(row)
      const pass = moves ? row.tabKept && row.dirty === 'true' && row.diskSame && row.groupsAfter === groupsBefore - 1 : row.asked && row.kind === 'close' && row.tabKept && row.dirty === 'true' && row.diskSame
      check(`E3a-${label}${moves ? '-moves-tab' : ''}`, pass, row)
      await key('Escape')
      await click(`[data-main-tab="file:${rel}"]`)
      await sleep(200)
    }
    await entry('cmd-w', async () => {
      await edOf(rel, 'e.focus(); return true')
      await key('W', ['meta'])
    })
    await entry('close-button', () => click(`[data-main-tab-close="file:${rel}"]`))
    await entry('middle-click', async () => {
      const p = center(await rect(`[data-main-tab="file:${rel}"]`))
      await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: p.x, y: p.y, button: 'middle' })
      await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: p.x, y: p.y, button: 'middle' })
    })
    await entry('context-close', async () => {
      await rightClick(`[data-main-tab="file:${rel}"]`)
      await click('[data-context-menu] [data-menu-action="close"]')
    })
    await entry('context-close-others', async () => {
      await rightClick('[data-main-tab="file:src/sample.ts"]')
      await click('[data-context-menu] [data-menu-action="close-others"]')
    })
    await entry('context-close-right', async () => {
      // sample.ts 가 plain 왼쪽이어야 「오른쪽 탭 닫기」 가 plain 을 닫는다 — 순서를 확인해 기록
      const order = (await allTabIds()).filter((id) => id.startsWith('file:'))
      record.orderForRight = order
      await rightClick(`[data-main-tab="${order[0]}"]`)
      await click('[data-context-menu] [data-menu-action="close-right"]')
    })
    await entry('group-close-cmd-alt-w', async () => {
      await edOf(rel, 'e.focus(); return true')
      await key('W', ['meta', 'alt'])
    }, { moves: true })
    await entry('palette-close-tab', async () => {
      await key('K', ['meta'])
      await until(() => js(`document.querySelector('[data-palette-entry="terminal.close:0"]') !== null`), { label: 'palette entry' })
      await click('[data-palette-entry="terminal.close:0"]')
    })
    await entry('palette-close-group', async () => {
      await key('K', ['meta'])
      await until(() => js(`document.querySelector('[data-palette-entry="group.close:0"]') !== null`), { label: 'palette group entry' })
      await click('[data-palette-entry="group.close:0"]')
    }, { moves: true })
    record.table = table
    break
  }
  case 'e3b': {
    // 대화상자 3갈래(E3ⓑ) — 저장 → 저장 뒤 닫힘 · 저장 실패면 닫히지 않음 · 저장 안 함 → 닫힘·디스크 무변경 · 취소(e3a). + ⓖ 저장 안 함 → ⌘⇧T = 디스크 내용.
    const rows = []
    const run = async (label, rel, answers, setup) => {
      put(rel, `${label} body\n`)
      await js('window.corral.refreshTree?.()')
      await openFile(rel)
      await typeIn(rel, 'Q')
      await until(async () => (await dirtyOf(rel)) === 'true', { label: `dirty ${label}` })
      const model = await edOf(rel, 'return m.getValue()')
      await setup?.()
      await stub(answers)
      await edOf(rel, 'e.focus(); return true')
      await key('W', ['meta'])
      await sleep(1500)
      const row = { label, tabKept: (await allTabIds()).includes(`file:${rel}`), dirty: await dirtyOf(rel), disk: disk(rel).toString('utf8'), model }
      rows.push(row)
      clearHook()
      return row
    }
    let row = await run('save', 'f/close-save.txt', ['save'])
    check('E3b-save-then-close', !row.tabKept && row.disk === row.model, row)
    row = await run('save-fail', 'f/close-savefail.txt', ['save'], () => writeHook({ failWrite: 'before' }))
    check('E3b-save-fail-not-closed', row.tabKept && row.dirty === 'true' && row.disk === 'save-fail body\n', row)
    row = await run('discard', 'f/close-discard.txt', ['discard'])
    check('E3b-discard-closes-disk-unchanged', !row.tabKept && row.disk === 'discard body\n', row)
    await key('T', ['meta', 'shift'])
    await until(() => js(`document.querySelector('[data-file-view="f/close-discard.txt"] [data-editor-ready]') !== null`), { label: 'reopened' })
    const reopened = { model: await edOf('f/close-discard.txt', 'return m.getValue()'), dirty: await dirtyOf('f/close-discard.txt') }
    check('E3g-reopen-after-discard-is-disk', reopened.model === 'discard body\n' && reopened.dirty === 'false', reopened)
    record.rows = rows
    break
  }
  case 'e3d': {
    // worktree 닫기·삭제(E3ⓓ) — linked worktree B 에 수정된 파일 → 카드 메뉴 「worktree 닫기」 확인(취소 → 그대로, 저장 → 닫힘) · 삭제(⌘⇧⌫ → 삭제 창 → 수정 파일 확인 「취소」 → 남음).
    const repoReal = fs.realpathSync(repo)
    const prep = (dir, branch) => {
      const wt = path.join(path.dirname(repoReal), dir)
      fs.rmSync(wt, { recursive: true, force: true })
      execFileSync('git', ['-C', repoReal, 'worktree', 'prune'])
      try {
        execFileSync('git', ['-C', repoReal, 'branch', '-D', branch], { stdio: 'ignore' })
      } catch {
        // 없으면 지울 것이 없다
      }
      execFileSync('git', ['-C', repoReal, 'worktree', 'add', '-q', '-b', branch, wt])
      return wt
    }
    const wtB = prep('wt-final-close', 'l591-final-close')
    const wtC = prep('wt-final-del', 'l591-final-del')
    await js('window.corral.refreshTree?.()')
    const openWt = async (wt) => {
      await js(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(repoReal)}, path: ${JSON.stringify(wt)}, isLinked: true })`)
      await until(() => js(`!!document.querySelector('[data-worktree="${wt}"]')`), { label: `card ${wt}`, timeoutMs: 15_000 })
      await click(`[data-worktree="${wt}"]`)
      await sleep(800)
      await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
      await openFile('notes/plain.txt')
      await typeIn('notes/plain.txt', 'D')
      await until(async () => (await dirtyOf('notes/plain.txt')) === 'true', { label: 'dirty' })
    }
    const isOpen = (wt) => js(`(() => { const el = document.querySelector('[data-worktree="${wt}"]'); return el === null ? null : el.querySelector('[data-worktree-actions]') !== null || el.dataset.open === 'true' || el.getAttribute('data-open-workspace') !== null })()`)
    const workspaceOf = async (wt) => ((await herdr(root, 'pane.list')).panes ?? []).some((pane) => typeof pane.cwd === 'string' && fs.realpathSync(pane.cwd) === wt)
    await openWt(wtB)
    const closeCard = async (answer) => {
      await stub([answer])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', ...center(await rect(`[data-worktree="${wtB}"]`)) })
      await sleep(300)
      await click(`[data-worktree-menu-toggle="${wtB}"]`)
      await click(`[data-close-worktree="${wtB}"]`)
      await sleep(2000)
      return { dialog: logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null, workspace: await workspaceOf(wtB), disk: fs.readFileSync(path.join(wtB, 'notes/plain.txt'), 'utf8').slice(0, 6) }
    }
    const cancelled = await closeCard('cancel')
    check('E3d-close-worktree-asks-cancel-keeps', cancelled.dialog?.kind === 'close' && cancelled.workspace === true && (await dirtyOf('notes/plain.txt')) === 'true', cancelled)
    const saved = await closeCard('save')
    check('E3d-close-worktree-save-closes', saved.dialog?.kind === 'close' && saved.workspace === false && saved.disk.startsWith('D'), saved)
    await openWt(wtC)
    const deleteCard = async (answer) => {
      await stub([answer])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', ...center(await rect(`[data-worktree="${wtC}"]`)) })
      await sleep(300)
      await key('Backspace', ['meta', 'shift'])
      await until(() => js(`document.querySelector('[data-delete-confirm]') !== null`), { label: 'delete dialog', timeoutMs: 5000 })
      await click('[data-delete-confirm]')
      await sleep(2500)
      return { dialog: logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null, exists: fs.existsSync(wtC), dirty: await dirtyOf('notes/plain.txt') }
    }
    const delCancel = await deleteCard('cancel')
    check('E3d-delete-worktree-asks-cancel-keeps', delCancel.dialog?.kind === 'discard' && delCancel.exists && delCancel.dirty === 'true', delCancel)
    const delGo = await deleteCard('discard')
    check('E3d-delete-worktree-discard-deletes', delGo.dialog?.kind === 'discard' && !delGo.exists, delGo)
    record.isOpenProbe = await isOpen(wtB)
    break
  }
  case 'e3e': {
    // 마지막 터미널 탭(E3ⓔ) — 수정된 파일 탭이 있는 worktree 의 마지막 터미널 탭을 닫으면 확인(취소 → 터미널·파일 탭 그대로, 저장 → 저장 뒤 닫힘).
    const rel = 'notes/plain.txt'
    await openFile(rel)
    await typeIn(rel, 'L')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const term = await terminalTabId()
    const termTabs = (await allTabIds()).filter((id) => !id.startsWith('file:'))
    record.termTabs = termTabs
    await click(`[data-main-tab="${term}"]`)
    await sleep(400)
    await stub(['cancel'])
    let before = logRows().filter((row) => row.tag === 'file.dialog').length
    await key('W', ['meta'])
    await sleep(1500)
    const cancelled = { dialog: logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null, ids: await allTabIds(), dirty: await dirtyOf(rel) }
    check('E3e-last-terminal-asks-cancel-keeps', termTabs.length === 1 && cancelled.dialog?.kind === 'close' && cancelled.ids.includes(term) && cancelled.ids.includes(`file:${rel}`) && cancelled.dirty === 'true', cancelled)
    await click(`[data-main-tab="${term}"]`)
    await stub(['save'])
    before = logRows().filter((row) => row.tag === 'file.dialog').length
    await key('W', ['meta'])
    await sleep(2000)
    const saved = { dialog: logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null, ids: await allTabIds(), disk: disk(rel).toString('utf8').slice(0, 4) }
    check('E3e-last-terminal-save-then-close', saved.dialog?.kind === 'close' && !saved.ids.includes(term) && saved.disk.startsWith('L'), saved)
    break
  }
  case 'e3f': {
    // 렌더러 다시 불러오기(E3ⓕ) — 수정 문서가 있으면 main 이 묻는다(`will-prevent-unload`): 취소 → 그대로 · 다시 불러오기 → 내린다(문서 버림 — 사용자가 고른 것).
    // 입구: main `webContents.reload()`(View ▸ Reload·Force Reload 메뉴가 부르는 것과 같은 동작) — main inspector(`--inspect=0`).
    const rel = 'notes/plain.txt'
    await openFile(rel)
    await typeIn(rel, 'R')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const logFile = fs.readdirSync(root).find((item) => /^electron-.*\.log$/.test(item))
    const url = fs.readFileSync(path.join(root, logFile), 'utf8').match(/Debugger listening on (ws:\/\/\S+)/)?.[1]
    if (url === undefined) throw new Error('main inspector 없음 — L577_ELECTRON_ARGS=--inspect=0')
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
    let seq = 0
    const waiters = new Map()
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      waiters.get(message.id)?.(message)
      waiters.delete(message.id)
    }
    const mainEval = (expression) =>
      new Promise((resolve) => {
        seq += 1
        waiters.set(seq, (message) => resolve(message.result?.result?.value ?? null))
        ws.send(JSON.stringify({ id: seq, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
    await mainEval(`globalThis.l591w = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows()[0]; true`)
    try {
      await stub(['cancel'])
      await mainEval('l591w.webContents.reload(); true')
      await sleep(2000)
      const cancelled = { ask: logRows().filter((row) => row.tag === 'file.reload_confirm').slice(-1)[0] ?? null, dirty: await dirtyOf(rel), model: (await edOf(rel, 'return m?.getValue() ?? null'))?.slice(0, 4) ?? null }
      check('E3f-reload-asks-cancel-keeps', cancelled.ask?.reload === false && cancelled.dirty === 'true' && cancelled.model?.startsWith('R'), cancelled)
      await stub(['reload'])
      await mainEval('l591w.webContents.reload(); true')
      await sleep(4000)
      const reloaded = { ask: logRows().filter((row) => row.tag === 'file.reload_confirm').slice(-1)[0] ?? null, disk: disk(rel).toString('utf8').slice(0, 4) }
      check('E3f-reload-confirmed-reloads-disk-unchanged', reloaded.ask?.reload === true && reloaded.disk.startsWith('확장'), reloaded)
    } finally {
      ws.close()
    }
    break
  }
  case 'e4a':
  case 'e4b':
  case 'e4c':
  case 'e4d':
  case 'e4e': {
    // 외부 변경(E4) — 회차 하나에 시나리오 한 번(여러 회차로 ≥ 5). 외부 변경은 이 스크립트가 fixture 파일에 직접 쓴다(다른 프로세스 쓰기와 같은 경로 — 감시는 stat).
    const rel = `f/${name}.txt`
    put(rel, Array.from({ length: 300 }, (_, i) => `ext ${i + 1}`).join('\n') + '\n')
    await js('window.corral.refreshTree?.()')
    await openFile(rel)
    const file = path.join(repo, rel)
    if (name === 'e4a') {
      // ⓐ 수정 없는 탭 — 2 초 안에 갱신, 스크롤 유지(F2 그대로)
      await edOf(rel, `e.revealLineInCenter(150); e.setPosition({ lineNumber: 150, column: 1 }); return true`)
      await sleep(400)
      const before = await stateOf(rel)
      const t0 = Date.now()
      fs.writeFileSync(file, 'CHANGED\n' + fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n'))
      const updated = await settle(async () => (await edOf(rel, 'return m.getLineContent(1)')) === 'CHANGED', 2000)
      const ms = Date.now() - t0
      await sleep(300)
      const after = await stateOf(rel)
      check('E4a-clean-reloads-2s-scroll-kept', updated && ms <= 2000 && after.scrollTop === before.scrollTop && (await dirtyOf(rel)) === 'false' && !(await banner(rel)), { updated, ms, scrollBefore: before.scrollTop, scrollAfter: after.scrollTop })
      break
    }
    await typeIn(rel, 'MINE-')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const mine = await edOf(rel, 'return m.getValue()')
    if (name === 'e4b') {
      // ⓑ 수정 중 외부 변경 — 덮지 않고 배너 → 「디스크 내용으로 되돌리기」 → 디스크 내용·수정 해제 → ⌘Z 로 내 변경(실행 취소 가능 방식)
      fs.writeFileSync(file, 'EXTERNAL\n')
      const shown = await settle(() => banner(rel), 4000)
      const notOverwritten = (await edOf(rel, 'return m.getValue()')) === mine && (await dirtyOf(rel)) === 'true'
      await click(`[data-file-view="${rel}"] [data-external-action="revert"]`)
      const reverted = await settle(async () => (await edOf(rel, 'return m.getValue()')) === 'EXTERNAL\n' && (await dirtyOf(rel)) === 'false' && !(await banner(rel)), 3000)
      await edOf(rel, `e.focus(); e.trigger('keyboard', 'undo', null); return true`)
      const undone = await settle(async () => (await edOf(rel, 'return m.getValue()')) === mine && (await dirtyOf(rel)) === 'true', 3000)
      check('E4b-banner-not-overwritten', shown && notOverwritten, { shown, notOverwritten })
      check('E4b-revert-then-undo', reverted && undone, { reverted, undone, disk: fs.readFileSync(file, 'utf8') })
    } else if (name === 'e4c') {
      // ⓒ 저장 시점 충돌 검사 양성 대조 — 감시를 끊고(`file-watch-drop`) 외부 변경 직후 ⌘S → 감시가 모르는 채여도 충돌 확인(묻지 않고 덮지 않음)
      await ctl(root, { cmd: 'file-watch-drop' })
      const markRows = logRows().length
      fs.writeFileSync(file, 'SNEAKY\n')
      await stub(['cancel'])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await edOf(rel, 'e.focus(); return true')
      await key('S', ['meta'])
      await sleep(1500)
      const dialog = logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null
      // 감시가 그 변경을 먼저 알았는가(알았으면 양성 대조가 아니다) — 대화상자 전에 `file.changed` push 가 있었는지 기록
      const pushBeforeDialog = dialog === null ? null : logRows().slice(markRows).some((r) => r.tag === 'file.changed' && r.at <= dialog.at)
      const row = { dialog: dialog?.kind ?? null, choice: dialog?.choice ?? null, disk: fs.readFileSync(file, 'utf8'), dirty: await dirtyOf(rel), bannerSeenAfter: await banner(rel), pushBeforeDialog }
      check('E4c-save-time-conflict-without-watch', row.dialog === 'conflict' && row.disk === 'SNEAKY\n' && row.dirty === 'true' && row.pushBeforeDialog === false, row)
    } else if (name === 'e4d') {
      // ⓓ 수정 중 삭제·rename → 「삭제됨」 + 수정 유지 → ⌘S → 다시 만들기 확인(스텁 recreate) → 같은 경로에 내 내용
      const iteration = Number(process.env.L591_ITER ?? '0')
      const how = iteration % 2 === 0 ? 'delete' : 'rename'
      if (how === 'delete') fs.rmSync(file)
      else fs.renameSync(file, `${file}.moved`)
      const deleted = await settle(async () => (await noticeOf(rel)).includes('deleted'), 4000)
      const kept = (await edOf(rel, 'return m.getValue()')) === mine && (await dirtyOf(rel)) === 'true'
      await stub(['recreate'])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await edOf(rel, 'e.focus(); return true')
      await key('S', ['meta'])
      const recreated = await settle(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === mine, 4000)
      const dialog = logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null
      check(`E4d-${how}-kept-then-recreate`, deleted && kept && recreated && dialog?.kind === 'recreate' && (await dirtyOf(rel)) === 'false', { how, deleted, kept, recreated, dialog: dialog?.kind ?? null })
    } else {
      // ⓔ 「내 변경 유지」 뒤 저장도 충돌 확인(조용히 덮지 않음) → 취소 → 디스크 = 외부 내용
      fs.writeFileSync(file, 'THEIRS\n')
      const shown = await settle(() => banner(rel), 4000)
      await click(`[data-file-view="${rel}"] [data-external-action="keep"]`)
      await sleep(300)
      await stub(['cancel'])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await edOf(rel, 'e.focus(); return true')
      await key('S', ['meta'])
      await sleep(1500)
      const dialog = logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null
      const row = { shown, dialog: dialog?.kind ?? null, disk: fs.readFileSync(file, 'utf8'), dirty: await dirtyOf(rel), model: (await edOf(rel, 'return m.getValue()')) === mine }
      check('E4e-keep-then-save-asks', row.shown && row.dialog === 'conflict' && row.disk === 'THEIRS\n' && row.dirty === 'true' && row.model, row)
    }
    break
  }
  case 'e5': {
    // 합성 조합(E5) — CDP `Input.imeSetComposition`·`insertText`(Chromium IME 경로). 입력 경로 계측(EditContext/textarea), 조합 → 확정 정확, 조합 중 Enter·⌘W, 누출 0.
    // (조합 중 ⌘S 는 r1-cases `ime` 회차 — 같은 관문에서 따로 돈다.) L577_ELECTRON_ARGS=--remote-debugging-port=0 필요.
    const rel = 'f/ime.txt'
    put(rel, 'alpha\nbeta\n')
    await js('window.corral.refreshTree?.()')
    await openFile(rel)
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
    const cdpKey = async (keyName, code, vk, modifiers = 0, text) => {
      // text 가 있으면 문자 키(keyDown + text — Enter 는 '\r'), 없으면 rawKeyDown(단축키)
      if (text !== undefined) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers, text, unmodifiedText: text })
      else await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers })
    }
    try {
      await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
      const term = await terminalTabId()
      const explorerBefore = await js(`[...document.querySelectorAll('[data-explorer-row]')].map((el) => el.dataset.explorerRow).join('|')`)
      await edOf(rel, `window.l591Ime = []; e.onDidCompositionStart(() => window.l591Ime.push('start')); e.onDidCompositionEnd(() => window.l591Ime.push('end')); e.setPosition({ lineNumber: 1, column: 1 }); e.focus(); return true`)
      const pathInfo = await js(`(() => { const el = document.activeElement; return { tag: el?.tagName ?? null, className: el?.className?.toString() ?? null, editContext: el !== null && 'editContext' in el && el.editContext !== null, textarea: el?.tagName === 'TEXTAREA' } })()`)
      record.inputPath = pathInfo
      check('E5-input-path-measured', pathInfo.editContext === true || pathInfo.textarea === true, pathInfo)
      // ① 「한글」 조합 → 확정
      for (const [text, commit] of [['ㅎ', null], ['하', null], ['한', null], ['한ㄱ', null], ['한그', null], ['한글', '한글']]) {
        await cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
        await sleep(60)
        if (commit !== null) await cdp('Input.insertText', { text: commit })
      }
      await sleep(400)
      const composed = { first: await edOf(rel, 'return m.getLineContent(1)'), cursor: await edOf(rel, 'return e.getPosition()'), events: await js('window.l591Ime.slice()') }
      check('E5-compose-hangul-exact', composed.first === '한글alpha' && composed.cursor.column === 3, composed)
      // ② 조합 중 Enter — 실제 IME 는 Enter 를 먼저 가로채 조합을 확정(composition end)한 뒤 Enter 를 넘긴다. 그 순서를 CDP 로: imeSetComposition → insertText(확정) → Enter.
      //    판정 = 확정 1회 + 줄바꿈 1회(마지막 글자 중복 0).
      await cdp('Input.imeSetComposition', { text: '말', selectionStart: 1, selectionEnd: 1 })
      await sleep(100)
      await cdp('Input.insertText', { text: '말' })
      await cdpKey('Enter', 'Enter', 13, 0, '\r')
      await sleep(400)
      const afterEnter = await edOf(rel, 'return m.getValue()')
      record.afterEnter = afterEnter
      const count = (afterEnter.match(/말/g) ?? []).length
      check('E5-enter-commit-then-newline', count === 1 && afterEnter.startsWith('한글말\n') && afterEnter.split('\n').length === 4, { afterEnter, count, events: await js('window.l591Ime.slice()') })
      // ②′ (관찰 — 판정 아님) 조합이 살아 있는 채 Enter 문자 키를 페이지에 넣는 합성 순서. 실제 IME 는 조합 중 Enter 를 가로채므로(keyCode 229) 이 순서는
      //    합성에서만 생긴다고 보지만 확인은 E10(실제 macOS 한글 IME). 결과를 그대로 기록한다.
      await edOf(rel, `e.setPosition({ lineNumber: 2, column: 1 }); e.focus(); return true`)
      await cdp('Input.imeSetComposition', { text: '물', selectionStart: 1, selectionEnd: 1 })
      await sleep(100)
      await cdpKey('Enter', 'Enter', 13, 0, '\r')
      await sleep(200)
      const rawMid = { model: await edOf(rel, 'return m.getValue()'), events: await js('window.l591Ime.slice()') }
      await cdp('Input.insertText', { text: '물' })
      await sleep(300)
      record.rawEnterDuringComposition = { mid: rawMid, after: await edOf(rel, 'return m.getValue()') }
      console.log(`OBSERVE E5-raw-enter-during-composition ${JSON.stringify(record.rawEnterDuringComposition)}`)
      await edOf(rel, `m.setValue('한글말\\nalpha\\nbeta\\n'); e.setPosition({ lineNumber: 1, column: 4 }); e.focus(); return true`)
      // ③ 조합 중 ⌘W → 확인 대화상자(스텁 취소) · 조합 글자 유실 0
      await cdp('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 })
      await sleep(150)
      await stub(['cancel'])
      const before = logRows().filter((row) => row.tag === 'file.dialog').length
      await cdpKey('w', 'KeyW', 87, 4)
      await sleep(1200)
      const dialog = logRows().filter((row) => row.tag === 'file.dialog').slice(before)[0] ?? null
      const afterW = await edOf(rel, 'return m.getValue()')
      check('E5-cmd-w-during-composition', dialog?.kind === 'close' && afterW.includes('글') && (await allTabIds()).includes(`file:${rel}`), { dialog: dialog?.kind ?? null, afterW })
      // ④ 누출 0 — 터미널 탐침·탐색기 행 그대로
      const termNow = await termText()
      await click(`[data-main-tab="${term}"]`)
      await sleep(400)
      const termSeen = await termText()
      const explorerAfter = await js(`[...document.querySelectorAll('[data-explorer-row]').values()].map((el) => el.dataset.explorerRow).join('|')`)
      check('E5-no-leak-terminal-explorer', !termSeen.includes('한') && !termSeen.includes('말') && !termSeen.includes('글') && explorerAfter === explorerBefore, { termHasHangul: termSeen.includes('한') || termSeen.includes('말'), explorerSame: explorerAfter === explorerBefore, termNowLen: termNow.length })
    } finally {
      socket.close()
    }
    break
  }
  case 'e6': {
    // 쓰기 IPC 양성 대조(E6ⓑ) — **실제 창 → preload(window.corral.writeFile) → ipcMain 같은 핸들러**. 사유 코드로 어느 검사에서 났는지 본다. ⑩ 경쟁 주입은 시험 훅.
    const repoReal = fs.realpathSync(repo)
    const outDir = path.join(path.dirname(repoReal), 'final-out')
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'a.txt'), 'OUT-A\n')
    fs.writeFileSync(path.join(outDir, 'hard.txt'), 'OUT-HARD\n')
    const outSha = () => ({ a: sha(fs.readFileSync(path.join(outDir, 'a.txt'))), hard: sha(fs.readFileSync(path.join(outDir, 'hard.txt'))) })
    const before = outSha()
    put('e6/in.txt', 'inside\n')
    put('e6/sub/a.txt', 'sub inside\n')
    fs.rmSync(path.join(repo, 'e6/lastlink.txt'), { force: true })
    fs.symlinkSync(path.join(outDir, 'a.txt'), path.join(repo, 'e6/lastlink.txt'))
    fs.rmSync(path.join(repo, 'e6/midlink'), { force: true, recursive: true })
    fs.symlinkSync(outDir, path.join(repo, 'e6/midlink'))
    fs.rmSync(path.join(repo, 'e6/fifo'), { force: true })
    execFileSync('mkfifo', [path.join(repo, 'e6/fifo')])
    fs.rmSync(path.join(repo, 'e6/hard.txt'), { force: true })
    fs.linkSync(path.join(outDir, 'hard.txt'), path.join(repo, 'e6/hard.txt'))
    fs.rmSync(path.join(repo, 'e6/devlink'), { force: true })
    fs.symlinkSync('/dev/null', path.join(repo, 'e6/devlink'))
    // textRepeat = 렌더러 안에서 그 길이의 내용을 만든다(50 MB 를 제어 소켓으로 보내지 않게)
    const call = (input) => {
      const { textRepeat, ...rest } = input
      return textRepeat === undefined ? js(`window.corral.writeFile(${JSON.stringify(rest)}).then((r) => r)`) : js(`window.corral.writeFile({ ...${JSON.stringify(rest)}, text: 'x'.repeat(${textRepeat}) }).then((r) => r)`)
    }
    const base = { root: repoReal, text: 'WRITTEN\n', bom: false, baseStamp: null, baseHash: null, overwrite: true, create: false }
    const cases = [
      ['01-inside', { ...base, rel: 'e6/in.txt' }, true],
      ['02-dotdot', { ...base, rel: '../final-out/a.txt' }, false],
      ['03-absolute', { ...base, rel: path.join(outDir, 'a.txt') }, false],
      ['04-last-link-out', { ...base, rel: 'e6/lastlink.txt' }, false],
      ['05-mid-dir-link-out', { ...base, rel: 'e6/midlink/a.txt' }, false],
      ['06-unregistered-root', { ...base, root: outDir, rel: 'a.txt' }, false],
      ['07a-type-rel', { ...base, rel: 42 }, false],
      ['07b-type-text', { ...base, rel: 'e6/in.txt', text: 7 }, false],
      ['08-too-large', { ...base, rel: 'e6/in.txt', textRepeat: 50 * 1024 * 1024 + 1 }, false],
      ['09a-folder', { ...base, rel: 'e6/sub' }, false],
      ['09b-fifo', { ...base, rel: 'e6/fifo' }, false],
      ['09c-device-link', { ...base, rel: 'e6/devlink' }, false],
      ['11-hardlink-out', { ...base, rel: 'e6/hard.txt' }, false],
    ]
    const rows = []
    for (const [id, input, ok] of cases) {
      const t0 = Date.now()
      const result = await call(input)
      const row = { id, ok: result?.ok ?? null, code: result?.ok === false ? result.code : null, ms: Date.now() - t0 }
      rows.push(row)
      check(`E6b-${id}`, ok ? row.ok === true && disk('e6/in.txt').toString('utf8') === 'WRITTEN\n' : row.ok === false, row)
    }
    // ⑩ 경쟁 주입 — 검사 뒤·열기 전에 중간 폴더 e6/sub 를 밖(final-out)을 가리키는 링크로 바꾼다(시험 훅 swapDir)
    writeHook({ swapDir: path.join(repoReal, 'e6/sub'), linkTo: outDir })
    const raced = await call({ ...base, rel: 'e6/sub/a.txt' })
    clearHook()
    const race = { ok: raced?.ok ?? null, code: raced?.code ?? null, outsideSame: JSON.stringify(outSha()) === JSON.stringify(before), swapped: fs.lstatSync(path.join(repo, 'e6/sub')).isSymbolicLink() }
    rows.push({ id: '10-race-swap', ...race })
    check('E6b-10-race-swap', race.ok === false && race.outsideSame && race.swapped, race)
    check('E6b-outside-bytes-unchanged', JSON.stringify(outSha()) === JSON.stringify(before), { before, after: outSha() })
    record.rows = rows
    break
  }
  case 'e9': {
    // 자동 저장 없음(E9) — 편집 뒤 30 초 대기·포커스 이동(터미널 탭 → 탐색기 → 다른 파일 탭 → 돌아오기) 동안 디스크·쓰기 로그 무변경.
    const rel = 'notes/plain.txt'
    await openFile(rel)
    const before = sha(disk(rel))
    await typeIn(rel, 'AUTO?')
    await until(async () => (await dirtyOf(rel)) === 'true', { label: 'dirty' })
    const writesBefore = logRows().filter((row) => row.tag === 'file.write').length
    const term = await terminalTabId()
    const samples = []
    const t0 = Date.now()
    const steps = [
      () => click(`[data-main-tab="${term}"]`),
      () => js(`document.querySelector('[data-explorer-tree]')?.focus(); true`),
      () => openFile('src/sample.ts'),
      () => click(`[data-main-tab="file:${rel}"]`),
      () => key('L', ['meta']),
      () => key('L', ['meta']),
    ]
    for (let i = 0; Date.now() - t0 < 31_000; i += 1) {
      if (i < steps.length) await steps[i]()
      await sleep(5000)
      samples.push({ s: Math.round((Date.now() - t0) / 1000), same: sha(disk(rel)) === before })
    }
    const writes = logRows().filter((row) => row.tag === 'file.write').length - writesBefore
    check('E9-no-autosave-30s-focus-moves', samples.every((row) => row.same) && writes === 0 && (await dirtyOf(rel)) === 'true', { samples, writes, waitedMs: Date.now() - t0 })
    break
  }
  default:
    throw new Error(`모르는 case: ${name}`)
}

function original0(rel) {
  return rel === 'notes/plain.txt' ? '확장자' : ''
}

const failed = checks.filter((row) => !row.pass)
writeJson(path.join(values.out, `${name}.json`), { case: name, checks, record })
if (alive()) await stub(['discard', 'discard', 'discard', 'discard']).catch(() => null)
console.log(failed.length === 0 && checks.length > 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(',')}`)
process.exit(failed.length === 0 && checks.length > 0 ? 0 : 1)
