// LIFE-592 수정 r1 — 리뷰 r1 지적의 main 쪽 회귀 시험(R1-B·R1-C·R1-G·R1-H). 휴지통은 가짜(시험 폴더로 옮김 — 사용자 ~/.Trash 무접촉).
//   R1-B `.git` 보호 = 실제 위치(링크 없는 realpath)·대소문자 무시 이름 — 내부 링크·`.GIT` 표기로 메타데이터 영역 쓰기 0, `.github`·`.gitignore` 는 허용
//   R1-C 복제·가져온 폴더 하위 변경(내용·추가·삭제) 뒤 실행 취소 = `modified` 거절
//   R1-G 만들기·복제·가져오기 결과가 다시 실행(재생)에 필요한 것을 준다 — 복제 원본(`from`), 가져오기 재생 근거(`replayId` — 수정 r2 에서 표지 대신)
//   R1-H 가져오기 도중 쓰기 실패로 남은 부분 파일 = 결과·표지(실행 취소 범위)·`partial` 에 든다
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
const gitList = (): string => JSON.stringify(fs.readdirSync(at('.git'), { recursive: true }).map(String).sort())
const field = (result: ExplorerOpResult, name: string): unknown => (typeof result === 'object' && name in result ? Reflect.get(result, name) : undefined)

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l592-r1-')))
  root = path.join(base, 'wt')
  src = path.join(base, 'drop-src')
  trashDir = path.join(base, 'trash')
})

beforeEach(() => {
  for (const dir of [root, src, trashDir]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true })
  fs.writeFileSync(at('.git/HEAD'), 'ref: x\n')
  fs.mkdirSync(at('src'), { recursive: true })
  fs.writeFileSync(at('src/a.ts'), 'a\n')
  fs.mkdirSync(at('folder'))
  fs.writeFileSync(at('folder/child.txt'), 'original')
  fs.symlinkSync('.git', at('meta-link'))
  fs.mkdirSync(path.join(src, 'pack'), { recursive: true })
  fs.writeFileSync(path.join(src, 'pack/inner.txt'), 'inner')
  fs.writeFileSync(path.join(src, 'one.txt'), 'content')
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

describe('R1-B .git 보호 = 실제 위치·대소문자 무시', () => {
  it('내부 링크로 .git 안에 만들기·옮겨 넣기·가져오기·되살리기 거절, 메타데이터 무변경', async () => {
    const before = gitList()
    expect(code(await op({ op: 'create', dir: 'meta-link', name: 'l592-in', kind: 'file' }))).toBe('protected')
    expect(code(await op({ op: 'create', dir: 'meta-link/objects', name: 'l592-in', kind: 'dir' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'meta-link/a.ts' }))).toBe('protected')
    const token = deps.drops.register([path.join(src, 'one.txt')])
    expect(code(await op({ op: 'import', dir: 'meta-link', token }))).toBe('protected')
    const gone = await op({ op: 'trash', rel: 'src/a.ts', snapshot: true })
    const snapshotId = field(gone, 'snapshotId')
    expect(typeof snapshotId).toBe('string')
    expect(code(await op({ op: 'restore', rel: 'meta-link/a.ts', snapshotId }))).toBe('protected')
    expect(gitList()).toBe(before)
  })
  it('대소문자 다른 표기(.GIT·.Git)로 만들기·옮기기·복제·삭제·조회 거절', async () => {
    const before = gitList()
    expect(code(await op({ op: 'create', dir: '.GIT', name: 'l592-in', kind: 'file' }))).toBe('protected')
    expect(code(await op({ op: 'create', dir: '', name: '.Git/l592-in', kind: 'file' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: '.GIT/HEAD', to: 'HEAD-moved' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: '.Git/a.ts' }))).toBe('protected')
    expect(code(await op({ op: 'duplicate', rel: '.GIT' }))).toBe('protected')
    expect(code(await op({ op: 'trash', rel: '.Git', snapshot: false }))).toBe('protected')
    expect(code(await op({ op: 'inspect', rel: '.GIT/HEAD' }))).toBe('protected')
    expect(fs.existsSync(at('HEAD-moved'))).toBe(false)
    expect(fs.existsSync(at('src/a.ts'))).toBe(true)
    expect(gitList()).toBe(before)
  })
  it('.git 을 가리키는 링크 자체(링크만)·.github·.gitignore·.gitkeep 은 조작할 수 있다', async () => {
    expect(code(await op({ op: 'create', dir: '', name: '.github/workflows/ci.yml', kind: 'file' }))).toBe('ok')
    expect(code(await op({ op: 'create', dir: '', name: '.gitignore', kind: 'file' }))).toBe('ok')
    expect(code(await op({ op: 'create', dir: 'src', name: '.gitkeep', kind: 'file' }))).toBe('ok')
    expect(code(await op({ op: 'move', from: 'meta-link', to: 'meta-link2' }))).toBe('ok')
    expect(code(await op({ op: 'trash', rel: 'meta-link2', snapshot: false }))).toBe('ok')
    expect(fs.existsSync(at('.git/HEAD'))).toBe(true)
  })
})

describe('R1-C 폴더 실행 취소 — 하위 변경이면 거절', () => {
  const undoOf = (result: ExplorerOpResult): Record<string, unknown> => {
    if (!result.ok || (result.op !== 'duplicate' && result.op !== 'import')) throw new Error(`복제·가져오기 실패 ${JSON.stringify(result)}`)
    const rel = result.op === 'duplicate' ? result.rel : result.rels[0]
    const expect = result.op === 'duplicate' ? result.marks : result.marks[0]
    return { op: 'trash', rel, expect, snapshot: false }
  }
  it('복제한 폴더의 하위 파일 내용 변경 → modified, 폴더 그대로', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'folder' })
    fs.writeFileSync(at('folder copy/child.txt'), 'user edit after duplicate')
    expect(code(await op(undoOf(dupe)))).toBe('modified')
    expect(fs.readFileSync(at('folder copy/child.txt'), 'utf8')).toBe('user edit after duplicate')
  })
  it('하위 파일 추가·삭제도 → modified', async () => {
    const added = await op({ op: 'duplicate', rel: 'folder' })
    fs.mkdirSync(at('folder copy/deep'))
    const deepUndo = undoOf(added)
    fs.writeFileSync(at('folder copy/deep/new.txt'), 'x')
    expect(code(await op(deepUndo))).toBe('modified')
    const removed = await op({ op: 'duplicate', rel: 'folder' })
    fs.rmSync(at('folder copy 2/child.txt'))
    expect(code(await op(undoOf(removed)))).toBe('modified')
  })
  it('가져온 폴더의 하위 변경 → modified', async () => {
    const token = deps.drops.register([path.join(src, 'pack')])
    const imported = await op({ op: 'import', dir: '', token })
    fs.writeFileSync(at('pack/inner.txt'), 'changed!!')
    expect(code(await op(undoOf(imported)))).toBe('modified')
  })
  it('양성 대조 — 안 바뀐 폴더는 실행 취소된다', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'folder' })
    expect(code(await op(undoOf(dupe)))).toBe('ok')
    expect(fs.existsSync(at('folder copy'))).toBe(false)
  })
})

describe('R1-G 다시 실행 재생에 필요한 것', () => {
  it('복제 결과에 원본 경로(from)', async () => {
    const dupe = await op({ op: 'duplicate', rel: 'folder' })
    expect(field(dupe, 'from')).toBe('folder')
  })
  it('가져오기 결과의 재생 근거(수정 r2 — main 이 붙잡은 id) — 원래 이름으로 같은 원본을 다시 가져오고, 자리가 차 있으면 다시 만들지 않는다', async () => {
    const token = deps.drops.register([path.join(src, 'one.txt')])
    const first = await op({ op: 'import', dir: 'src', token })
    const replay = field(first, 'replayId')
    expect(typeof replay).toBe('string')
    fs.rmSync(at('src/one.txt'))
    const again = await op({ op: 'import', dir: 'src', replay, names: ['one.txt'] })
    expect(code(again)).toBe('ok')
    expect(fs.readFileSync(at('src/one.txt'), 'utf8')).toBe('content')
    expect(code(await op({ op: 'import', dir: 'src', replay, names: ['one.txt'] }))).toBe('exists')
  })
})

describe('R1-H 가져오기 부분 파일', () => {
  it('쓰기 도중 실패 — 남은 부분 파일이 rels·marks·partial 에 들고 failed 에 사유', async () => {
    const token = deps.drops.register([path.join(src, 'one.txt')])
    const realOpen = fsp.open
    const target = at('src/one.txt')
    let injected = false
    fsp.open = async function (...args: Parameters<typeof fsp.open>) {
      const handle = await realOpen(...args)
      if (args[0] === target) {
        handle.write = async () => {
          injected = true
          throw Object.assign(new Error('controlled ENOSPC'), { code: 'ENOSPC' })
        }
      }
      return handle
    }
    let result: ExplorerOpResult
    try {
      result = await op({ op: 'import', dir: 'src', token })
    } finally {
      fsp.open = realOpen
    }
    expect(injected).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    expect(result.ok).toBe(true)
    if (!result.ok || result.op !== 'import') return
    expect(result.rels).toEqual(['src/one.txt'])
    expect(result.marks).toHaveLength(1)
    expect(field(result, 'partial')).toEqual(['src/one.txt'])
    expect(result.failed.map((row) => row.name)).toEqual(['one.txt'])
  })
})
