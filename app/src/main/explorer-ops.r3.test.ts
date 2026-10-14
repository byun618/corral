// LIFE-592 수정 r3 — 리뷰 r3 지적의 main 쪽 회귀 시험(R3-A·B·C). 휴지통은 가짜(시험 폴더로 옮김 — 사용자 ~/.Trash 무접촉).
//   R3-A 폴더 복제·가져오기 도중 남이 대상 폴더 안에 만든 하위(같은 이름 먼저 생성 = EEXIST · 다른 이름 추가)는 이번 조작의 것이 아니다 — 폴더 실행 취소는 거절, 남의 파일 그대로(리뷰어 child-collision·ownership duplicate-dir/import-dir)
//   R3-B 새 파일·중간 폴더·되살리기 직후 그 자리가 다른 파일로 바뀌면(외부 원자 저장) 성공·표지로 기록하지 않는다 — `changed`(done), 남의 파일 그대로(리뷰어 ownership create/nested-create/restore)
//   R3-C 중간 폴더 만들기의 다시 실행(`again`)은 원래 만든 맨 위 폴더 자리가 비어 있을 때만 — 남의 폴더가 있으면 `exists`, 그 안에 쓰지 않는다(리뷰어 matrix-hook nested-occupied-redo)
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DropStore, runExplorerOp, SnapshotStore, type OpDeps } from './explorer-ops.js'
import type { ExplorerOpResult } from '../shared/explorer-ops.js'

let base = ''
let root = ''
let src = ''
let trashDir = ''
let deps: OpDeps

const op = (input: Record<string, unknown>): Promise<ExplorerOpResult> => runExplorerOp(deps, { root, ...input })
const at = (rel: string): string => path.join(root, rel)
const code = (result: ExplorerOpResult): string => (result.ok ? 'ok' : result.code)
/** 결과의 실행 취소(휴지통) 요청 — 렌더러 `inverseOf` 와 같은 모양(가져오기는 첫 항목). 결과가 성공이 아니면 null. */
const undoOf = (result: ExplorerOpResult): Record<string, unknown> | null => {
  if (!result.ok) return null
  switch (result.op) {
    case 'create':
      return { op: 'trash', rel: result.created, expect: result.marks, snapshot: false }
    case 'restore':
    case 'duplicate':
      return { op: 'trash', rel: result.rel, expect: result.marks, snapshot: false }
    case 'import':
      return result.rels[0] === undefined ? null : { op: 'trash', rel: result.rels[0], expect: result.marks[0], snapshot: false }
    default:
      return null
  }
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l592-r3-')))
  root = path.join(base, 'wt')
  src = path.join(base, 'drop-src')
  trashDir = path.join(base, 'trash')
})

beforeEach(() => {
  for (const dir of [root, src, trashDir]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(at('pack'))
  fs.mkdirSync(at('in'))
  fs.writeFileSync(at('pack/child.txt'), 'original source')
  fs.mkdirSync(path.join(src, 'pack'), { recursive: true })
  fs.writeFileSync(path.join(src, 'pack/child.txt'), 'original source')
  fs.mkdirSync(trashDir, { recursive: true })
  let n = 0
  deps = {
    roots: () => [root],
    trashItem: async (abs) => {
      n += 1
      fs.renameSync(abs, path.join(trashDir, `${n}-${path.basename(abs)}`))
    },
    snapshots: new SnapshotStore(),
    drops: new DropStore(),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('R3-A 폴더 복사 도중 남이 대상 안에 만든 하위', () => {
  const cases = [
    { kind: 'duplicate', target: 'pack copy', request: (): Record<string, unknown> => ({ op: 'duplicate', rel: 'pack' }) },
    { kind: 'import', target: 'in/pack', request: (): Record<string, unknown> => ({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'pack')]) }) },
  ]
  for (const item of cases) {
    it(`${item.kind} — 같은 이름 먼저 생성(EEXIST): 결과에 실패로 알리고, 폴더 실행 취소는 거절, 남의 파일 그대로(child-collision)`, async () => {
      deps.hooks = {
        afterCheck: async (phase) => {
          if (phase === 'create-file' && !fs.existsSync(at(`${item.target}/child.txt`))) fs.writeFileSync(at(`${item.target}/child.txt`), 'other writer created this', { flag: 'wx' })
        },
      }
      const result = await op(item.request())
      deps.hooks = undefined
      expect(result.ok).toBe(true)
      const undo = undoOf(result)
      if (undo !== null) expect(code(await op(undo))).toBe('modified')
      expect(fs.readFileSync(at(`${item.target}/child.txt`), 'utf8')).toBe('other writer created this')
    })
    it(`${item.kind} — 다른 이름 외부 추가: 폴더 실행 취소는 거절, 남의 파일 그대로(ownership ${item.kind}-dir)`, async () => {
      deps.hooks = {
        afterCheck: async (phase) => {
          if (phase === 'create-file' && !fs.existsSync(at(`${item.target}/external-notes.txt`))) fs.writeFileSync(at(`${item.target}/external-notes.txt`), 'external work during copy', { flag: 'wx' })
        },
      }
      const result = await op(item.request())
      deps.hooks = undefined
      expect(result.ok).toBe(true)
      const undo = undoOf(result)
      if (undo !== null) expect(code(await op(undo))).toBe('modified')
      expect(fs.readFileSync(at(`${item.target}/external-notes.txt`), 'utf8')).toBe('external work during copy')
    })
  }
  it('대조 — 아무도 끼어들지 않으면 폴더 실행 취소가 된다(복제·가져오기)', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'pack' })
    const imported = await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'pack')]) })
    for (const result of [dupe, imported]) {
      const undo = undoOf(result)
      expect(undo).not.toBeNull()
      if (undo !== null) expect(code(await op(undo))).toBe('ok')
    }
  })
})

/** 만든 파일을 닫은 직후 그 경로를 다른 파일로 원자 교체(외부 편집기 저장) — 리뷰어 ownership-probe 와 같은 시점. */
const swapAfterClose = (target: string): void => {
  const realOpen = fsp.open
  let done = false
  vi.spyOn(fsp, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await realOpen(file, flags, mode)
    if (file === target && typeof flags === 'number' && (flags & fs.constants.O_CREAT) !== 0 && !done) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        if (done) return
        done = true
        fs.renameSync(target, path.join(base, `made-${path.basename(target)}`))
        fs.writeFileSync(target, 'external atomic save', { flag: 'wx' })
      }
    }
    return handle
  })
}

describe('R3-B 만든 직후 그 자리가 남의 파일로 바뀜', () => {
  afterEach(() => {
    for (const name of fs.readdirSync(base)) if (name.startsWith('made-')) fs.rmSync(path.join(base, name), { force: true })
  })
  it('새 파일 — changed(done), 실행 취소 기록 없음, 남의 파일 그대로', async () => {
    swapAfterClose(at('leaf.txt'))
    const result = await op({ op: 'create', dir: '', name: 'leaf.txt', kind: 'file' })
    expect(code(result)).toBe('changed')
    expect(result.ok ? null : result.done).toBe(true)
    expect(undoOf(result)).toBeNull()
    expect(fs.readFileSync(at('leaf.txt'), 'utf8')).toBe('external atomic save')
  })
  it('중간 폴더 + 파일 — changed(done)', async () => {
    swapAfterClose(at('nested/leaf.txt'))
    const result = await op({ op: 'create', dir: '', name: 'nested/leaf.txt', kind: 'file' })
    expect(code(result)).toBe('changed')
    expect(undoOf(result)).toBeNull()
    expect(fs.readFileSync(at('nested/leaf.txt'), 'utf8')).toBe('external atomic save')
  })
  it('되살리기 — changed(done), 남의 파일에 표지를 붙이지 않는다', async () => {
    fs.writeFileSync(at('leaf.txt'), 'original')
    const gone = await op({ op: 'trash', rel: 'leaf.txt', snapshot: true })
    const snapshotId = gone.ok && gone.op === 'trash' ? gone.snapshotId : null
    swapAfterClose(at('leaf.txt'))
    const result = await op({ op: 'restore', rel: 'leaf.txt', snapshotId })
    expect(code(result)).toBe('changed')
    expect(undoOf(result)).toBeNull()
    expect(fs.readFileSync(at('leaf.txt'), 'utf8')).toBe('external atomic save')
  })
  it('대조 — 끼어들지 않으면 새 파일·되살리기 표지로 실행 취소된다', async () => {
    const made = await op({ op: 'create', dir: '', name: 'nested/leaf.txt', kind: 'file' })
    const undo = undoOf(made)
    expect(undo).not.toBeNull()
    if (undo !== null) expect(code(await op(undo))).toBe('ok')
  })
})

describe('R3-C 중간 폴더 만들기 다시 실행 — 원래 맨 위 자리가 차 있으면 거절', () => {
  it('again: 남이 같은 이름 폴더를 만들었으면 exists, 그 안에 쓰지 않는다', async () => {
    fs.mkdirSync(at('nested'))
    fs.writeFileSync(at('nested/external.txt'), 'other project work')
    expect(code(await op({ op: 'create', dir: '', name: 'nested/sub/file.txt', kind: 'file', again: true }))).toBe('exists')
    expect(fs.readdirSync(at('nested'))).toEqual(['external.txt'])
  })
  it('대조 — 새 만들기(again 없음)는 이미 있는 중간 폴더를 쓴다(E1ⓓ)', async () => {
    fs.mkdirSync(at('nested'))
    expect(code(await op({ op: 'create', dir: '', name: 'nested/sub/file.txt', kind: 'file' }))).toBe('ok')
    expect(fs.existsSync(at('nested/sub/file.txt'))).toBe(true)
  })
})
