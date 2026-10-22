// worktree git 상태 (LIFE-357 C4) — `git status --porcelain=v2 --branch` 파싱 + TTL 캐시.
//
// herdr-studio 의 `server/src/workspace/status.ts` 를 참고했다(layout-reference-2026-09-13.md
// §herdr-studio 좌측 패널) — 캐시 TTL 4000ms·조회 타임아웃 8000ms 를 그대로 가져온다. 매 렌더·
// 폴링마다 git 을 실행하지 않기 위한 캐시다. 캐시 적중/실행은 각각 로그로 남긴다(C4 통과선 —
// "TTL 내 재요청이 git 프로세스를 재실행하지 않음을 로그로 증명").
//
// git-worktrees.ts 와 다른 관심사다: 저건 **구조**(worktree 목록 자체), 이건 한 worktree 의
// **작업트리 상태**(dirty·ahead/behind)다.
//
// 출처: C1~C8 은 경쟁 브랜치(`-claude`) 공통 채점 기준이라 이 파일은 그쪽 것을 그대로 가져왔다
// (02-kickoff-orca.md "재사용 가능하면 재사용 권장" — Orca 이식이 아니라 corral 자체 코드이므로
// MIT 고지 대상 아님).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatusSummary } from '../shared/types.js'
import { log } from './log.js'

const run = promisify(execFile)

export const GIT_STATUS_CACHE_MS = 4000
export const GIT_STATUS_TIMEOUT_MS = 8000
/** 주기 조회라 optional lock 을 잡지 않는다 — index 를 고쳐 쓰려고 `.git/index.lock` 을 잡으면 사람·출고 스크립트의 git 이 막힌다(LIFE-672). */
export const GIT_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch']

type CacheEntry = { value: GitStatusSummary; at: number }
const cache = new Map<string, CacheEntry>()

/** 커밋·체크아웃 등으로 상태가 바뀐 게 확실한 경로의 캐시를 지운다. 지금은 호출부가 없다 —
 * corral 은 아직 그런 이벤트를 안 받는다(주기 재조회로 대신한다, index.ts scheduleTree 폴링).
 * herdr-studio 의 `invalidateGitStatus` 자리를 남겨 둔다. */
export function invalidateGitStatus(worktreePath: string): void {
  cache.delete(worktreePath)
}

export function clearGitStatusCacheForTest(): void {
  cache.clear()
}

/** 캐시를 끼고 worktree 하나의 상태를 읽는다. TTL 안이면 git 을 안 띄운다. */
export async function getGitStatus(worktreePath: string): Promise<GitStatusSummary> {
  const now = Date.now()
  const cached = cache.get(worktreePath)
  if (cached !== undefined && now - cached.at < GIT_STATUS_CACHE_MS) {
    log('git_status.cache_hit', { path: worktreePath, ageMs: now - cached.at })
    return cached.value
  }
  log('git_status.run', { path: worktreePath })
  const value = await computeGitStatus(worktreePath)
  cache.set(worktreePath, { value, at: Date.now() })
  return value
}

async function computeGitStatus(worktreePath: string): Promise<GitStatusSummary> {
  try {
    const { stdout } = await run('git', ['-C', worktreePath, ...GIT_STATUS_ARGS], {
      timeout: GIT_STATUS_TIMEOUT_MS,
    })
    return parseGitStatus(stdout)
  } catch (error) {
    return {
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
      error: String(error),
    }
  }
}

/**
 * `git status --porcelain=v2 --branch` 출력 파서. 순수 함수 — 유닛 테스트 가능(Orca 의
 * `clampSidebarResizeWidth` 류 분리 방침과 같은 결).
 *
 * v2 모양: 헤더는 `# branch.head <name>`·`# branch.upstream <name>`·`# branch.ab +A -B`.
 * 항목 줄은 `1 <XY> ...`(보통 변경)·`2 <XY> ...`(rename/copy)·`u <XY> ...`(unmerged)·
 * `? <path>`(untracked). XY 의 `.` 은 "그 축은 안 바뀜" — staged 는 X, unstaged 는 Y.
 */
export function parseGitStatus(stdout: string): GitStatusSummary {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      branch = head === '(detached)' ? null : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (match !== null && match[1] !== undefined && match[2] !== undefined) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    const parts = line.split(' ')
    const tag = parts[0]
    if (tag === '1' || tag === '2') {
      const xy = parts[1] ?? ''
      if (xy[0] !== undefined && xy[0] !== '.') staged += 1
      if (xy[1] !== undefined && xy[1] !== '.') unstaged += 1
    } else if (tag === 'u') {
      conflicted += 1
    } else if (tag === '?') {
      untracked += 1
    }
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    dirty: staged + unstaged + untracked + conflicted > 0,
    error: null,
  }
}
