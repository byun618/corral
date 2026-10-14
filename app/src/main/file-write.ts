// 파일 탭 저장 (LIFE-591 F3 · E6) — **쓰기 경계**. 렌더러가 준 (루트, 상대 경로, 내용)을 열린 worktree 밑의 **이미 있는 일반 파일**에만 쓴다.
//
// F1 `confine`·F2 `file-read.ts` 는 경로 문자열을 다시 재는 방식이라 검사와 접근 사이에 중간 성분을 바꿨다 되돌리는 ABA 가 남는다(`explorer-fs.ts` 머리말).
// 여기서는 가둠 **판정**(등록 루트·형·realpath 접두사)만 `confine` 에 맡기고, 실제 열기는 그 판정이 낸 realpath 를 **`O_NOFOLLOW_ANY`** 로 연다:
//   ① `confine` — 등록 루트·형·realpath(루트/상대) 가 realpath(루트) 밑. 결과 `abs` 는 링크가 하나도 없는 경로다(realpath)
//   ② lstat — 일반 파일이 아니면(폴더·FIFO·소켓·장치) 열지 않고 `not_file`(FIFO 열기 대기 방지 — F2 R1-F 와 같다)
//   ③ `open(abs, O_WRONLY | O_NOFOLLOW_ANY | O_NONBLOCK)` — 경로의 **어느 성분이든** 그 사이 링크로 바뀌었으면 커널이 `ELOOP` 로 거절한다(macOS 11+,
//      코디 실측 `raw/coord/c20` — Node 20·24·Electron 44). 링크 없는 절대 경로를 링크 없이 풀면 그 경로 자리의 파일이고, 그 자리는 ① 에서 루트 밑이다.
//      그래서 ① 뒤에 무엇을 바꿔도 밖 파일이 열리는 길이 없다 — 재확인(사후 검사)이 아니라 열기 자체가 막는다
//   ④ fstat(fd) — 일반 파일 · nlink == 1(하드링크면 `hardlink` — `O_NOFOLLOW_ANY` 는 하드링크를 못 막는다, 같은 inode 의 다른 이름이 밖일 수 있다)
//      · 정체(dev:ino)가 ② 와 같은지(그 사이 다른 파일로 바뀌었으면 `changed`)
//   ⑤ 저장 시점 충돌(E4ⓒ) — fd 의 stamp(dev:ino:size:mtime)가 `baseStamp` 와 다르면 `overwrite` 가 아닌 한 **쓰지 않고** `conflict`
//   ⑥ 쓰기 — **제자리**(같은 inode): 0 부터 새 내용을 쓰고 → `ftruncate(새 길이)` → `fdatasync` → fstat 으로 새 stamp. VS Code·Orca 편집기 저장과 같은 방식이다.
//      제자리를 고른 이유(근거 `raw/claude/write-mode.md`): inode·mode·xattr·하드링크 수가 그대로고(E2ⓕ), rename 은 경로 기반이라 그 단계의 가둠을 다시
//      설계해야 한다(Node 에 `renameat` 없음). 대가 — 쓰는 도중 실패하면 앞부분만 새 내용인 파일이 남을 수 있다(`write_failed.bytesWritten` 로 알린다).
//      자를 때(`ftruncate`)를 쓰기 **뒤**로 둬서 「크기 0 파일」 순간을 만들지 않는다.
// 다시 만들기(E4ⓓ, `create`) — 부모 폴더를 ① 처럼 가두고 `O_CREAT | O_EXCL | O_NOFOLLOW_ANY` 로 연다(이미 있으면 `exists`, 그 사이 링크면 `ELOOP`).
// 내용 상한은 main 이 다시 잰다(E6ⓓ — 렌더러 값을 믿지 않는다).
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { confine } from './explorer-fs.js'
import { TEXT_LIMIT_BYTES, type FileWriteResult } from '../shared/file-view.js'

/** macOS `O_NOFOLLOW_ANY`(XNU `fcntl.h` — "no symlinks allowed in path", macOS 11+). `fs.constants` 에 없어 리터럴로 둔다. corral 은 macOS 전용. */
export const O_NOFOLLOW_ANY = 0x20000000

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * 시험 전용 주입(E6ⓑ⑩·E2ⓔ) — 제품 경로에서는 늘 `{}`(아래 `loadTestHooks` 가 패키지 앱·환경변수 없음이면 빈 값).
 *   · `afterCheck` = ① 가둠 검사(와 ② lstat) 뒤·③ 열기 전에 부른다 — 경쟁 주입(중간 폴더를 밖 링크로 바꾼다)
 *   · `failWrite` = 쓰기 오류 주입: `before` 첫 바이트 전 · `mid` 앞 절반을 쓴 뒤
 */
export type WriteHooks = { afterCheck?: () => Promise<void>; failWrite?: 'before' | 'mid' }

export const stampOf = (stat: { dev: number; ino: number; size: number; mtimeMs: number }): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`

const errorCode = (error: unknown): string => (typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '')

type WriteInput = { roots: readonly string[]; root: unknown; rel: unknown; text: unknown; bom: unknown; baseStamp: unknown; overwrite: unknown; create: unknown; limit?: number; hooks?: WriteHooks }

export async function writeFileContent(input: WriteInput): Promise<FileWriteResult> {
  const { text, bom, baseStamp, overwrite, create } = input
  if (typeof text !== 'string' || typeof bom !== 'boolean' || typeof overwrite !== 'boolean' || typeof create !== 'boolean' || !(baseStamp === null || typeof baseStamp === 'string')) {
    return { ok: false, code: 'invalid_argument', error: '내용·옵션 형 위반' }
  }
  const limit = input.limit ?? TEXT_LIMIT_BYTES
  const body = Buffer.from(text, 'utf8')
  const data = bom ? Buffer.concat([BOM, body]) : body
  if (data.length > limit) return { ok: false, code: 'too_large', error: `내용 ${data.length} B 가 상한 ${limit} B 를 넘는다` }
  const hooks = input.hooks ?? {}
  return create ? createAndWrite({ ...input, data, hooks }) : writeExisting({ ...input, data, hooks, baseStamp, overwrite })
}

async function writeExisting(input: { roots: readonly string[]; root: unknown; rel: unknown; data: Buffer; hooks: WriteHooks; baseStamp: string | null; overwrite: boolean }): Promise<FileWriteResult> {
  const confined = await confine(input)
  if (!confined.ok) return { ok: false, code: confined.code, error: confined.error }
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    before = await fs.lstat(confined.abs)
  } catch (error) {
    return { ok: false, code: errorCode(error) === 'ENOENT' ? 'not_found' : 'io_error', error: String(error) }
  }
  if (!before.isFile()) return { ok: false, code: 'not_file', error: '일반 파일이 아니다 — 열지 않았다' }
  await input.hooks.afterCheck?.()
  let handle: fs.FileHandle
  try {
    handle = await fs.open(confined.abs, constants.O_WRONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK)
  } catch (error) {
    return openRefusal(error)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { ok: false, code: 'not_file', error: '연 대상이 일반 파일이 아니다' }
    if (stat.nlink > 1) return { ok: false, code: 'hardlink', error: `하드링크(nlink ${stat.nlink}) — 다른 이름과 같은 파일이라 쓰지 않았다` }
    if (stat.dev !== before.dev || stat.ino !== before.ino) return { ok: false, code: 'changed', error: '검사와 열기 사이에 다른 파일로 바뀌었다 — 쓰지 않았다' }
    const diskStamp = stampOf(stat)
    if (!input.overwrite && input.baseStamp !== null && diskStamp !== input.baseStamp) {
      return { ok: false, code: 'conflict', error: '디스크 내용이 마지막으로 읽은 뒤 바뀌었다 — 쓰지 않았다', diskStamp }
    }
    return await writeAll({ handle, data: input.data, hooks: input.hooks })
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function createAndWrite(input: { roots: readonly string[]; root: unknown; rel: unknown; data: Buffer; hooks: WriteHooks }): Promise<FileWriteResult> {
  const rel = input.rel
  if (typeof rel !== 'string') return { ok: false, code: 'invalid_argument', error: '상대 경로 형 위반' }
  const name = path.posix.basename(rel)
  if (name === '' || name === '.' || name === '..' || rel.endsWith('/')) return { ok: false, code: 'invalid_argument', error: '파일 이름 형 위반' }
  const parent = await confine({ roots: input.roots, root: input.root, rel: path.posix.dirname(rel) })
  if (!parent.ok) return { ok: false, code: parent.code, error: `부모 폴더: ${parent.error}` }
  let dir: Awaited<ReturnType<typeof fs.lstat>>
  try {
    dir = await fs.lstat(parent.abs)
  } catch (error) {
    return { ok: false, code: errorCode(error) === 'ENOENT' ? 'not_found' : 'io_error', error: String(error) }
  }
  if (!dir.isDirectory()) return { ok: false, code: 'not_directory', error: '부모가 폴더가 아니다' }
  await input.hooks.afterCheck?.()
  let handle: fs.FileHandle
  try {
    handle = await fs.open(path.join(parent.abs, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY | constants.O_NONBLOCK, 0o666)
  } catch (error) {
    return openRefusal(error)
  }
  try {
    return await writeAll({ handle, data: input.data, hooks: input.hooks })
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function openRefusal(error: unknown): FileWriteResult {
  switch (errorCode(error)) {
    case 'ENOENT':
      return { ok: false, code: 'not_found', error: String(error) }
    // 그 사이 경로 어딘가가 링크가 됐다(`O_NOFOLLOW_ANY`) — 경쟁 주입(E6ⓑ⑩)이 여기서 난다.
    case 'ELOOP':
      return { ok: false, code: 'changed', error: `경로에 링크가 끼었다 — 열지 않았다 (${String(error)})` }
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return { ok: false, code: 'permission_denied', error: String(error) }
    case 'EISDIR':
      return { ok: false, code: 'not_file', error: String(error) }
    case 'EEXIST':
      return { ok: false, code: 'exists', error: String(error) }
    default:
      return { ok: false, code: 'io_error', error: String(error) }
  }
}

/** ⑥ 제자리 쓰기 — 0 부터 다 쓰고 → 자르고 → fdatasync → 새 stamp. 도중 실패면 쓴 바이트 수를 같이 돌려준다. */
async function writeAll(input: { handle: fs.FileHandle; data: Buffer; hooks: WriteHooks }): Promise<FileWriteResult> {
  const { handle, data, hooks } = input
  let offset = 0
  try {
    if (hooks.failWrite === 'before') throw Object.assign(new Error('주입된 쓰기 오류(before)'), { code: 'EIO' })
    const stopAt = hooks.failWrite === 'mid' ? Math.floor(data.length / 2) : data.length
    while (offset < stopAt) {
      const { bytesWritten } = await handle.write(data, offset, stopAt - offset, offset)
      if (bytesWritten === 0) throw Object.assign(new Error('0 바이트 쓰기'), { code: 'EIO' })
      offset += bytesWritten
    }
    if (hooks.failWrite === 'mid') throw Object.assign(new Error('주입된 쓰기 오류(mid)'), { code: 'EIO' })
    await handle.truncate(data.length)
    await handle.datasync()
    const stat = await handle.stat()
    return { ok: true, stamp: stampOf(stat), size: stat.size }
  } catch (error) {
    return { ok: false, code: 'write_failed', error: String(error), bytesWritten: offset }
  }
}

/**
 * 시험 전용 주입을 읽는다 — **패키지 앱이면 늘 빈 값**, 개발 실행도 `CORRAL_TEST_WRITE_HOOK_FILE` 이 있을 때만. 파일은 저장마다 다시 읽는다(회차마다 바꿀 수 있게).
 * 형식: `{ "swapDir": "<루트 안 폴더>", "linkTo": "<밖 폴더>", "failWrite": "before" | "mid" }` — 경로는 `/tmp/l591` 밑만 받는다(시험 fixture 밖을 건드리지 않게).
 * `swapDir` 이 있으면 afterCheck 에서 그 폴더를 `<이름>.l591-orig` 로 옮기고 같은 자리에 `linkTo` 를 가리키는 링크를 만든다(E6ⓑ⑩ — 검사 뒤·열기 전).
 */
export async function loadTestHooks(input: { packaged: boolean; file: string | undefined }): Promise<WriteHooks> {
  if (input.packaged || input.file === undefined || input.file === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(input.file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const underTmp = (value: unknown): value is string => typeof value === 'string' && /^\/(private\/)?tmp\/l591[^/]*\//.test(value)
  const swapDir = 'swapDir' in parsed ? parsed.swapDir : undefined
  const linkTo = 'linkTo' in parsed ? parsed.linkTo : undefined
  const failWrite = 'failWrite' in parsed ? parsed.failWrite : undefined
  const hooks: WriteHooks = {}
  if (failWrite === 'before' || failWrite === 'mid') hooks.failWrite = failWrite
  if (underTmp(swapDir) && underTmp(linkTo)) {
    hooks.afterCheck = async () => {
      await fs.rename(swapDir, `${swapDir}.l591-orig`)
      await fs.symlink(linkTo, swapDir)
    }
  }
  return hooks
}
