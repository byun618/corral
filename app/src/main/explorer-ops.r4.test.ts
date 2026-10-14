// LIFE-592 수정 r4 — 리뷰 r4 지적의 main 쪽 회귀 시험(R4-A·R4-B). 휴지통은 가짜(시험 폴더로 옮김 — 사용자 ~/.Trash 무접촉).
//   R4-A 앱 자신의 실행 취소·다시 실행이 항목을 새 정체로 다시 만든 경우(삭제 되살림·만들기/복제/가져오기 재생), 그 앞·뒤 기록이 기대하던 옛 정체로 잇는다 —
//        정상 연쇄(외부 변경 없음)는 원래 상태로 돌아가고, 다시 만든 뒤 남이 그 항목을 바꾸면 이어진 기록도 여전히 거절(리뷰어 history-chain).
//        요청 모양은 렌더러 `explorer-history.ts` 와 같다(사용자 삭제 = snapshot · 만들기 되돌리기 = expect · 재생 = again + was).
//   R4-B 진행 중 가져오기가 끝나기 전에 수명이 끝나면(그 hook 의 owner 닫힘·전체 해제) 끝난 뒤 재생 근거를 붙잡지 않는다(리뷰어 lifetime-inflight·lifetime-navigation).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DropStore, runExplorerOp, SnapshotStore, type OpDeps } from './explorer-ops.js'
import type { EntryMark, ExplorerOpResult } from '../shared/explorer-ops.js'

let base = ''
let root = ''
let src = ''
let trashDir = ''
let deps: OpDeps

const op = (input: Record<string, unknown>): Promise<ExplorerOpResult> => runExplorerOp(deps, { root, ...input })
const at = (rel: string): string => path.join(root, rel)
const exists = (rel: string): boolean => fs.existsSync(at(rel))
const code = (result: ExplorerOpResult): string => (result.ok ? 'ok' : result.code)

const created = (result: ExplorerOpResult): { rel: string; marks: EntryMark[] } => {
  if (!result.ok || result.op !== 'create') throw new Error(`create 실패: ${JSON.stringify(result)}`)
  return { rel: result.created, marks: result.marks }
}
const moved = (result: ExplorerOpResult): { from: string; to: string; id: string } => {
  if (!result.ok || result.op !== 'move') throw new Error(`move 실패: ${JSON.stringify(result)}`)
  return { from: result.from, to: result.to, id: result.id }
}
const trashed = (result: ExplorerOpResult): string => {
  if (!result.ok || result.op !== 'trash' || result.snapshotId === null) throw new Error(`trash(사본) 실패: ${JSON.stringify(result)}`)
  return result.snapshotId
}
const restored = (result: ExplorerOpResult): EntryMark[] => {
  if (!result.ok || result.op !== 'restore') throw new Error(`restore 실패: ${JSON.stringify(result)}`)
  return result.marks
}
const copied = (result: ExplorerOpResult): { rel: string; marks: EntryMark[]; from: string; source: string } => {
  if (!result.ok || result.op !== 'duplicate') throw new Error(`duplicate 실패: ${JSON.stringify(result)}`)
  return { rel: result.rel, marks: result.marks, from: result.from, source: result.source }
}
const imported = (result: ExplorerOpResult): { rels: string[]; marks: EntryMark[][]; replayId: string | null } => {
  if (!result.ok || result.op !== 'import') throw new Error(`import 실패: ${JSON.stringify(result)}`)
  return { rels: result.rels, marks: result.marks, replayId: result.replayId }
}

/** 사용자 삭제(Q1 사본) → 실행 취소(사본으로 다시 만들기). 다시 만든 항목은 새 inode 다. */
async function deleteAndRestore(rel: string): Promise<EntryMark[]> {
  const before = fs.lstatSync(at(rel)).ino
  const snapshotId = trashed(await op({ op: 'trash', rel, snapshot: true }))
  const marks = restored(await op({ op: 'restore', rel, snapshotId }))
  expect(fs.lstatSync(at(rel)).ino).not.toBe(before)
  return marks
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l592-r4-')))
  root = path.join(base, 'wt')
  src = path.join(base, 'drop-src')
  trashDir = path.join(base, 'trash')
})

beforeEach(() => {
  for (const dir of [root, src, trashDir]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(at('pack'))
  fs.mkdirSync(at('in'))
  fs.mkdirSync(at('dest'))
  fs.writeFileSync(at('pack/child.txt'), 'original source')
  fs.writeFileSync(at('plain.txt'), 'plain bytes')
  fs.mkdirSync(path.join(src, 'pack'), { recursive: true })
  fs.writeFileSync(path.join(src, 'pack/child.txt'), 'dropped child')
  fs.writeFileSync(path.join(src, 'one.txt'), 'dropped file')
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

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('R4-A 사용자 삭제 되살림 뒤 앞 기록(⌘Z 연쇄)', () => {
  it('만들기 → 삭제 → ⌘Z(되살림) → ⌘Z(만들기 되돌리기) = 원래 상태(리뷰어 history-chain ①)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'fresh.txt', kind: 'file' }))
    await deleteAndRestore('fresh.txt')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    expect(exists('fresh.txt')).toBe(false)
  })

  it('이름 변경 → 삭제 → ⌘Z → ⌘Z(이름 되돌리기) = 원래 이름(리뷰어 history-chain ②)', async () => {
    const renamed = moved(await op({ op: 'move', from: 'plain.txt', to: 'renamed.txt' }))
    await deleteAndRestore('renamed.txt')
    expect(code(await op({ op: 'move', from: 'renamed.txt', to: 'plain.txt', expect: renamed.id }))).toBe('ok')
    expect(fs.readFileSync(at('plain.txt'), 'utf8')).toBe('plain bytes')
    expect(exists('renamed.txt')).toBe(false)
  })

  it('이동(다른 폴더) → 삭제 → ⌘Z → ⌘Z(이동 되돌리기)', async () => {
    const went = moved(await op({ op: 'move', from: 'plain.txt', to: 'dest/plain.txt' }))
    await deleteAndRestore('dest/plain.txt')
    expect(code(await op({ op: 'move', from: 'dest/plain.txt', to: 'plain.txt', expect: went.id }))).toBe('ok')
  })

  it('빈 폴더 만들기 → 사본 있는 삭제 → 되살림 → 만들기 되돌리기(main 경로 — UI 의 폴더 삭제는 Q1 대로 칸을 만들지 않는다)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'empty-dir', kind: 'dir' }))
    await deleteAndRestore('empty-dir')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
  })

  it('중간 폴더 만들기(a/b/f.txt) → 안의 파일 삭제 → ⌘Z → ⌘Z(맨 위 폴더 되돌리기 — 폴더 표지 안의 하위)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'nest/deep/f.txt', kind: 'file' }))
    await deleteAndRestore('nest/deep/f.txt')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    expect(exists('nest')).toBe(false)
  })

  it('파일 복제 → 사본 삭제 → ⌘Z → ⌘Z(복제 되돌리기)', async () => {
    const dup = copied(await op({ op: 'duplicate', rel: 'plain.txt' }))
    await deleteAndRestore(dup.rel)
    expect(code(await op({ op: 'trash', rel: dup.rel, expect: dup.marks, snapshot: false }))).toBe('ok')
  })

  it('폴더 복제 → 사본 안 파일 삭제 → ⌘Z → ⌘Z(복제 되돌리기)', async () => {
    const dup = copied(await op({ op: 'duplicate', rel: 'pack' }))
    await deleteAndRestore(`${dup.rel}/child.txt`)
    expect(code(await op({ op: 'trash', rel: dup.rel, expect: dup.marks, snapshot: false }))).toBe('ok')
  })

  it('파일 가져오기 → 삭제 → ⌘Z → ⌘Z(가져오기 되돌리기)', async () => {
    const got = imported(await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'one.txt')]) }))
    await deleteAndRestore('in/one.txt')
    expect(code(await op({ op: 'trash', rel: got.rels[0], expect: got.marks[0], snapshot: false }))).toBe('ok')
  })

  it('폴더 가져오기 → 안의 파일 삭제 → ⌘Z → ⌘Z(가져오기 되돌리기)', async () => {
    const got = imported(await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'pack')]) }))
    await deleteAndRestore('in/pack/child.txt')
    expect(code(await op({ op: 'trash', rel: 'in/pack', expect: got.marks[0], snapshot: false }))).toBe('ok')
  })

  it('삭제 되살림을 두 번(⌘Z·⌘⇧Z·⌘Z) 거쳐도 앞 기록이 이어진다 — 만들기 → 삭제 → ⌘Z → ⌘⇧Z → ⌘Z → ⌘Z', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'twice.txt', kind: 'file' }))
    const marks = await deleteAndRestore('twice.txt')
    // ⌘⇧Z = 되살린 것을 다시 휴지통(되살림 표지로 — 사본을 다시 뜬다), ⌘Z = 다시 되살림.
    const again = trashed(await op({ op: 'trash', rel: 'twice.txt', expect: marks, snapshot: true }))
    restored(await op({ op: 'restore', rel: 'twice.txt', snapshotId: again }))
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
  })

  it('이름 변경 → 삭제 → ⌘Z → ⌘Z → ⌘⇧Z(이름 다시) → ⌘⇧Z(다시 삭제) — 뒤 기록도 이어진다', async () => {
    const renamed = moved(await op({ op: 'move', from: 'plain.txt', to: 'renamed.txt' }))
    const marks = await deleteAndRestore('renamed.txt')
    const back = moved(await op({ op: 'move', from: 'renamed.txt', to: 'plain.txt', expect: renamed.id }))
    const redo = moved(await op({ op: 'move', from: 'plain.txt', to: 'renamed.txt', expect: back.id }))
    expect(redo.to).toBe('renamed.txt')
    expect(code(await op({ op: 'trash', rel: 'renamed.txt', expect: marks, snapshot: true }))).toBe('ok')
  })
})

describe('R4-A 되살린 뒤 새 조작', () => {
  it('삭제 → ⌘Z(되살림) → 이름 변경(새 조작) → ⌘Z → ⌘⇧Z — 새 기록도 이어진 정체로 대조된다', async () => {
    await deleteAndRestore('plain.txt')
    const renamed = moved(await op({ op: 'move', from: 'plain.txt', to: 'after.txt' }))
    const back = moved(await op({ op: 'move', from: 'after.txt', to: 'plain.txt', expect: renamed.id }))
    expect(code(await op({ op: 'move', from: 'plain.txt', to: 'after.txt', expect: back.id }))).toBe('ok')
  })
})

describe('R4-A 재생(만들기·복제·가져오기 다시 실행) 뒤 뒤 기록(⌘⇧Z 연쇄)', () => {
  it('만들기 → 이름 변경 → ⌘Z ⌘Z → ⌘⇧Z(재생) → ⌘⇧Z(이름 변경 다시)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file' }))
    const renamed = moved(await op({ op: 'move', from: 'a.txt', to: 'b.txt' }))
    const back = moved(await op({ op: 'move', from: 'b.txt', to: 'a.txt', expect: renamed.id }))
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    const again = created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file', again: true, was: made.marks }))
    expect(code(await op({ op: 'move', from: 'a.txt', to: 'b.txt', expect: back.id }))).toBe('ok')
    // 그 뒤 ⌘Z ⌘Z 도 이어진다(재생 결과 표지로).
    const undoRename = moved(await op({ op: 'move', from: 'b.txt', to: 'a.txt', expect: renamed.id }))
    expect(undoRename.to).toBe('a.txt')
    expect(code(await op({ op: 'trash', rel: again.rel, expect: again.marks, snapshot: false }))).toBe('ok')
  })

  it('중간 폴더 만들기 → 안 파일 이름 변경 → ⌘Z ⌘Z → ⌘⇧Z(재생) → ⌘⇧Z(안 파일 이름 변경 다시)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'n/s/f.txt', kind: 'file' }))
    const renamed = moved(await op({ op: 'move', from: 'n/s/f.txt', to: 'n/s/g.txt' }))
    const back = moved(await op({ op: 'move', from: 'n/s/g.txt', to: 'n/s/f.txt', expect: renamed.id }))
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    created(await op({ op: 'create', dir: '', name: 'n/s/f.txt', kind: 'file', again: true, was: made.marks }))
    expect(code(await op({ op: 'move', from: 'n/s/f.txt', to: 'n/s/g.txt', expect: back.id }))).toBe('ok')
  })

  it('폴더 복제 → 사본 안 이름 변경 → ⌘Z ⌘Z → ⌘⇧Z(재생) → ⌘⇧Z(사본 안 이름 변경 다시)', async () => {
    const dup = copied(await op({ op: 'duplicate', rel: 'pack' }))
    const renamed = moved(await op({ op: 'move', from: `${dup.rel}/child.txt`, to: `${dup.rel}/kid.txt` }))
    const back = moved(await op({ op: 'move', from: `${dup.rel}/kid.txt`, to: `${dup.rel}/child.txt`, expect: renamed.id }))
    expect(code(await op({ op: 'trash', rel: dup.rel, expect: dup.marks, snapshot: false }))).toBe('ok')
    copied(await op({ op: 'duplicate', rel: dup.from, again: { name: 'pack copy', source: dup.source }, was: dup.marks }))
    expect(code(await op({ op: 'move', from: `${dup.rel}/child.txt`, to: `${dup.rel}/kid.txt`, expect: back.id }))).toBe('ok')
  })

  it('폴더 가져오기 → 안 이름 변경 → ⌘Z ⌘Z → ⌘⇧Z(재생) → ⌘⇧Z(안 이름 변경 다시)', async () => {
    const got = imported(await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'pack')]) }))
    const renamed = moved(await op({ op: 'move', from: 'in/pack/child.txt', to: 'in/pack/kid.txt' }))
    const back = moved(await op({ op: 'move', from: 'in/pack/kid.txt', to: 'in/pack/child.txt', expect: renamed.id }))
    expect(code(await op({ op: 'trash', rel: 'in/pack', expect: got.marks[0], snapshot: false }))).toBe('ok')
    imported(await op({ op: 'import', dir: 'in', replay: got.replayId, names: ['pack'], was: got.marks[0] }))
    expect(code(await op({ op: 'move', from: 'in/pack/child.txt', to: 'in/pack/kid.txt', expect: back.id }))).toBe('ok')
  })

  it('만들기 → 삭제 → ⌘Z ⌘Z → ⌘⇧Z(만들기 재생) → ⌘⇧Z(다시 삭제 — 되살림 표지로)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'c.txt', kind: 'file' }))
    const marks = await deleteAndRestore('c.txt')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    created(await op({ op: 'create', dir: '', name: 'c.txt', kind: 'file', again: true, was: made.marks }))
    expect(code(await op({ op: 'trash', rel: 'c.txt', expect: marks, snapshot: true }))).toBe('ok')
  })
})

describe('R4-A 거짓 통과 대조 — 다시 만든 뒤 남이 바꾸면 이어진 기록도 거절', () => {
  it('만들기 → 삭제 → ⌘Z → (남이 내용 씀) → ⌘Z = modified, 파일 그대로', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'fresh.txt', kind: 'file' }))
    await deleteAndRestore('fresh.txt')
    fs.writeFileSync(at('fresh.txt'), 'someone else')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('modified')
    expect(fs.readFileSync(at('fresh.txt'), 'utf8')).toBe('someone else')
  })

  it('이름 변경 → 삭제 → ⌘Z → (남이 그 자리를 다른 파일로 바꿈) → ⌘Z = modified', async () => {
    const renamed = moved(await op({ op: 'move', from: 'plain.txt', to: 'renamed.txt' }))
    await deleteAndRestore('renamed.txt')
    fs.renameSync(at('renamed.txt'), path.join(base, 'aside.txt'))
    fs.writeFileSync(at('renamed.txt'), 'other file')
    expect(code(await op({ op: 'move', from: 'renamed.txt', to: 'plain.txt', expect: renamed.id }))).toBe('modified')
    expect(fs.readFileSync(at('renamed.txt'), 'utf8')).toBe('other file')
    fs.rmSync(path.join(base, 'aside.txt'))
  })

  it('폴더 가져오기 → 안 파일 삭제 → ⌘Z → (남이 폴더 안에 파일 추가) → ⌘Z = modified', async () => {
    const got = imported(await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'pack')]) }))
    await deleteAndRestore('in/pack/child.txt')
    fs.writeFileSync(at('in/pack/foreign.txt'), 'foreign')
    expect(code(await op({ op: 'trash', rel: 'in/pack', expect: got.marks[0], snapshot: false }))).toBe('modified')
    expect(exists('in/pack/foreign.txt')).toBe(true)
  })

  it('만들기 → (남이 내용 씀) → 삭제 → ⌘Z → ⌘Z = modified(삭제 전에 이미 바뀐 것은 잇지 않는다)', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'edited.txt', kind: 'file' }))
    fs.writeFileSync(at('edited.txt'), 'edited before delete')
    await deleteAndRestore('edited.txt')
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('modified')
    expect(exists('edited.txt')).toBe(true)
  })

  it('재생 뒤 남이 그 자리를 바꾸면 뒤 기록(이름 변경 다시) = modified', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file' }))
    const renamed = moved(await op({ op: 'move', from: 'a.txt', to: 'b.txt' }))
    const back = moved(await op({ op: 'move', from: 'b.txt', to: 'a.txt', expect: renamed.id }))
    expect(code(await op({ op: 'trash', rel: made.rel, expect: made.marks, snapshot: false }))).toBe('ok')
    created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file', again: true, was: made.marks }))
    fs.renameSync(at('a.txt'), path.join(base, 'aside.txt'))
    fs.writeFileSync(at('a.txt'), 'other')
    expect(code(await op({ op: 'move', from: 'a.txt', to: 'b.txt', expect: back.id }))).toBe('modified')
    fs.rmSync(path.join(base, 'aside.txt'))
  })

  it('재생에 앱이 치우지 않은 표지(was)를 대도 잇지 않는다 — 경로만 같다고 잇지 않음', async () => {
    const made = created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file' }))
    const renamed = moved(await op({ op: 'move', from: 'a.txt', to: 'b.txt' }))
    const back = moved(await op({ op: 'move', from: 'b.txt', to: 'a.txt', expect: renamed.id }))
    // 앱이 아니라 남이 치웠다(실행 취소 휴지통 아님) — 재생이 대는 표지는 앱 기록에 없다.
    fs.renameSync(at('a.txt'), path.join(base, 'gone.txt'))
    created(await op({ op: 'create', dir: '', name: 'a.txt', kind: 'file', again: true, was: made.marks }))
    expect(code(await op({ op: 'move', from: 'a.txt', to: 'b.txt', expect: back.id }))).toBe('modified')
    fs.rmSync(path.join(base, 'gone.txt'))
  })
})

describe('R4-B 진행 중 가져오기와 재생 근거 수명', () => {
  /** 파일 만들기 직전에 멈추는 가져오기 — 수명 사건을 그 사이에 넣는다. */
  async function inflight(during: () => void, owner: string): Promise<ExplorerOpResult> {
    let entered: () => void = () => undefined
    let proceed: () => void = () => undefined
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const go = new Promise<void>((resolve) => (proceed = resolve))
    deps.hooks = {
      afterCheck: async (phase) => {
        if (phase !== 'create-file') return
        entered()
        await go
      },
    }
    const pending = op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'one.txt')]), owner })
    await reached
    during()
    proceed()
    const result = await pending
    deps.hooks = undefined
    return result
  }

  it('owner 가 닫힌 뒤(hook 언마운트) 끝난 가져오기는 재생 근거를 붙잡지 않는다(리뷰어 lifetime-inflight)', async () => {
    const result = imported(await inflight(() => void runExplorerOp(deps, { op: 'release', ids: [], owner: 'hook-1' }), 'hook-1'))
    expect(result.rels).toEqual(['in/one.txt'])
    expect(result.replayId).toBeNull()
    expect(deps.drops.heldSize).toBe(0)
  })

  it('전체 해제(렌더러 재생성) 뒤 끝난 가져오기는 붙잡지 않는다(리뷰어 lifetime-navigation)', async () => {
    const result = imported(await inflight(() => deps.drops.releaseAll(), 'hook-1'))
    expect(result.replayId).toBeNull()
    expect(deps.drops.heldSize).toBe(0)
  })

  it('끝난 뒤 owner 를 닫으면 그 owner 가 붙잡은 근거를 전부 놓는다(놓기 신호가 결과보다 늦어도)', async () => {
    imported(await op({ op: 'import', dir: 'in', token: deps.drops.register([path.join(src, 'one.txt')]), owner: 'hook-1' }))
    imported(await op({ op: 'import', dir: 'dest', token: deps.drops.register([path.join(src, 'one.txt')]), owner: 'hook-2' }))
    expect(deps.drops.heldSize).toBe(2)
    await op({ op: 'release', ids: [], owner: 'hook-1' })
    expect(deps.drops.heldSize).toBe(1)
  })

  it('살아 있는 owner 의 가져오기는 그대로 붙잡고 재생된다(회귀 없음)', async () => {
    const got = imported(await inflight(() => undefined, 'hook-1'))
    expect(got.replayId).not.toBeNull()
    expect(deps.drops.heldSize).toBe(1)
    expect(code(await op({ op: 'trash', rel: 'in/one.txt', expect: got.marks[0], snapshot: false }))).toBe('ok')
    expect(code(await op({ op: 'import', dir: 'in', replay: got.replayId, names: ['one.txt'] }))).toBe('ok')
  })
})
