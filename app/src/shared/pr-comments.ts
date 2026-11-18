// PR 리뷰 코멘트 (LIFE-811) — main 이 `gh api graphql` 읽기 query 하나로 받아 렌더러 「PR」 보기에 주는 값. 판독은 순수 함수(시험 대상).
//
// - 출처 셋(C3): 리뷰(본문 있는 것 — 본문이 빈 COMMENTED 리뷰는 줄 코멘트 묶음일 뿐이라 뺀다) · 줄 코멘트 스레드(해소·outdated·경로·줄·답글) · 일반 코멘트.
//   숨김(minimized)은 셋 모두 — 리뷰·리뷰 코멘트도 GraphQL `Minimizable` 이다(리뷰 r1 A4).
// - 상한(C4): 각 목록 최근 100건 · 스레드 답글 50건. `more` = totalCount − 받은 수 → 화면 「N건 더 — GitHub 에서 보기」.
// - 모르는 모양은 던지지 않고 null — main 이 「못 읽음」 오류 값으로 바꾼다.
import { isRecord, safeParse } from './json.js'
import type { PrErrorKind, PrInfo } from './pr-status.js'

export const PR_COMMENTS_LIMIT = 100
export const PR_THREAD_COMMENTS_LIMIT = 50

/**
 * 읽기 전용 query 하나(C2) — mutation 없음. 변수는 owner·name(문자열)·n(정수).
 * 목록은 `last` 로 최근 것부터 상한까지(오래된 것이 「더 있음」 으로 빠진다), 스레드 안 코멘트는 `first` 로 첫 코멘트 + 답글.
 */
export const PR_COMMENTS_QUERY =
  'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){' +
  `reviews(last:${PR_COMMENTS_LIMIT}){totalCount nodes{id author{login} state body submittedAt url isMinimized}} ` +
  `comments(last:${PR_COMMENTS_LIMIT}){totalCount nodes{id author{login} body createdAt url isMinimized}} ` +
  `reviewThreads(last:${PR_COMMENTS_LIMIT}){totalCount nodes{id isResolved isOutdated path line ` +
  `comments(first:${PR_THREAD_COMMENTS_LIMIT}){totalCount nodes{id author{login} body createdAt url isMinimized}}}}}}}`

export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

export const PR_REVIEW_STATE_LABEL: Record<PrReviewState, string> = {
  APPROVED: '승인',
  CHANGES_REQUESTED: '변경 요청',
  COMMENTED: '코멘트',
  DISMISSED: '기각',
  PENDING: '대기',
}

/** 작성자 — 지워진 계정은 GraphQL 이 author null 을 준다(GitHub 화면의 「ghost」). `minimized` = GitHub 에서 숨긴 코멘트(본문 대신 숨김 표시). */
export type PrComment = { id: string; author: string | null; body: string; at: string | null; url: string; minimized: boolean }
export type PrReview = PrComment & { state: PrReviewState }
export type PrThread = { id: string; path: string; line: number | null; resolved: boolean; outdated: boolean; comments: PrComment[]; more: number }

export type PrComments = {
  reviews: PrReview[]
  threads: PrThread[]
  comments: PrComment[]
  /** 상한 밖으로 빠진 수(받은 노드 기준 — 빈 본문 리뷰를 뺀 수가 아니다). */
  more: { reviews: number; threads: number; comments: number }
}

/** 한 worktree 의 PR 코멘트 조회 결과(C5) — 「PR 없음」 과 「못 읽음」 은 다른 값. */
export type PrCommentsResult =
  | { kind: 'comments'; pr: PrInfo; comments: PrComments }
  | { kind: 'none' }
  | { kind: 'error'; error: PrErrorKind; message: string }
  | { kind: 'rejected'; reason: string }

export const PR_COMMENTS_ERROR_LABEL: Record<PrErrorKind, string> = {
  no_gh: 'gh 가 없습니다 — GitHub CLI(gh)를 설치하면 PR 코멘트를 볼 수 있습니다.',
  unauthenticated: 'gh 로그인이 필요합니다 — 터미널에서 `gh auth login` 을 실행하세요.',
  not_github: '이 worktree 의 원격이 GitHub 이 아닙니다.',
  repo_unreadable: '레포를 읽을 수 없습니다 — gh 계정에 이 레포 접근 권한이 있는지 확인하세요.',
  failed: 'PR 코멘트를 읽지 못했습니다',
}

const PR_URL_PARTS = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)$/

/** `isPrUrl` 을 통과한 URL → GraphQL 변수. */
export function prUrlParts(url: string): { owner: string; name: string; number: number } | null {
  const match = PR_URL_PARTS.exec(url)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null
  return { owner: match[1], name: match[2], number: Number(match[3]) }
}

const authorOf = (value: unknown): string | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  return typeof value.login === 'string' ? value.login : undefined
}

const timeOf = (value: unknown): string | null | undefined => (value === null ? null : typeof value === 'string' ? value : undefined)

function readComment({ node, timeField }: { node: unknown; timeField: 'createdAt' | 'submittedAt' }): PrComment | null {
  if (!isRecord(node)) return null
  const author = authorOf(node.author)
  const at = timeOf(node[timeField])
  if (typeof node.id !== 'string' || author === undefined || at === undefined || typeof node.body !== 'string' || typeof node.url !== 'string' || typeof node.isMinimized !== 'boolean') return null
  return { id: node.id, author, body: node.body, at, url: node.url, minimized: node.isMinimized }
}

function readReviewState(value: unknown): PrReviewState | null {
  switch (value) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'COMMENTED':
    case 'DISMISSED':
    case 'PENDING':
      return value
    default:
      return null
  }
}

/** connection → 노드 목록 + 빠진 수. 노드 하나라도 못 읽으면 전체 null(모양이 다르면 「못 읽음」). */
function readConnection<T>({ value, read }: { value: unknown; read: (node: unknown) => T | null }): { items: T[]; more: number } | null {
  if (!isRecord(value) || typeof value.totalCount !== 'number' || !Array.isArray(value.nodes)) return null
  const items: T[] = []
  for (const node of value.nodes) {
    const item = read(node)
    if (item === null) return null
    items.push(item)
  }
  return { items, more: Math.max(0, value.totalCount - value.nodes.length) }
}

function readThread(node: unknown): PrThread | null {
  if (!isRecord(node) || typeof node.id !== 'string' || typeof node.path !== 'string' || typeof node.isResolved !== 'boolean' || typeof node.isOutdated !== 'boolean') return null
  const line = node.line === null ? null : typeof node.line === 'number' ? node.line : undefined
  if (line === undefined) return null
  const comments = readConnection({ value: node.comments, read: (comment) => readComment({ node: comment, timeField: 'createdAt' }) })
  if (comments === null) return null
  return { id: node.id, path: node.path, line, resolved: node.isResolved, outdated: node.isOutdated, comments: comments.items, more: comments.more }
}

const byTime = (a: { at: string | null }, b: { at: string | null }): number => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0)

/** `gh api graphql` 성공 출력 → 표시 모델(C3). 시간순(오래된 것 먼저). 모르는 모양이면 null. */
export function readPrComments(stdout: string): PrComments | null {
  const parsed = safeParse(stdout)
  if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.repository)) return null
  const pr = parsed.data.repository.pullRequest
  if (!isRecord(pr)) return null
  const reviews = readConnection({
    value: pr.reviews,
    read: (node): PrReview | null => {
      const comment = readComment({ node, timeField: 'submittedAt' })
      const state = isRecord(node) ? readReviewState(node.state) : null
      return comment === null || state === null ? null : { ...comment, state }
    },
  })
  const comments = readConnection({ value: pr.comments, read: (node) => readComment({ node, timeField: 'createdAt' }) })
  const threads = readConnection({ value: pr.reviewThreads, read: readThread })
  if (reviews === null || comments === null || threads === null) return null
  return {
    // 본문이 빈 COMMENTED 리뷰는 줄 코멘트를 묶어 낸 껍데기다 — 그 내용은 스레드에 있다(C3).
    reviews: reviews.items.filter((review) => !(review.state === 'COMMENTED' && review.body.trim() === '')).sort(byTime),
    threads: threads.items.sort((a, b) => byTime({ at: a.comments[0]?.at ?? null }, { at: b.comments[0]?.at ?? null })),
    comments: comments.items.sort(byTime),
    more: { reviews: reviews.more, threads: threads.more, comments: comments.more },
  }
}
