// LIFE-469 수정 라운드 1·2·3 — hook 시험의 음성 대조. 고친 줄을 하나씩 옛 동작으로 되돌려(변이) 시험이 **실패하는지** 본다.
// 변이마다 원본 바이트로 되돌리고, 끝에 원본 해시를 대조한다. 사용: node mutation-r1.mjs <out 폴더>
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const out = process.argv[2]
const app = path.resolve(import.meta.dirname, '../..')
const src = (file) => path.join(app, 'src/renderer/src', file)
const MUTANTS = [
  {
    id: 'R1-01',
    file: src('hooks/useSidebarReorder.ts'),
    from: ' || point.y < listRect.top || point.y > listRect.bottom',
    to: '',
  },
  { id: 'R1-02', file: src('hooks/useSidebarReorder.ts'), from: 'else swallowClickOfPendingRelease()', to: 'else swallowNextClick()' },
  {
    id: 'R1-03-up',
    file: src('hooks/useSidebarReorder.ts'),
    from: `        point = { x: upEvent.clientX, y: upEvent.clientY }
        update()`,
    to: `        point = { x: upEvent.clientX, y: upEvent.clientY }`,
  },
  {
    id: 'R1-03-frame',
    file: src('hooks/useSidebarReorder.ts'),
    from: `      if (next !== null) list.scrollTop = next
      // 스크롤이 없어도`,
    to: `      if (next === null) {
        frame = requestAnimationFrame(tick)
        return
      }
      list.scrollTop = next
      // 스크롤이 없어도`,
  },
  {
    id: 'R1-03-vanish',
    file: src('hooks/useSidebarReorder.ts'),
    from: `      if (!measured.keys.includes(key)) {`,
    to: `      if (measured.keys.length === 0 && !measured.keys.includes(key)) {`,
  },
  { id: 'R1-04', file: src('hooks/useManualOrder.ts'), from: '    removingRef.current.set(root, removed.registryGeneration)\n', to: '' },
  // 수정 라운드 2 — 대기 키를 「root 없음 관측」으로만 내리던 옛 동작.
  { id: 'R2-01', file: src('hooks/useManualOrder.ts'), from: 'if (gone || reRegistered) removing.delete(root)', to: 'if (gone) removing.delete(root)' },
  // 수정 라운드 3 — 세대를 제거(목록 줄어듦)에서만 올리던 것과 같은 동작: CLI·GUI 추가가 세대를 올리지 않는다.
  {
    id: 'R3-01',
    file: path.join(app, 'src/main/registry-generation.ts'),
    from: 'if (this.seen !== null && key !== this.seen) this.generation++',
    to: 'if (this.seen !== null && key !== this.seen && key.length < this.seen.length) this.generation++',
  },
  { id: 'R1-05', file: src('hooks/useSidebarReorder.ts'), from: 'headTop: headBox.top,', to: 'headTop: box.top,' },
]
const TESTS = ['src/renderer/src/hooks/useSidebarReorder.test.mjs', 'src/renderer/src/hooks/useManualOrder.test.mjs', 'src/renderer/src/hooks/useManualOrder.cli.test.mjs']
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

fs.mkdirSync(out, { recursive: true })
const files = [...new Set(MUTANTS.map((mutant) => mutant.file))]
const before = Object.fromEntries(files.map((file) => [file, sha(file)]))
const results = []
for (const mutant of MUTANTS) {
  const original = fs.readFileSync(mutant.file, 'utf8')
  if (!original.includes(mutant.from)) {
    results.push({ id: mutant.id, applied: false })
    continue
  }
  fs.writeFileSync(mutant.file, original.replace(mutant.from, mutant.to))
  let exit = 0
  let log = ''
  try {
    log = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...TESTS], { cwd: app, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    exit = error.status ?? -1
    log = `${error.stdout ?? ''}${error.stderr ?? ''}`
  } finally {
    fs.writeFileSync(mutant.file, original)
  }
  fs.writeFileSync(path.join(out, `${mutant.id}.log`), log)
  const failed = [...log.matchAll(/✕|×|FAIL\s.*>\s(.*)/g)].length
  results.push({ id: mutant.id, applied: true, exit, failedMarks: failed, killed: exit !== 0 })
}
const after = Object.fromEntries(files.map((file) => [file, sha(file)]))
const restored = files.every((file) => before[file] === after[file])
const summary = { results, restored, allKilled: results.every((result) => result.applied && result.killed) }
fs.writeFileSync(path.join(out, 'mutation.json'), `${JSON.stringify(summary, null, 1)}\n`)
console.log(JSON.stringify(summary, null, 1))
process.exit(summary.allKilled && restored ? 0 : 1)
