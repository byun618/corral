// PR 상태 (LIFE-624) — main 이 `gh` CLI 로 읽어 렌더러에 주는 값. 판독·분류는 `main/pr-status.ts`.
//
// - 「PR 없음」(`none`)과 「못 읽음」(`error`)은 다른 값이다 — 빈 칩이 「없다」 와 「못 본다」 를 가르지 못하게(00-analysis F3).
// - `rejected` = IPC 경계가 받지 않은 입력(모르는 worktree 경로 · GitHub PR URL 이 아님). gh 를 부르지 않았다.

export type PrState = 'draft' | 'open' | 'merged' | 'closed'

export type PrInfo = {
  number: number
  state: PrState
  url: string
  headRefName: string | null
  baseRefName: string | null
  createdAt: string | null
  mergedAt: string | null
  closedAt: string | null
}

/** gh 실패 분류 — `not_github` 는 그 레포에 원래 PR 이 없는 경우라 화면에서 소리 내지 않는다. */
export type PrErrorKind = 'no_gh' | 'unauthenticated' | 'not_github' | 'repo_unreadable' | 'failed'

export type PrLookup =
  | { kind: 'pr'; pr: PrInfo }
  | { kind: 'none' }
  | { kind: 'error'; error: PrErrorKind; message: string }
  | { kind: 'rejected'; reason: string }

/** 브랜치 조회 — worktree 경로마다 결과. `recorded` = 이번 조회가 활동에 새로 남긴 줄 수(상세 활동을 다시 읽을지). */
export type PrBranchesResult = { lookups: Record<string, PrLookup>; recorded: number }

/** 작업 하나의 열린 PR 재조회(URL) — 사라진 worktree 의 머지·닫힘을 잡는다. */
export type PrItemRefreshResult = { ok: true; checked: number; recorded: number } | { ok: false; reason: string }

export const PR_STATE_LABEL: Record<PrState, string> = { draft: '초안', open: '열림', merged: '머지됨', closed: '닫힘' }

export const PR_ERROR_LABEL: Record<PrErrorKind, string> = {
  no_gh: 'gh 가 없습니다',
  unauthenticated: 'gh 로그인이 필요합니다',
  not_github: 'GitHub 원격이 아닙니다',
  repo_unreadable: '레포를 읽을 수 없습니다',
  failed: 'PR 상태를 읽지 못했습니다',
}

/** gh 가 받는 PR URL 꼴 — 이 밖의 값은 gh 에 넘기지 않는다. */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/

export function isPrUrl(value: unknown): value is string {
  return typeof value === 'string' && PR_URL_PATTERN.test(value)
}
