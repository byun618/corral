// LIFE-624 C1·C2·C3·C4·C5·C8·C9·C10·C11(main) — PR 상태 출처(`gh`). 신호는 실측 원문(corral-specs LIFE-624 raw/coordinator a1·a2) 그대로.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitStatusSummary, RepoRow, WorktreeRow } from '../shared/types.js'
import { readWorkActivityQuery, type WorkActivityChange, type WorkActivityRecord } from '../shared/work.js'
import type { WorktreeWorkLink } from '../shared/work-link.js'
import { MemoryActivity, WorkActivityStore, type ActivityPort } from './work/activity-store.js'
import { classifyFailure, makeRunGh, pickPr, PrStatus, readOutput, readPr, resolveGh, type GhOutcome, type GhRun, type PrWorkPort } from './pr-status.js'

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
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/a', branch: 'refs/heads/a' })])], work: () => null, gh: () => null, run })
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
    expect(argv).toEqual(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt', '--limit', '20'])
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
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run })
    const result = await status.branches({ paths: ['/w/other', '/w/a/../a', '/etc'] })
    expect(Object.values(result.lookups).map((value) => value.kind)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(run.calls).toHaveLength(0)
    expect(await status.branches(null)).toEqual({ lookups: {}, recorded: 0 })
    expect(await status.branches({ paths: 'nope' })).toEqual({ lookups: {}, recorded: 0 })
    expect(run.calls).toHaveLength(0)
  })
  it('GitHub PR URL 꼴이 아니면 거절, gh 를 부르지 않는다', async () => {
    const run = fakeRun(() => exit(0, JSON.stringify(A1_MERGED)))
    const status = new PrStatus({ repos: () => [], work: () => null, gh: () => '/fake/gh', run })
    for (const bad of ['http://github.com/a/b/pull/1', 'https://gitlab.com/a/b/pull/1', 'https://github.com/a/b/pull/1;rm', 'https://github.com/a/b/pull/1 --web', '--help', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/0', 42, null]) {
      expect(await status.byUrl(bad)).toMatchObject({ kind: 'rejected' })
    }
    expect(run.calls).toHaveLength(0)
    expect(await status.byUrl('https://github.com/byun618/corral/pull/30')).toMatchObject({ kind: 'pr' })
    expect(run.calls).toEqual([{ args: ['pr', 'view', 'https://github.com/byun618/corral/pull/30', '--json', 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt'], cwd: '/' }])
  })
  it('detached(브랜치 없음)는 PR 없음, gh 를 부르지 않는다', async () => {
    const run = fakeRun(() => exit(0, '[]'))
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/d', branch: null })])], work: () => null, gh: () => '/fake/gh', run })
    expect((await status.branches({ paths: ['/w/d'] })).lookups['/w/d']).toEqual({ kind: 'none' })
    expect(run.calls).toHaveLength(0)
  })
})

describe('C8 활동 PR 줄', () => {
  it('머지된 PR 을 처음 보면 열림·머지 두 줄(PR 의 시각) — 세 번 관측해도 줄 수 불변', async () => {
    const activity = new MemoryActivity()
    const work = workOf(activity)
    const run = fakeRun(() => exit(0, JSON.stringify([A1_MERGED])))
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/683', branch: 'refs/heads/LIFE-683-source-control', workLink: link() })])], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
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
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/a', branch: 'a' }), row({ path: '/w/b', branch: 'b', workLink: { ...link(), connected: false } })])], work: () => work, gh: () => '/fake/gh', run })
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
      const status = new PrStatus({ repos: () => [repo([row({ path: '/w/683', branch: 'LIFE-683-source-control', workLink: link() })])], work: () => workOf(store), gh: () => '/fake/gh', run: fakeRun(() => exit(0, JSON.stringify([A1_MERGED]))) })
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
    const status = new PrStatus({ repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
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
    const status = new PrStatus({ repos: () => [], work: () => work, gh: () => '/fake/gh', run, ttlMs: 0 })
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
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/a', branch: 'a' })])], work: () => null, gh: () => '/fake/gh', run, now: () => now, ttlMs: 60_000 })
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
    const status = new PrStatus({ repos: () => [repo([row({ path: '/w/a', branch })])], work: () => null, gh: () => '/fake/gh', run })
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
    const status = new PrStatus({ repos: () => [repo(paths.map((p) => row({ path: p, branch: p.slice(3) })))], work: () => null, gh: () => '/fake/gh', run, maxConcurrent: 2 })
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
