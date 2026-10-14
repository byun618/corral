// 파일 탭 내용 읽기 (LIFE-590 F2 · E7ⓐ) — **읽기 전용**. 렌더러가 준 (루트, 상대 경로)를 F1 `confine` 으로 열린 worktree 밑에 가둔 뒤에만 읽는다.
//
// 순서: ① 가둠(`confine` — 등록 루트·형·realpath 접두사) ①' lstat 이 일반 파일이 아니면 열지 않고 `not_file`(FIFO 열기 대기 방지 — 수정 r1 R1-F)
// ② 가둔 실경로를 `O_NOFOLLOW | O_NONBLOCK` 으로 연다(마지막 성분이 그 사이 링크로 바뀌었으면 열기가 실패한다)
// ③ 연 fd 의 fstat 으로 종류·크기 — 파일이 아니면 거절, 상한(50 MB)을 넘으면 **내용을 읽지 않고** `too_large` ④ 다시 가둬 같은 실경로이고
// fd 정체(dev:ino)가 그 경로의 lstat 정체와 같은지(F1 R1-A 재확인과 같은 결) ⑤ 앞 8 KB 에 NUL 이면 바이너리 — 나머지를 읽지 않는다 ⑥ 텍스트는 크기만큼(상한까지) 읽어 UTF-8 로.
// LIFE-591 — 텍스트는 BOM 유무·UTF-8 손실 여부·nlink 를 같이 돌려준다(편집 가능 판정 E1ⓕ·E6ⓑ⑪). 저장은 이 파일이 아니라 `file-write.ts`(fd 기반 쓰기 경계).
// 남은 위험은 F1 과 같다(`explorer-fs.ts` 머리말): 중간 성분을 열기 직전에 바꿨다 되돌리는 ABA. 노출은 worktree 밖 파일 **내용**일 수 있어 F1 보다 무겁지만,
// 바꾸는 쪽은 worktree 에 쓸 수 있는 같은 사용자 프로세스다. **쓰기 경계로 넘기지 않는다**(F3 은 fd 기반으로 따로 설계).
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { confine } from './explorer-fs.js'
import { BINARY_PROBE_BYTES, imageMimeOf, TEXT_LIMIT_BYTES, type FileReadRefusal, type FileReadResult, type ImageReadResult } from '../shared/file-view.js'

/** NUL 판정(Orca `binary-buffer.ts`·git) — 앞 창 안에 0 바이트가 하나라도 있으면 바이너리. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE_BYTES)
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true
  return false
}

const decoder = new TextDecoder('utf-8')
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const BOM = [0xef, 0xbb, 0xbf]

/** UTF-8 로 디코드 — BOM 은 떼고 유무를 따로(저장이 다시 붙인다). 잘못된 바이트가 있으면 대체 문자로 읽고 `utf8: false`(손실 — 렌더러가 읽기 전용으로 연다). */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean; utf8: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
  try {
    return { text: strictDecoder.decode(bytes), bom, utf8: true }
  } catch {
    return { text: decoder.decode(bytes), bom, utf8: false }
  }
}

/** ①~④ — 가두고 `O_NOFOLLOW` 로 열어 fstat·재가둠까지. 성공이면 열린 handle(닫는 것은 부른 쪽)·stat·stamp. */
async function openConfined(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<
  { ok: true; handle: fs.FileHandle; size: number; nlink: number; stamp: string } | { ok: false; code: FileReadRefusal; error: string }
> {
  const confined = await confine(input)
  if (!confined.ok) return { ok: false, code: confined.code, error: confined.error }
  const errorCode = (error: unknown): string => (typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '')
  // 일반 파일이 아니면(FIFO·소켓·장치·폴더) **열기 전에** 거절한다 — FIFO 를 그냥 열면 쓰는 쪽이 올 때까지 열기가 끝나지 않는다(수정 r1 R1-F).
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    before = await fs.lstat(confined.abs)
  } catch (error) {
    return { ok: false, code: errorCode(error) === 'ENOENT' ? 'not_found' : 'io_error', error: String(error) }
  }
  if (!before.isFile()) return { ok: false, code: 'not_file', error: '일반 파일이 아니다 — 열지 않았다' }
  let handle: fs.FileHandle
  try {
    // lstat 과 열기 사이에 FIFO 로 바뀌어도 막히지 않게 `O_NONBLOCK`(일반 파일 읽기에는 영향 없음) — 바뀐 것은 아래 fstat 이 `not_file` 로 거른다.
    handle = await fs.open(confined.abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = errorCode(error)
    return { ok: false, code: code === 'ENOENT' ? 'not_found' : code === 'ELOOP' ? 'changed' : 'io_error', error: String(error) }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw Object.assign(new Error('파일이 아니다'), { refusal: 'not_file' })
    const again = await confine(input)
    const lstat = again.ok ? await fs.lstat(again.abs).catch(() => null) : null
    if (!again.ok || again.abs !== confined.abs || lstat === null || lstat.dev !== stat.dev || lstat.ino !== stat.ino) {
      throw Object.assign(new Error('여는 동안 경로가 바뀌었다 — 읽지 않았다'), { refusal: 'changed' })
    }
    return { ok: true, handle, size: stat.size, nlink: stat.nlink, stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` }
  } catch (error) {
    await handle.close()
    const refusal = typeof error === 'object' && error !== null && 'refusal' in error ? error.refusal : null
    return { ok: false, code: refusal === 'not_file' ? 'not_file' : refusal === 'changed' ? 'changed' : 'io_error', error: String(error) }
  }
}

/** 처음부터 `length` 바이트까지(파일이 짧으면 거기까지) 읽는다. */
async function readUpTo(input: { handle: fs.FileHandle; buffer: Uint8Array; from: number; to: number }): Promise<number> {
  let offset = input.from
  while (offset < input.to) {
    const { bytesRead } = await input.handle.read(input.buffer, offset, input.to - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset
}

export async function readFileContent(input: { roots: readonly string[]; root: unknown; rel: unknown; limit?: number }): Promise<FileReadResult> {
  const limit = input.limit ?? TEXT_LIMIT_BYTES
  const opened = await openConfined(input)
  if (!opened.ok) return opened
  const { handle, stamp } = opened
  try {
    if (opened.size > limit) return { ok: true, kind: 'too_large', size: opened.size, limit, bytesRead: 0, stamp }
    // 크기만큼 한 번에 — 읽는 사이 자라도 상한 + 1 바이트 넘게는 읽지 않는다(상한 초과면 그때 too_large).
    const capacity = Math.min(opened.size, limit) + 1
    const buffer = new Uint8Array(capacity)
    let bytesRead = await readUpTo({ handle, buffer, from: 0, to: Math.min(capacity, BINARY_PROBE_BYTES) })
    if (looksBinary(buffer.subarray(0, bytesRead))) return { ok: true, kind: 'binary', size: opened.size, bytesRead, stamp }
    bytesRead = await readUpTo({ handle, buffer, from: bytesRead, to: capacity })
    if (bytesRead > limit) return { ok: true, kind: 'too_large', size: bytesRead, limit, bytesRead, stamp }
    // 8 KB 뒤에 NUL 이 있어도 텍스트로 본다(판정 창 밖 — Orca·git 과 같다). UTF-8 아닌 바이트는 U+FFFD 로(인코딩 추정 없음) — 그때 `utf8: false`(LIFE-591 Q4).
    return { ok: true, kind: 'text', ...decodeText(buffer.subarray(0, bytesRead)), nlink: opened.nlink, size: opened.size, bytesRead, stamp }
  } catch (error) {
    return { ok: false, code: 'io_error', error: String(error) }
  } finally {
    await handle.close()
  }
}

/**
 * 이미지 바이트(E4ⓔ) — 확장자가 VS Code media-preview 목록(`IMAGE_MIME`)일 때만. 바이트를 그대로 넘기고 렌더러가 `createImageBitmap`(래스터)·
 * sanitize 한 인라인 SVG 로 그린다 — URL 을 만들지 않으니 CSP `img-src` 를 바꾸지 않는다(E10 답). 상한은 텍스트와 같은 50 MB(넘으면 읽지 않는다).
 */
export async function readImageContent(input: { roots: readonly string[]; root: unknown; rel: unknown; limit?: number }): Promise<ImageReadResult> {
  const limit = input.limit ?? TEXT_LIMIT_BYTES
  const mime = typeof input.rel === 'string' ? imageMimeOf(input.rel) : null
  if (mime === null) return { ok: false, code: 'not_file', error: '이미지 확장자가 아니다' }
  const opened = await openConfined(input)
  if (!opened.ok) return opened
  const { handle, stamp } = opened
  try {
    if (opened.size > limit) return { ok: true, kind: 'too_large', size: opened.size, limit, bytesRead: 0, stamp }
    const buffer = new Uint8Array(Math.min(opened.size, limit) + 1)
    const bytesRead = await readUpTo({ handle, buffer, from: 0, to: buffer.length })
    if (bytesRead > limit) return { ok: true, kind: 'too_large', size: bytesRead, limit, bytesRead, stamp }
    return { ok: true, kind: 'image', mime, bytes: buffer.slice(0, bytesRead), size: opened.size, bytesRead, stamp }
  } catch (error) {
    return { ok: false, code: 'io_error', error: String(error) }
  } finally {
    await handle.close()
  }
}
