// LIFE-635 — LA 작업 링크 저장(L1a) · 인증 응답 분류(L1d). 실제 경로: WorkService → LaSource → McpHttpClient → LaMcpFixture(127.0.0.1 HTTP).
// C1 링크 읽기 · C2 링크 쓰기 · C4 기존 로컬 링크 이관 · C6 실패·미연결 · C7 인증 응답 분류. 토큰은 가짜(`test-kit`)뿐이다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoRegistry } from '../registry.js'
import { testRepo, testWorktree } from '../../shared/test-rows.js'
import type { WorkLink } from '../../shared/work.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import type { RepoRow } from '../../shared/types.js'
import { LA_CAPABILITIES, laSourceEntry } from './la-source.js'
import { WorkService } from './service.js'
import { WorkSourceRegistry } from './source.js'
import { CredentialVault } from './vault.js'
import { FIXTURE_IDS, type FixtureCorrupt, type LaMcpFixture } from './la-mcp-fixture.js'
import { MIGRATE_MAX_ATTEMPTS, MIGRATE_RETRY_MS, WorkLinks } from './links.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { FakeCipher, FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, FAKE_MACHINE, FAKE_MOCK_TOKEN, laFixtureHarness, MemoryStore, workHarness, type WorkHarness } from './test-kit.js'

type Rig = WorkHarness & { fixture: LaMcpFixture; url: string; connectionId: string }

const rigs: Rig[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.fixture.stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function connected({ token = FAKE_LA_TOKEN, timeoutMs }: { token?: string; timeoutMs?: number } = {}): Promise<Rig> {
  const harness = await laFixtureHarness({ timeoutMs })
  const added = await harness.service.addConnection({ sourceId: 'la', token, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.kind}`)
  const rig = { ...harness, connectionId: added.connection.id }
  rigs.push(rig)
  return rig
}

/** 같은 fixture 위의 새 서비스 — 재기동·machine 원천을 바꿔 본다. */
function serviceOver({ url, store = new MemoryStore(), cipher = new FakeCipher(), machine = async () => FAKE_MACHINE }: { url: string; store?: MemoryStore; cipher?: FakeCipher; machine?: () => Promise<string> }): WorkService {
  return new WorkService({ store, vault: new CredentialVault(cipher), sources: new WorkSourceRegistry([laSourceEntry({ url, clientVersion: 'test' })]), repos: () => [], onChange: () => {}, machine })
}

const WT = '/tmp/l635/repo/.claude/worktrees/LIFE-600-x'
const LINK: WorkLink = { kind: 'worktree', path: WT, repoRoot: '/tmp/l635/repo' }
const linkTools = (fixture: LaMcpFixture): number => fixture.requests.filter((request) => request.tool?.startsWith('issue_work_link_')).length

describe('C1 LA 링크 읽기 — 단건의 workLinks 를 계약 모양으로', () => {
  it('네 종류 모두 machine·repo·createdAt 까지 실린다 (getItem · findByKey) · 목록 행은 안 실음(빈 배열)', async () => {
    const rig = await connected()
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: '/a/wt', repoRoot: '/a' }, machine: 'mac-a', repo: 'a' })
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'branch', name: 'LIFE-600-x', repoRoot: null }, machine: null, repo: null })
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'pull_request', url: 'https://github.com/o/r/pull/1', state: 'open' }, machine: null, repo: 'o/r' })
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'agent_session', sessionId: 's-1', agent: 'claude' }, machine: 'phone', repo: null })
    const expected = [
      { link: { kind: 'worktree', path: '/a/wt', repoRoot: '/a' }, machine: 'mac-a', repo: 'a' },
      { link: { kind: 'branch', name: 'LIFE-600-x', repoRoot: null }, machine: null, repo: null },
      { link: { kind: 'pull_request', url: 'https://github.com/o/r/pull/1', state: 'open' }, machine: null, repo: 'o/r' },
      { link: { kind: 'agent_session', sessionId: 's-1', agent: 'claude' }, machine: 'phone', repo: null },
    ].map((row) => expect.objectContaining({ ...row, createdAt: expect.stringMatching(/^2026-10-18T/) }))
    const got = await rig.service.request({ requestId: 'g', connectionId: rig.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    expect(got.ok && got.result.op === 'getItem' ? got.result.item.workLinks : null).toEqual(expected)
    const found = await rig.service.request({ requestId: 'f', connectionId: rig.connectionId, call: { op: 'findByKey', key: 'LIFE-600' } })
    expect(found.ok && found.result.op === 'findByKey' ? found.result.item?.workLinks : null).toEqual(expected)
    // 목록 행에는 LA 가 링크를 주지 않는다(F8) — 빈 배열은 「안 실음」 이다(계약 주석). 단건이 정본.
    const listed = await rig.service.request({ requestId: 'l', connectionId: rig.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    const row = listed.ok && listed.result.op === 'listItems' ? listed.result.items.find((item) => item.id === FIXTURE_IDS.task600) : undefined
    expect(row?.workLinks).toEqual([])
  })

  const broken: FixtureCorrupt[] = ['worklink-unknown-kind', 'worklink-drop-path', 'worklink-machine-number', 'worklink-drop-createdAt', 'drop-workLinks']
  for (const corrupt of broken) {
    it(`${corrupt} → invalid_response (조용히 버리거나 빈 배열로 접지 않는다) · 양성 대조: 깨기 전엔 성공`, async () => {
      const rig = await connected()
      rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: '/a/wt', repoRoot: '/a' }, machine: 'mac-a', repo: 'a' })
      const call = { op: 'getItem' as const, itemId: FIXTURE_IDS.task600 }
      expect(await rig.service.request({ requestId: 'ok', connectionId: rig.connectionId, call })).toMatchObject({ ok: true })
      rig.fixture.corrupt = corrupt
      expect(await rig.service.request({ requestId: corrupt, connectionId: rig.connectionId, call })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    })
  }

  it('링크 도구 응답의 workLinks 가 배열이 아니면 저장 결과도 실패(failed) — 양성 대조: 깨기 전엔 saved', async () => {
    const rig = await connected()
    expect(await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })).toEqual({ state: 'saved', message: null })
    rig.fixture.corrupt = 'worklink-not-array'
    expect(await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })).toMatchObject({ state: 'failed' })
  })
})

describe('C2 LA 링크 쓰기 — 능력 켜짐 · add/remove 인자 · LA 609 의미', () => {
  it('workLinkStore = on', () => {
    expect(LA_CAPABILITIES.workLinkStore).toEqual({ state: 'on' })
  })

  it('save = issue_work_link_add({issueId, link, machine, repo}) · remove = issue_work_link_remove({issueId, link, machine}) — 같은 machine, add 마다 repo', async () => {
    const rig = await connected()
    rig.repos.push({ id: 'repo-1', root: '/tmp/l635/repo', name: 'corral' })
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'remove' })
    expect(rig.fixture.workLinkArgs).toEqual([
      { tool: 'issue_work_link_add', args: { issueId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE, repo: 'corral' } },
      { tool: 'issue_work_link_add', args: { issueId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE, repo: 'corral' } },
      { tool: 'issue_work_link_remove', args: { issueId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE } },
    ])
  })

  it('레포를 모르면 루트 폴더 이름을 repo 로 — 생략하지 않는다(생략 = LA 가 repo 를 null 로 덮음)', async () => {
    const rig = await connected()
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
    expect(rig.fixture.workLinkArgs[0]?.args).toMatchObject({ repo: 'repo' })
    expect(Object.hasOwn(rig.fixture.workLinkArgs[0]?.args ?? {}, 'repo')).toBe(true)
  })

  it('결과 = 그 일감 링크 목록 전체(다른 machine 행 포함) · 재추가 = 한 행 · 없는 링크 remove = 오류 아님 · 다른 machine 의 같은 경로는 남는다', async () => {
    const rig = await connected()
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: LINK, machine: 'other-mac', repo: 'x' })
    const call = { op: 'saveWorkLink' as const, itemId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE, repo: 'corral' }
    // main 만 보내는 연산이라 서비스 공개 경로(storeLink — 결과는 상태만) 대신 같은 fixture 의 출처 클라이언트로 결과 목록 모양을 본다.
    const client = laSourceEntry({ url: rig.url, clientVersion: 'test' }).create({ token: FAKE_LA_TOKEN, account: {} })
    const first = await client.call(call, { writeId: null })
    const again = await client.call({ ...call, repo: 'corral2' }, { writeId: null })
    expect(first.ok && again.ok).toBe(true)
    const rows = again.ok && again.result.op === 'saveWorkLink' ? again.result.workLinks : []
    expect(rows.map((row) => [row.machine, row.repo])).toEqual([['other-mac', 'x'], [FAKE_MACHINE, 'corral2']])
    const removed = await client.call({ op: 'removeWorkLink', itemId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE }, { writeId: null })
    const missing = await client.call({ op: 'removeWorkLink', itemId: FIXTURE_IDS.task600, link: LINK, machine: FAKE_MACHINE }, { writeId: null })
    for (const outcome of [removed, missing]) expect(outcome.ok && outcome.result.op === 'removeWorkLink' ? outcome.result.workLinks.map((row) => row.machine) : null).toEqual(['other-mac'])
  })

  it('issue:write 없는 토큰 → 200 isError `missing scope` → forbidden(failed) · 양성 대조: 쓰기 토큰은 saved', async () => {
    const read = await connected({ token: FAKE_LA_READ_TOKEN })
    expect(await read.service.storeLink({ connectionId: read.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })).toMatchObject({ state: 'failed', message: expect.stringContaining('issue:write') })
    expect(read.fixture.workLinks).toEqual([])
    const write = await connected()
    expect(await write.service.storeLink({ connectionId: write.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })).toEqual({ state: 'saved', message: null })
  })

  it('machine 은 한 번만 읽고 저장·지우기·재기동(같은 원천)에 같은 값', async () => {
    let reads = 0
    const harness = await laFixtureHarness()
    const service = serviceOver({ url: harness.url, machine: async () => { reads += 1; return '변상현의 MacBook Pro' } })
    const added = await service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('연결 실패')
    await service.storeLink({ connectionId: added.connection.id, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
    await service.storeLink({ connectionId: added.connection.id, itemId: FIXTURE_IDS.task600, link: LINK, action: 'remove' })
    expect(reads).toBe(1)
    expect(harness.fixture.workLinkArgs.map((row) => row.args.machine)).toEqual(['변상현의 MacBook Pro', '변상현의 MacBook Pro'])
    expect(service.settings().machine).toBe('변상현의 MacBook Pro')
    await harness.fixture.stop()
  })

  it('링크 저장·지우기는 일감 판(version)을 바꾸지 않는다(F9 — L1b 충돌 없음)', async () => {
    const rig = await connected()
    const before = rig.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.version
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
    await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'remove' })
    expect(rig.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.version).toBe(before)
  })
})

// --- C4 이관 ---

const STORED = (connectionId: string): StoredWorkLink => ({ sourceId: 'la', connectionId, itemId: FIXTURE_IDS.task600, key: 'LIFE-600', linkedAt: 1_700_000_000_000 })
const AUTO_WT = '/tmp/l635/repo/.claude/worktrees/LIFE-601-auto'

/** repos.json 고정본 — 명시 링크 하나(이 실행 전) + 자동 연결 worktree 하나(브랜치 키). */
function fixedRegistry(connectionId: string): { file: string; registry: () => RepoRegistry; hash: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l635-mig-'))
  dirs.push(dir)
  const file = path.join(dir, 'repos.json')
  const data = {
    version: 2,
    repos: [{ id: 'repo-1', path: '/tmp/l635/repo', name: 'corral', projectId: 'repo:repo-1', baseRef: 'main', method: 'imported-existing-folder' }],
    setups: [],
    worktrees: { [WT]: { repoId: 'repo-1', workLink: STORED(connectionId), workLinkSuppressed: false } },
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  return { file, registry: () => new RepoRegistry(dir), hash: () => createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}

/** `auto` false = 명시 링크 worktree 하나만(보낸 요청 수를 링크 하나로 센다). */
function tree({ auto = true }: { auto?: boolean } = {}): RepoRow[] {
  const worktrees = [testWorktree({ path: WT, branch: 'refs/heads/LIFE-600-x' })]
  if (auto) worktrees.push(testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' }))
  return [testRepo({ root: '/tmp/l635/repo', worktrees })]
}

/** 손으로 넘기는 시계 · 타이머는 걸지 않는다(관측으로 깨운다). 자동 연결 사건은 이미 남긴 것으로(이 실행 전 — L1a 전에 생긴 자동 연결). */
function migrator({ rig, registry, auto = true }: { rig: Rig; registry: () => RepoRegistry; auto?: boolean }): { links: WorkLinks; observe: () => Promise<void>; tick: (ms: number) => void } {
  let clock = 2_000_000_000_000
  const links = new WorkLinks({ registry, work: () => rig.service, log: () => {}, now: () => clock, schedule: () => {}, generation: () => 'g1' })
  rig.activity.append({ id: 'pre', connectionId: rig.connectionId, itemId: '', itemKey: 'LIFE-601', at: 1, writeId: 'x', eventKey: `run:auto:${rig.connectionId}:LIFE-601:${AUTO_WT}:g1`, change: { field: 'run', event: 'auto_link', worktree: AUTO_WT, branch: 'LIFE-601-auto' } })
  return {
    links,
    tick: (ms) => { clock += ms },
    observe: async () => { links.observe(links.annotate(tree({ auto }))); await links.migrationsSettled() },
  }
}

const addsFor = (fixture: LaMcpFixture, worktree: string): number => fixture.workLinkArgs.filter((row) => row.tool === 'issue_work_link_add' && JSON.stringify(row.args.link).includes(worktree)).length
/** 도구까지 닿지 않은 요청(HTTP 고장·403)도 센다 — 받은 요청 기록의 도구 이름으로. 명시 링크 하나만 있는 트리에서 쓴다. */
const addRequests = (fixture: LaMcpFixture): number => fixture.requests.filter((request) => request.tool === 'issue_work_link_add').length

describe('C4 기존 로컬 링크 이관 — 덧붙이기만', () => {
  it('명시·자동 링크가 LA 에 한 번씩 add · ⓐ repos.json 바이트 불변 · ⓑ 두 번 관측·재기동해도 LA 행 1 · ⓕ LA 에만 있는 행은 그대로', async () => {
    const rig = await connected()
    const { registry, hash } = fixedRegistry(rig.connectionId)
    rig.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: '/elsewhere/wt', repoRoot: null }, machine: 'other-mac', repo: null })
    const before = hash()
    const first = migrator({ rig, registry })
    await first.observe()
    await first.observe()
    expect(addsFor(rig.fixture, WT)).toBe(1)
    expect(addsFor(rig.fixture, AUTO_WT)).toBe(1)
    expect(rig.fixture.workLinkArgs.find((row) => JSON.stringify(row.args.link).includes(WT))?.args).toEqual({ issueId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: WT, repoRoot: '/tmp/l635/repo' }, machine: FAKE_MACHINE, repo: 'repo' })
    // 재기동 — 새 WorkLinks(메모리 비움)가 다시 보내도 LA 는 같은 판별이라 한 행.
    const restarted = migrator({ rig, registry })
    await restarted.observe()
    const rows = (issueId: string, worktree: string) => rig.fixture.workLinks.filter((row) => row.issueId === issueId && row.key === worktree)
    expect(rows(FIXTURE_IDS.task600, WT)).toHaveLength(1)
    expect(rows(FIXTURE_IDS.task601, AUTO_WT)).toHaveLength(1)
    expect(rows(FIXTURE_IDS.task600, '/elsewhere/wt')).toHaveLength(1)
    expect(rig.fixture.requests.filter((request) => request.tool === 'issue_work_link_remove')).toHaveLength(0)
    expect(hash()).toBe(before)
  })

  it('ⓒ 실패(5xx·끊김·응답 깨짐)면 로컬 그대로 + 간격·상한 안에서만 다시 — 폭주 0, 상한 뒤엔 다음 실행에서', async () => {
    for (const fault of ['http-503', 'drop', 'corrupt'] as const) {
      const rig = await connected()
      const { registry, hash } = fixedRegistry(rig.connectionId)
      const before = hash()
      if (fault === 'http-503') rig.fixture.toolFaults.set('issue_work_link_add', { kind: 'http', status: 503, body: '{}' })
      if (fault === 'drop') rig.fixture.toolFaults.set('issue_work_link_add', { kind: 'drop' })
      if (fault === 'corrupt') rig.fixture.corrupt = 'worklink-not-array'
      const run = migrator({ rig, registry, auto: false })
      await run.observe()
      expect(addRequests(rig.fixture)).toBe(1)
      // 같은 시각에 관측이 몇 번 와도 다시 보내지 않는다.
      for (let index = 0; index < 5; index += 1) await run.observe()
      expect(addRequests(rig.fixture)).toBe(1)
      for (let attempt = 1; attempt < MIGRATE_MAX_ATTEMPTS; attempt += 1) {
        run.tick(MIGRATE_RETRY_MS * 2 ** (attempt - 1) - 1)
        await run.observe()
        expect(addRequests(rig.fixture)).toBe(attempt)
        run.tick(1)
        await run.observe()
        expect(addRequests(rig.fixture)).toBe(attempt + 1)
      }
      run.tick(3_600_000)
      await run.observe()
      expect(addRequests(rig.fixture)).toBe(MIGRATE_MAX_ATTEMPTS)
      // 실패는 활동에 링크마다 한 번.
      expect(rig.activity.list({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, itemKey: 'LIFE-600' }).filter((row) => row.change.field === 'run' && row.change.event === 'source_link_failed')).toHaveLength(1)
      // 고친 뒤 다음 실행은 다시 보내 성공한다.
      rig.fixture.toolFaults.clear()
      rig.fixture.corrupt = null
      await migrator({ rig, registry, auto: false }).observe()
      expect(rig.fixture.workLinks.filter((row) => row.key === WT)).toHaveLength(1)
      expect(hash()).toBe(before)
    }
  })

  it('ⓓ 401(폐기 토큰)·403·200 isError scope 는 같은 자격으로 자동 재전송 0 · 토큰을 바꾸면(새 세대) 다시', async () => {
    // 401 — 폐기한 토큰. 인증 실패 뒤로는 링크 add 도 일반 요청도 보내지 않는다.
    const revoked = await connected()
    const { registry } = fixedRegistry(revoked.connectionId)
    revoked.fixture.revoke(FAKE_LA_TOKEN)
    const run = migrator({ rig: revoked, registry, auto: false })
    await run.observe()
    const sent = revoked.fixture.requests.length
    // 첫 add 가 401 을 받는다(폐기를 처음 아는 요청) — 그 뒤로는 0.
    expect(addRequests(revoked.fixture)).toBe(1)
    for (let index = 0; index < 4; index += 1) { run.tick(MIGRATE_RETRY_MS * 8); await run.observe() }
    expect(revoked.fixture.requests.length).toBe(sent)
    // 새 토큰으로 교체 — 새 자격 세대라 멈춘 이관이 다시 간다.
    const fresh = 'life_pat_fixturefresh000000000000000000000000000000'
    revoked.fixture.tokens.set(fresh, 'write')
    const replaced = await revoked.service.addConnection({ sourceId: 'la', token: fresh, replaceId: revoked.connectionId })
    expect(replaced.ok).toBe(true)
    await run.observe()
    expect(revoked.fixture.workLinks.filter((row) => row.key === WT)).toHaveLength(1)

    // 403(HTTP 꼴) · 200 isError scope(LA 실제 꼴) — 읽기 토큰.
    for (const style of ['http', 'sdk'] as const) {
      const rig = await connected({ token: FAKE_LA_READ_TOKEN })
      rig.fixture.scopeStyle = style
      const { registry: reg } = fixedRegistry(rig.connectionId)
      const forbidden = migrator({ rig, registry: reg, auto: false })
      await forbidden.observe()
      const adds = addRequests(rig.fixture)
      expect(adds).toBe(1)
      for (let index = 0; index < 4; index += 1) { forbidden.tick(MIGRATE_RETRY_MS * 8); await forbidden.observe() }
      expect(addRequests(rig.fixture)).toBe(adds)
      expect(rig.fixture.workLinks).toEqual([])
    }
  })

  it('ⓔ LA 미연결 · 능력을 아직 모름(기동 직후) · 능력 꺼짐(Jira 형) 은 요청 0', async () => {
    // 미연결 — 링크의 연결이 설정에 없다.
    const rig = await connected()
    const { registry } = fixedRegistry('c-gone')
    await migrator({ rig, registry, auto: false }).observe()
    expect(linkTools(rig.fixture)).toBe(0)

    // 기동 직후 — 연결은 있지만 이 실행에서 클라이언트를 아직 안 만들었다(금고 무접촉).
    const boot = await connected()
    // 같은 저장 파일·금고를 쓰는 새 서비스 = 재기동(그 연결의 클라이언트를 아직 안 만들었다).
    const service = serviceOver({ url: boot.url, store: boot.store, cipher: boot.cipher })
    const { registry: bootRegistry } = fixedRegistry(boot.connectionId)
    const decrypts = boot.cipher.decrypts
    const links = new WorkLinks({ registry: bootRegistry, work: () => service, log: () => {}, schedule: () => {} })
    links.observe(links.annotate(tree()))
    await links.migrationsSettled()
    expect(linkTools(boot.fixture)).toBe(0)
    expect(boot.cipher.decrypts).toBe(decrypts)

    // 능력 꺼짐 — 모의 출처를 `cap-workLinkStore-off` 로.
    const state = seedMockState()
    const mock = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await mock.service.addConnection({ sourceId: 'mock-jira', token: `${FAKE_MOCK_TOKEN}-cap-workLinkStore-off`, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const { registry: mockRegistry } = fixedRegistry(added.connection.id)
    const off = new WorkLinks({ registry: mockRegistry, work: () => mock.service, log: () => {}, schedule: () => {} })
    off.observe(off.annotate(tree()))
    await off.migrationsSettled()
    expect(state.linkWrites ?? []).toEqual([])
  })

  it('이 실행에서 시작이 적은 명시 링크는 이관하지 않는다(시작이 이미 보냈다)', async () => {
    const rig = await connected()
    const { registry, file } = fixedRegistry(rig.connectionId)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    data.worktrees[WT].workLink.linkedAt = 2_000_000_000_001
    fs.writeFileSync(file, JSON.stringify(data))
    await migrator({ rig, registry }).observe()
    expect(addsFor(rig.fixture, WT)).toBe(0)
    expect(addsFor(rig.fixture, AUTO_WT)).toBe(1)
  })
})

describe('C6 실패·미연결 — 로컬 유지 · failed + 이쪽 말 · 활동 기록', () => {
  const TOKEN_SHAPE = /life_pat_[A-Za-z0-9]+/

  it('저장 실패 문구에 원격 message·토큰·WWW-Authenticate 글이 없다 — 양성 대조: 원격 응답에는 그 글이 있다', async () => {
    const cases: { name: string; arrange: (rig: Rig) => void; token?: string }[] = [
      { name: 'drop', arrange: (rig) => rig.fixture.toolFaults.set('issue_work_link_add', { kind: 'drop' }) },
      { name: '401', arrange: (rig) => rig.fixture.revoke(FAKE_LA_TOKEN) },
      { name: '403', arrange: (rig) => { rig.fixture.scopeStyle = 'http' }, token: FAKE_LA_READ_TOKEN },
      { name: 'scope', arrange: () => {}, token: FAKE_LA_READ_TOKEN },
      { name: 'corrupt', arrange: (rig) => { rig.fixture.corrupt = 'worklink-not-array' } },
      { name: 'echo', arrange: (rig) => { rig.fixture.echo = 'tool-error' } },
    ]
    for (const entry of cases) {
      const rig = await connected({ token: entry.token })
      entry.arrange(rig)
      const result = await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })
      expect(result.state, entry.name).toBe('failed')
      const message = result.message ?? ''
      expect(message.length, entry.name).toBeGreaterThan(0)
      for (const leak of ['인증이 필요해요', '권한이 없어요', 'invalid_token', 'realm=', 'is not allowed']) expect(message, `${entry.name}:${leak}`).not.toContain(leak)
      expect(TOKEN_SHAPE.test(message), entry.name).toBe(false)
    }
    // 양성 대조 — fixture 가 실제로 그 글을 보낸다(가리지 않았으면 문구에 실렸을 것).
    const probe = await connected()
    probe.fixture.revoke(FAKE_LA_TOKEN)
    const raw = await fetch(probe.url, { method: 'POST', headers: { authorization: `Bearer ${FAKE_LA_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    expect(raw.status).toBe(401)
    expect(raw.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(await raw.text()).toContain('인증이 필요해요')
    probe.fixture.echo = 'tool-error'
    probe.fixture.tokens.set('life_pat_fixtureecho0000000000000000000000000000000', 'write')
    const echoed = await fetch(probe.url, { method: 'POST', headers: { authorization: 'Bearer life_pat_fixtureecho0000000000000000000000000000000', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'issue_work_link_add', arguments: {} } }) })
    expect(TOKEN_SHAPE.test(await echoed.text())).toBe(true)
  })

  it('떼기 — 출처 지우기가 실패해도 로컬 떼기는 그대로(예외 저장) · sourceLink failed · 활동에 떼기와 출처 실패', async () => {
    const rig = await connected()
    const { registry, file } = fixedRegistry(rig.connectionId)
    rig.fixture.toolFaults.set('issue_work_link_remove', { kind: 'http', status: 502, body: '{}' })
    const links = new WorkLinks({ registry, work: () => rig.service, log: () => {}, schedule: () => {} })
    const worktree = testWorktree({ path: WT, branch: 'refs/heads/LIFE-600-x' })
    const result = await links.detach({ worktree, repoRoot: '/tmp/l635/repo' })
    expect(result).toMatchObject({ ok: true, mode: 'explicit', sourceLink: { state: 'failed' } })
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(after.worktrees[WT]).toEqual({ repoId: 'repo-1', workLinkSuppressed: true })
    const events = rig.activity.list({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, itemKey: 'LIFE-600' }).map((row) => row.change.field === 'run' ? row.change.event : null)
    expect(events).toEqual(['detach', 'source_link_failed'])
  })

  it('자동 연결 — 출처 저장 실패면 활동에 「출처 저장 실패」 · 링크는 로컬 해석 그대로', async () => {
    const rig = await connected()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l635-auto-'))
    dirs.push(dir)
    rig.fixture.toolFaults.set('issue_work_link_add', { kind: 'http', status: 500, body: '{"code":"INTERNAL_ERROR"}' })
    const links = new WorkLinks({ registry: () => new RepoRegistry(dir), work: () => rig.service, log: () => {}, schedule: () => {}, generation: () => 'g1' })
    const repos = links.annotate([testRepo({ root: '/tmp/l635/repo', worktrees: [testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' })] })])
    expect(repos[0]?.worktrees[0]?.workLink).toMatchObject({ mode: 'auto', key: 'LIFE-601' })
    links.observe(repos)
    for (let index = 0; index < 20 && !rig.activity.list({ connectionId: rig.connectionId, itemId: '', itemKey: 'LIFE-601' }).some((row) => row.change.field === 'run' && row.change.event === 'source_link_failed'); index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const events = rig.activity.list({ connectionId: rig.connectionId, itemId: '', itemKey: 'LIFE-601' }).map((row) => row.change.field === 'run' ? row.change.event : null)
    expect(events).toEqual(['auto_link', 'source_link_failed'])
    expect(links.annotate(repos)[0]?.worktrees[0]?.workLink).toMatchObject({ mode: 'auto', key: 'LIFE-601' })
  })
})

describe('C7 인증 응답 분류 (L1d · K2) — 실측 모양(c10) · 분기마다 양성 대조', () => {
  const listSpaces = { op: 'listSpaces' as const }

  it('무인증·형식 다른 토큰은 보내기 전 거절(요청 0) — 지금 규칙 유지', async () => {
    const harness = await laFixtureHarness()
    rigs.push({ ...harness, connectionId: '' })
    expect(await harness.service.addConnection({ sourceId: 'la', token: '', replaceId: null })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(await harness.service.addConnection({ sourceId: 'la', token: 'not_a_pat_token', replaceId: null })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(harness.fixture.requests).toHaveLength(0)
  })

  it('형식 맞는 모르는 토큰 → 401 + invalid_token → auth · 양성 대조: 아는 토큰은 ok', async () => {
    const harness = await laFixtureHarness()
    rigs.push({ ...harness, connectionId: '' })
    const unknown = 'life_pat_fixtureunknown0000000000000000000000000000'
    expect(await harness.service.addConnection({ sourceId: 'la', token: unknown, replaceId: null })).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    harness.fixture.tokens.set(unknown, 'write')
    expect(await harness.service.addConnection({ sourceId: 'la', token: unknown, replaceId: null })).toMatchObject({ ok: true })
  })

  it('폐기된 토큰(처음엔 통과, 뒤에 401) → auth 로 바뀌고 이후 일반 요청 재전송 0 · 양성 대조: 폐기 전엔 ok', async () => {
    const rig = await connected()
    expect(await rig.service.request({ requestId: 'a', connectionId: rig.connectionId, call: listSpaces })).toMatchObject({ ok: true })
    rig.fixture.revoke(FAKE_LA_TOKEN)
    expect(await rig.service.request({ requestId: 'b', connectionId: rig.connectionId, call: listSpaces })).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    const sent = rig.fixture.requests.length
    for (const call of [listSpaces, { op: 'getItem' as const, itemId: FIXTURE_IDS.task600 }]) expect(await rig.service.request({ requestId: 'c', connectionId: rig.connectionId, call })).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(await rig.service.storeLink({ connectionId: rig.connectionId, itemId: FIXTURE_IDS.task600, link: LINK, action: 'save' })).toMatchObject({ state: 'failed' })
    expect(rig.fixture.requests.length).toBe(sent)
  })

  it('403 → forbidden · 양성 대조: 같은 쓰기를 쓰기 토큰으로는 ok', async () => {
    const read = await connected({ token: FAKE_LA_READ_TOKEN })
    read.fixture.scopeStyle = 'http'
    const call = { op: 'setPlacement' as const, itemId: FIXTURE_IDS.task600, placement: 'backlog' as const, ifVersion: null }
    expect(await read.service.request({ requestId: 'w', connectionId: read.connectionId, call })).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } })
    const write = await connected()
    write.fixture.scopeStyle = 'http'
    expect(await write.service.request({ requestId: 'w', connectionId: write.connectionId, call })).toMatchObject({ ok: true })
  })

  it('200 isError `missing scope: issue:write` → forbidden · 양성 대조: 쓰기 토큰은 ok', async () => {
    const read = await connected({ token: FAKE_LA_READ_TOKEN })
    const call = { op: 'setPlacement' as const, itemId: FIXTURE_IDS.task600, placement: 'backlog' as const, ifVersion: null }
    expect(await read.service.request({ requestId: 'w', connectionId: read.connectionId, call })).toMatchObject({ ok: false, error: { kind: 'forbidden', message: expect.stringContaining('issue:write') } })
    const write = await connected()
    expect(await write.service.request({ requestId: 'w', connectionId: write.connectionId, call })).toMatchObject({ ok: true })
  })

  it('분류는 HTTP 상태가 정한다 — 500(본문 UNAUTHORIZED 여도) = network · 401(본문 INTERNAL_ERROR 여도) = auth', async () => {
    const server = await connected()
    server.fixture.fault = { kind: 'http', status: 500, body: '{"code":"UNAUTHORIZED","message":"인증이 필요해요"}' }
    expect(await server.service.request({ requestId: 's', connectionId: server.connectionId, call: listSpaces })).toMatchObject({ ok: false, error: { kind: 'network', status: 500 } })
    const auth = await connected()
    auth.fixture.fault = { kind: 'http', status: 401, body: '{"code":"INTERNAL_ERROR","message":"잠시 후 다시 시도해주세요"}' }
    expect(await auth.service.request({ requestId: 'a', connectionId: auth.connectionId, call: listSpaces })).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
  })

  it('시간 초과 → network · 양성 대조: 지연 없으면 ok', async () => {
    const rig = await connected({ timeoutMs: 100 })
    expect(await rig.service.request({ requestId: 'ok', connectionId: rig.connectionId, call: listSpaces })).toMatchObject({ ok: true })
    rig.fixture.fault = { kind: 'delay', ms: 400 }
    expect(await rig.service.request({ requestId: 't', connectionId: rig.connectionId, call: listSpaces })).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('fixture 401 모양 = 실측(c10) — 자격 없음은 error 없는 challenge, 무효는 invalid_token, 본문 UNAUTHORIZED', async () => {
    const rig = await connected()
    const send = (authorization: string | null) => fetch(rig.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    const none = await send(null)
    expect([none.status, none.headers.get('www-authenticate')]).toEqual([401, 'Bearer realm="life-assistant"'])
    expect(JSON.parse(await none.text())).toEqual({ code: 'UNAUTHORIZED', message: '인증이 필요해요' })
    for (const token of ['life_pat_fixturebogus000000000000000000000000000000', 'nonpat-random-token']) {
      const bad = await send(`Bearer ${token}`)
      expect([bad.status, bad.headers.get('www-authenticate')]).toEqual([401, 'Bearer realm="life-assistant", error="invalid_token"'])
    }
  })
})
