// 탐색기 읽기 전용 파일시스템 (LIFE-589 F1 · E7) — 렌더러가 준 (루트, 상대 경로)를 **열린 worktree 루트 밑**으로 가둔 뒤에만 읽는다.
//
// 가둠 규칙 (F3·F4 가 쓰기 IPC 에서 이 함수를 그대로 다시 쓴다):
//   ① 루트는 지금 열린 worktree 경로와 **문자열로 같아야** 한다(`knownWorktree` 와 같은 결 — 등록 안 된 루트 거절)
//   ② 상대 경로는 문자열·상대·NUL 없음·길이 상한(형 위반 거절)
//   ③ `realpath(루트/상대)` 가 `realpath(루트)` 와 같거나 그 **밑**(`+ path.sep` 접두사 — `/a/b` 와 `/a/bc` 를 가른다)이어야 한다.
//      `..` 탈출과 밖을 가리키는 링크가 여기서 걸린다(문법 검사에서 미리 거르지 않는다 — 거절이 이 검사에서 났다는 것을 사유 코드로 보인다).
// 쓰는 쪽은 없다 — 이 파일에는 읽기(realpath·readdir·lstat·stat)만 있다.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExplorerEntry, ExplorerListResult, ExplorerRefusal } from '../shared/explorer.js'

export const MAX_REL_LENGTH = 4096

export type Confined = { ok: true; realRoot: string; abs: string; rel: string } | { ok: false; code: ExplorerRefusal; error: string }

const refuse = (code: ExplorerRefusal, error: string): Confined => ({ ok: false, code, error })

/** 접두사 검사 — 같은 경로이거나 `root + sep` 로 시작. */
export const isInside = (realRoot: string, real: string): boolean => real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)

export async function confine(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<Confined> {
  if (typeof input.root !== 'string' || !path.isAbsolute(input.root) || !input.roots.includes(input.root)) return refuse('not_worktree', '열린 worktree 루트가 아니다')
  const rel = input.rel
  if (typeof rel !== 'string' || rel.length > MAX_REL_LENGTH || rel.includes('\0') || path.isAbsolute(rel) || rel.startsWith('/')) return refuse('invalid_argument', '상대 경로 형 위반')
  let realRoot: string
  try {
    realRoot = await fs.realpath(input.root)
  } catch (error) {
    return refuse('not_found', `루트 없음 ${String(error)}`)
  }
  const joined = path.resolve(realRoot, rel)
  let real: string
  try {
    real = await fs.realpath(joined)
  } catch {
    // 없는 경로 — 그래도 탈출 시도인지 먼저 가린다(사유 코드가 「없음」 으로 탈출을 가리지 않게).
    return isInside(realRoot, joined) ? refuse('not_found', '없는 경로') : refuse('outside_root', '루트 밖')
  }
  if (!isInside(realRoot, real)) return refuse('outside_root', '루트 밖')
  return { ok: true, realRoot, abs: real, rel }
}

/** 한 항목의 종류·링크 상태. 링크는 대상을 따라가 보되(stat) 루트 밖이면 `outside` — 펼칠 수 없게 한다(가둠·루프와 무관하게 밖은 안 읽는다). */
async function entryOf(dir: string, realRoot: string, dirent: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }): Promise<ExplorerEntry> {
  if (!dirent.isSymbolicLink()) return { name: dirent.name, kind: dirent.isDirectory() ? 'dir' : 'file', link: 'none' }
  const full = path.join(dir, dirent.name)
  try {
    const target = await fs.realpath(full)
    const stat = await fs.stat(target)
    return { name: dirent.name, kind: stat.isDirectory() ? 'dir' : 'file', link: isInside(realRoot, target) ? 'ok' : 'outside' }
  } catch {
    return { name: dirent.name, kind: 'file', link: 'broken' }
  }
}

/** 한 폴더의 항목(숨김·정렬 전 원본) — 숨김·정렬은 렌더러 `shared/explorer.ts`. */
export async function listDir(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<ExplorerListResult> {
  const dirLabel = typeof input.rel === 'string' ? input.rel : ''
  const confined = await confine(input)
  if (!confined.ok) return { ok: false, dir: dirLabel, code: confined.code, error: confined.error }
  try {
    const dirents = await fs.readdir(confined.abs, { withFileTypes: true })
    const entries = await Promise.all(dirents.map((dirent) => entryOf(confined.abs, confined.realRoot, dirent)))
    return { ok: true, dir: confined.rel, entries }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    return { ok: false, dir: confined.rel, code: code === 'ENOTDIR' ? 'not_directory' : code === 'ENOENT' ? 'not_found' : 'io_error', error: String(error) }
  }
}
