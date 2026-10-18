// LIFE-592 수정 r4 — 기록 연쇄 격리 실창 1회(리뷰어 r4 history-ui 와 같은 경로: 툴바 새 파일 → ⌘⌫ 삭제 → ⌘Z 되살림 → ⌘Z 만들기 되돌림).
// 고친 뒤 기대: 두 번째 ⌘Z 가 거절 없이 파일을 치운다. 이어서 ⌘⇧Z(만들기 재생) → ⌘⇧Z(다시 삭제) → ⌘Z(되살림) → ⌘Z(만들기 되돌림) 왕복도 거절 없이.
// 사용(app/ 에서, iso.sh 안): node scripts/l592/chain-flow.mjs <ROOT> <OUT.json>
// 입력은 제어 소켓(sendInputEvent) — OS 키 입력(CGEvent)·클립보드·Finder 아님. 휴지통에는 이름에 l592 가 든 fixture 항목만 간다(trashed 목록을 결과에 남긴다).
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: chain-flow.mjs /tmp/l592g-* OUT.json')
const repo = path.join(root, 'repo')
const rel = 'src/l592-chain.ts'
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], trashed: [], checks: {} }
const exists = () => fs.existsSync(path.join(repo, rel))
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const treeFocused = () => q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
const toasts = () => q(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((e) => e.textContent)`)
const step = async (name, data = {}) => {
  const row = { name, at: new Date().toISOString(), exists: exists(), treeFocused: await treeFocused(), toasts: await toasts(), ...data }
  result.steps.push(row)
  console.log(`# ${name} ${JSON.stringify(row).slice(0, 300)}`)
  return row
}
const focusRow = async (target) => {
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: `[data-explorer-row="${target}"]` })
    await sleep(200)
    return (await treeFocused()) && (await q(`document.querySelector('[data-explorer-row="${target}"]')?.classList.contains('is-selected') === true`))
  }, { timeoutMs: 6000, label: `트리 포커스 ${target}` })
}
/** 트리 포커스를 src 행으로 되돌린다(접혔으면 다시 편다 — 행 확인용). */
const treeOnSrc = async () => {
  if (await treeFocused()) return
  await focusRow('src')
  if ((await q(`document.querySelector('[data-explorer-row="src"]')?.getAttribute('aria-expanded')`)) === 'false') await key('Right')
}

await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
await giveBack()
await repoPane(root)
await sleep(1500)
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
if (!(await panelOpen())) await key('L', ['meta'])
await until(panelOpen, { label: '탐색기' })
await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })

// ① 새 파일 — src 선택 → 툴바 「새 파일」 → 이름 → Enter.
await focusRow('src')
await ctl(root, { cmd: 'click', selector: '[data-explorer-new-file]' })
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '입력 행 포커스' })
await ctl(root, { cmd: 'type', text: 'l592-chain.ts' })
await sleep(100)
await key('Return')
await until(() => exists(), { label: '새 파일' })
await until(() => q(`document.querySelector('[data-explorer-row="${rel}"]') !== null`), { label: '새 행' })
await step('create')

// ② 삭제 — 트리 ⌘⌫ → 확인(스텁 'trash') → 휴지통.
await ctl(root, { cmd: 'file-dialog-stub', answers: ['trash'] })
await focusRow(rel)
const trashAt = new Date().toISOString()
await key('Backspace', ['meta'])
await until(() => !exists(), { label: '삭제' })
result.trashed.push({ path: path.join(repo, rel), at: trashAt, via: '⌘⌫ → shell.trashItem' })
await step('delete')

// ③ ⌘Z — 되살림. ④ ⌘Z — 만들기 되돌림(고치기 전에는 여기서 modified 거절).
await treeOnSrc()
await key('Z', ['meta'])
await until(() => exists(), { label: '되살림' })
await step('undo-delete')
const undoCreateAt = new Date().toISOString()
await key('Z', ['meta'])
await until(() => !exists(), { timeoutMs: 8000, label: '만들기 되돌림' }).catch(() => null)
if (!exists()) result.trashed.push({ path: path.join(repo, rel), at: undoCreateAt, via: '⌘Z(만들기 되돌림) → shell.trashItem' })
const undoCreate = await step('undo-create')

// ⑤ ⌘⇧Z — 만들기 재생. ⑥ ⌘⇧Z — 다시 삭제. ⑦ ⌘Z 되살림. ⑧ ⌘Z 만들기 되돌림.
await key('Z', ['meta', 'shift'])
await until(() => exists(), { timeoutMs: 8000, label: '만들기 재생' }).catch(() => null)
const redoCreate = await step('redo-create')
const redoDeleteAt = new Date().toISOString()
await key('Z', ['meta', 'shift'])
await until(() => !exists(), { timeoutMs: 8000, label: '다시 삭제' }).catch(() => null)
if (!exists()) result.trashed.push({ path: path.join(repo, rel), at: redoDeleteAt, via: '⌘⇧Z(다시 삭제) → shell.trashItem' })
const redoDelete = await step('redo-delete')
await treeOnSrc()
await key('Z', ['meta'])
await until(() => exists(), { timeoutMs: 8000, label: '다시 되살림' }).catch(() => null)
const undoDeleteAgain = await step('undo-delete-again')
const finalAt = new Date().toISOString()
await key('Z', ['meta'])
await until(() => !exists(), { timeoutMs: 8000, label: '다시 만들기 되돌림' }).catch(() => null)
if (!exists()) result.trashed.push({ path: path.join(repo, rel), at: finalAt, via: '⌘Z(만들기 되돌림) → shell.trashItem' })
const undoCreateAgain = await step('undo-create-again')

const refusals = result.steps.flatMap((row) => row.toasts.filter((text) => text.includes('하지 못했습니다')))
result.checks = {
  undoCreateAfterRestore: undoCreate.exists === false,
  redoCreate: redoCreate.exists === true,
  redoDelete: redoDelete.exists === false,
  undoDeleteAgain: undoDeleteAgain.exists === true,
  undoCreateAgain: undoCreateAgain.exists === false,
  noRefusalToast: refusals.length === 0,
}
result.refusals = refusals
result.pass = Object.values(result.checks).every(Boolean)
result.focus = giveBackLog
writeJson(out, result)
console.log(JSON.stringify(result.checks))
if (!result.pass) process.exitCode = 1
