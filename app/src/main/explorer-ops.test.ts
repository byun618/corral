// LIFE-592 E1·E2·E3·E5·E6·E7·E8·E9 — 탐색기 조작 쓰기 경계(단위). 휴지통은 가짜(`trashItem` = 시험 폴더로 옮김 — 사용자 휴지통 무접촉).
// 조작 가족마다 ① 안 경로 ② `..` ③ 절대 밖 ④ 마지막 성분 밖 링크 ⑤ 중간 폴더 밖 링크 ⑥ 등록 안 된 루트 ⑦ 형 위반 ⑧ 루트·.git ⑨ 이름 규칙 ⑩ 경쟁 주입 —
// ②~⑩ 은 사유 코드로 「그 검사에서 났다」 를 보이고, 거절마다 **밖 목록·sha 무변경**을 본다. 덮어쓰기 0·영구 삭제 0·대소문자만 바꾸기·실행 취소 사본도 같이.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DropStore, loadOpHooks, runExplorerOp, SnapshotStore, type OpDeps, type OpHooks } from './explorer-ops.js'
import type { ExplorerOpResult } from '../shared/explorer-ops.js'

let base = ''
let root = ''
let outside = ''
let trashDir = ''
let trashed: string[] = []
let deps: OpDeps

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
/** 밖 폴더 전체 목록 + sha — 거절 회차마다 같아야 한다. */
const outsideState = (): string =>
  JSON.stringify(
    fs
      .readdirSync(outside, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name)
        return `${path.relative(outside, full)}:${entry.isFile() ? sha(full) : entry.isDirectory() ? 'dir' : 'other'}`
      })
      .sort(),
  )
const op = (input: Record<string, unknown>, hooks?: OpHooks): Promise<ExplorerOpResult> => runExplorerOp(hooks === undefined ? deps : { ...deps, hooks }, { root, ...input })
const at = (rel: string): string => path.join(root, rel)
const exists = (rel: string): boolean => fs.existsSync(at(rel)) || isLink(rel)
const isLink = (rel: string): boolean => {
  try {
    return fs.lstatSync(at(rel)).isSymbolicLink()
  } catch {
    return false
  }
}
const code = (result: ExplorerOpResult): string => (result.ok ? 'ok' : result.code)
/** 경쟁 주입 — 검사 뒤·호출 직전에 `rel` 폴더를 밖 링크로 바꾼다. */
const swap = (rel: string): OpHooks => ({
  afterCheck: async () => {
    fs.renameSync(at(rel), `${at(rel)}.orig`)
    fs.symlinkSync(outside, at(rel))
  },
})

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l592-ops-')))
  root = path.join(base, 'wt')
  outside = path.join(base, 'outside')
  trashDir = path.join(base, 'trash')
})

beforeEach(() => {
  for (const dir of [root, outside, trashDir]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'src/sub'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: x\n')
  fs.writeFileSync(at('src/a.ts'), 'export const a = 1\n')
  fs.writeFileSync(at('src/Foo.ts'), 'foo\n')
  fs.writeFileSync(at('src/sub/c.md'), '# c\n')
  fs.writeFileSync(at('docs/readme.md'), '# readme\n')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  fs.mkdirSync(path.join(outside, 'sub'))
  fs.writeFileSync(path.join(outside, 'sub/x.txt'), 'x\n')
  fs.symlinkSync(outside, at('out-link'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), at('out-file-link'))
  fs.symlinkSync('src/a.ts', at('in-link'))
  fs.mkdirSync(trashDir, { recursive: true })
  trashed = []
  deps = {
    roots: () => [root],
    // 가짜 휴지통 — 이름을 붙여 시험 폴더로 옮긴다(사용자 ~/.Trash 무접촉).
    trashItem: async (abs) => {
      const target = path.join(trashDir, `${trashed.length}-${path.basename(abs)}`)
      fs.renameSync(abs, target)
      trashed.push(abs)
    },
    snapshots: new SnapshotStore(),
    drops: new DropStore(),
  }
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('E1 새 파일·새 폴더', () => {
  it('① 파일 0 B·폴더 — 디스크에 생기고 표지(도장)를 준다', async () => {
    const file = await op({ op: 'create', dir: 'src', name: 'new.ts', kind: 'file' })
    expect(file).toMatchObject({ ok: true, rel: 'src/new.ts', created: 'src/new.ts' })
    expect(fs.statSync(at('src/new.ts')).size).toBe(0)
    const dir = await op({ op: 'create', dir: '', name: 'lib', kind: 'dir' })
    expect(dir).toMatchObject({ ok: true, rel: 'lib', kind: 'dir' })
    expect(fs.statSync(at('lib')).isDirectory()).toBe(true)
  })
  it('ⓓ a/b/c.ts — 중간 폴더까지 만들고 created = 처음 만든 폴더', async () => {
    const result = await op({ op: 'create', dir: 'src', name: 'x/y/z.ts', kind: 'file' })
    expect(result).toMatchObject({ ok: true, rel: 'src/x/y/z.ts', created: 'src/x' })
    // 표지는 맨 위(created) 하나 — 그 밑에서 이번에 만든 것 전부(y·z.ts)를 담은 집합(수정 r3).
    expect(result.ok && result.op === 'create' ? result.marks.map((mark) => mark.rel) : []).toEqual(['src/x'])
    // 이미 있는 중간 폴더는 그대로 내려간다
    const again = await op({ op: 'create', dir: '', name: 'src/sub/d.ts', kind: 'file' })
    expect(again).toMatchObject({ ok: true, rel: 'src/sub/d.ts', created: 'src/sub/d.ts' })
  })
  it('ⓒ 이미 있음(대소문자만 달라도) — exists, 디스크 무변경', async () => {
    const before = sha(at('src/a.ts'))
    expect(code(await op({ op: 'create', dir: 'src', name: 'a.ts', kind: 'file' }))).toBe('exists')
    expect(code(await op({ op: 'create', dir: 'src', name: 'A.TS', kind: 'file' }))).toBe('exists')
    expect(code(await op({ op: 'create', dir: 'src', name: 'sub', kind: 'dir' }))).toBe('exists')
    expect(sha(at('src/a.ts'))).toBe(before)
    expect(fs.readdirSync(at('src')).sort()).toEqual(['Foo.ts', 'a.ts', 'sub'])
  })
  it('⑨ 이름 규칙 — 빈·.·..·NUL·앞뒤 공백·255 바이트 초과·앞 / ·빈 성분', async () => {
    for (const name of ['', '   ', '.', '..', 'a\0b', ' a', 'a ', 'x'.repeat(256), '가'.repeat(86), '/abs', 'a//b', 'a/', 'a/../b']) {
      expect(code(await op({ op: 'create', dir: 'src', name, kind: 'file' })), JSON.stringify(name)).toBe('invalid_name')
    }
    expect(fs.readdirSync(at('src')).sort()).toEqual(['Foo.ts', 'a.ts', 'sub'])
  })
  it('②~⑧ 거절 — 사유 코드, 밖 무변경', async () => {
    const before = outsideState()
    expect(code(await op({ op: 'create', dir: '..', name: 'evil.txt', kind: 'file' }))).toBe('outside_root')
    expect(code(await op({ op: 'create', dir: outside, name: 'evil.txt', kind: 'file' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'create', dir: 'out-link', name: 'evil.txt', kind: 'file' }))).toBe('outside_root')
    expect(code(await op({ op: 'create', dir: 'out-link/sub', name: 'evil.txt', kind: 'file' }))).toBe('outside_root')
    expect(code(await runExplorerOp(deps, { op: 'create', root: outside, dir: '', name: 'evil.txt', kind: 'file' }))).toBe('not_worktree')
    expect(code(await op({ op: 'create', dir: 'src', name: 5, kind: 'file' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'create', dir: 'src', name: 'a', kind: 'socket' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'create', dir: '.git', name: 'evil', kind: 'file' }))).toBe('protected')
    expect(code(await op({ op: 'create', dir: '', name: '.git/evil', kind: 'file' }))).toBe('protected')
    expect(outsideState()).toBe(before)
  })
  it('⑩ 경쟁 주입 — 파일(fd 연산) 은 ELOOP 거절, 밖 무변경', async () => {
    const before = outsideState()
    const result = await op({ op: 'create', dir: 'src/sub', name: 'race.ts', kind: 'file' }, swap('src'))
    expect(code(result)).toBe('changed')
    expect(outsideState()).toBe(before)
  })
  it('⑩ 경쟁 주입 — 폴더(경로 연산) 는 사후 확인이 잡는다(done) — 잔여 창 기록', async () => {
    const result = await op({ op: 'create', dir: 'src/sub', name: 'race-dir', kind: 'dir' }, swap('src'))
    expect(result).toMatchObject({ ok: false, code: 'changed', done: true })
    // mkdir 은 경로 기반이라 밖에 만들어졌다(Q8 잔여 — residual.md). 사후 확인이 그것을 알린다.
    expect(fs.existsSync(path.join(outside, 'sub', 'race-dir'))).toBe(true)
  })
})

describe('E2 이름 변경·E6 이동', () => {
  it('① 이름 변경 — inode 유지, 원 자리 없음', async () => {
    const ino = fs.statSync(at('src/a.ts')).ino
    const result = await op({ op: 'move', from: 'src/a.ts', to: 'src/b.ts' })
    expect(result).toMatchObject({ ok: true, from: 'src/a.ts', to: 'src/b.ts' })
    expect(fs.statSync(at('src/b.ts')).ino).toBe(ino)
    expect(exists('src/a.ts')).toBe(false)
  })
  it('ⓒ 대소문자만 바꾸기 — 성공하고 readdir 이 새 이름을 보인다', async () => {
    const result = await op({ op: 'move', from: 'src/Foo.ts', to: 'src/foo.ts' })
    expect(result).toMatchObject({ ok: true })
    expect(fs.readdirSync(at('src'))).toContain('foo.ts')
    expect(fs.readdirSync(at('src'))).not.toContain('Foo.ts')
  })
  it('ⓒ 같은 이름 — 무동작 성공', async () => {
    const ino = fs.statSync(at('src/a.ts')).ino
    expect(await op({ op: 'move', from: 'src/a.ts', to: 'src/a.ts' })).toMatchObject({ ok: true })
    expect(fs.statSync(at('src/a.ts')).ino).toBe(ino)
  })
  it('ⓓ 충돌 — exists, 덮어쓰기 0(대상·원본 sha 그대로)', async () => {
    fs.writeFileSync(at('src/b.ts'), 'b\n')
    const before = [sha(at('src/a.ts')), sha(at('src/b.ts'))]
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/b.ts' }))).toBe('exists')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/B.TS' }))).toBe('exists')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'docs' }))).toBe('exists')
    expect([sha(at('src/a.ts')), sha(at('src/b.ts'))]).toEqual(before)
  })
  it('E6 폴더 이동 — 하위 그대로, 자기 자신·하위로는 into_self', async () => {
    expect(await op({ op: 'move', from: 'src/sub', to: 'docs/sub' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(at('docs/sub/c.md'), 'utf8')).toBe('# c\n')
    expect(code(await op({ op: 'move', from: 'docs', to: 'docs/sub/docs' }))).toBe('into_self')
    expect(code(await op({ op: 'move', from: 'docs', to: 'docs' }))).toBe('ok')
  })
  it('링크 이동 = 링크만(대상 무변경)', async () => {
    const before = outsideState()
    expect(await op({ op: 'move', from: 'out-link', to: 'docs/out-link' })).toMatchObject({ ok: true })
    expect(fs.lstatSync(at('docs/out-link')).isSymbolicLink()).toBe(true)
    expect(outsideState()).toBe(before)
  })
  it('expect(정체)가 다르면 modified — 실행 취소가 다른 항목을 옮기지 않는다', async () => {
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/z.ts', expect: '1:2' }))).toBe('modified')
    expect(exists('src/a.ts')).toBe(true)
  })
  it('②~⑨ 원본·대상 거절 — 밖 무변경', async () => {
    const before = outsideState()
    // 원본
    expect(code(await op({ op: 'move', from: '../outside/secret.txt', to: 'src/s.txt' }))).toBe('outside_root')
    expect(code(await op({ op: 'move', from: path.join(outside, 'secret.txt'), to: 'src/s.txt' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'move', from: 'out-link/secret.txt', to: 'src/s.txt' }))).toBe('outside_root')
    expect(code(await op({ op: 'move', from: 'out-link/sub/x.txt', to: 'src/s.txt' }))).toBe('outside_root')
    expect(code(await runExplorerOp(deps, { op: 'move', root: outside, from: 'secret.txt', to: 'x' }))).toBe('not_worktree')
    expect(code(await op({ op: 'move', from: 42, to: 'x' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'move', from: '', to: 'x' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: '.git', to: 'git2' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: 'src/./a.ts', to: 'src/q.ts' }))).toBe('invalid_name')
    // 대상
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: '../evil.ts' }))).toBe('outside_root')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: '/tmp/evil.ts' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'out-link/evil.ts' }))).toBe('outside_root')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'out-link/sub/evil.ts' }))).toBe('outside_root')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: '.git/evil.ts' }))).toBe('protected')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/a\0b' }))).toBe('invalid_argument')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/ a.ts' }))).toBe('invalid_name')
    expect(code(await op({ op: 'move', from: 'src/a.ts', to: 'src/..' }))).toBe('invalid_name')
    expect(outsideState()).toBe(before)
    expect(exists('src/a.ts')).toBe(true)
  })
  it('⑩ 경쟁 주입(대상 중간 폴더) — 경로 연산: 사후 확인이 잡는다(done)', async () => {
    const result = await op({ op: 'move', from: 'docs/readme.md', to: 'src/sub/readme.md' }, swap('src'))
    expect(result).toMatchObject({ ok: false, code: 'changed', done: true })
  })
  it('⑪ 하드링크·FIFO — 하드링크는 이름만 옮김(nlink 그대로), FIFO 는 not_file', async () => {
    fs.linkSync(at('src/a.ts'), path.join(outside, 'hard.ts'))
    expect(await op({ op: 'move', from: 'src/a.ts', to: 'docs/a.ts' })).toMatchObject({ ok: true })
    expect(fs.statSync(at('docs/a.ts')).nlink).toBe(2)
    execFileSync('mkfifo', [at('src/pipe')])
    expect(code(await op({ op: 'move', from: 'src/pipe', to: 'docs/pipe' }))).toBe('not_file')
  })
})

describe('E3 휴지통·E5 실행 취소 사본', () => {
  it('파일 — 휴지통(가짜)으로 가고 사본 id(≤ 5 MB), 되살리면 sha 같음·mode 같음', async () => {
    fs.chmodSync(at('src/a.ts'), 0o640)
    const before = sha(at('src/a.ts'))
    const result = await op({ op: 'trash', rel: 'src/a.ts', snapshot: true })
    expect(result).toMatchObject({ ok: true, kind: 'file' })
    expect(exists('src/a.ts')).toBe(false)
    expect(trashed).toEqual([at('src/a.ts')])
    const snapshotId = result.ok && result.op === 'trash' ? result.snapshotId : null
    expect(snapshotId).not.toBeNull()
    const restored = await op({ op: 'restore', rel: 'src/a.ts', snapshotId })
    expect(restored).toMatchObject({ ok: true, rel: 'src/a.ts', hash: before })
    expect(sha(at('src/a.ts'))).toBe(before)
    expect(fs.statSync(at('src/a.ts')).mode & 0o777).toBe(0o640)
    // 사본은 한 번 쓰면 버린다
    expect(code(await op({ op: 'restore', rel: 'src/a2.ts', snapshotId }))).toBe('expired')
  })
  it('되살릴 자리에 다른 것이 생겼으면 exists — 덮어쓰기 0', async () => {
    const result = await op({ op: 'trash', rel: 'src/a.ts', snapshot: true })
    fs.writeFileSync(at('src/a.ts'), 'new\n')
    const snapshotId = result.ok && result.op === 'trash' ? result.snapshotId : null
    expect(code(await op({ op: 'restore', rel: 'src/a.ts', snapshotId }))).toBe('exists')
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('new\n')
  })
  it('5 MB 초과 파일·내용 있는 폴더 — 사본 없음(Q1)', async () => {
    fs.writeFileSync(at('big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1))
    expect(await op({ op: 'trash', rel: 'big.bin', snapshot: true })).toMatchObject({ ok: true, snapshotId: null })
    expect(await op({ op: 'trash', rel: 'src/sub', snapshot: true })).toMatchObject({ ok: true, kind: 'dir', snapshotId: null })
    expect(await op({ op: 'inspect', rel: 'docs/readme.md' })).toMatchObject({ ok: true, kind: 'file', undoable: true })
    expect(await op({ op: 'inspect', rel: 'docs' })).toMatchObject({ ok: true, kind: 'dir', undoable: false })
  })
  it('ⓓ 링크 삭제 = 링크만(안·밖 대상 sha 그대로)', async () => {
    const inside = sha(at('src/a.ts'))
    const before = outsideState()
    expect(await op({ op: 'trash', rel: 'in-link', snapshot: true })).toMatchObject({ ok: true, kind: 'link', snapshotId: null })
    expect(await op({ op: 'trash', rel: 'out-file-link', snapshot: true })).toMatchObject({ ok: true, kind: 'link' })
    expect(await op({ op: 'trash', rel: 'out-link', snapshot: true })).toMatchObject({ ok: true, kind: 'link' })
    expect(sha(at('src/a.ts'))).toBe(inside)
    expect(outsideState()).toBe(before)
  })
  it('ⓔ 루트·.git·밖은 거절 — 휴지통 호출 0', async () => {
    const before = outsideState()
    for (const rel of ['', '.git', '.git/HEAD', 'src/../../outside/secret.txt', 'out-link/secret.txt', 'out-link/sub']) {
      const result = await op({ op: 'trash', rel, snapshot: true })
      expect(result.ok, rel).toBe(false)
    }
    expect(code(await op({ op: 'trash', rel: '.git', snapshot: true }))).toBe('protected')
    expect(code(await op({ op: 'trash', rel: 'out-link/secret.txt', snapshot: true }))).toBe('outside_root')
    expect(trashed).toEqual([])
    expect(outsideState()).toBe(before)
  })
  it('ⓕ 휴지통 실패 — trash_failed, 디스크 무변경(영구 삭제 폴백 없음)', async () => {
    deps = { ...deps, trashItem: async () => Promise.reject(new Error('권한 없음')) }
    expect(code(await op({ op: 'trash', rel: 'src/a.ts', snapshot: true }))).toBe('trash_failed')
    expect(exists('src/a.ts')).toBe(true)
  })
  it('⑩ 경쟁 주입 — 휴지통 직전 재확인이 잡는다(보내지 않음)', async () => {
    const before = outsideState()
    expect(code(await op({ op: 'trash', rel: 'src/sub/c.md', snapshot: true }, swap('src')))).toBe('changed')
    expect(trashed).toEqual([])
    expect(outsideState()).toBe(before)
  })
  it('E5ⓒ 만들기 되돌리기 — 만든 뒤 바뀌었으면 modified(휴지통 안 감)', async () => {
    const made = await op({ op: 'create', dir: 'src', name: 'n.ts', kind: 'file' })
    const marks = made.ok && made.op === 'create' ? made.marks : []
    fs.writeFileSync(at('src/n.ts'), 'typed\n')
    expect(code(await op({ op: 'trash', rel: 'src/n.ts', snapshot: true, expect: marks }))).toBe('modified')
    expect(exists('src/n.ts')).toBe(true)
  })
  it('E5 빈 폴더 사본 — 만든 폴더 되돌리기 → 다시 실행', async () => {
    const made = await op({ op: 'create', dir: '', name: 'lib', kind: 'dir' })
    const marks = made.ok && made.op === 'create' ? made.marks : []
    const undone = await op({ op: 'trash', rel: 'lib', snapshot: true, expect: marks })
    expect(undone).toMatchObject({ ok: true, kind: 'dir' })
    const snapshotId = undone.ok && undone.op === 'trash' ? undone.snapshotId : null
    expect(snapshotId).not.toBeNull()
    expect(await op({ op: 'restore', rel: 'lib', snapshotId })).toMatchObject({ ok: true })
    expect(fs.statSync(at('lib')).isDirectory()).toBe(true)
  })
  it('restore ②~⑨ 거절', async () => {
    const result = await op({ op: 'trash', rel: 'src/a.ts', snapshot: true })
    const snapshotId = result.ok && result.op === 'trash' ? result.snapshotId : null
    const before = outsideState()
    expect(code(await op({ op: 'restore', rel: '../evil.ts', snapshotId }))).toBe('outside_root')
    expect(code(await op({ op: 'restore', rel: 'out-link/evil.ts', snapshotId }))).toBe('outside_root')
    expect(code(await op({ op: 'restore', rel: 'out-link/sub/evil.ts', snapshotId }))).toBe('outside_root')
    expect(code(await op({ op: 'restore', rel: '.git/evil', snapshotId }))).toBe('protected')
    expect(code(await op({ op: 'restore', rel: 'src/..', snapshotId }))).toBe('invalid_name')
    expect(code(await op({ op: 'restore', rel: 'src/x', snapshotId: 'nope' }))).toBe('expired')
    expect(code(await runExplorerOp(deps, { op: 'restore', root: outside, rel: 'x', snapshotId }))).toBe('not_worktree')
    expect(code(await op({ op: 'restore', rel: 'src/sub/r.ts', snapshotId }, swap('src')))).toBe('changed')
    expect(outsideState()).toBe(before)
  })
  it('사본 메모리 상한 — 넘으면 오래된 것부터 버린다', () => {
    const store = new SnapshotStore(10)
    const a = store.put({ root, kind: 'file', bytes: Buffer.alloc(6), mode: 0o644 })
    const b = store.put({ root, kind: 'file', bytes: Buffer.alloc(6), mode: 0o644 })
    expect(store.get(a)).toBeUndefined()
    expect(store.get(b)).toBeDefined()
  })
})

describe('E8 복제', () => {
  it('파일 — 「copy」·「copy 2」, 원본 무변경, mode 유지', async () => {
    fs.chmodSync(at('src/a.ts'), 0o600)
    expect(await op({ op: 'duplicate', rel: 'src/a.ts' })).toMatchObject({ ok: true, rel: 'src/a copy.ts' })
    expect(await op({ op: 'duplicate', rel: 'src/a.ts' })).toMatchObject({ ok: true, rel: 'src/a copy 2.ts' })
    expect(await op({ op: 'duplicate', rel: 'src/a copy.ts' })).toMatchObject({ ok: true, rel: 'src/a copy 3.ts' })
    expect(sha(at('src/a copy.ts'))).toBe(sha(at('src/a.ts')))
    expect(fs.statSync(at('src/a copy.ts')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(at('src/a copy.ts')).ino).not.toBe(fs.statSync(at('src/a.ts')).ino)
  })
  it('폴더(재귀)·링크는 링크로', async () => {
    fs.symlinkSync('../a.ts', at('src/sub/to-a'))
    expect(await op({ op: 'duplicate', rel: 'src/sub' })).toMatchObject({ ok: true, rel: 'src/sub copy', kind: 'dir' })
    expect(fs.readFileSync(at('src/sub copy/c.md'), 'utf8')).toBe('# c\n')
    expect(fs.readlinkSync(at('src/sub copy/to-a'))).toBe('../a.ts')
    expect(await op({ op: 'duplicate', rel: 'out-link' })).toMatchObject({ ok: true, rel: 'out-link copy', kind: 'link' })
    expect(fs.readlinkSync(at('out-link copy'))).toBe(outside)
  })
  it('점 파일·확장자 없는 이름', async () => {
    fs.writeFileSync(at('.env'), 'X=1\n')
    expect(await op({ op: 'duplicate', rel: '.env' })).toMatchObject({ ok: true, rel: '.env copy' })
  })
  it('거절 — 밖·.git·루트', async () => {
    const before = outsideState()
    expect(code(await op({ op: 'duplicate', rel: 'out-link/secret.txt' }))).toBe('outside_root')
    expect(code(await op({ op: 'duplicate', rel: '.git' }))).toBe('protected')
    expect(code(await op({ op: 'duplicate', rel: '' }))).toBe('protected')
    expect(code(await op({ op: 'duplicate', rel: '../outside' }))).toBe('outside_root')
    expect(outsideState()).toBe(before)
  })
  it('⑩ 경쟁 주입 — 파일 쓰기(fd)는 ELOOP 로 거절', async () => {
    const before = outsideState()
    expect(code(await op({ op: 'duplicate', rel: 'src/sub/c.md' }, swap('src')))).toBe('changed')
    expect(outsideState()).toBe(before)
  })
})

describe('E7 가져오기', () => {
  let source = ''
  beforeEach(() => {
    source = path.join(base, 'finder')
    fs.rmSync(source, { recursive: true, force: true })
    fs.mkdirSync(path.join(source, 'pack/inner'), { recursive: true })
    fs.writeFileSync(path.join(source, 'one.txt'), 'one\n')
    fs.writeFileSync(path.join(source, 'pack/inner/two.txt'), 'two\n')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'pack/leak'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'top-link'))
  })
  it('파일·폴더 복사(원본 sha·inode 무변경), 안 링크·최상위 링크는 건너뜀', async () => {
    const ino = fs.statSync(path.join(source, 'one.txt')).ino
    const token = deps.drops.register([path.join(source, 'one.txt'), path.join(source, 'pack'), path.join(source, 'top-link')])
    const result = await op({ op: 'import', dir: 'docs', token })
    expect(result).toMatchObject({ ok: true, rels: ['docs/one.txt', 'docs/pack'] })
    expect(fs.readFileSync(at('docs/pack/inner/two.txt'), 'utf8')).toBe('two\n')
    expect(exists('docs/pack/leak')).toBe(false)
    expect(exists('docs/top-link')).toBe(false)
    expect(result.ok && result.op === 'import' ? result.skipped.map((row) => row.name).sort() : []).toEqual(['pack/leak', 'top-link'])
    expect(fs.statSync(path.join(source, 'one.txt')).ino).toBe(ino)
  })
  it('ⓒ 충돌 — 「copy」 새 이름(덮어쓰기 0)', async () => {
    fs.writeFileSync(at('docs/one.txt'), 'mine\n')
    const token = deps.drops.register([path.join(source, 'one.txt')])
    expect(await op({ op: 'import', dir: 'docs', token })).toMatchObject({ ok: true, rels: ['docs/one copy.txt'] })
    expect(fs.readFileSync(at('docs/one.txt'), 'utf8')).toBe('mine\n')
  })
  it('ⓓ 표지 위조·재사용 — bad_token, 대상 무변경', async () => {
    const before = fs.readdirSync(at('docs')).sort()
    expect(code(await op({ op: 'import', dir: 'docs', token: path.join(outside, 'secret.txt') }))).toBe('bad_token')
    expect(code(await op({ op: 'import', dir: 'docs', token: crypto.randomUUID() }))).toBe('bad_token')
    const token = deps.drops.register([path.join(source, 'one.txt')])
    expect(await op({ op: 'import', dir: 'docs', token })).toMatchObject({ ok: true })
    expect(code(await op({ op: 'import', dir: 'docs', token }))).toBe('bad_token')
    expect(fs.readdirSync(at('docs')).sort()).toEqual([...before, 'one.txt'].sort())
  })
  it('대상 거절 — 밖 링크·.git·형', async () => {
    const before = outsideState()
    for (const dir of ['out-link', 'out-link/sub', '..', '.git']) {
      const token = deps.drops.register([path.join(source, 'one.txt')])
      expect((await op({ op: 'import', dir, token })).ok, dir).toBe(false)
    }
    expect(outsideState()).toBe(before)
  })
  it('표지 만료', () => {
    let now = 0
    const store = new DropStore(1000, () => now)
    const token = store.register(['/x'])
    now = 2000
    expect(store.take(token)).toBeNull()
  })
  it('⑩ 경쟁 주입 — 원본 중간 폴더가 링크로 바뀌면 O_NOFOLLOW_ANY 가 읽지 않는다', async () => {
    const token = deps.drops.register([path.join(source, 'pack')])
    const hooks: OpHooks = {
      afterCheck: async (phase) => {
        if (phase !== 'create-file' || fs.lstatSync(path.join(source, 'pack/inner')).isSymbolicLink()) return
        fs.renameSync(path.join(source, 'pack/inner'), path.join(source, 'pack/inner.orig'))
        fs.symlinkSync(path.join(outside, 'sub'), path.join(source, 'pack/inner'))
      },
    }
    const result = await op({ op: 'import', dir: 'docs', token }, hooks)
    // 원본 파일은 이미 연 fd 에서 읽었거나(바꾸기 전 연 것) 열기가 ELOOP — 어느 쪽이든 밖 x.txt 내용이 들어오지 않는다.
    expect(result.ok).toBe(true)
    expect(fs.existsSync(at('docs/pack/inner/x.txt'))).toBe(false)
  })
})

describe('시험 주입은 제품 경로에서 꺼짐', () => {
  it('패키지·환경변수 없음이면 빈 값, /tmp/l592 밖 경로는 무시', async () => {
    expect(await loadOpHooks({ packaged: true, file: '/tmp/x.json' })).toEqual({})
    expect(await loadOpHooks({ packaged: false, file: undefined })).toEqual({})
    const file = path.join(base, 'hook.json')
    fs.writeFileSync(file, JSON.stringify({ swapDir: '/etc', linkTo: '/tmp/l592x/y' }))
    expect(await loadOpHooks({ packaged: false, file })).toEqual({})
  })
})
