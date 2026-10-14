// LIFE-590 E7ⓐⓑ·E4ⓕ — 파일 내용 읽기 가둠·크기 상한·바이너리 판정(단위). 같은 함수에 ① 안 경로 ② `..` 탈출 ③ 절대 경로 ④ 밖을 가리키는 링크
// ⑤ 등록 안 된 루트 ⑥ 형 위반 ⑦ 크기 상한 초과 — ②~⑦ 은 사유 코드로 「그 검사에서 났다」 를 보이고, ⑦ 은 읽은 바이트 0 으로 「상한 넘게 읽지 않았다」 를 보인다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeText, looksBinary, readFileContent, readImageContent } from './file-read.js'
import { BINARY_PROBE_BYTES } from '../shared/file-view.js'

let base = ''
let root = ''
const roots = (): string[] => [root]

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l590-fr-')))
  root = path.join(base, 'wt')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const a = 1\n')
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.concat([Buffer.from('PK'), Buffer.from([0, 1, 2]), Buffer.alloc(20_000, 65)]))
  // NUL 이 판정 창(8 KB) 밖에만 있으면 텍스트(Orca·git 과 같다).
  fs.writeFileSync(path.join(root, 'late-nul.txt'), Buffer.concat([Buffer.alloc(BINARY_PROBE_BYTES, 97), Buffer.from([0]), Buffer.from('tail')]))
  fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])) // "café" latin-1 — UTF-8 아님
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(4096, 98))
  fs.writeFileSync(path.join(base, 'outside.txt'), 'secret')
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'escape-file'))
  fs.symlinkSync('src/a.ts', path.join(root, 'inside-link'))
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('E7ⓑ 내용 읽기 양성 대조', () => {
  it('① 안 경로 텍스트 — 내용·크기·읽은 바이트', async () => {
    const result = await readFileContent({ roots: roots(), root, rel: 'src/a.ts' })
    expect(result).toMatchObject({ ok: true, kind: 'text', text: 'const a = 1\n', size: 12, bytesRead: 12 })
  })
  it('① 안을 가리키는 링크는 대상 내용', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'inside-link' })).toMatchObject({ ok: true, kind: 'text', text: 'const a = 1\n' })
  })
  it('② `..` 탈출 = outside_root', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: '../outside.txt' })).toMatchObject({ ok: false, code: 'outside_root' })
  })
  it('③ 절대 경로 = invalid_argument', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: path.join(base, 'outside.txt') })).toMatchObject({ ok: false, code: 'invalid_argument' })
  })
  it('④ 밖을 가리키는 링크 = outside_root (내용 없음)', async () => {
    const result = await readFileContent({ roots: roots(), root, rel: 'escape-file' })
    expect(result).toMatchObject({ ok: false, code: 'outside_root' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('⑤ 등록 안 된 루트 = not_worktree', async () => {
    expect(await readFileContent({ roots: roots(), root: base, rel: 'outside.txt' })).toMatchObject({ ok: false, code: 'not_worktree' })
  })
  it('⑥ 형 위반 = invalid_argument', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 7 })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await readFileContent({ roots: roots(), root, rel: 'a\0b' })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await readFileContent({ roots: roots(), root: 3, rel: 'a' })).toMatchObject({ ok: false, code: 'not_worktree' })
  })
  it('⑦ 크기 상한 초과 = too_large, 읽은 바이트 0', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'big.txt', limit: 1000 })).toMatchObject({ ok: true, kind: 'too_large', size: 4096, limit: 1000, bytesRead: 0 })
    expect(await readFileContent({ roots: roots(), root, rel: 'big.txt', limit: 4096 })).toMatchObject({ ok: true, kind: 'text', bytesRead: 4096 })
  })
  it('폴더 = not_file · 없는 파일 = not_found', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'src' })).toMatchObject({ ok: false, code: 'not_file' })
    expect(await readFileContent({ roots: roots(), root, rel: 'src/nope.ts' })).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('E4ⓕ 바이너리·빈 파일·UTF-8 아님', () => {
  it('앞 8 KB 에 NUL = binary, 판정 창까지만 읽는다', async () => {
    const result = await readFileContent({ roots: roots(), root, rel: 'bin.dat' })
    expect(result).toMatchObject({ ok: true, kind: 'binary', size: 20_005 })
    expect(result.ok && result.bytesRead).toBe(BINARY_PROBE_BYTES)
  })
  it('NUL 이 판정 창 밖이면 텍스트', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'late-nul.txt' })).toMatchObject({ ok: true, kind: 'text' })
  })
  it('빈 파일 = 빈 텍스트', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'empty.txt' })).toMatchObject({ ok: true, kind: 'text', text: '', size: 0, bytesRead: 0 })
  })
  it('UTF-8 아닌 바이트는 U+FFFD 로 보인다(인코딩 추정 없음)', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'latin1.txt' })).toMatchObject({ ok: true, kind: 'text', text: 'caf�' })
  })
  it('looksBinary 는 판정 창만 본다', () => {
    expect(looksBinary(new Uint8Array([1, 2, 0]))).toBe(true)
    const late = new Uint8Array(BINARY_PROBE_BYTES + 1)
    late.fill(1)
    late[BINARY_PROBE_BYTES] = 0
    expect(looksBinary(late)).toBe(false)
  })
})

describe('LIFE-591 E1ⓕ·E6ⓑ⑪ 편집 판정 재료 — BOM·UTF-8 손실·nlink', () => {
  it('UTF-8 아님 → utf8 false(렌더러가 읽기 전용으로 연다)', async () => {
    expect(await readFileContent({ roots: roots(), root, rel: 'latin1.txt' })).toMatchObject({ ok: true, kind: 'text', utf8: false, bom: false, nlink: 1 })
    expect(await readFileContent({ roots: roots(), root, rel: 'src/a.ts' })).toMatchObject({ ok: true, kind: 'text', utf8: true, bom: false })
  })
  it('BOM — 글에서 떼고 bom true', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]))).toEqual({ text: 'a\r\n', bom: true, utf8: true })
    expect(decodeText(new Uint8Array([0xef, 0xbb]))).toMatchObject({ bom: false, utf8: false })
  })
  it('정상 UTF-8 안의 U+FFFD 글자는 손실이 아니다', () => {
    expect(decodeText(new TextEncoder().encode('a\ufffdb'))).toEqual({ text: 'a\ufffdb', bom: false, utf8: true })
  })
  it('하드링크면 nlink > 1', async () => {
    fs.linkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'a-hard.ts'))
    expect(await readFileContent({ roots: roots(), root, rel: 'a-hard.ts' })).toMatchObject({ ok: true, kind: 'text', nlink: 2 })
    fs.rmSync(path.join(root, 'a-hard.ts'))
  })
})

describe('E4ⓔ 이미지 바이트 읽기', () => {
  it('목록 확장자 — 바이트·MIME·크기', async () => {
    fs.writeFileSync(path.join(root, 'pic.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const result = await readImageContent({ roots: roots(), root, rel: 'pic.PNG' })
    expect(result).toMatchObject({ ok: true, kind: 'image', mime: 'image/png', size: 7, bytesRead: 7 })
    expect(result.ok && result.kind === 'image' ? [...result.bytes.subarray(0, 4)] : null).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
  it('목록 밖 확장자는 열지 않는다(not_file) — 텍스트는 readFile 로', async () => {
    expect(await readImageContent({ roots: roots(), root, rel: 'src/a.ts' })).toMatchObject({ ok: false, code: 'not_file' })
  })
  it('상한 초과 — 읽은 바이트 0', async () => {
    fs.writeFileSync(path.join(root, 'huge.jpg'), Buffer.alloc(5000, 1))
    expect(await readImageContent({ roots: roots(), root, rel: 'huge.jpg', limit: 4096 })).toMatchObject({ ok: true, kind: 'too_large', bytesRead: 0 })
  })
  it('가둠 — 밖을 가리키는 링크·`..` 탈출은 거절', async () => {
    fs.writeFileSync(path.join(base, 'out.png'), 'x')
    fs.symlinkSync(path.join(base, 'out.png'), path.join(root, 'escape.png'))
    expect((await readImageContent({ roots: roots(), root, rel: 'escape.png' })).ok).toBe(false)
    expect((await readImageContent({ roots: roots(), root, rel: '../out.png' })).ok).toBe(false)
  })
})

describe('수정 r1 R1-F 일반 파일이 아닌 대상은 열기 전에 not_file', () => {
  // 실패(옛 코드)면 열기가 쓰는 쪽을 기다리며 끝나지 않는다 — 2 s 로 끊고, 막힌 열기는 쓰기 쪽을 잠깐 열어 풀어 준다(시험 프로세스가 남지 않게).
  const within = async <T,>(work: Promise<T>): Promise<T | 'timeout'> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), 2000)))
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  const unblock = (fifo: string): void => {
    try {
      fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK))
    } catch {
      // 읽는 쪽이 없으면(이미 끝남) ENXIO — 풀 것이 없다
    }
  }

  it('named pipe — 즉시 not_file(텍스트·이미지 둘 다)', async () => {
    const fifo = path.join(root, 'pipe.txt')
    const fifoImage = path.join(root, 'pipe.png')
    execFileSync('mkfifo', [fifo, fifoImage])
    try {
      const started = Date.now()
      expect(await within(readFileContent({ roots: roots(), root, rel: 'pipe.txt' }))).toMatchObject({ ok: false, code: 'not_file' })
      expect(await within(readImageContent({ roots: roots(), root, rel: 'pipe.png' }))).toMatchObject({ ok: false, code: 'not_file' })
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      unblock(fifo)
      unblock(fifoImage)
      fs.rmSync(fifo, { force: true })
      fs.rmSync(fifoImage, { force: true })
    }
  })

  it('lstat 뒤 열기 전에 FIFO 로 바뀌어도 막히지 않고 not_file — O_NONBLOCK + 연 fd 의 fstat', async () => {
    const fifo = path.join(root, 'swap.txt')
    execFileSync('mkfifo', [fifo])
    const regular = await fs.promises.lstat(path.join(root, 'src', 'a.ts'))
    // lstat 만 「일반 파일」 로 속인다 = 검사와 열기 사이에 바꿔치기된 상황.
    const spy = vi.spyOn(fs.promises, 'lstat').mockResolvedValueOnce(regular)
    try {
      expect(await within(readFileContent({ roots: roots(), root, rel: 'swap.txt' }))).toMatchObject({ ok: false, code: 'not_file' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      unblock(fifo)
      fs.rmSync(fifo, { force: true })
    }
  })
})
