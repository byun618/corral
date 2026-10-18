// LIFE-591 E6·E2ⓔⓕ·E4ⓒⓓ — 파일 쓰기 경계(단위). 같은 함수에 ① 안 경로 ② `..` ③ 절대 경로 ④ 마지막 성분 밖 링크 ⑤ 중간 폴더 밖 링크 ⑥ 등록 안 된 루트
// ⑦ 형 위반 ⑧ 크기 상한 ⑨ 폴더·FIFO ⑩ 경쟁 주입(검사 뒤·열기 전 중간 폴더 → 밖 링크) ⑪ 하드링크 — ②~⑪ 은 사유 코드로 「그 검사에서 났다」 를 보이고,
// 거절 회차마다 **밖 파일 바이트 sha256 무변경**을 본다. 저장 시점 충돌·덮어쓰기·BOM·mode·inode·안쪽 링크·다시 만들기·쓰기 오류 주입도 같이.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import { loadTestHooks, O_NOFOLLOW_ANY, stampOf, writeFileContent } from './file-write.js'
import { readFileContent } from './file-read.js'

let base = ''
let root = ''
let outside = ''
const roots = (): string[] => [root]
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const stamp = (rel: string): string => stampOf(fs.statSync(path.join(root, rel)))
const write = (input: { rel: string; text: string; bom?: boolean; baseStamp?: string | null; baseHash?: string | null; overwrite?: boolean; create?: boolean; root?: unknown; limit?: number; hooks?: Parameters<typeof writeFileContent>[0]['hooks'] }) =>
  writeFileContent({
    roots: roots(),
    root: input.root ?? root,
    rel: input.rel,
    text: input.text,
    bom: input.bom ?? false,
    baseStamp: input.baseStamp ?? null,
    baseHash: input.baseHash ?? null,
    overwrite: input.overwrite ?? false,
    create: input.create ?? false,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  })

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l591-fw-')))
  root = path.join(base, 'wt')
  outside = path.join(base, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  fs.mkdirSync(path.join(base, 'outside-dir'), { recursive: true })
  fs.writeFileSync(path.join(base, 'outside-dir', 'a.txt'), 'outside a\n')
})

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('E6ⓑ 쓰기 양성 대조', () => {
  it('O_NOFOLLOW_ANY 는 macOS 값 0x20000000', () => {
    expect(O_NOFOLLOW_ANY).toBe(0x20000000)
  })
  it('① 안 경로 — 내용이 그대로 쓰이고 새 stamp 가 디스크와 같다', async () => {
    const result = await write({ rel: 'src/a.txt', text: 'hello world\n' })
    expect(result).toMatchObject({ ok: true, size: 12 })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('hello world\n')
    expect(result.ok && result.stamp).toBe(stamp('src/a.txt'))
  })
  it('① 짧아진 내용 — 뒤가 잘린다(제자리 쓰기 뒤 ftruncate)', async () => {
    fs.writeFileSync(path.join(root, 'src/a.txt'), 'a much longer original line\n')
    await write({ rel: 'src/a.txt', text: 'short\n' })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('short\n')
  })
  it('① 0 B 로 저장', async () => {
    const result = await write({ rel: 'src/a.txt', text: '' })
    expect(result).toMatchObject({ ok: true, size: 0 })
    expect(fs.statSync(path.join(root, 'src/a.txt')).size).toBe(0)
  })
  it('② `..` 탈출 — outside_root, 밖 파일 무변경', async () => {
    const before = sha(path.join(outside, 'secret.txt'))
    expect(await write({ rel: '../outside/secret.txt', text: 'x' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(sha(path.join(outside, 'secret.txt'))).toBe(before)
  })
  it('③ 절대 경로 — invalid_argument', async () => {
    expect(await write({ rel: path.join(outside, 'secret.txt'), text: 'x' })).toMatchObject({ ok: false, code: 'invalid_argument' })
  })
  it('④ 마지막 성분이 밖 링크 — outside_root, 밖 파일 무변경', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    const before = sha(path.join(outside, 'secret.txt'))
    expect(await write({ rel: 'leak.txt', text: 'x' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(sha(path.join(outside, 'secret.txt'))).toBe(before)
  })
  it('⑤ 중간 폴더가 밖 링크 — outside_root, 밖 파일 무변경', async () => {
    fs.symlinkSync(outside, path.join(root, 'linkdir'))
    const before = sha(path.join(outside, 'secret.txt'))
    expect(await write({ rel: 'linkdir/secret.txt', text: 'x' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(sha(path.join(outside, 'secret.txt'))).toBe(before)
  })
  it('⑥ 등록 안 된 루트 — not_worktree', async () => {
    expect(await write({ root: outside, rel: 'secret.txt', text: 'x' })).toMatchObject({ ok: false, code: 'not_worktree' })
  })
  it('⑦ 형 위반(경로·내용·옵션) — invalid_argument', async () => {
    expect(await write({ rel: 'a\0b', text: 'x' })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await writeFileContent({ roots: roots(), root, rel: 'src/a.txt', text: 42, bom: false, baseStamp: null, overwrite: false, create: false })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await writeFileContent({ roots: roots(), root, rel: 'src/a.txt', text: 'x', bom: 'yes', baseStamp: null, overwrite: false, create: false })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await writeFileContent({ roots: roots(), root, rel: 'src/a.txt', text: 'x', bom: false, baseStamp: 7, overwrite: false, create: false })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('hello\n')
  })
  it('⑧ 크기 상한 — main 이 다시 재고(BOM 포함) 쓰지 않는다', async () => {
    expect(await write({ rel: 'src/a.txt', text: 'abcd', limit: 4 })).toMatchObject({ ok: true })
    expect(await write({ rel: 'src/a.txt', text: 'abcd', bom: true, limit: 4 })).toMatchObject({ ok: false, code: 'too_large' })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('abcd')
  })
  it('⑨ 폴더·FIFO — 막히지 않고 not_file', async () => {
    expect(await write({ rel: 'src', text: 'x' })).toMatchObject({ ok: false, code: 'not_file' })
    execFileSync('mkfifo', [path.join(root, 'pipe')])
    expect(await write({ rel: 'pipe', text: 'x' })).toMatchObject({ ok: false, code: 'not_file' })
  })
  it('⑩ 경쟁 주입 — 검사 뒤·열기 전에 중간 폴더를 밖 링크로 → changed(ELOOP), 밖 파일 무변경', async () => {
    fs.mkdirSync(path.join(root, 'mid'))
    fs.writeFileSync(path.join(root, 'mid', 'a.txt'), 'inside a\n')
    const target = path.join(base, 'outside-dir', 'a.txt')
    const before = sha(target)
    const result = await write({
      rel: 'mid/a.txt',
      text: 'PWNED\n',
      hooks: {
        afterCheck: async () => {
          fs.renameSync(path.join(root, 'mid'), path.join(root, 'mid.orig'))
          fs.symlinkSync(path.join(base, 'outside-dir'), path.join(root, 'mid'))
        },
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'changed' })
    expect(sha(target)).toBe(before)
    expect(fs.readFileSync(path.join(root, 'mid.orig', 'a.txt'), 'utf8')).toBe('inside a\n')
  })
  it('⑩ 대조 — 같은 바꿔치기를 `O_NOFOLLOW_ANY` 없이 열면 밖 파일이 열린다(검사 뒤 교체가 실제로 밖을 가리킨다)', () => {
    fs.mkdirSync(path.join(root, 'mid2'))
    fs.renameSync(path.join(root, 'mid2'), path.join(root, 'mid2.orig'))
    fs.symlinkSync(path.join(base, 'outside-dir'), path.join(root, 'mid2'))
    const fd = fs.openSync(path.join(root, 'mid2', 'a.txt'), fs.constants.O_RDONLY)
    try {
      expect(fs.fstatSync(fd).ino).toBe(fs.statSync(path.join(base, 'outside-dir', 'a.txt')).ino)
    } finally {
      fs.closeSync(fd)
    }
    expect(() => fs.openSync(path.join(root, 'mid2', 'a.txt'), fs.constants.O_RDONLY | O_NOFOLLOW_ANY)).toThrow(/ELOOP/)
  })
  it('⑪ 하드링크(nlink > 1) — hardlink 거절, 밖 파일 무변경', async () => {
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'))
    const before = sha(path.join(outside, 'secret.txt'))
    expect(await write({ rel: 'hard.txt', text: 'x' })).toMatchObject({ ok: false, code: 'hardlink' })
    expect(sha(path.join(outside, 'secret.txt'))).toBe(before)
  })
})

describe('E4ⓒ 저장 시점 충돌', () => {
  it('디스크가 baseStamp 와 다르면 쓰지 않고 conflict + 디스크 stamp', async () => {
    const base0 = stamp('src/a.txt')
    fs.writeFileSync(path.join(root, 'src/a.txt'), 'changed outside\n')
    const result = await write({ rel: 'src/a.txt', text: 'mine\n', baseStamp: base0 })
    expect(result).toMatchObject({ ok: false, code: 'conflict', diskStamp: stamp('src/a.txt') })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('changed outside\n')
  })
  it('overwrite 면 덮는다', async () => {
    const base0 = stamp('src/a.txt')
    fs.writeFileSync(path.join(root, 'src/a.txt'), 'changed outside\n')
    expect(await write({ rel: 'src/a.txt', text: 'mine\n', baseStamp: base0, overwrite: true })).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('mine\n')
  })
  it('같은 stamp 면 그대로 쓴다 — 연속 저장은 앞 저장이 돌려준 stamp 로', async () => {
    const first = await write({ rel: 'src/a.txt', text: 'one\n', baseStamp: stamp('src/a.txt') })
    expect(first.ok).toBe(true)
    const second = await write({ rel: 'src/a.txt', text: 'two\n', baseStamp: first.ok ? first.stamp : null })
    expect(second.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('two\n')
  })
})

describe('E1ⓕ·E2ⓕ 바이트·속성 보존', () => {
  it('BOM — EF BB BF 를 앞에 붙인다', async () => {
    await write({ rel: 'src/a.txt', text: 'x\r\n', bom: true })
    expect([...fs.readFileSync(path.join(root, 'src/a.txt'))]).toEqual([0xef, 0xbb, 0xbf, 0x78, 0x0d, 0x0a])
  })
  it('실행 권한(755)·inode 유지(제자리 쓰기)', async () => {
    const file = path.join(root, 'run.sh')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o755)
    const before = fs.statSync(file)
    await write({ rel: 'run.sh', text: '#!/bin/sh\necho hi\n' })
    const after = fs.statSync(file)
    expect(after.mode & 0o777).toBe(0o755)
    expect(after.ino).toBe(before.ino)
  })
  it('worktree 안을 가리키는 링크 — 대상에 쓰이고 링크는 링크로 남는다', async () => {
    fs.symlinkSync('src/a.txt', path.join(root, 'alias.txt'))
    expect(await write({ rel: 'alias.txt', text: 'via link\n' })).toMatchObject({ ok: true })
    expect(fs.lstatSync(path.join(root, 'alias.txt')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('via link\n')
  })
})

describe('E2ⓔ 저장 실패 — 원본이 깨지지 않는다', () => {
  it('권한 없음(444) — permission_denied, 원본 그대로', async () => {
    const file = path.join(root, 'src/a.txt')
    fs.chmodSync(file, 0o444)
    const before = sha(file)
    expect(await write({ rel: 'src/a.txt', text: 'x' })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(sha(file)).toBe(before)
    fs.chmodSync(file, 0o644)
  })
  it('파일이 폴더로 바뀜 — not_file', async () => {
    fs.rmSync(path.join(root, 'src/a.txt'))
    fs.mkdirSync(path.join(root, 'src/a.txt'))
    expect(await write({ rel: 'src/a.txt', text: 'x' })).toMatchObject({ ok: false, code: 'not_file' })
  })
  it('지워짐 — not_found(다시 만들지 않는다)', async () => {
    fs.rmSync(path.join(root, 'src/a.txt'))
    expect(await write({ rel: 'src/a.txt', text: 'x' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(fs.existsSync(path.join(root, 'src/a.txt'))).toBe(false)
  })
  it('쓰기 오류 주입(before) — write_failed · 0 바이트 · 원본 그대로', async () => {
    const file = path.join(root, 'src/a.txt')
    const before = sha(file)
    expect(await write({ rel: 'src/a.txt', text: 'new content\n', hooks: { failWrite: 'before' } })).toMatchObject({ ok: false, code: 'write_failed', bytesWritten: 0 })
    expect(sha(file)).toBe(before)
  })
  it('쓰기 오류 주입(mid) — write_failed · 쓴 바이트 수를 알린다(제자리 쓰기의 대가 — 기록)', async () => {
    const file = path.join(root, 'src/a.txt')
    const result = await write({ rel: 'src/a.txt', text: 'ABCDEFGHIJ', hooks: { failWrite: 'mid' } })
    expect(result).toMatchObject({ ok: false, code: 'write_failed', bytesWritten: 5 })
    // 앞 5 바이트만 새 내용, 자르기 전이라 원래 길이(6)를 넘지 않은 부분은 옛 내용이 남는다 — 「크기 0」 순간은 없다.
    expect(fs.readFileSync(file, 'utf8')).toBe('ABCDE\n')
  })
})

describe('E4ⓓ 다시 만들기', () => {
  it('지워진 파일을 같은 경로에 만든다', async () => {
    fs.rmSync(path.join(root, 'src/a.txt'))
    const result = await write({ rel: 'src/a.txt', text: 'back\n', create: true })
    expect(result).toMatchObject({ ok: true, size: 5 })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('back\n')
  })
  it('그 사이 생겼으면 exists — 덮지 않는다', async () => {
    expect(await write({ rel: 'src/a.txt', text: 'back\n', create: true })).toMatchObject({ ok: false, code: 'exists' })
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('hello\n')
  })
  it('부모 폴더가 없으면 not_found · 부모가 밖 링크면 outside_root', async () => {
    expect(await write({ rel: 'gone/a.txt', text: 'x', create: true })).toMatchObject({ ok: false, code: 'not_found' })
    fs.symlinkSync(outside, path.join(root, 'outlink'))
    expect(await write({ rel: 'outlink/new.txt', text: 'x', create: true })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
  })
  it('경쟁 주입 — 부모 검사 뒤 부모를 밖 링크로 → changed, 밖에 파일이 생기지 않는다', async () => {
    fs.mkdirSync(path.join(root, 'p'))
    const result = await write({
      rel: 'p/new.txt',
      text: 'x',
      create: true,
      hooks: {
        afterCheck: async () => {
          fs.renameSync(path.join(root, 'p'), path.join(root, 'p.orig'))
          fs.symlinkSync(outside, path.join(root, 'p'))
        },
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'changed' })
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
  })
})

describe('시험 전용 주입 로더 — 제품 경로에서 꺼짐', () => {
  it('패키지 앱이면 파일이 있어도 빈 값', async () => {
    const file = path.join(base, 'hook.json')
    fs.writeFileSync(file, JSON.stringify({ failWrite: 'before' }))
    expect(await loadTestHooks({ packaged: true, file })).toEqual({})
    expect(await loadTestHooks({ packaged: false, file: undefined })).toEqual({})
    expect(await loadTestHooks({ packaged: false, file })).toEqual({ failWrite: 'before' })
  })
  it('swapDir·linkTo 는 /tmp/l591 밑만', async () => {
    const file = path.join(base, 'hook2.json')
    fs.writeFileSync(file, JSON.stringify({ swapDir: '/Users/x/a', linkTo: '/tmp/l591-x/b' }))
    expect((await loadTestHooks({ packaged: false, file })).afterCheck).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ swapDir: '/tmp/l591-x/a', linkTo: '/tmp/l591-x/b' }))
    expect(typeof (await loadTestHooks({ packaged: false, file })).afterCheck).toBe('function')
  })
})

// 수정 r1 (Codex 리뷰 r1 `source-cases.mts` 조건) — 옛 코드(1a670faf6)에서 실패.
describe('수정 r1 — 저장 기준의 내용 확인', () => {
  it('R1-C 같은 inode·같은 크기·같은 mtime 의 다른 내용 — 내용 지문이 달라 conflict, 디스크는 외부 내용 그대로', async () => {
    const file = path.join(root, 'preserved.txt')
    fs.writeFileSync(file, 'ORIGINAL')
    fs.utimesSync(file, 1700000000, 1700000000)
    const before = await readFileContent({ roots: roots(), root, rel: 'preserved.txt' })
    if (!before.ok || before.kind !== 'text') throw new Error('읽기 실패')
    fs.writeFileSync(file, 'EXTERNAL')
    fs.utimesSync(file, 1700000000, 1700000000)
    expect(stamp('preserved.txt')).toBe(before.stamp)
    const result = await write({ rel: 'preserved.txt', text: 'MY EDIT!', baseStamp: before.stamp, baseHash: before.hash })
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
    expect(fs.readFileSync(file, 'utf8')).toBe('EXTERNAL')
  })
  it('R1-B 쓰기 끝(fdatasync 뒤·마지막 fstat 전)에 외부 쓰기가 끼면 자기 저장으로 기록하지 않는다 — conflict 로 알린다', async () => {
    const file = path.join(root, 'overlap.txt')
    fs.writeFileSync(file, 'ORIGINAL')
    const before = await readFileContent({ roots: roots(), root, rel: 'overlap.txt' })
    if (!before.ok || before.kind !== 'text') throw new Error('읽기 실패')
    const originalOpen = fsp.open
    let injected = false
    // 리뷰어 주입과 같은 자리 — 우리 fd 의 datasync 가 돌아온 직후 외부가 같은 파일을 다시 쓴다.
    Reflect.set(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('/overlap.txt')) {
        const sync = handle.datasync.bind(handle)
        Reflect.set(handle, 'datasync', async () => {
          await sync()
          if (!injected) {
            injected = true
            fs.writeFileSync(file, 'EXTERNAL')
          }
        })
      }
      return handle
    })
    let result: Awaited<ReturnType<typeof writeFileContent>>
    try {
      result = await write({ rel: 'overlap.txt', text: 'MY EDIT!', baseStamp: before.stamp, baseHash: before.hash })
    } finally {
      Reflect.set(fsp, 'open', originalOpen)
    }
    expect(injected).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('EXTERNAL')
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
  })
  it('읽기·쓰기 지문이 같은 내용이면 같다 — 저장 뒤 다음 저장은 그 지문으로 그대로 쓴다', async () => {
    const before = await readFileContent({ roots: roots(), root, rel: 'src/a.txt' })
    if (!before.ok || before.kind !== 'text') throw new Error('읽기 실패')
    const first = await write({ rel: 'src/a.txt', text: 'one\n', baseStamp: before.stamp, baseHash: before.hash })
    if (!first.ok) throw new Error(first.code)
    const reread = await readFileContent({ roots: roots(), root, rel: 'src/a.txt' })
    expect(reread.ok && reread.kind === 'text' ? reread.hash : null).toBe(first.hash)
    expect(await write({ rel: 'src/a.txt', text: 'two\n', baseStamp: first.stamp, baseHash: first.hash })).toMatchObject({ ok: true })
  })
})
