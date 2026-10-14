// LIFE-592 수정 r1 — 격리 회귀 탐침(R1-D·R1-E·R1-F). 리뷰어 R12 `ui-probe-v3` 방식을 판정식이 있는 회차로 옮겼다.
//   R1-E 활성 편집기(커서 80:5·스크롤 아래)를 트리에서 이름 변경 → 커서·scrollTop 같음
//   R1-F `.txt → .ts` 이름 변경 → 같은 모델의 `getLanguageId()` = typescript, 이름 변경 전 편집의 실행 취소 유지
//   R1-D 이름 변경 직후(새 탭 준비 150 ms 뒤 — 감시 붙잡기 구간 안) 외부 쓰기 1회 → 2.6 s 뒤 모델 = 디스크(수정 없는 탭)
// 사용(app/ 에서, iso.sh 안): node scripts/l592/r1-ui-probe.mjs <ROOT> <OUT.json>   — 입력은 제어 소켓(sendInputEvent), Monaco 상태는 `exposeMonaco`(시험 전용)
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, exposeMonaco, sleep, until, repoPane, writeJson } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: r1-ui-probe.mjs /tmp/l592g-* OUT.json')
const repo = path.join(root, 'repo')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], checks: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${name} ${JSON.stringify(data).slice(0, 400)}`)
}
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const ready = (selector) => until(() => q(`document.querySelector(${JSON.stringify(selector)}) !== null`), { timeoutMs: 8000, label: selector })
/** 그 파일 뷰의 편집기·모델 상태. */
const stateOf = (rel) =>
  q(`(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); const e = window.l592Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); if (e === undefined) return null; const m = e.getModel(); const p = e.getPosition(); const t = document.querySelector('[data-file-tab="${rel}"]'); return { uri: m?.uri.toString() ?? null, language: m?.getLanguageId() ?? null, first: m?.getLineContent(1) ?? null, text: m?.getValue().slice(0, 80) ?? null, position: p === null ? null : { line: p.lineNumber, column: p.column }, scrollTop: e.getScrollTop(), dirty: t?.dataset.fileDirty ?? null, notices: [...document.querySelectorAll('[data-file-notice]')].map((x) => x.dataset.fileNotice) } })()`)
const open = async (rel) => {
  await ready(`[data-explorer-row="${rel}"]`)
  await ctl(root, { cmd: 'dblclick', selector: `[data-explorer-row="${rel}"]` })
  await ready(`[data-file-view="${rel}"] .view-lines`)
  await until(async () => (await stateOf(rel)) !== null, { label: `편집기 ${rel}` })
  await sleep(200)
}
const rename = async (from, toName, toRel) => {
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: `[data-explorer-row="${from}"]` })
    await sleep(150)
    return q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
  }, { timeoutMs: 6000, label: '트리 포커스' })
  await key('Return')
  await ready('[data-explorer-input]')
  await q(`(() => { const i = document.querySelector('[data-explorer-input]'); i.setSelectionRange(0, i.value.length); return true })()`)
  await key('Shift')
  await ctl(root, { cmd: 'type', text: toName })
  await key('Return')
  await ready(`[data-file-tab="${toRel}"]`)
}

await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
fs.writeFileSync(path.join(repo, 'l592-lang.txt'), Array.from({ length: 200 }, (_, index) => `const line${index} = ${index}`).join('\n'))
fs.writeFileSync(path.join(repo, 'l592-watch.txt'), 'before external change')
await repoPane(root)
await sleep(1200)
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await ready('[data-explorer-tree]')
await exposeMonaco(root)

// R1-E·R1-F
await open('l592-lang.txt')
await q(`(() => { const host = document.querySelector('[data-file-view="l592-lang.txt"] [data-file-editor]'); const e = window.l592Monaco.editor.getEditors().find((x) => host.contains(x.getContainerDomNode())); e.executeEdits('l592', [{ range: new window.l592Monaco.Range(1, 1, 1, 1), text: '// dirty ' }]); e.pushUndoStop(); e.setPosition({ lineNumber: 80, column: 5 }); e.revealLineInCenter(80); return true })()`)
await sleep(200)
const before = await stateOf('l592-lang.txt')
step('before-rename', { before })
await rename('l592-lang.txt', 'l592-lang.ts', 'l592-lang.ts')
await sleep(1200)
const after = await stateOf('l592-lang.ts')
step('after-rename', { after })
result.checks.viewState = before?.position?.line === 80 && before.scrollTop > 0 && after?.position?.line === before.position.line && after.position.column === before.position.column && Math.abs(after.scrollTop - before.scrollTop) <= 1
result.checks.language = before?.language === 'plaintext' && after?.language === 'typescript' && after.uri === before.uri
await q(`(() => { const host = document.querySelector('[data-file-view="l592-lang.ts"] [data-file-editor]'); const e = window.l592Monaco.editor.getEditors().find((x) => host.contains(x.getContainerDomNode())); e.trigger('l592', 'undo', null); return true })()`)
await sleep(200)
const undone = await stateOf('l592-lang.ts')
step('editor-undo-after-rename', { undone })
result.checks.editUndo = undone?.first === 'const line0 = 0' && undone.dirty === 'false'

// R1-D
await open('l592-watch.txt')
await rename('l592-watch.txt', 'l592-watched.txt', 'l592-watched.txt')
await ready('[data-file-view="l592-watched.txt"] .view-lines')
await sleep(150)
const writeAt = Date.now()
fs.writeFileSync(path.join(repo, 'l592-watched.txt'), 'external edit inside grace')
await sleep(2600)
const inGrace = await stateOf('l592-watched.txt')
step('after-grace-change', { writeAt, inGrace })
result.checks.watchInGrace = inGrace?.text === 'external edit inside grace'
fs.writeFileSync(path.join(repo, 'l592-watched.txt'), 'external edit after grace')
await sleep(1600)
const control = await stateOf('l592-watched.txt')
step('after-grace-control', { control })
result.checks.watchControl = control?.text === 'external edit after grace'

result.pass = Object.values(result.checks).every((value) => value === true)
writeJson(out, result)
console.log(`# checks ${JSON.stringify(result.checks)} pass=${result.pass}`)
process.exit(result.pass ? 0 : 1)
