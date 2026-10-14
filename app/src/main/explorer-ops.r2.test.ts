// LIFE-592 수정 r2 — 리뷰 r2 지적의 main 쪽 회귀 시험(R2-A·B·C·D·E·G). 휴지통은 가짜(시험 폴더로 옮김 — 사용자 ~/.Trash 무접촉).
//   R2-A 건너뛴 가져오기 항목은 그 이름에 다른 작성자의 파일이 생겨도 결과·표지에 들지 않는다(실제로 만든 것만 — 만든 순간의 정체)
//   R2-B `..archive` 처럼 두 점으로 시작하는 정상 폴더 밑의 실제 `.git` 위치도 보호
//   R2-C 도장에 mode — 복제 폴더 하위·복제 파일의 chmod 뒤 실행 취소 = `modified`
//   R2-D 다시 실행은 원래 대상 이름에만, 원본이 원래 조작 뒤 바뀌었으면 거절
//   R2-E 가져오기 다시 실행 근거는 main 이 붙잡는다 — 드롭 표지 수명(2 분)이 지나도 재생, 새 드롭 표지는 그대로 짧게, 놓으면(release) 재생 불가
//   R2-G 읽을 수 없는 하위 폴더 — 도장을 못 만들어도 결과(만든 항목·부분 실패)를 잃지 않고, 그 항목의 실행 취소는 안전 쪽(거절)
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DropStore, runExplorerOp, SnapshotStore, type OpDeps } from './explorer-ops.js'
import type { ExplorerOpResult } from '../shared/explorer-ops.js'
import { inverseOf, type HistoryStep } from '../renderer/src/explorer-history.js'

let base = ''
let root = ''
let src = ''
let trashDir = ''
let now = 0
let deps: OpDeps
const locked: string[] = []

const op = (input: Record<string, unknown>): Promise<ExplorerOpResult> => runExplorerOp(deps, { root, ...input })
const at = (rel: string): string => path.join(root, rel)
const code = (result: ExplorerOpResult): string => (result.ok ? 'ok' : result.code)
/** 역조작(휴지통)과 그 다시 실행(재생) — 실제 `inverseOf` 가 만든 것. */
const undoOf = (result: ExplorerOpResult): Extract<HistoryStep, { op: 'trash' | 'batch' }> => {
  const step = inverseOf(result)
  if (step === null || (step.op !== 'trash' && step.op !== 'batch')) throw new Error(`역조작 없음 ${JSON.stringify(result)}`)
  return step
}
const replayInput = (step: Extract<HistoryStep, { op: 'trash' | 'batch' }>): Record<string, unknown> => {
  if (step.replay === undefined) throw new Error('재생 없음')
  return { ...step.replay }
}
const trashInput = (step: Extract<HistoryStep, { op: 'trash' | 'batch' }>): Record<string, unknown> => {
  if (step.op !== 'trash') throw new Error('묶음')
  return { op: 'trash', rel: step.rel, expect: step.expect, snapshot: false }
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l592-r2-')))
  root = path.join(base, 'wt')
  src = path.join(base, 'drop-src')
  trashDir = path.join(base, 'trash')
})

beforeEach(() => {
  for (const dir of [root, src, trashDir]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(at('folder'))
  fs.writeFileSync(at('folder/child.txt'), 'original')
  fs.writeFileSync(at('original.txt'), 'original bytes')
  fs.mkdirSync(src, { recursive: true })
  fs.mkdirSync(trashDir, { recursive: true })
  now = 0
  let n = 0
  deps = {
    roots: () => [root],
    trashItem: async (abs) => {
      n += 1
      fs.renameSync(abs, path.join(trashDir, `${n}-${path.basename(abs)}`))
    },
    snapshots: new SnapshotStore(),
    drops: new DropStore(120_000, () => now),
  }
})

afterEach(() => {
  for (const dir of locked.splice(0)) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755)
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('R2-A 건너뛴 가져오기 항목은 결과·실행 취소 대상이 아니다', () => {
  it('링크를 건너뛰는 사이 같은 이름에 다른 작성자가 파일을 만들어도 rels·marks 에 안 들고, 역조작이 없다(리뷰어 R16 partial-skip)', async () => {
    fs.writeFileSync(path.join(src, 'target'), 'outside-source')
    fs.symlinkSync('target', path.join(src, 'skip.txt'))
    const realLstat = fsp.lstat
    let n = 0
    fsp.lstat = async function (...args: Parameters<typeof fsp.lstat>) {
      if (args[0] === path.join(src, 'skip.txt') && ++n === 2) await fsp.writeFile(at('skip.txt'), 'user-created concurrently', { flag: 'wx' })
      return realLstat(...args)
    } as typeof fsp.lstat
    let result: ExplorerOpResult
    try {
      result = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'skip.txt')]) })
    } finally {
      fsp.lstat = realLstat
    }
    expect(result.ok).toBe(true)
    if (!result.ok || result.op !== 'import') return
    expect(result.skipped.map((row) => row.name)).toEqual(['skip.txt'])
    expect(result.rels).toEqual([])
    expect(result.marks).toEqual([])
    expect(inverseOf(result)).toBeNull()
    expect(fs.readFileSync(at('skip.txt'), 'utf8')).toBe('user-created concurrently')
  })
})

describe('R2-B .. 으로 시작하는 정상 폴더 밑의 .git', () => {
  it('..archive/nested/.git 을 가리키는 내부 링크로 만들기 → protected, 메타데이터 무변경', async () => {
    fs.mkdirSync(at('..archive/nested/.git'), { recursive: true })
    fs.symlinkSync('..archive/nested/.git', at('meta2'))
    expect(code(await op({ op: 'create', dir: 'meta2', name: 'l592-in', kind: 'file' }))).toBe('protected')
    expect(code(await op({ op: 'create', dir: '..archive/nested/.git', name: 'l592-in', kind: 'file' }))).toBe('protected')
    expect(fs.readdirSync(at('..archive/nested/.git'))).toEqual([])
    // 대조 — .git 이 아닌 곳은 된다.
    expect(code(await op({ op: 'create', dir: '..archive/nested', name: 'l592-ok', kind: 'file' }))).toBe('ok')
  })
})

describe('R2-C 도장에 mode', () => {
  it('복제 폴더 하위 파일 chmod → 실행 취소 modified, 폴더 그대로', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'folder' })
    // chmod 는 mtime 을 바꾸지 않는다(ctime 만) — 크기·mtime 이 같은 채 mode 만 바뀐다.
    const child = at('folder copy/child.txt')
    const before = fs.statSync(child)
    fs.chmodSync(child, 0o751)
    expect(fs.statSync(child).mtimeMs).toBe(before.mtimeMs)
    expect(code(await op(trashInput(undoOf(dupe))))).toBe('modified')
    expect(fs.existsSync(at('folder copy'))).toBe(true)
  })
  it('복제 파일 chmod → 실행 취소 modified', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'original.txt' })
    fs.chmodSync(at('original copy.txt'), 0o755)
    expect(code(await op(trashInput(undoOf(dupe))))).toBe('modified')
  })
})

describe('R2-D 다시 실행 = 원래 대상 이름·원래 원본', () => {
  it('복제 → 실행 취소 → 원본 수정 → 다시 실행 = 거절, 사본 안 생김', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'original.txt' })
    const undo = undoOf(dupe)
    expect(code(await op(trashInput(undo)))).toBe('ok')
    fs.writeFileSync(at('original.txt'), 'new bytes after undo')
    expect(code(await op(replayInput(undo)))).toBe('modified')
    expect(fs.existsSync(at('original copy.txt'))).toBe(false)
  })
  it('복제 → 실행 취소 → 원래 사본 자리에 다른 파일 → 다시 실행 = exists, copy 2 안 생김', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'original.txt' })
    const undo = undoOf(dupe)
    await op(trashInput(undo))
    fs.writeFileSync(at('original copy.txt'), 'occupied')
    expect(code(await op(replayInput(undo)))).toBe('exists')
    expect(fs.readFileSync(at('original copy.txt'), 'utf8')).toBe('occupied')
    expect(fs.existsSync(at('original copy 2.txt'))).toBe(false)
  })
  it('대조 — 아무것도 안 바뀌었으면 같은 이름으로 다시 만든다', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'folder' })
    const undo = undoOf(dupe)
    await op(trashInput(undo))
    expect(code(await op(replayInput(undo)))).toBe('ok')
    expect(fs.readFileSync(at('folder copy/child.txt'), 'utf8')).toBe('original')
  })
  it('가져오기 → 실행 취소 → 원본 수정 → 다시 실행 = 거절, 안 생김', async () => {
    fs.writeFileSync(path.join(src, 'drop.txt'), 'drop original')
    const imported = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'drop.txt')]) })
    const undo = undoOf(imported)
    await op(trashInput(undo))
    fs.writeFileSync(path.join(src, 'drop.txt'), 'drop changed')
    expect(code(await op(replayInput(undo)))).toBe('modified')
    expect(fs.existsSync(at('drop.txt'))).toBe(false)
  })
  it('가져오기 → 실행 취소 → 원래 자리 참 → 다시 실행 = exists, 새 이름 안 생김', async () => {
    fs.writeFileSync(path.join(src, 'drop.txt'), 'drop original')
    const imported = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'drop.txt')]) })
    const undo = undoOf(imported)
    await op(trashInput(undo))
    fs.writeFileSync(at('drop.txt'), 'occupied')
    expect(code(await op(replayInput(undo)))).toBe('exists')
    expect(fs.readdirSync(root).filter((name) => name.startsWith('drop')).sort()).toEqual(['drop.txt'])
  })
})

describe('R2-E 가져오기 재생 근거 = main 이 붙잡음', () => {
  it('드롭 표지 수명(2 분)이 지나도 다시 실행 — 새 드롭 표지는 그대로 만료', async () => {
    fs.writeFileSync(path.join(src, 'drop.txt'), 'drop original')
    const imported = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'drop.txt')]) })
    const undo = undoOf(imported)
    await op(trashInput(undo))
    const stale = deps.drops.register([path.join(src, 'drop.txt')])
    now = 120_001
    expect(code(await op(replayInput(undo)))).toBe('ok')
    expect(fs.readFileSync(at('drop.txt'), 'utf8')).toBe('drop original')
    expect(code(await op({ op: 'import', dir: 'folder', token: stale }))).toBe('bad_token')
  })
  it('놓은(release) 재생 근거로는 다시 실행할 수 없다 · 위조 id 거절', async () => {
    fs.writeFileSync(path.join(src, 'drop.txt'), 'drop original')
    const imported = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'drop.txt')]) })
    const undo = undoOf(imported)
    await op(trashInput(undo))
    const replay = replayInput(undo)
    expect(code(await runExplorerOp(deps, { op: 'release', ids: [replay.replay] }))).toBe('ok')
    expect(code(await op(replay))).toBe('bad_token')
    expect(code(await op({ op: 'import', dir: '', replay: 'forged-id' }))).toBe('bad_token')
  })
})

describe('R2-G 도장을 못 만들어도 결과를 잃지 않는다', () => {
  it('가져오기 — 정상 파일 + 읽을 수 없는 폴더: 둘 다 rels·marks 에, 잠긴 쪽 실행 취소는 거절(리뷰어 R21)', async () => {
    fs.writeFileSync(path.join(src, 'good'), 'good')
    fs.mkdirSync(path.join(src, 'locked'))
    fs.writeFileSync(path.join(src, 'locked/child'), 'unreadable child')
    fs.chmodSync(path.join(src, 'locked'), 0)
    locked.push(path.join(src, 'locked'), at('locked'))
    const result = await op({ op: 'import', dir: '', token: deps.drops.register([path.join(src, 'good'), path.join(src, 'locked')]) })
    expect(result.ok).toBe(true)
    if (!result.ok || result.op !== 'import') return
    expect(result.rels).toEqual(['good', 'locked'])
    expect(result.marks).toHaveLength(2)
    expect(result.partial).toContain('locked')
    expect(code(await op({ op: 'trash', rel: 'locked', expect: result.marks[1], snapshot: false }))).toBe('modified')
    expect(code(await op({ op: 'trash', rel: 'good', expect: result.marks[0], snapshot: false }))).toBe('ok')
  })
  it('복제 — 하위에 읽을 수 없는 폴더: 결과(만든 사본·실패)를 잃지 않고 실행 취소는 거절', async () => {
    fs.mkdirSync(at('folder/locked'))
    fs.chmodSync(at('folder/locked'), 0)
    locked.push(at('folder/locked'), at('folder copy/locked'))
    const result = await op({ op: 'duplicate', rel: 'folder' })
    expect(result.ok).toBe(true)
    if (!result.ok || result.op !== 'duplicate') return
    expect(result.rel).toBe('folder copy')
    expect(result.failed.length).toBeGreaterThan(0)
    expect(code(await op(trashInput(undoOf(result))))).toBe('modified')
    expect(fs.existsSync(at('folder copy'))).toBe(true)
  })
})
