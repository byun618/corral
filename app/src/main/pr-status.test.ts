// LIFE-624 C1·C2·C3·C4·C5·C8·C9·C10·C11(main) — PR 상태 출처(`gh`). 신호는 실측 원문(corral-specs LIFE-624 raw/coordinator a1·a2) 그대로.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitStatusSummary, RepoRow, WorktreeRow } from '../shared/types.js'
import { readWorkActivityQuery, type WorkActivityChange, type WorkActivityRecord } from '../shared/work.js'
import type { WorktreeWorkLink } from '../shared/work-link.js'
import { MemoryActivity, WorkActivityStore, type ActivityPort } from './work/activity-store.js'
import { mockSourceEntry, seedMockDemoState } from './work/mock-source.js'
import { workHarness } from './work/test-kit.js'
import { classifyFailure, makeRunGh, pickPr, PR_ERROR_TTL_MS, PR_TTL_MS, PrStatus, readOutput, readPr, resolveGh, type GhOutcome, type GhRun, type PrWorkPort } from './pr-status.js'

let base = ''
beforeAll(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l624-'))) })
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }) })

// --- 실측 씨앗 ---
// a1: 간접 머지된 작업 PR — MERGED 인데 closedAt 도 있다.
const A1_MERGED = { baseRefName: 'main', closedAt: '2026-10-30T09:18:24Z', createdAt: '2026-10-30T04:32:18Z', headRefName: 'LIFE-683-source-control', isDraft: false, mergedAt: '2026-10-30T09:18:24Z', number: 30, state: 'MERGED', url: 'https://github.com/byun618/corral/pull/30' }
const A2 = {
  unauth: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
  noRemote: 'no git remotes found\n',
  notGithub: 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n',
  noRepo: "GraphQL: Could not resolve to a Repository with the name 'byun618/does-not-exist-xyz'. (repository)\n",
}
const exit = (code: number, stdout: string, stderr = ''): GhOutcome => ({ kind: 'exit', code, stdout, stderr })

// --- 트리·작업 가짜 ---
const link = (key = 'LIFE-683'): WorktreeWorkLink => ({ mode: 'auto', sourceId: 'la', connectionId: 'c1', key, itemId: null, connected: true })
const CLEAN: GitStatusSummary = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
const row = ({ path: p, branch, workLink = null }: { path: string; branch: string | null; workLink?: WorktreeWorkLink | null }): WorktreeRow => ({
  path: p, branch, head: null, repoName: 'corral', isLinked: true, openWorkspaceId: null, workspace: null, gitStatus: CLEAN, displayName: null, comment: null, parentPath: null, workLink,
})
const repo = (worktrees: WorktreeRow[]): RepoRow => ({ root: '/r', name: 'corral', error: null, worktrees })

function workOf(activity: ActivityPort): PrWorkPort & { records: () => WorkActivityRecord[] } {
  let id = 0
  const all: WorkActivityRecord[] = []
  return {
    recordEvent: ({ connectionId, itemId, itemKey, eventKey, change, at }) => {
      id += 1
      const record: WorkActivityRecord = { id: `r${id}`, connectionId, itemId: itemId ?? '', itemKey, at: at ?? 0, writeId: eventKey, eventKey, change }
      const added = activity.append(record)
      if (added) all.push(record)
      return added
    },
    activity: (input) => {
      const query = readWorkActivityQuery(input)
      return query === null ? { ok: false, error: { kind: 'invalid_request', message: 'bad', status: null } } : { ok: true, records: activity.list(query) }
    },
    records: () => all,
  }
}

/** 가짜 실행기 — 부른 인자를 남기고 정해진 결과를 준다. */
function fakeRun(answer: (input: { args: string[]; cwd: string }) => GhOutcome): GhRun & { calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = []
  const run = async (input: { gh: string; args: string[]; cwd: string }): Promise<GhOutcome> => {
    calls.push({ args: input.args, cwd: input.cwd })
    return answer(input)
  }
  return Object.assign(run, { calls })
}

describe('C1 gh 고르기', () => {
  it('설치본 PATH(/usr/bin:/bin:/usr/sbin:/sbin)에서도 /opt/homebrew/bin/gh 를 고른다', () => {
    const seen: string[] = []
    const picked = resolveGh({ pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin', isExecutable: (file) => (seen.push(file), file === '/opt/homebrew/bin/gh') })
    expect(picked).toBe('/opt/homebrew/bin/gh')
    expect(seen).toEqual(['/usr/bin/gh', '/bin/gh', '/usr/sbin/gh', '/sbin/gh', '/opt/homebrew/bin/gh'])
  })
  it('PATH 의 gh 가 먼저 · 상대 항목은 보지 않는다 · /usr/local/bin 도 본다', () => {
    expect(resolveGh({ pathEnv: '.:bin:/x/bin', isExecutable: (file) => file === '/x/bin/gh' || file === 'bin/gh' || file === 'gh' })).toBe('/x/bin/gh')
    expect(resolveGh({ pathEnv: '/usr/bin', isExecutable: (file) => file === '/usr/local/bin/gh' })).toBe('/usr/local/bin/gh')
  })
  it('알려진 worktree 아래 심은 gh 는 고르지 않는다(실제 파일)', () => {
    const wt = path.join(base, 'wt-planted')
    const bin = path.join(wt, 'tools', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
    const safe = path.join(base, 'safe-bin')
    fs.mkdirSync(safe, { recursive: true })
    fs.writeFileSync(path.join(safe, 'gh'), '#!/bin/sh\n', { mode: 0o755 })
    // 양성 대조 — 루트를 모르면 심은 gh 가 먼저 뽑힌다.
    expect(resolveGh({ pathEnv: `${bin}:${safe}`, roots: [] })).toBe(path.join(bin, 'gh'))
    expect(resolveGh({ pathEnv: `${bin}:${safe}`, roots: [wt] })).toBe(path.join(safe, 'gh'))
    // 심링크 폴더로 감싸도 실경로로 가린다.
    const linked = path.join(base, 'linked-bin')
    fs.symlinkSync(bin, linked)
    expect(resolveGh({ pathEnv: `${linked}:${safe}`, roots: [wt] })).toBe(path.join(safe, 'gh'))
  })
  it('아무 데도 없으면 null → 「gh 없음」 분류, gh 를 띄우지 않는다', async () => {
    expect(resolveGh({ pathEnv: '/usr/bin:/bin', isExecutable: () => false })).toBeNull()
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'refs/heads/a' })])], work: () => null, gh: () => null, run })
    const result = await status.branches({ paths: ['/w/a'] })
    expect(result.lookups['/w/a']).toMatchObject({ kind: 'error', error: 'no_gh' })
    expect(run.calls).toHaveLength(0)
  })
})

describe('C2 실행 안전(실제 execFile)', () => {
  const fakeGh = (body: string): string => {
    const dir = fs.mkdtempSync(path.join(base, 'gh-'))
    const file = path.join(dir, 'gh')
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }
  it('브랜치 이름(; 공백 $() 백틱)은 셸 해석 없이 인자 하나로 간다', async () => {
    const out = path.join(base, 'argv.txt')
    const marker = path.join(base, 'pwned')
    const gh = fakeGh(`for a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\necho '[]'`)
    const wt = path.join(base, 'wt-argv')
    fs.mkdirSync(wt, { recursive: true })
    const branch = `x; touch ${marker} $(touch ${marker}) \`touch ${marker}\` a b`
    const status = new PrStatus({ repos: () => [repo([row({ path: wt, branch: `refs/heads/${branch}` })])], work: () => null, gh: () => gh, run: makeRunGh() })
    const result = await status.branches({ paths: [wt] })
    expect(result.lookups[wt]).toEqual({ kind: 'none' })
    const argv = fs.readFileSync(out, 'utf8').split('\n').slice(0, -1)
    expect(argv).toEqual(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,isCrossRepository', '--limit', '50'])
    expect(fs.existsSync(marker)).toBe(false)
  })
  it('시간 초과 · 출력 상한 · 없는 실행 파일 — 던지지 않고 분류 값', async () => {
    const slow = fakeGh('sleep 5')
    expect(await makeRunGh({ timeoutMs: 200 })({ gh: slow, args: [], cwd: base })).toEqual({ kind: 'timeout' })
    const loud = fakeGh('head -c 5000 /dev/zero')
    expect(await makeRunGh({ maxBytes: 100 })({ gh: loud, args: [], cwd: base })).toEqual({ kind: 'overflow' })
    const missing = await makeRunGh()({ gh: path.join(base, 'nope', 'gh'), args: [], cwd: base })
    expect(missing).toMatchObject({ kind: 'spawn_error', code: 'ENOENT' })
    expect(classifyFailure(missing)).toMatchObject({ kind: 'error', error: 'no_gh' })
    const code4 = await makeRunGh()({ gh: fakeGh(`printf '%s' "${A2.unauth.split('\n')[0]}" >&2; exit 4`), args: [], cwd: base })
    expect(code4).toMatchObject({ kind: 'exit', code: 4 })
  })
})

describe('C3 오류 분류(실측 원문)', () => {
  it('여섯 분류가 서로 다른 값이고, PR 없음은 오류가 아니다', () => {
    const none = readOutput({ stdout: '[]\n', many: true })
    expect(none).toEqual({ kind: 'none' })
    expect(classifyFailure({ kind: 'spawn_error', code: 'ENOENT', message: 'spawn gh ENOENT' })).toMatchObject({ kind: 'error', error: 'no_gh' })
    expect(classifyFailure(exit(4, '', A2.unauth))).toMatchObject({ kind: 'error', error: 'unauthenticated', message: 'To get started with GitHub CLI, please run:  gh auth login' })
    expect(classifyFailure(exit(1, '', A2.noRemote))).toMatchObject({ kind: 'error', error: 'not_github' })
    expect(classifyFailure(exit(1, '', A2.notGithub))).toMatchObject({ kind: 'error', error: 'not_github' })
    expect(classifyFailure(exit(1, '', A2.noRepo))).toMatchObject({ kind: 'error', error: 'repo_unreadable' })
    expect(classifyFailure({ kind: 'timeout' })).toMatchObject({ kind: 'error', error: 'failed', message: '시간 초과' })
    expect(classifyFailure(exit(1, '', 'HTTP 502: Bad Gateway\n'))).toMatchObject({ kind: 'error', error: 'failed', message: 'HTTP 502: Bad Gateway' })
    expect(readOutput({ stdout: 'not json', many: true })).toMatchObject({ kind: 'error', error: 'failed' })
  })
  it('미인증 신호는 종료 코드 4 로 가른다(문구가 바뀌어도)', () => {
    expect(classifyFailure(exit(4, '', 'something else'))).toMatchObject({ error: 'unauthenticated' })
    expect(classifyFailure(exit(1, '', A2.unauth))).toMatchObject({ error: 'failed' })
  })
})

describe('C4 상태 매핑·선택', () => {
  it('draft · OPEN · MERGED(+closedAt) · CLOSED', () => {
    expect(readPr(A1_MERGED)?.state).toBe('merged')
    expect(readPr({ ...A1_MERGED, state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null })?.state).toBe('draft')
    expect(readPr({ ...A1_MERGED, state: 'OPEN', mergedAt: null, closedAt: null })?.state).toBe('open')
    expect(readPr({ ...A1_MERGED, state: 'CLOSED', mergedAt: null })?.state).toBe('closed')
    expect(readPr({ ...A1_MERGED, state: 'WEIRD' })).toBeNull()
    expect(readPr({ ...A1_MERGED, url: 'https://evil.example/pull/30' })).toBeNull()
  })
  it('여럿이면 열린 것 우선, 없으면 가장 최근 createdAt', () => {
    const at = (n: number, state: string, createdAt: string): unknown => ({ ...A1_MERGED, number: n, state, createdAt, url: `https://github.com/byun618/corral/pull/${n}` })
    const list = (rows: unknown[]) => rows.flatMap((value) => { const pr = readPr(value); return pr === null ? [] : [pr] })
    expect(pickPr(list([at(1, 'CLOSED', '2026-10-01T00:00:00Z'), at(2, 'OPEN', '2026-09-01T00:00:00Z'), at(3, 'MERGED', '2026-10-02T00:00:00Z')]))?.number).toBe(2)
    expect(pickPr(list([at(1, 'CLOSED', '2026-10-01T00:00:00Z'), at(3, 'MERGED', '2026-10-02T00:00:00Z')]))?.number).toBe(3)
    expect(pickPr([])).toBeNull()
  })
})

describe('C5 IPC 경계', () => {
  it('모르는 worktree 경로는 거절, gh 를 부르지 않는다', async () => {
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run })
    const result = await status.branches({ paths: ['/w/other', '/w/a/../a', '/etc'] })
    expect(Object.values(result.lookups).map((value) => value.kind)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(run.calls).toHaveLength(0)
    expect(await status.branches(null)).toEqual({ lookups: {}, recorded: 0 })
    expect(await status.branches({ paths: 'nope' })).toEqual({ lookups: {}, recorded: 0 })
    expect(run.calls).toHaveLength(0)
  })
  it('GitHub PR URL 꼴이 아니면 거절, gh 를 부르지 않는다', async () => {
    const run = fakeRun(() => exit(0, JSON.stringify(A1_MERGED)))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [], work: () => null, gh: () => '/fake/gh', run })
    for (const bad of ['http://github.com/a/b/pull/1', 'https://gitlab.com/a/b/pull/1', 'https://github.com/a/b/pull/1;rm', 'https://github.com/a/b/pull/1 --web', '--help', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/0', 42, null]) {
      expect(await status.byUrl(bad)).toMatchObject({ kind: 'rejected' })
    }
    expect(run.calls).toHaveLength(0)
    expect(await status.byUrl('https://github.com/byun618/corral/pull/30')).toMatchObject({ kind: 'pr' })
    expect(run.calls).toEqual([{ args: ['pr', 'view', 'https://github.com/byun618/corral/pull/30', '--json', 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,isCrossRepository'], cwd: '/' }])
  })
  it('detached(브랜치 없음)는 PR 없음, gh 를 부르지 않는다', async () => {
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/d', branch: null })])], work: () => null, gh: () => '/fake/gh', run })
    expect((await status.branches({ paths: ['/w/d'] })).lookups['/w/d']).toEqual({ kind: 'none' })
    expect(run.calls).toHaveLength(0)
  })
})

describe('C8 활동 PR 줄', () => {
  it('머지된 PR 을 처음 보면 열림·머지 두 줄(PR 의 시각) — 세 번 관측해도 줄 수 불변', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const run = fakeRun(() => exit(0, JSON.stringify([A1_MERGED])))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/683', branch: 'refs/heads/LIFE-683-source-control', workLink: link() })])], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
    const first = await status.branches({ paths: ['/w/683'] })
    expect(first.recorded).toBe(2)
    await status.branches({ paths: ['/w/683'] })
    const third = await status.branches({ paths: ['/w/683'] })
    expect(third.recorded).toBe(0)
    expect(run.calls).toHaveLength(3)
    const rows = activity.list({ connectionId: 'c1', itemId: 'x', itemKey: 'LIFE-683' })
    expect(rows.map((record) => record.change.field === 'run' && record.change.event === 'pr' ? record.change.action : '?')).toEqual(['open', 'merged'])
    expect(rows.map((record) => record.at)).toEqual([Date.parse('2026-10-30T04:32:18Z'), Date.parse('2026-10-30T09:18:24Z')])
    expect(rows[0]?.change).toEqual({ field: 'run', event: 'pr', action: 'open', worktree: '/w/683', number: 30, url: A1_MERGED.url, branch: 'LIFE-683-source-control', base: 'main', draft: false })
  })
  it('링크 없는·연결 끊긴 worktree 는 남기지 않는다(칩은 그대로)', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const run = fakeRun(() => exit(0, JSON.stringify([A1_MERGED])))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' }), row({ path: '/w/b', branch: 'b', workLink: { ...link(), connected: false } })])], work: () => work, gh: () => '/fake/gh', run })
    const result = await status.branches({ paths: ['/w/a', '/w/b'] })
    expect(result.recorded).toBe(0)
    expect(result.lookups['/w/a']).toMatchObject({ kind: 'pr' })
    expect(activity.records).toHaveLength(0)
  })
  it('재시작(파일 저장소 다시 읽기)에도 중복 0', async () => {
    const dir = fs.mkdtempSync(path.join(base, 'restart-'))
    const observe = async (): Promise<number> => {
      const store = new WorkActivityStore(dir)
      store.load()
      const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/683', branch: 'LIFE-683-source-control', workLink: link() })])], work: () => workOf(store), gh: () => '/fake/gh', run: fakeRun(() => exit(0, JSON.stringify([A1_MERGED]))) })
      return (await status.branches({ paths: ['/w/683'] })).recorded
    }
    expect(await observe()).toBe(2)
    expect(await observe()).toBe(0)
    const reread = new WorkActivityStore(dir)
    reread.load()
    expect(reread.list({ connectionId: 'c1', itemId: 'x', itemKey: 'LIFE-683' })).toHaveLength(2)
  })
})

describe('C9 영속 형식 호환', () => {
  it('base 형식 파일을 그대로 읽고(손실 0), 새 PR 줄도 읽고, 모르는 모양은 버린다', () => {
    const dir = fs.mkdtempSync(path.join(base, 'compat-'))
    const baseRecords = [
      { id: 'a1', connectionId: 'c1', itemId: 'i1', at: 1, writeId: 'w1', change: { field: 'status', statusKey: 'done', statusLabel: '완료', resolution: 'completed' } },
      { id: 'a2', connectionId: 'c1', itemId: 'i1', at: 2, writeId: 'w2', change: { field: 'body', lines: 3 } },
      { id: 'a3', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 3, writeId: 'run:start:x', eventKey: 'run:start:x', change: { field: 'run', event: 'start', worktree: '/w', branch: 'LIFE-1-x', agent: 'claude', model: null } },
      { id: 'a4', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 4, writeId: 'run:auto:x', eventKey: 'run:auto:x', change: { field: 'run', event: 'auto_link', worktree: '/w', branch: null } },
      { id: 'a5', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 5, writeId: 'agent:t:x', eventKey: 'agent:t:x', change: { field: 'agent', event: 'result', agent: 'claude', worktree: '/w', outcome: 'completed', detail: null, filesChanged: 2 } },
      { id: 'a6', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 6, writeId: 'run:srcfail:x', eventKey: 'run:srcfail:x', change: { field: 'run', event: 'source_link_failed', worktree: '/w', message: null } },
    ]
    const file = path.join(dir, 'work-activity.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: baseRecords, seen: [['run:start:x', 'c1']] }))
    const store = new WorkActivityStore(dir)
    store.load()
    expect(store.list({ connectionId: 'c1', itemId: 'i1', itemKey: 'LIFE-1' })).toEqual(baseRecords)
    const pr = { id: 'p1', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 7, writeId: 'run:pr:a', eventKey: 'run:pr:a', change: { field: 'run', event: 'pr', action: 'merged', worktree: '/w', number: 30, url: A1_MERGED.url, branch: 'b', base: 'main', draft: false } }
    const unknown = [
      { ...pr, id: 'u1', change: { ...pr.change, action: 'reopened' } },
      { ...pr, id: 'u2', change: { ...pr.change, number: '30' } },
      { ...pr, id: 'u3', change: { ...pr.change, draft: undefined } },
      { ...pr, id: 'u4', change: { field: 'run', event: 'pr_merged', worktree: '/w' } },
    ]
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: [...baseRecords, pr, ...unknown] }))
    const next = new WorkActivityStore(dir)
    next.load()
    expect(next.list({ connectionId: 'c1', itemId: 'i1', itemKey: 'LIFE-1' }).map((record) => record.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'p1'])
  })
})

describe('C10 사라진 worktree 의 머지', () => {
  it('열림만 기록된 PR 은 URL 로 다시 보고 머지 줄을 남긴다 — 다시 열어도 1', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    work.recordEvent({ connectionId: 'c1', itemId: null, itemKey: 'LIFE-683', eventKey: `run:pr:c1:LIFE-683:${A1_MERGED.url}:open`, change: { field: 'run', event: 'pr', action: 'open', worktree: '/gone/683', number: 30, url: A1_MERGED.url, branch: 'LIFE-683-source-control', base: 'main', draft: false }, at: 1 })
    const run = fakeRun(() => exit(0, JSON.stringify(A1_MERGED)))
    // 트리는 비었다 — worktree 가 지워진 뒤.
    const status = new PrStatus({ cwdExists: () => true, repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
    const query = { connectionId: 'c1', itemId: 'item-683', itemKey: 'LIFE-683' }
    expect(await status.refreshItem(query)).toEqual({ ok: true, checked: 1, recorded: 1 })
    expect(run.calls.map((call) => call.args.slice(0, 3))).toEqual([['pr', 'view', A1_MERGED.url]])
    expect(await status.refreshItem(query)).toEqual({ ok: true, checked: 0, recorded: 0 })
    const merged = activity.list(query).filter((record) => record.change.field === 'run' && record.change.event === 'pr' && record.change.action === 'merged')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.at).toBe(Date.parse(A1_MERGED.mergedAt))
    expect(merged[0]?.change).toMatchObject({ worktree: '/gone/683' })
    expect(run.calls).toHaveLength(1)
  })
  it('아직 열려 있으면 줄 0, 다음에 다시 본다 · 저장된 URL 이 꼴이 아니면 gh 0', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const open: Extract<WorkActivityChange, { event: 'pr' }> = { field: 'run', event: 'pr', action: 'open', worktree: '/gone', number: 5, url: 'https://github.com/o/r/pull/5', branch: 'b', base: 'main', draft: false }
    work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: 'k1', change: open })
    work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: 'k2', change: { ...open, number: 6, url: 'https://github.com/o/r/pull/6 --web' } })
    const run = fakeRun(() => exit(0, JSON.stringify({ ...A1_MERGED, number: 5, url: open.url, state: 'OPEN', mergedAt: null, closedAt: null })))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
    expect(await status.refreshItem({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1' })).toEqual({ ok: true, checked: 2, recorded: 0 })
    expect(run.calls.map((call) => call.args[2])).toEqual([open.url])
    expect(await status.refreshItem({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1' })).toMatchObject({ checked: 2 })
    expect(await status.refreshItem({ bad: true })).toMatchObject({ ok: false })
  })
})

describe('C11 비용(main) — TTL 캐시 · 진행 중 합치기 · 동시 실행 상한', () => {
  it('TTL 안 재조회는 gh 0 회, 지나면 다시', async () => {
    let now = 1_000
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run, now: () => now, ttlMs: 60_000 })
    await status.branches({ paths: ['/w/a'] })
    now += 59_000
    await status.branches({ paths: ['/w/a'] })
    expect(run.calls).toHaveLength(1)
    now += 2_000
    await status.branches({ paths: ['/w/a'] })
    expect(run.calls).toHaveLength(2)
    expect(status.calls).toBe(2)
  })
  it('브랜치가 바뀌면 다른 키 — TTL 안이어도 다시 묻는다', async () => {
    let branch = 'a'
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch })])], work: () => null, gh: () => '/fake/gh', run })
    await status.branches({ paths: ['/w/a'] })
    branch = 'b'
    await status.branches({ paths: ['/w/a'] })
    expect(run.calls.map((call) => call.args[3])).toEqual(['a', 'b'])
  })
  it('상한을 넘는 요청은 줄 선다 — 동시에 도는 gh 는 상한 이하, 진행 중인 같은 키는 하나로', async () => {
    let running = 0
    let peak = 0
    const releases: (() => void)[] = []
    const run: GhRun = () => new Promise((resolve) => {
      running += 1
      peak = Math.max(peak, running)
      releases.push(() => { running -= 1; resolve(exit(0, '[]')) })
    })
    const paths = ['/w/1', '/w/2', '/w/3', '/w/4', '/w/5']
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo(paths.map((p) => row({ path: p, branch: p.slice(3) })))], work: () => null, gh: () => '/fake/gh', run, maxConcurrent: 2 })
    const pending = Promise.all([status.branches({ paths }), status.branches({ paths: ['/w/1'] })])
    for (let round = 0; round < 10; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      releases.shift()?.()
    }
    const [all, again] = await pending
    expect(peak).toBe(2)
    expect(status.calls).toBe(5)
    expect(Object.values(all.lookups).every((value) => value.kind === 'none')).toBe(true)
    expect(again.lookups['/w/1']).toEqual({ kind: 'none' })
  })
})

// --- 리뷰 r1 수정(fix1) ---
// e1 실측(corral-specs raw/coordinator/e1-fork-head-probe.txt): `gh pr list --repo cli/cli --head trunk` → 5건 전부 isCrossRepository true.
const E1_FORKS = [
  { headRefName: 'trunk', headRepositoryOwner: { id: 'U_kgDOFFG9yA', login: 'arletteramosg26-ux' }, isCrossRepository: true, number: 14872, state: 'CLOSED' },
  { headRefName: 'trunk', headRepositoryOwner: { id: 'U_kgDOBxWfsw', name: 'rakcom', login: 'HIHACK1911' }, isCrossRepository: true, number: 14481, state: 'CLOSED' },
  { headRefName: 'trunk', headRepositoryOwner: { id: 'O_kgDOE67wKg', login: 'deploy-velcat' }, isCrossRepository: true, number: 14471, state: 'CLOSED' },
  { headRefName: 'trunk', headRepositoryOwner: { id: 'MDQ6VXNlcjQxNzMzODc=', name: 'Jesse Houwing', login: 'jessehouwing' }, isCrossRepository: true, number: 14310, state: 'CLOSED' },
  { headRefName: 'trunk', headRepositoryOwner: { id: 'U_kgDOEUIGWA', login: 'mirsalimorteza4-hub' }, isCrossRepository: true, number: 14218, state: 'CLOSED' },
].map((row) => ({ ...row, url: `https://github.com/cli/cli/pull/${row.number}`, isDraft: false, baseRefName: 'trunk', createdAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: '2026-01-02T00:00:00Z' }))

describe('fix1 e1 포크 PR 은 붙이지 않는다(C4 선택)', () => {
  it('실측 모양 — cross 5건뿐이면 PR 없음', () => {
    expect(readOutput({ stdout: JSON.stringify(E1_FORKS), many: true })).toEqual({ kind: 'none' })
  })
  it('같은 레포 1건 + cross 여럿 → 같은 레포 것(cross 가 더 최근·열림이어도)', () => {
    const own = { ...A1_MERGED, isCrossRepository: false }
    const openFork = { ...E1_FORKS[0], state: 'OPEN', closedAt: null, createdAt: '2026-10-31T00:00:00Z' }
    const result = readOutput({ stdout: JSON.stringify([openFork, ...E1_FORKS, own]), many: true })
    expect(result).toMatchObject({ kind: 'pr', pr: { number: 30, state: 'merged' } })
  })
  it('branches() 경로에서도 포크 PR 은 칩·활동 0', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/t', branch: 'trunk', workLink: link('LIFE-9') })])], work: () => work, gh: () => '/fake/gh', run: fakeRun(() => exit(0, JSON.stringify(E1_FORKS))) })
    const result = await status.branches({ paths: ['/w/t'] })
    expect(result).toEqual({ lookups: { '/w/t': { kind: 'none' } }, recorded: 0 })
    expect(activity.records).toHaveLength(0)
  })
})

describe('fix1 c1-1 없는 cwd 는 「gh 없음」 이 아니다', () => {
  it('실제 stat — 없는 worktree 경로면 failed(경로 없음), gh 를 띄우지 않는다', async () => {
    const run = fakeRun(() => exit(0, '[]'))
    const gone = path.join(base, 'gone-worktree')
    const status = new PrStatus({ repos: () => [repo([row({ path: gone, branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run })
    const result = await status.branches({ paths: [gone] })
    expect(result.lookups[gone]).toEqual({ kind: 'error', error: 'failed', message: 'worktree 경로가 없습니다' })
    expect(run.calls).toHaveLength(0)
  })
})

describe('fix1 c1-2 닫힘 기록 뒤 다시 열려 머지된 PR', () => {
  it('closed 기록 → MERGED 응답 → 머지 줄 1, 다시 열어도 1', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const base0: Extract<WorkActivityChange, { event: 'pr' }> = { field: 'run', event: 'pr', action: 'open', worktree: '/gone', number: 30, url: A1_MERGED.url, branch: 'b', base: 'main', draft: false }
    work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: `run:pr:c1:K-1:${A1_MERGED.url}:open`, change: base0 })
    work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: `run:pr:c1:K-1:${A1_MERGED.url}:closed`, change: { ...base0, action: 'closed' } })
    const run = fakeRun(() => exit(0, JSON.stringify(A1_MERGED)))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0, errorTtlMs: 0 })
    const query = { connectionId: 'c1', itemId: 'i', itemKey: 'K-1' }
    expect(await status.refreshItem(query)).toEqual({ ok: true, checked: 1, recorded: 1 })
    expect(await status.refreshItem(query)).toEqual({ ok: true, checked: 0, recorded: 0 })
    const actions = activity.list(query).map((record) => (record.change.field === 'run' && record.change.event === 'pr' ? record.change.action : '?'))
    expect(actions).toEqual(['open', 'closed', 'merged'])
  })
})

describe('fix1 c1-4① 오류 접착부 — branches() 결과', () => {
  it('exit 4 → unauthenticated, exit 1 + stdout [] 는 PR 없음이 아니다', async () => {
    const answers: GhOutcome[] = [exit(4, '', A2.unauth), exit(1, '[]\n', 'HTTP 502')]
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' }), row({ path: '/w/b', branch: 'b' })])], work: () => null, gh: () => '/fake/gh', run: fakeRun(({ args }) => answers[args[3] === 'a' ? 0 : 1] ?? exit(9, '')), maxConcurrent: 1 })
    const result = await status.branches({ paths: ['/w/a', '/w/b'] })
    expect(result.lookups['/w/a']).toMatchObject({ kind: 'error', error: 'unauthenticated' })
    expect(result.lookups['/w/b']).toMatchObject({ kind: 'error', error: 'failed' })
  })
})

describe('fix1 c1-5 오류 결과는 짧은 TTL', () => {
  it('오류는 errorTtl 뒤 다시 묻고, 성공은 성공 TTL 동안 묻지 않는다', async () => {
    let now = 0
    let answer: GhOutcome = exit(4, '', A2.unauth)
    const run = fakeRun(() => answer)
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run, now: () => now, ttlMs: 60_000, errorTtlMs: 10_000 })
    await status.branches({ paths: ['/w/a'] })
    now = 9_000
    await status.branches({ paths: ['/w/a'] })
    expect(run.calls).toHaveLength(1)
    now = 11_000
    answer = exit(0, '[]')
    expect((await status.branches({ paths: ['/w/a'] })).lookups['/w/a']).toEqual({ kind: 'none' })
    expect(run.calls).toHaveLength(2)
    now = 50_000
    await status.branches({ paths: ['/w/a'] })
    expect(run.calls).toHaveLength(2)
  })
  it('기본값 — 오류 TTL 이 성공 TTL 보다 짧다', () => {
    expect(PR_ERROR_TTL_MS).toBeLessThan(PR_TTL_MS)
  })
})

// --- 리뷰 r2 수정(fix2) ---
describe('fix2 c2-1 기본 gh 고르기는 알려진 worktree 를 roots 로 넘긴다', () => {
  it('deps.gh 없이 — PATH 앞의 worktree 아래 심은 gh 대신 안전한 gh 를 띄운다(양성 대조: 그 worktree 가 트리에 없으면 심은 것이 뽑힌다)', async () => {
    const wt = fs.mkdtempSync(path.join(base, 'wt-default-'))
    const planted = path.join(wt, 'bin')
    fs.mkdirSync(planted)
    fs.writeFileSync(path.join(planted, 'gh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const safe = fs.mkdtempSync(path.join(base, 'safe-default-'))
    fs.writeFileSync(path.join(safe, 'gh'), '#!/bin/sh\necho []\n', { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${planted}:${safe}`
    try {
      const seen: string[] = []
      const run: GhRun = async ({ gh }) => { seen.push(gh); return exit(0, '[]') }
      const known = new PrStatus({ repos: () => [repo([row({ path: wt, branch: 'a' })])], work: () => null, run })
      await known.branches({ paths: [wt] })
      const other = fs.mkdtempSync(path.join(base, 'wt-other-'))
      const unknown = new PrStatus({ repos: () => [repo([row({ path: other, branch: 'a' })])], work: () => null, run })
      await unknown.branches({ paths: [other] })
      expect(seen).toEqual([path.join(safe, 'gh'), path.join(planted, 'gh')])
    } finally {
      process.env.PATH = before
    }
  })
})

describe('fix2 c2-2 WorkService.recordEvent 는 at 을 그대로 남긴다', () => {
  it('at 을 주면 그 시각, 안 주면 now', async () => {
    const { service, activity } = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l624_fix2', replaceId: null })
    expect(added.ok).toBe(true)
    const connectionId = service.settings().connections[0]?.id ?? ''
    const change: WorkActivityChange = { field: 'run', event: 'pr', action: 'merged', worktree: '/w', number: 30, url: A1_MERGED.url, branch: 'b', base: 'main', draft: false }
    expect(service.recordEvent({ connectionId, itemId: null, itemKey: 'K-1', eventKey: 'k-at', change, at: Date.parse(A1_MERGED.mergedAt) })).toBe(true)
    expect(service.recordEvent({ connectionId, itemId: null, itemKey: 'K-1', eventKey: 'k-now', change })).toBe(true)
    const rows = activity.list({ connectionId, itemId: 'x', itemKey: 'K-1' })
    expect(rows.map((record) => record.at)).toEqual([Date.parse(A1_MERGED.mergedAt), 1_791_800_000_000])
  })
})

describe('fix2 c2-3 폐기·만료 토큰도 미인증', () => {
  it('HTTP 401 Bad credentials(exit 1, 리뷰어 실측 원문) → unauthenticated', () => {
    const stderr = 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n'
    expect(classifyFailure(exit(1, '', stderr))).toEqual({ kind: 'error', error: 'unauthenticated', message: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' })
    expect(classifyFailure(exit(1, '', 'HTTP 404: Not Found\n'))).toMatchObject({ error: 'failed' })
  })
})

describe('fix2 c2-4 TTL 은 완료 시각부터', () => {
  it('오래 걸린 오류 실행 — 끝난 뒤 errorTtl 안 재조회는 gh 0 회', async () => {
    let now = 0
    let release: () => void = () => undefined
    const calls: string[] = []
    const run: GhRun = () => new Promise((resolve) => { calls.push('run'); release = () => resolve(exit(1, '', 'HTTP 502')) })
    const status = new PrStatus({ cwdExists: () => true, repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run, now: () => now, ttlMs: 60_000, errorTtlMs: 10_000 })
    const first = status.branches({ paths: ['/w/a'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    now = 15_000
    release()
    expect((await first).lookups['/w/a']).toMatchObject({ kind: 'error' })
    now = 20_000
    await status.branches({ paths: ['/w/a'] })
    expect(calls).toHaveLength(1)
    now = 26_000
    const third = status.branches({ paths: ['/w/a'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await third
    expect(calls).toHaveLength(2)
  })
})

describe('fix2 c2-5 재조회 대상은 최근에 연 PR 부터', () => {
  it('열림 12건(오래된 10건은 닫힘 기록) → 상한 10 안에 최근 2건이 든다', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const urls: string[] = []
    for (let n = 1; n <= 12; n += 1) {
      const url = `https://github.com/o/r/pull/${n}`
      urls.push(url)
      const change: Extract<WorkActivityChange, { event: 'pr' }> = { field: 'run', event: 'pr', action: 'open', worktree: '/gone', number: n, url, branch: `b${n}`, base: 'main', draft: false }
      work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: `o${n}`, change, at: n })
      if (n <= 10) work.recordEvent({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1', eventKey: `c${n}`, change: { ...change, action: 'closed' }, at: n + 0.5 })
    }
    const run = fakeRun(() => exit(0, JSON.stringify({ ...A1_MERGED, state: 'CLOSED', mergedAt: null })))
    const status = new PrStatus({ cwdExists: () => true, repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
    expect(await status.refreshItem({ connectionId: 'c1', itemId: 'i', itemKey: 'K-1' })).toMatchObject({ ok: true, checked: 10 })
    const asked = run.calls.map((call) => call.args[2])
    expect(asked).toContain(urls[11])
    expect(asked).toContain(urls[10])
    expect(asked).not.toContain(urls[0])
  })
})

describe('fix2 c2-6 목록 행을 하나도 못 읽으면 「PR 없음」 이 아니다', () => {
  it('다른 호스트 URL · 모르는 state 행만 → failed, 하나라도 읽으면 그것', () => {
    const ghe = { ...A1_MERGED, url: 'https://ghe.example.com/o/r/pull/3' }
    const weird = { ...A1_MERGED, state: 'QUEUED' }
    expect(readOutput({ stdout: JSON.stringify([ghe]), many: true })).toMatchObject({ kind: 'error', error: 'failed' })
    expect(readOutput({ stdout: JSON.stringify([weird]), many: true })).toMatchObject({ kind: 'error', error: 'failed' })
    expect(readOutput({ stdout: JSON.stringify([weird, A1_MERGED]), many: true })).toMatchObject({ kind: 'pr', pr: { number: 30 } })
    expect(readOutput({ stdout: '[]', many: true })).toEqual({ kind: 'none' })
  })
})
