// LIFE-592 빠른 확인 — 핵심 진입점 1회(격리 Electron, fixture 만). 새 파일 → 수정 → 이름 변경(Enter) → 열린 탭 따라감 → ⌘S 새 경로 저장
// → 삭제(⌘⌫, 확인 대화상자는 계측 스텁 'trash') → OS 휴지통 → ⌘Z 되살림 → ⌘⇧Z 다시 휴지통 → ⌘Z 되살림. 단계마다 디스크 대조.
// 사용(app/ 에서, iso.sh 안): node scripts/l592/core-flow.mjs <ROOT> <OUT.json>
// 입력은 제어 소켓(sendInputEvent) — OS 키 입력(CGEvent)·클립보드·Finder 아님. 휴지통에는 이름에 l592 가 든 fixture 항목만 간다(trashed 목록을 결과에 남긴다).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: core-flow.mjs /tmp/l592g-* OUT.json')
const repo = path.join(root, 'repo')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], trashed: [], checks: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${name} ${JSON.stringify(data).slice(0, 300)}`)
}
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null)
const disk = (rel) => {
  const file = path.join(repo, rel)
  if (!fs.existsSync(file)) return { exists: false }
  const stat = fs.lstatSync(file)
  return { exists: true, size: stat.size, mode: (stat.mode & 0o777).toString(8), sha: sha(file) }
}
const q = (js) => evalJs(root, js)
const treeFocused = () => q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
const focusRow = async (rel) => {
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: `[data-explorer-row="${rel}"]` })
    await sleep(200)
    return (await treeFocused()) && (await q(`document.querySelector('[data-explorer-row="${rel}"]')?.classList.contains('is-selected') === true`))
  }, { timeoutMs: 6000, label: `트리 포커스 ${rel}` })
}
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
/** 「삭제됨」 표시(탭·띠)·외부 변경 배너가 한 번이라도 보였는지 20 ms 간격으로 본다. */
const startSampler = () => q(`(() => { window.__l592seen = []; clearInterval(window.__l592timer); window.__l592timer = setInterval(() => { const d = document.querySelector('.main-tab.is-deleted, [data-file-notice="deleted"]'); const b = document.querySelector('[data-file-notice="external"], .file-view-banner.is-external'); if (d || b) window.__l592seen.push({ at: Date.now(), deleted: !!d, banner: !!b, tab: d?.getAttribute('data-file-tab') ?? null }) }, 20); return true })()`)
const stopSampler = () => q(`(() => { clearInterval(window.__l592timer); return window.__l592seen })()`)
const trashListing = (name) => {
  try {
    return fs.readdirSync(path.join(process.env.HOME, '.Trash')).filter((entry) => entry.startsWith(name.replace(/\.[^.]+$/, '')))
  } catch (error) {
    return `~/.Trash 읽기 실패: ${error.code ?? error.message}`
  }
}

await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
await repoPane(root)
await sleep(1500)
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
if (!(await panelOpen())) await key('L', ['meta'])
await until(panelOpen, { label: '탐색기' })
await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })

// ① 새 파일 — src 를 선택하고 툴바 「새 파일」(선택이 폴더면 그 안). 입력 행 → 이름 → Enter.
await focusRow('src')
await ctl(root, { cmd: 'click', selector: '[data-explorer-new-file]' })
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '입력 행 포커스' })
const slot = await q(`(() => { const r = document.querySelector('[data-explorer-input-row]'); const rows = [...document.querySelectorAll('[data-explorer-row]')].map((e) => ({ rel: e.dataset.explorerRow, top: parseFloat(e.style.top) })); return { kind: r?.dataset.explorerInputRow ?? null, top: r === null ? null : parseFloat(r.style.top), rows } })()`)
await ctl(root, { cmd: 'type', text: 'l592-new.ts' })
await sleep(100)
const enterAt = Date.now()
await key('Return')
const shown = await until(() => q(`document.querySelector('[data-explorer-row="src/l592-new.ts"]') !== null ? Date.now() : null`), { label: '새 행' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-new.ts"]') !== null`), { label: '새 탭' })
const created = disk('src/l592-new.ts')
const newTab = await q(`(() => { const t = document.querySelector('[data-file-tab="src/l592-new.ts"]'); return { preview: t?.dataset.tabPreview ?? null, active: t?.dataset.active ?? null } })()`)
step('create', { slot, created, newTab, rowShownMs: shown.value - enterAt })
result.checks.create = created.exists === true && created.size === 0 && newTab.preview === 'false'

// ② 수정 — 새 탭 편집기에 글을 친다(저장 안 함).
await until(async () => {
  await ctl(root, { cmd: 'click', selector: '[data-file-view="src/l592-new.ts"] [data-file-editor] .view-lines' })
  await sleep(200)
  return q(`document.activeElement?.closest('[data-file-editor]') !== null`)
}, { timeoutMs: 6000, label: '편집기 포커스' })
await ctl(root, { cmd: 'type', text: 'export const n = 1' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-new.ts"]')?.dataset.fileDirty === 'true'`), { label: '수정 표시' })
step('edit', { dirty: true, disk: disk('src/l592-new.ts') })

// ③ 이름 변경 — 트리 Enter(Q6) → 확장자 앞까지 선택 → 새 이름 → Enter. 「삭제됨」·배너 표본.
await focusRow('src/l592-new.ts')
await key('Return')
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '이름 변경 입력' })
const selection = await q(`(() => { const i = document.activeElement; return { value: i.value, start: i.selectionStart, end: i.selectionEnd } })()`)
await startSampler()
await ctl(root, { cmd: 'type', text: 'l592-renamed' })
await key('Return')
await until(() => q(`document.querySelector('[data-file-tab="src/l592-renamed.ts"]') !== null`), { label: '탭 따라감' })
await sleep(1800)
const seenAfterRename = await stopSampler()
const renamedTab = await q(`(() => { const t = document.querySelector('[data-file-tab="src/l592-renamed.ts"]'); return { dirty: t?.dataset.fileDirty ?? null, active: t?.dataset.active ?? null, preview: t?.dataset.tabPreview ?? null, oldTab: document.querySelector('[data-file-tab="src/l592-new.ts"]') !== null, editorText: window.document.querySelector('[data-file-view="src/l592-renamed.ts"] .view-lines')?.textContent ?? null } })()`)
step('rename', { selection, oldDisk: disk('src/l592-new.ts'), newDisk: disk('src/l592-renamed.ts'), renamedTab, seenDeletedOrBanner: seenAfterRename })
result.checks.rename =
  selection.value === 'l592-new.ts' && selection.start === 0 && selection.end === 'l592-new'.length && !disk('src/l592-new.ts').exists && disk('src/l592-renamed.ts').exists && renamedTab.dirty === 'true' && renamedTab.oldTab === false && seenAfterRename.length === 0

// ④ ⌘S — 새 경로에 저장, 옛 경로는 다시 생기지 않는다.
await until(async () => {
  await ctl(root, { cmd: 'click', selector: '[data-file-view="src/l592-renamed.ts"] [data-file-editor] .view-lines' })
  await sleep(200)
  return q(`document.activeElement?.closest('[data-file-editor]') !== null`)
}, { timeoutMs: 6000, label: '편집기 포커스(저장)' })
await key('S', ['meta'])
await until(() => q(`document.querySelector('[data-file-tab="src/l592-renamed.ts"]')?.dataset.fileDirty === 'false'`), { label: '저장' })
const saved = disk('src/l592-renamed.ts')
const savedText = fs.readFileSync(path.join(repo, 'src/l592-renamed.ts'), 'utf8')
step('save', { saved, savedText, oldDisk: disk('src/l592-new.ts') })
result.checks.save = savedText === 'export const n = 1' && !disk('src/l592-new.ts').exists

// ⑤ 삭제 — 트리 ⌘⌫ → 확인(스텁 'trash') → 휴지통. 수정 없는 탭은 닫힌다(Q3).
await ctl(root, { cmd: 'file-dialog-stub', answers: ['trash'] })
await focusRow('src/l592-renamed.ts')
const trashAt = new Date().toISOString()
await key('Backspace', ['meta'])
await until(() => !disk('src/l592-renamed.ts').exists, { label: '휴지통으로' })
result.trashed.push({ path: path.join(repo, 'src/l592-renamed.ts'), at: trashAt, via: '⌘⌫ → shell.trashItem' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-renamed.ts"]') === null`), { label: '탭 닫힘' })
const asked = await ctl(root, { cmd: 'file-dialog-stub', answers: [] })
step('trash', { disk: disk('src/l592-renamed.ts'), dialogAsked: asked.asked ?? asked, trashListing: trashListing('l592-renamed.ts'), rowGone: await q(`document.querySelector('[data-explorer-row="src/l592-renamed.ts"]') === null`) })
result.checks.trash = !disk('src/l592-renamed.ts').exists

// ⑥ ⌘Z(트리 포커스) — 사본으로 되살림, 바이트 sha = 삭제 전. 닫힌 탭은 다시 열지 않는다.
await until(async () => {
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="src"]' })
  await sleep(150)
  return treeFocused()
}, { timeoutMs: 6000, label: '트리 포커스(⌘Z)' })
// src 클릭이 폴더를 접었으면 다시 펼친다(행 확인용).
if ((await q(`document.querySelector('[data-explorer-row="src"]')?.getAttribute('aria-expanded')`)) === 'false') await key('Right')
await key('Z', ['meta'])
await until(() => disk('src/l592-renamed.ts').exists, { label: '되살림' })
const restored = disk('src/l592-renamed.ts')
await until(() => q(`document.querySelector('[data-explorer-row="src/l592-renamed.ts"]') !== null`), { label: '되살린 행' }).catch(() => null)
step('undo-trash', { restored, sameSha: restored.sha === saved.sha, tabReopened: await q(`document.querySelector('[data-file-tab="src/l592-renamed.ts"]') !== null`) })
result.checks.undo = restored.sha === saved.sha && (await q(`document.querySelector('[data-file-tab="src/l592-renamed.ts"]') === null`))

// ⑦ ⌘⇧Z — 다시 휴지통(확인 없이 — 다시 실행), ⑧ ⌘Z — 다시 되살림.
const redoAt = new Date().toISOString()
await key('Z', ['meta', 'shift'])
await until(() => !disk('src/l592-renamed.ts').exists, { label: '다시 실행' })
result.trashed.push({ path: path.join(repo, 'src/l592-renamed.ts'), at: redoAt, via: '⌘⇧Z(다시 실행) → shell.trashItem' })
step('redo', { disk: disk('src/l592-renamed.ts'), zoomed: await q(`!!document.querySelector('[data-zoomed="true"], .is-zoomed')`), treeFocused: await treeFocused() })
await key('Z', ['meta'])
await until(() => disk('src/l592-renamed.ts').exists, { label: '다시 되살림' })
const again = disk('src/l592-renamed.ts')
step('undo-again', { again, sameSha: again.sha === saved.sha })
result.checks.redo = again.sha === saved.sha

// 로그 — 조작 결과·대화상자.
const logFile = path.join(root, 'ud/corral.ndjson')
result.log = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : []).filter((line) => /explorer\.op|file\.dialog|shortcut\.intercepted/.test(line)).slice(-40)
result.disk = { files: fs.readdirSync(path.join(repo, 'src')).sort() }
result.pass = Object.values(result.checks).every((value) => value === true)
writeJson(out, result)
console.log(`# checks ${JSON.stringify(result.checks)} pass=${result.pass}`)
process.exit(result.pass ? 0 : 1)
