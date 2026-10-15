// worktree 전체 파일 목록 (LIFE-593 F5 — ⌘P 빠른 열기·탐색기 이름 필터) — main·렌더러가 같이 쓰는 모양과 순수 규칙.
//
// 목록 출처는 git 이다(`raw/claude/list-source.md` — 번들 바이너리 없음). main 은 `git ls-files` 결과를 이 파일의 규칙으로 걸러 **루트 상대 경로**만 준다.
// 렌더러가 넘기는 것은 루트·무시 파일 포함 여부·요청 id 뿐이다 — 실행 인자·glob·질의는 main 으로 가지 않는다(E8ⓑ).
import type { ExplorerRefusal } from './explorer.js'

/** 목록 상한 — 넘으면 앞 것만 주고 `truncated`(E7ⓓ 안내). 20만 fixture 보다 넉넉히. */
export const FILE_LIST_MAX = 500_000
/** 요청 id 형 — 렌더러가 만든 짧은 토큰(취소 키). 경로·인자로 쓰이지 않는다. */
export const FILE_LIST_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 무시 파일을 넣어도 빼는 폴더 이름(VS Code `search.exclude` 기본·Orca blocklist 와 같은 결 — Q3). */
export const LIST_EXCLUDED_DIRS: readonly string[] = ['.git', 'node_modules']

export type FileListInput = { root: string; includeIgnored: boolean; requestId: string }

/**
 * 성공 응답의 경로는 **NUL 로 이은 문자열 하나**(`paths`, `count` 개)다(수정 r1 R1-C-10) — 20만 개 문자열 배열을 IPC 로 받으면 렌더러가 그 배열을 풀어 만드는 데
 * 한 덩어리로 긴 작업을 치른다. 문자열 하나는 복사 한 번이고, 렌더러가 `split('\0')` 로 나눈다(`file-list-client.ts`).
 */
export type FileListResult =
  | { ok: true; root: string; includeIgnored: boolean; paths: string; count: number; truncated: boolean; ms: number }
  | { ok: false; code: ExplorerRefusal | 'cancelled' | 'git_failed' | 'timeout'; error: string }

/** 응답에 실어도 되는 경로인가 — 루트 상대·`/` 구분·빈 성분/`.`/`..` 없음·NUL·절대 경로 없음(E8ⓓ). */
export function isSafeRel(rel: string): boolean {
  if (rel.length === 0 || rel.length > 4096 || rel.includes('\0') || rel.startsWith('/') || rel.endsWith('/')) return false
  for (const part of rel.split('/')) if (part === '' || part === '.' || part === '..') return false
  return true
}

/** 경로가 제외 폴더(`.git`·`node_modules`) 아래인가 — 어느 깊이든. */
export function underExcludedDir(rel: string): boolean {
  const parts = rel.split('/')
  for (let index = 0; index < parts.length - 1; index += 1) if (LIST_EXCLUDED_DIRS.includes(parts[index] ?? '')) return true
  return false
}

/**
 * `git ls-files -z --cached --others -s -t` 출력 → 고를 수 있는 경로(NUL 로 이음) + 확인할 링크(수정 r1 R1-C-05).
 * 추적 항목 = `<태그> <모드> <sha> <stage>\t<경로>`, untracked = `? <경로>`. 디스크에 파일로 없는 추적 항목은 뺀다:
 * 태그 `S`(skip-worktree — sparse checkout 으로 디스크에 없음)·모드 `160000`(gitlink — 서브모듈 폴더). 모드 `120000`(링크)은 `links` 로도 내 main 이 폴더 링크인지 본다.
 */
export function parseStagedListing(stdout: string): { listed: string; links: string[] } {
  const paths: string[] = []
  const links: string[] = []
  for (const entry of stdout.split('\0')) {
    if (entry === '') continue
    if (entry.startsWith('? ')) {
      paths.push(entry.slice(2))
      continue
    }
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const [tag, mode] = entry.slice(0, tab).split(' ')
    const rel = entry.slice(tab + 1)
    if (tag === 'S' || mode === '160000') continue
    if (mode === '120000') links.push(rel)
    paths.push(rel)
  }
  return { listed: paths.join('\0'), links }
}

/**
 * `git ls-files -z` 출력들 → 목록. `listed` = 추적(+ untracked), `deleted` = 지워졌지만 아직 추적 중(뺀다 — 오라클 「끔」), `ignored` = 무시 파일(켬일 때만, 제외 폴더 아래는 뺀다).
 * 끝이 `/` 인 항목(중첩 저장소·빈 디렉터리 — 파일이 아니다)과 안전하지 않은 경로는 버린다. 순서는 git 출력 순서(정렬은 렌더러), 중복 없음.
 */
export function mergeFileLists(input: { listed: string; deleted: string; ignored: string | null; max: number }): { files: string[]; truncated: boolean } {
  const gone = new Set(input.deleted.split('\0'))
  const seen = new Set<string>()
  const files: string[] = []
  let truncated = false
  const add = (rel: string): void => {
    if (rel === '' || seen.has(rel) || gone.has(rel) || !isSafeRel(rel)) return
    if (files.length >= input.max) {
      truncated = true
      return
    }
    seen.add(rel)
    files.push(rel)
  }
  for (const rel of input.listed.split('\0')) add(rel)
  if (input.ignored !== null) for (const rel of input.ignored.split('\0')) if (!underExcludedDir(rel)) add(rel)
  return { files, truncated }
}
