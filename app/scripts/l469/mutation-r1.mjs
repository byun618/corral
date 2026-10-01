// LIFE-469 수정 라운드 1~4 + 게이트 ① 사용자 수정 1 — 시험의 음성 대조. 고친 줄을 하나씩 옛 동작으로 되돌려(변이) 시험이 **실패하는지** 본다.
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
    // 수정 1 에서 `keys.includes(key)` 가 `indexOf` 로 바뀌었다 — 같은 옛 동작(행이 사라져도 계속 끈다)으로 되돌린다.
    from: `      if (from < 0) {`,
    to: `      if (from < 0 && measured.keys.length === 0) {`,
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
  // 수정 라운드 4 — 제거 응답 세대를 잠금이 풀린 뒤 다시 읽은 목록으로 관측하던 라운드 3 동작.
  {
    id: 'R4-01',
    file: path.join(app, 'src/main/registry-generation.ts'),
    from: 'registryGeneration: input.generation.observe(rootsAfter)',
    to: 'registryGeneration: input.generation.observe(input.registry.list())',
  },
  { id: 'R1-05', file: src('hooks/useSidebarReorder.ts'), from: 'headTop: headBox.top,', to: 'headTop: box.top,' },
  // 게이트 ① 사용자 수정 1 — 주 체크아웃 고정으로 되돌리기: 표시 순서에서 주 체크아웃을 늘 맨 위로(옛 `orderWorktrees`).
  {
    id: 'F1-01-main-pin-order',
    file: src('manual-order.ts'),
    from: 'return [...base.filter((worktree) => !storedSet.has(worktree.path)), ...known]',
    to: 'return [...known.filter((worktree) => !worktree.isLinked), ...base.filter((worktree) => !storedSet.has(worktree.path)), ...known.filter((worktree) => worktree.isLinked)]',
  },
  // 같음 — 저장 목록에 연결 워크트리만 적던 옛 정규화(주 체크아웃 키 없음).
  {
    id: 'F1-02-linked-only-store',
    file: src('manual-order.ts'),
    from: 'const paths = base.map((worktree) => worktree.path)',
    to: 'const paths = base.filter((worktree) => worktree.isLinked).map((worktree) => worktree.path)',
  },
  // 같음 — 카드 경계 판정이 주 체크아웃 위(경계 0)를 허용하지 않던 옛 동작: 맨 앞 경계를 1 로 올린다.
  {
    id: 'F1-03-not-above-main',
    file: src('sidebar-reorder.ts'),
    from: `    return y < (rect.top + rect.bottom) / 2 ? index : index + 1
  }
  return rects.length
}`,
    to: `    return Math.max(1, y < (rect.top + rect.bottom) / 2 ? index : index + 1)
  }
  return rects.length
}`,
  },
  // K3ⓗⓒ — 밀리기 전 기하를 쓰지 않는다(실측에서 transform 을 빼지 않음 → 밀린 좌표로 판정).
  { id: 'F1-04-shifted-geometry', file: src('hooks/useSidebarReorder.ts'), from: 'shift += translateYOf(node)', to: 'shift += 0' },
  // K3ⓗⓓ — 끝낼 때 사본을 떼지 않는다.
  { id: 'F1-05-preview-left', file: src('hooks/useSidebarReorder.ts'), from: '      preview?.element.remove()\n', to: '' },
  // K3ⓗⓓ — 끝낼 때 밀림을 거두지 않는다.
  {
    id: 'F1-06-shift-left',
    file: src('hooks/useSidebarReorder.ts'),
    from: `      preview = null
      applyShifts({ elements: [], offsets: [] })`,
    to: `      preview = null`,
  },
  // K3ⓗⓑ — 실측 소수 오차마다 밀림을 다시 써서 전환이 재시작되던 run18 동작.
  {
    id: 'F1-07-shift-rewrite',
    file: src('hooks/useSidebarReorder.ts'),
    from: 'next.set(element, current !== undefined && Math.abs(current - offset) < 0.5 ? current : offset)',
    to: 'next.set(element, offset)',
  },
  // 게이트 ① 수정 1 2차 R6-01 — 사본에서 열린 ⋯ 메뉴 등 일시 UI 를 떼지 않던 fcd40544 동작.
  { id: 'R6-01-transient-ui', file: src('hooks/useSidebarReorder.ts'), from: '    for (const node of clone.querySelectorAll(TRANSIENT_UI_SELECTOR)) node.remove()\n', to: '' },
]
const TESTS = [
  'src/renderer/src/hooks/useSidebarReorder.test.mjs',
  'src/renderer/src/hooks/useManualOrder.test.mjs',
  'src/renderer/src/hooks/useManualOrder.cli.test.mjs',
  'src/renderer/src/manual-order.test.ts',
  'src/renderer/src/sidebar-reorder.test.ts',
]
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
