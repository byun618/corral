// 탐색기 읽기 전용 파일시스템 (LIFE-589 F1 · E7) — 렌더러가 준 (루트, 상대 경로)를 **열린 worktree 루트 밑**으로 가둔 뒤에만 읽는다.
//
// 가둠 규칙:
//   ① 루트는 지금 열린 worktree 경로와 **문자열로 같아야** 한다(`knownWorktree` 와 같은 결 — 등록 안 된 루트 거절)
//   ② 상대 경로는 문자열·상대·NUL 없음·길이 상한(형 위반 거절)
//   ③ `realpath(루트/상대)` 가 `realpath(루트)` 와 같거나 그 **밑**(`+ path.sep` 접두사 — `/a/b` 와 `/a/bc` 를 가른다)이어야 한다.
//      `..` 탈출과 밖을 가리키는 링크가 여기서 걸린다(문법 검사에서 미리 거르지 않는다 — 거절이 이 검사에서 났다는 것을 사유 코드로 보인다).
//   ④ (R1-A) 목록은 읽은 **뒤에** 루트·대상의 realpath 와 lstat 정체(dev·ino)를 다시 재 ③ 때와 같은지 본다. 다르면(최종 성분이든 중간 성분이든
//      그 사이 링크로 바꿔치기됐으면) 읽은 결과를 버리고 `changed` 로 거절한다.
//
// **남은 위험 (정확히)** — Node 에는 fd 로 디렉터리를 읽는 길(`fdopendir`/`openat`)이 없어 검사와 접근이 원자적이지 않다:
//   · readdir 직전에 경로를 밖으로 바꿨다가 readdir 이 끝나고 재확인 전에 **원래대로 되돌리면**(ABA) 재확인을 지나 밖의 이름·종류가 나갈 수 있다.
//     창은 readdir 한 번의 길이고, 바꾸는 쪽은 worktree 안에서 rename·symlink 를 할 수 있는 같은 사용자 프로세스다. 노출은 이름·종류뿐(F1 은 내용을 안 읽는다).
//   · 동작(`explorer-actions.ts`)은 가둔 경로 **문자열**을 클립보드·Finder·셸 cwd 로 넘긴다 — 넘긴 뒤의 교체는 막지 못한다(전부 비파괴).
//   · 그래서 **이 함수를 쓰기 경계(F3·F4)로 그대로 쓰면 안 된다.** 쓰기는 경로 문자열 재검사가 아니라 fd 기반이어야 한다 —
//     부모 디렉터리를 `O_DIRECTORY|O_NOFOLLOW` 로 연 fd 정체 확인·`O_NOFOLLOW|O_EXCL` 생성·임시 파일 + rename 같은 방식(Node 만으로 안 되면 네이티브 보조)을 F3 에서 설계한다.
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

/** 정체 — lstat 의 dev·ino. 경로가 다른 객체로 바뀌었는지 본다. */
async function identity(target: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(target)
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

/** 접근 뒤 재확인(④) — 같은 입력으로 다시 가둬 같은 realpath·같은 정체(루트·대상)인지. */
async function stillSame(input: { roots: readonly string[]; root: unknown; rel: unknown }, before: { realRoot: string; abs: string; rootId: string | null; absId: string | null }): Promise<boolean> {
  const again = await confine(input)
  if (!again.ok || again.realRoot !== before.realRoot || again.abs !== before.abs) return false
  return (await identity(again.realRoot)) === before.rootId && (await identity(again.abs)) === before.absId
}

/**
 * 한 항목의 종류·링크 상태. 링크는 realpath 로 대상을 풀어 **먼저 경계를 판정**하고, 루트 밖이면 더 읽지 않는다(stat 없음 — 종류를 모르므로 `file`
 * 로 두고 펼칠 수 없다). 경계 판정 자체(realpath)는 링크 경로를 따라 성분을 푼다 — 그것까지 피할 수는 없다.
 */
async function entryOf(dir: string, realRoot: string, dirent: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }): Promise<ExplorerEntry> {
  if (!dirent.isSymbolicLink()) return { name: dirent.name, kind: dirent.isDirectory() ? 'dir' : 'file', link: 'none' }
  const full = path.join(dir, dirent.name)
  let target: string
  try {
    target = await fs.realpath(full)
  } catch {
    return { name: dirent.name, kind: 'file', link: 'broken' }
  }
  if (!isInside(realRoot, target)) return { name: dirent.name, kind: 'file', link: 'outside' }
  try {
    const stat = await fs.stat(target)
    return { name: dirent.name, kind: stat.isDirectory() ? 'dir' : 'file', link: 'ok' }
  } catch {
    return { name: dirent.name, kind: 'file', link: 'broken' }
  }
}

/** 한 폴더의 항목(숨김·정렬 전 원본) — 숨김·정렬은 렌더러 `shared/explorer.ts`. */
export async function listDir(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<ExplorerListResult> {
  const dirLabel = typeof input.rel === 'string' ? input.rel : ''
  const confined = await confine(input)
  if (!confined.ok) return { ok: false, dir: dirLabel, code: confined.code, error: confined.error }
  const before = { realRoot: confined.realRoot, abs: confined.abs, rootId: await identity(confined.realRoot), absId: await identity(confined.abs) }
  try {
    const dirents = await fs.readdir(confined.abs, { withFileTypes: true })
    if (!(await stillSame(input, before))) return { ok: false, dir: confined.rel, code: 'changed', error: '읽는 동안 경로가 바뀌었다 — 결과를 버렸다' }
    const entries = await Promise.all(dirents.map((dirent) => entryOf(confined.abs, confined.realRoot, dirent)))
    return { ok: true, dir: confined.rel, real: path.relative(confined.realRoot, confined.abs).split(path.sep).join('/'), entries }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    return { ok: false, dir: confined.rel, code: code === 'ENOTDIR' ? 'not_directory' : code === 'ENOENT' ? 'not_found' : 'io_error', error: String(error) }
  }
}
