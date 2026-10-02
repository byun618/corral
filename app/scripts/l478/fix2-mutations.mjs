// LIFE-478 fix2 변이 점검 (리뷰 r2 R2B-02 「변이 확인」 · R2B-09 M7·M11·M12) — 제품 파일 한 곳을 일부러 망가뜨리고 해당 시험 파일을 돌려
// **시험이 실패하는지**(변이 사망) 본다. 변이는 하나씩, 시험 뒤 원래 바이트로 되돌리고 해시로 원복을 확인한다.
// 사용: node fix2-mutations.mjs <결과 폴더>   (app/ 에서 · TMPDIR 짧게)   종료코드 0 = 모든 변이 사망 + 원복 확인
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(process.argv[2] ?? 'fix2-mutations')
fs.mkdirSync(out, { recursive: true })
const R = 'src/renderer/src'
const DIALOGS = `${R}/components/CardDialogs.test.tsx`
const MENU = `${R}/card-menu.test.ts`

const MUTATIONS = [
  { id: 'R2B-02-delete-no-announce', file: `${R}/components/DeleteWorktreeDialog.tsx`, find: '  useAnnounceDialog()\n', replace: '', test: DIALOGS },
  { id: 'R2B-02-meta-no-announce', file: `${R}/components/WorktreeMetaDialog.tsx`, find: '  useAnnounceDialog()\n', replace: '', test: DIALOGS },
  { id: 'R2B-02-hovercard-ignores-bus', file: `${R}/components/HoverCard.tsx`, find: 'const offMenu = onMenuOpen(null, close)', replace: 'const offMenu = () => {}', test: DIALOGS },
  { id: 'R2B-01-delete-no-window-escape', file: `${R}/components/DeleteWorktreeDialog.tsx`, find: '  useWindowEscape({ onEscape: onClose })\n', replace: '', test: DIALOGS },
  { id: 'R2B-01-meta-no-window-escape', file: `${R}/components/WorktreeMetaDialog.tsx`, find: '  useWindowEscape({ onEscape: close })\n', replace: '', test: DIALOGS },
  { id: 'R2B-01-picker-no-window-escape', file: `${R}/components/ParentPicker.tsx`, find: '  useWindowEscape({ onEscape: onClose })\n', replace: '', test: DIALOGS },
  { id: 'R2B-01-escape-leaks-to-terminal', file: `${R}/menu-bus.ts`, find: '      event.stopPropagation()\n      onEscapeRef.current()', replace: '      onEscapeRef.current()', test: DIALOGS },
  { id: 'R2B-07-escape-ignores-ime', file: `${R}/menu-bus.ts`, find: "if (event.key !== 'Escape' || event.isComposing) return", replace: "if (event.key !== 'Escape') return", test: DIALOGS },
  { id: 'R2B-01-blocked-no-focus', file: `${R}/components/DeleteWorktreeDialog.tsx`, find: "      case 'blocked':\n", replace: '', test: DIALOGS },
  { id: 'R2B-08-force-focuses-confirm', file: `${R}/components/DeleteWorktreeDialog.tsx`, find: "    switch (focusKind) {\n      case 'delete':", replace: "    switch (focusKind) {\n      case 'force':\n      case 'delete':", test: DIALOGS },
  { id: 'R2B-03-picker-no-scroll', file: `${R}/components/ParentPicker.tsx`, find: "    listRef.current?.querySelector('[aria-selected=\"true\"]')?.scrollIntoView({ block: 'nearest' })\n", replace: '', test: DIALOGS },
  { id: 'R2B-04-meta-no-catch', file: `${R}/components/WorktreeMetaDialog.tsx`, find: '    } catch (thrown) {\n      failure = thrown instanceof Error ? thrown.message : String(thrown)\n    } finally {', replace: '    } finally {', test: DIALOGS },
  { id: 'R2B-05-meta-closes-while-busy', file: `${R}/components/WorktreeMetaDialog.tsx`, find: '    if (!busy) onClose()', replace: '    onClose()', test: DIALOGS },
  { id: 'R2B-06-meta-compares-live-prop', file: `${R}/components/WorktreeMetaDialog.tsx`, find: 'if (comment.trim() !== initial.comment)', replace: "if (comment.trim() !== (worktree.comment ?? ''))", test: DIALOGS },
  { id: 'M7-dirty-boundary', file: `${R}/card-menu.ts`, find: 'if (input.dirtyCount > 0)', replace: 'if (input.dirtyCount > 1)', test: MENU },
  { id: 'M11-no-path-filter', file: `${R}/card-menu.ts`, find: "[input.nameOf(row), row.branch ?? '', row.path]", replace: "[input.nameOf(row), row.branch ?? '']", test: MENU },
  { id: 'M12-no-branch-filter', file: `${R}/card-menu.ts`, find: "[input.nameOf(row), row.branch ?? '', row.path]", replace: '[input.nameOf(row), row.path]', test: MENU },
]

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const rows = []
for (const mutation of MUTATIONS) {
  const file = path.join(app, mutation.file)
  const original = fs.readFileSync(file)
  const before = sha(file)
  const text = original.toString('utf8')
  const count = text.split(mutation.find).length - 1
  if (count !== 1) {
    rows.push({ id: mutation.id, error: `변이 자리가 정확히 1곳이 아니다(${count})`, killed: false, restored: true })
    continue
  }
  let run
  try {
    fs.writeFileSync(file, text.replace(mutation.find, mutation.replace))
    run = spawnSync('npx', ['vitest', 'run', mutation.test], { cwd: app, encoding: 'utf8', timeout: 120_000, env: process.env })
  } finally {
    fs.writeFileSync(file, original)
  }
  const restored = sha(file) === before
  const summary = (run.stdout ?? '').split('\n').find((line) => /^\s+Tests\s/.test(line))?.trim() ?? null
  const failedNames = (run.stdout ?? '').split('\n').filter((line) => /^\s+×/.test(line)).map((line) => line.trim().slice(0, 160))
  // 시험이 하나도 안 돌았으면(변이가 문법을 깨뜨림) 사망으로 세지 않는다 — 무효 변이(R048 의 R2B-03 1차가 그랬다).
  rows.push({ id: mutation.id, file: mutation.file, test: mutation.test, status: run.status, invalid: summary === null || /no tests/.test(summary), timedOut: run.error?.code === 'ETIMEDOUT', summary, failed: failedNames, killed: run.status !== 0 && failedNames.length > 0, restored })
  console.log(`[mut] ${mutation.id}: ${run.status !== 0 && failedNames.length > 0 ? '사망' : '생존'} — ${summary} · 원복 ${restored}`)
}
const ok = rows.every((row) => row.killed && row.restored)
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ total: rows.length, killed: rows.filter((row) => row.killed).length, allRestored: rows.every((row) => row.restored), rows }, null, 2) + '\n')
console.log(`[mut] 사망 ${rows.filter((row) => row.killed).length}/${rows.length} · 원복 전부 ${rows.every((row) => row.restored)}`)
process.exit(ok ? 0 : 1)
