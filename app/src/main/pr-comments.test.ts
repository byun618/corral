// LIFE-811 C1·C2·C3·C4·C5(분류)·C8(main) — PR 리뷰 코멘트 출처(`gh api graphql`). 씨앗 = 실측 원문 cli/cli #14858(corral-specs LIFE-811
// raw/coordinator/a4-graphql-14858.json — 본문만 120자로 줄인 사본, 필드명 그대로) · 오류 원문 a5-graphql-errors.txt.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PR_COMMENTS_QUERY, readPrComments } from '../shared/pr-comments.js'
import type { GitStatusSummary, RepoRow, WorktreeRow } from '../shared/types.js'
import { PrStatus, prCommentsArgs, readCommentsOutcome, type GhOutcome, type GhRun } from './pr-status.js'

const SEED_14858 = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pr-comments-14858.json'), 'utf8')
const PR_14858 = { baseRefName: 'trunk', closedAt: '2026-10-29T17:00:00Z', createdAt: '2026-10-28T19:00:00Z', headRefName: 'bagtoad/private-fork-deletion-guard', isDraft: false, mergedAt: '2026-10-29T17:00:00Z', number: 14858, state: 'MERGED', url: 'https://github.com/cli/cli/pull/14858', isCrossRepository: false }
const PR_INFO = { number: 14858, state: 'merged' as const, url: 'https://github.com/cli/cli/pull/14858', headRefName: 'x', baseRefName: 'trunk', createdAt: null, mergedAt: null, closedAt: null }
// a5 원문 그대로.
const A5 = {
  unauth: { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n' },
  noPr: { code: 1, stderr: 'gh: Could not resolve to a PullRequest with the number of 999999.\n' },
  noRepo: { code: 1, stderr: "gh: Could not resolve to a Repository with the name 'byun618/does-not-exist-xyz'.\n" },
  badToken: { code: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' },
}
const exit = (code: number, stdout: string, stderr = ''): GhOutcome => ({ kind: 'exit', code, stdout, stderr })

const CLEAN: GitStatusSummary = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
const row = ({ path: p, branch }: { path: string; branch: string | null }): WorktreeRow => ({
  path: p, branch, head: null, repoName: 'cli', isLinked: true, openWorkspaceId: null, workspace: null, gitStatus: CLEAN, displayName: null, comment: null, parentPath: null, workLink: null,
})
const repos = (): RepoRow[] => [{ root: '/w', name: 'cli', error: null, worktrees: [row({ path: '/w/a', branch: 'refs/heads/bagtoad/private-fork-deletion-guard' }), row({ path: '/w/b', branch: 'other' }), row({ path: '/w/detached', branch: null })] }]

function fakeRun(answer: (args: string[]) => GhOutcome): GhRun & { calls: string[][] } {
  const calls: string[][] = []
  const run = async ({ args }: { gh: string; args: string[]; cwd: string }): Promise<GhOutcome> => {
    calls.push(args)
    return answer(args)
  }
  return Object.assign(run, { calls })
}

/** 브랜치 조회는 PR #14858 하나, 코멘트 query 는 `graphql` 결과. */
function harness({ graphql, list = exit(0, JSON.stringify([PR_14858])), now = () => 1000 }: { graphql: GhOutcome; list?: GhOutcome; now?: () => number }) {
  const run = fakeRun((args) => (args[0] === 'api' ? graphql : list))
  const status = new PrStatus({ repos, work: () => null, gh: () => '/opt/homebrew/bin/gh', run, now, cwdExists: () => true })
  return { status, run }
}

describe('C1 조회 대상', () => {
  it('모르는 경로·모양이 틀린 입력은 거절, gh 0회', async () => {
    const { status, run } = harness({ graphql: exit(0, SEED_14858) })
    expect(await status.comments({ path: '/elsewhere' })).toEqual({ kind: 'rejected', reason: '알려진 worktree 가 아닙니다' })
    expect(await status.comments({ path: 1 })).toEqual({ kind: 'rejected', reason: '요청 모양이 잘못됐습니다' })
    expect(await status.comments(null)).toEqual({ kind: 'rejected', reason: '요청 모양이 잘못됐습니다' })
    expect(run.calls).toEqual([])
    expect(status.calls).toBe(0)
  })
  it('경로 → 브랜치 조회(기존 `pr list` 인자) → 그 결과의 pr.url 에서 owner·repo·번호', async () => {
    const { status, run } = harness({ graphql: exit(0, SEED_14858) })
    const result = await status.comments({ path: '/w/a' })
    expect(result.kind).toBe('comments')
    expect(run.calls[0]).toEqual(['pr', 'list', '--head', 'bagtoad/private-fork-deletion-guard', '--state', 'all', '--json', 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,isCrossRepository', '--limit', '50'])
    expect(run.calls[1]?.slice(0, 8)).toEqual(['api', 'graphql', '-f', 'owner=cli', '-f', 'name=cli', '-F', 'n=14858'])
  })
  it('브랜치 없음(detached)·PR 없음은 「PR 없음」, 코멘트 query 를 띄우지 않는다', async () => {
    const { status, run } = harness({ graphql: exit(0, SEED_14858), list: exit(0, '[]') })
    expect(await status.comments({ path: '/w/detached' })).toEqual({ kind: 'none' })
    expect(await status.comments({ path: '/w/b' })).toEqual({ kind: 'none' })
    expect(run.calls.map((args) => args[0])).toEqual(['pr'])
  })
  it('브랜치 조회 실패는 그 오류 그대로(코멘트 query 없음)', async () => {
    const { status, run } = harness({ graphql: exit(0, SEED_14858), list: exit(A5.unauth.code, '', A5.unauth.stderr) })
    expect(await status.comments({ path: '/w/a' })).toMatchObject({ kind: 'error', error: 'unauthenticated' })
    expect(run.calls.map((args) => args[0])).toEqual(['pr'])
  })
})

describe('C2 읽기 전용', () => {
  it('gh 인자 배열 전체 — api graphql + 변수 셋 + query 하나', () => {
    expect(prCommentsArgs({ owner: 'cli', name: 'cli', number: 14858 })).toEqual([
      'api', 'graphql',
      '-f', 'owner=cli',
      '-f', 'name=cli',
      '-F', 'n=14858',
      '-f', 'query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviews(last:100){totalCount nodes{id author{login} state body submittedAt url}} comments(last:100){totalCount nodes{id author{login} body createdAt url isMinimized}} reviewThreads(last:100){totalCount nodes{id isResolved isOutdated path line comments(first:50){totalCount nodes{id author{login} body createdAt url}}}}}}}',
    ])
  })
  it('query 에 mutation 이 없고, 인자에 -X·--method 가 없다', () => {
    expect(PR_COMMENTS_QUERY).not.toMatch(/mutation/i)
    expect(PR_COMMENTS_QUERY.startsWith('query(')).toBe(true)
    const args = prCommentsArgs({ owner: 'o', name: 'n', number: 1 })
    expect(args.some((arg) => arg === '-X' || arg.startsWith('--method') || arg.startsWith('-X'))).toBe(false)
  })
})

describe('C3 세 출처 판독 (#14858 실측 원문)', () => {
  const read = readPrComments(SEED_14858)
  it('리뷰 — 본문이 빈 COMMENTED 리뷰는 뺀다(4 → 3), 시간순', () => {
    expect(read?.reviews.map((review) => [review.author, review.state, review.at])).toEqual([
      ['copilot-pull-request-reviewer', 'COMMENTED', '2026-10-28T19:34:27Z'],
      ['babakks', 'APPROVED', '2026-10-29T16:21:54Z'],
      ['9nzhc899wn-maker', 'COMMENTED', '2026-11-07T13:29:35Z'],
    ])
    expect(read?.reviews[1]?.url).toMatch(/^https:\/\/github\.com\/cli\/cli\/pull\/14858#pullrequestreview-/)
  })
  it('스레드 — 경로·줄·해소됨·outdated·첫 코멘트 + 답글', () => {
    expect(read?.threads).toHaveLength(1)
    const thread = read?.threads[0]
    expect(thread).toMatchObject({ path: 'acceptance/testdata/repo/repo-delete-private-forks.txtar', line: 15, resolved: true, outdated: false, more: 0 })
    expect(thread?.comments.map((comment) => comment.author)).toEqual(['copilot-pull-request-reviewer', 'BagToad'])
  })
  it('일반 코멘트 — 3건, minimized 표시', () => {
    expect(read?.comments.map((comment) => [comment.author, comment.minimized])).toEqual([
      ['Ufktarimarge', false],
      ['biggiebarker8-cloud', true],
      ['biggiebarker8-cloud', true],
    ])
    expect(read?.more).toEqual({ reviews: 0, threads: 0, comments: 0 })
  })
  it('줄 없음(outdated) · 지워진 작성자(author null) 를 읽는다', () => {
    const seed = JSON.parse(SEED_14858)
    const node = seed.data.repository.pullRequest.reviewThreads.nodes[0]
    node.line = null
    node.isOutdated = true
    node.comments.nodes[0].author = null
    const one = readPrComments(JSON.stringify(seed))
    expect(one?.threads[0]).toMatchObject({ line: null, outdated: true })
    expect(one?.threads[0]?.comments[0]?.author).toBeNull()
  })
  it('모르는 모양 = null(던지지 않는다) → 「못 읽음」 오류 값', () => {
    for (const bad of ['', 'not json', '{}', '{"data":{"repository":{"pullRequest":null}}}', '{"data":{"repository":{"pullRequest":{"reviews":{"totalCount":1,"nodes":[{"id":"x"}]}}}}}']) expect(readPrComments(bad)).toBeNull()
    const seed = JSON.parse(SEED_14858)
    seed.data.repository.pullRequest.reviews.nodes[0].state = 'SOMETHING_NEW'
    expect(readPrComments(JSON.stringify(seed))).toBeNull()
    expect(readCommentsOutcome({ outcome: exit(0, '{}'), pr: PR_INFO })).toEqual({ kind: 'error', error: 'failed', message: 'gh 출력 모양이 다릅니다' })
  })
})

describe('C4 상한·더 있음', () => {
  it('일반 155 · 받은 100 → 55건 더', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `IC_${index}`, author: { login: 'dependabot' }, body: `b${index}`, createdAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`, url: `https://github.com/cli/cli/pull/14963#issuecomment-${index}`, isMinimized: false }))
    const seed = { data: { repository: { pullRequest: { reviews: { totalCount: 0, nodes: [] }, comments: { totalCount: 155, nodes }, reviewThreads: { totalCount: 0, nodes: [] } } } } }
    const read = readPrComments(JSON.stringify(seed))
    expect(read?.comments).toHaveLength(100)
    expect(read?.more).toEqual({ reviews: 0, threads: 0, comments: 55 })
  })
  it('스레드 답글 — totalCount 52 · 받은 2 → 50건 더', () => {
    const seed = JSON.parse(SEED_14858)
    const thread = seed.data.repository.pullRequest.reviewThreads.nodes[0]
    thread.comments.totalCount = 52
    expect(readPrComments(JSON.stringify(seed))?.threads[0]?.more).toBe(50)
  })
  it('출력 상한 초과(overflow)는 오류 값', () => {
    expect(readCommentsOutcome({ outcome: { kind: 'overflow' }, pr: PR_INFO })).toEqual({ kind: 'error', error: 'failed', message: '출력이 너무 큽니다' })
  })
})

describe('C5 오류 분류 (a5 원문·종료 코드)', () => {
  const classify = (outcome: GhOutcome) => readCommentsOutcome({ outcome, pr: PR_INFO })
  it('미인증 exit 4 · 잘못된 토큰 401 · 레포 없음 · PR 없음 · 시간 초과 · gh 없음', () => {
    expect(classify(exit(A5.unauth.code, '', A5.unauth.stderr))).toMatchObject({ kind: 'error', error: 'unauthenticated' })
    expect(classify(exit(A5.badToken.code, '', A5.badToken.stderr))).toMatchObject({ kind: 'error', error: 'unauthenticated' })
    expect(classify(exit(A5.noRepo.code, '', A5.noRepo.stderr))).toMatchObject({ kind: 'error', error: 'repo_unreadable' })
    expect(classify(exit(A5.noPr.code, '', A5.noPr.stderr))).toEqual({ kind: 'none' })
    expect(classify({ kind: 'timeout' })).toEqual({ kind: 'error', error: 'failed', message: '시간 초과' })
    expect(classify({ kind: 'spawn_error', code: 'ENOENT', message: 'spawn gh ENOENT' })).toMatchObject({ kind: 'error', error: 'no_gh' })
  })
  it('gh 를 못 고르면 「gh 없음」, 실행 0회', async () => {
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ repos, work: () => null, gh: () => null, run, cwdExists: () => true })
    expect(await status.comments({ path: '/w/a' })).toMatchObject({ kind: 'error', error: 'no_gh' })
    expect(run.calls).toEqual([])
  })
})

describe('C8 main 캐시 — TTL 재열기 0회 · 새로고침은 TTL 무시', () => {
  it('같은 PR 재조회는 TTL 안에서 gh 0회, refresh 는 브랜치 조회·코멘트 query 각 1회 다시', async () => {
    let clock = 1000
    const { status, run } = harness({ graphql: exit(0, SEED_14858), now: () => clock })
    await status.comments({ path: '/w/a' })
    expect(run.calls.map((args) => args[0])).toEqual(['pr', 'api'])
    clock += 30_000
    await status.comments({ path: '/w/a' })
    expect(run.calls.map((args) => args[0])).toEqual(['pr', 'api'])
    await status.comments({ path: '/w/a', refresh: true })
    expect(run.calls.map((args) => args[0])).toEqual(['pr', 'api', 'pr', 'api'])
    clock += 61_000
    await status.comments({ path: '/w/a' })
    expect(run.calls.filter((args) => args[0] === 'api')).toHaveLength(3)
  })
})
