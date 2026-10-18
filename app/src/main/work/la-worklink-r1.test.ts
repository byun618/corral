// LIFE-635 fix r1 — Codex r1 지적 X1-1–X1-7 의 재현 조건을 회귀 시험으로(리뷰 프로브 P1·P2·P3·P7·P8·P10·P12·P14 의 조건을 이식).
// 실제 경로: WorkLinks → WorkService → LaSource → McpHttpClient → LaMcpFixture(127.0.0.1 HTTP). 토큰은 가짜뿐 · 실제 Mac 이름·설정 무접촉(조회 함수 주입).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoRegistry } from '../registry.js'
import { readMacName } from '../mobile/mac-name.js'
import { testRepo, testWorktree } from '../../shared/test-rows.js'
import type { WorkLink } from '../../shared/work.js'
import type { RepoRow } from '../../shared/types.js'
import { laSourceEntry } from './la-source.js'
import { FIXTURE_IDS, LaMcpFixture } from './la-mcp-fixture.js'
import { MIGRATE_RETRY_MS, WorkLinks } from './links.js'
import { MACHINE_FILE, persistedMachine } from './machine.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { WorkService } from './service.js'
import { WorkSourceRegistry } from './source.js'
import { CredentialVault } from './vault.js'
import { FakeCipher, FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, MemoryStore, workHarness } from './test-kit.js'
import { MemoryActivity } from './activity-store.js'

const fixtures: LaMcpFixture[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const ROOT = '/tmp/l635r1/repo'
const AUTO_WT = `${ROOT}/.claude/worktrees/LIFE-601-auto`
const WT = `${ROOT}/.claude/worktrees/LIFE-600-x`

type Rig = { fixture: LaMcpFixture; url: string; service: WorkService; store: MemoryStore; cipher: FakeCipher; activity: MemoryActivity; connectionId: string }

/** 손으로 만든 서비스 — machine 원천·저장소를 시험이 고른다. */
async function rig({ machine = async () => 'corral-test-mac' }: { machine?: () => Promise<string> } = {}): Promise<Rig> {
  const fixture = new LaMcpFixture()
  fixture.tokens.set(FAKE_LA_TOKEN, 'write')
  fixture.tokens.set(FAKE_LA_READ_TOKEN, 'read')
  const url = await fixture.start()
  fixtures.push(fixture)
  const store = new MemoryStore()
  const cipher = new FakeCipher()
  const activity = new MemoryActivity()
  let n = 0
  const service = new WorkService({ store, vault: new CredentialVault(cipher), sources: new WorkSourceRegistry([laSourceEntry({ url, clientVersion: 'test' })]), repos: () => [], onChange: () => {}, activity, machine, newId: () => `id-${++n}` })
  const added = await service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.kind}`)
  return { fixture, url, service, store, cipher, activity, connectionId: added.connection.id }
}

/** 같은 저장소·금고·fixture 위의 새 서비스 = 재기동(이 실행의 클라이언트 없음). */
function restart({ r, machine = async () => 'corral-test-mac' }: { r: Rig; machine?: () => Promise<string> }): WorkService {
  return new WorkService({ store: r.store, vault: new CredentialVault(r.cipher), sources: new WorkSourceRegistry([laSourceEntry({ url: r.url, clientVersion: 'test' })]), repos: () => [], onChange: () => {}, machine })
}

/** 기존 명시 링크(이 실행 전) 하나를 가진 repos.json. `explicit` false 면 링크 칸 없음(자동 연결만). */
function registryFor({ connectionId, explicit }: { connectionId: string; explicit: boolean }): () => RepoRegistry {
  const dir = tempDir('l635r1-reg-')
  const worktrees = explicit ? { [WT]: { repoId: 'repo-1', workLink: { sourceId: 'la', connectionId, itemId: FIXTURE_IDS.task600, key: 'LIFE-600', linkedAt: 1_700_000_000_000 }, workLinkSuppressed: false } } : {}
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ version: 2, repos: [{ id: 'repo-1', path: ROOT, name: 'corral', projectId: 'repo:repo-1', baseRef: 'main', method: 'imported-existing-folder' }], setups: [], worktrees }))
  return () => new RepoRegistry(dir)
}

function rows({ auto = false, explicit = false }: { auto?: boolean; explicit?: boolean }): RepoRow[] {
  const worktrees = []
  if (explicit) worktrees.push(testWorktree({ path: WT, branch: 'refs/heads/LIFE-600-x' }))
  if (auto) worktrees.push(testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' }))
  return [testRepo({ root: ROOT, worktrees })]
}

/** 시계·타이머를 손으로. `fire` = 걸린 타이머를 지금 실행한다(관측 없이 — 재시도 타이머 경로). */
function clocked({ registry, service }: { registry: () => RepoRegistry; service: WorkService }) {
  let clock = 2_000_000_000_000
  const timers: { run: () => void; at: number }[] = []
  const links = new WorkLinks({ registry, work: () => service, log: () => {}, now: () => clock, schedule: (run, ms) => { timers.push({ run, at: clock + ms }) }, generation: () => 'g1' })
  return {
    links,
    tick: (ms: number) => { clock += ms },
    observe: async (repos: RepoRow[]) => { links.observe(links.annotate(repos)); await links.migrationsSettled() },
    fire: async () => { for (const timer of timers.splice(0)) if (timer.at <= clock) timer.run(); await links.migrationsSettled() },
  }
}

const remoteRows = (fixture: LaMcpFixture, key: string) => fixture.workLinks.filter((row) => row.key === key)
const toolCount = (fixture: LaMcpFixture, tool: string) => fixture.requests.filter((request) => request.tool === tool).length

describe('X1-1 자동 연결 떼기도 LA 에서 지운다', () => {
  it('자동 연결 → 출처 저장 → 떼기 → 같은 machine 으로 remove · 원격 행 0 · sourceLink saved', async () => {
    const r = await rig()
    const run = clocked({ registry: registryFor({ connectionId: r.connectionId, explicit: false }), service: r.service })
    await run.observe(rows({ auto: true }))
    expect(remoteRows(r.fixture, AUTO_WT)).toHaveLength(1)
    const result = await run.links.detach({ worktree: testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' }), repoRoot: ROOT })
    expect(result).toMatchObject({ ok: true, mode: 'auto', sourceLink: { state: 'saved' } })
    expect(r.fixture.workLinkArgs.at(-1)).toEqual({ tool: 'issue_work_link_remove', args: { issueId: FIXTURE_IDS.task601, link: { kind: 'worktree', path: AUTO_WT, repoRoot: ROOT }, machine: 'corral-test-mac' } })
    expect(remoteRows(r.fixture, AUTO_WT)).toHaveLength(0)
  })

  it('지우기 실패 → sourceLink failed + 활동 「출처 저장 실패」 · 로컬 떼기는 그대로', async () => {
    const r = await rig()
    const registry = registryFor({ connectionId: r.connectionId, explicit: false })
    const run = clocked({ registry, service: r.service })
    await run.observe(rows({ auto: true }))
    r.fixture.toolFaults.set('issue_work_link_remove', { kind: 'http', status: 502, body: '{}' })
    const result = await run.links.detach({ worktree: testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' }), repoRoot: ROOT })
    expect(result).toMatchObject({ ok: true, mode: 'auto', sourceLink: { state: 'failed' } })
    expect(registry().metadata()[AUTO_WT]).toEqual({ workLinkSuppressed: true })
    const events = r.activity.list({ connectionId: r.connectionId, itemId: '', itemKey: 'LIFE-601' }).map((row) => (row.change.field === 'run' ? row.change.event : null))
    expect(events).toEqual(['auto_link', 'detach', 'source_link_failed'])
  })

  it('이 실행에서 연결을 아직 안 쓴 상태의 떼기도 지운다(클라이언트를 만든다 — 사용자 동작) · 능력 꺼진 출처는 요청 0 · skipped', async () => {
    const first = await rig()
    first.fixture.plantWorkLink({ issueId: FIXTURE_IDS.task601, link: { kind: 'worktree', path: AUTO_WT, repoRoot: ROOT }, machine: 'corral-test-mac', repo: 'corral' })
    const service = restart({ r: first })
    const links = new WorkLinks({ registry: registryFor({ connectionId: first.connectionId, explicit: false }), work: () => service, log: () => {}, schedule: () => {} })
    const result = await links.detach({ worktree: testWorktree({ path: AUTO_WT, branch: 'refs/heads/LIFE-601-auto' }), repoRoot: ROOT })
    expect(result).toMatchObject({ sourceLink: { state: 'saved' } })
    expect(remoteRows(first.fixture, AUTO_WT)).toHaveLength(0)

    const state = seedMockState()
    const mock = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await mock.service.addConnection({ sourceId: 'mock-jira', token: `${FAKE_MOCK_TOKEN}-cap-workLinkStore-off`, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const off = new WorkLinks({ registry: registryFor({ connectionId: added.connection.id, explicit: false }), work: () => mock.service, log: () => {}, schedule: () => {} })
    const coreWt = `${ROOT}/.claude/worktrees/CORE-1-x`
    const skipped = await off.detach({ worktree: testWorktree({ path: coreWt, branch: 'refs/heads/CORE-1-x' }), repoRoot: ROOT })
    expect(skipped).toMatchObject({ ok: true, mode: 'auto', sourceLink: { state: 'skipped' } })
    expect(state.linkWrites ?? []).toEqual([])
  })
})

describe('X1-2 떼기가 마지막 연산 — 진행 중 이관 add 뒤에 지운다', () => {
  it('이관 add 가 250ms 늦는 사이 떼기 → 원격 행 0 · 마지막 도구 = remove · 이후 시간이 지나도 add 0', async () => {
    const r = await rig()
    const registry = registryFor({ connectionId: r.connectionId, explicit: true })
    const run = clocked({ registry, service: r.service })
    r.fixture.toolFaults.set('issue_work_link_add', { kind: 'delay', ms: 250 })
    run.links.observe(run.links.annotate(rows({ explicit: true })))
    for (let index = 0; index < 50 && toolCount(r.fixture, 'issue_work_link_add') === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(1)
    const result = await run.links.detach({ worktree: testWorktree({ path: WT, branch: 'refs/heads/LIFE-600-x' }), repoRoot: ROOT })
    expect(result).toMatchObject({ ok: true, mode: 'explicit', sourceLink: { state: 'saved' } })
    // 떼기 직후 낡은 트리(아직 링크가 보이는) 관측이 와도 다시 보내지 않는다.
    await run.observe(rows({ explicit: true }).map((repo) => ({ ...repo, worktrees: repo.worktrees.map((row) => ({ ...row, workLink: { mode: 'explicit' as const, sourceId: 'la', connectionId: r.connectionId, key: 'LIFE-600', itemId: FIXTURE_IDS.task600, connected: true } })) })))
    r.fixture.toolFaults.clear()
    for (let index = 0; index < 4; index += 1) { run.tick(MIGRATE_RETRY_MS * 4); await run.observe(rows({ explicit: true })); await run.fire() }
    expect(remoteRows(r.fixture, WT)).toHaveLength(0)
    expect(r.fixture.workLinkArgs.map((row) => row.tool)).toEqual(['issue_work_link_add', 'issue_work_link_remove'])
  })
})

describe('X1-3 machine 은 조회 일시 실패로 바뀌지 않는다 — 처음 정한 값을 userData 파일에', () => {
  const failing = () => readMacName({ exec: async () => null, hostname: () => 'review-host.local' })
  const working = () => readMacName({ exec: async () => 'Review Mac\n', hostname: () => 'review-host.local' })

  it('첫 실행 조회 실패(hostname) → 다음 실행 조회 성공이어도 같은 machine · 새 서비스의 remove 가 첫 행을 지운다', async () => {
    const dir = tempDir('l635r1-ud-')
    const a = await rig({ machine: persistedMachine({ dir, read: failing }) })
    await a.service.storeLink({ connectionId: a.connectionId, itemId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: WT, repoRoot: ROOT }, action: 'save' })
    const service = restart({ r: a, machine: persistedMachine({ dir, read: working }) })
    await service.storeLink({ connectionId: a.connectionId, itemId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: WT, repoRoot: ROOT }, action: 'remove' })
    expect(a.fixture.workLinkArgs.map((row) => row.args.machine)).toEqual(['review-host', 'review-host'])
    expect(remoteRows(a.fixture, WT)).toHaveLength(0)
    expect(JSON.parse(fs.readFileSync(path.join(dir, MACHINE_FILE), 'utf8'))).toEqual({ version: 1, machine: 'review-host' })
  })

  it('양성 대조 — 파일이 없으면 실행마다 조회값을 쓴다(첫 성공 → 그 값 고정, 뒤 실패에도 그대로) · 깨진 파일은 다시 정한다', async () => {
    const dir = tempDir('l635r1-ud-')
    expect(await persistedMachine({ dir, read: working })()).toBe('Review Mac')
    expect(await persistedMachine({ dir, read: failing })()).toBe('Review Mac')
    fs.writeFileSync(path.join(dir, MACHINE_FILE), '{broken')
    expect(await persistedMachine({ dir, read: failing })()).toBe('review-host')
    // 저장 없이 매번 읽는 옛 동작이면 두 실행이 갈린다(리뷰 P3 조건).
    expect([await failing(), await working()]).toEqual(['review-host', 'Review Mac'])
  })
})

describe('X1-4 자격 세대를 시도 전체에 고정 — 교체 중 실패를 옛 세대로 적지 않는다', () => {
  it('machine 대기 중 읽기 전용 토큰으로 교체 → 그 시도는 보내지 않음 · 새 토큰 add 1회(forbidden) 뒤 재전송 0', async () => {
    let release: (name: string) => void = () => {}
    const gate = new Promise<string>((resolve) => { release = resolve })
    const r = await rig({ machine: () => gate })
    const run = clocked({ registry: registryFor({ connectionId: r.connectionId, explicit: true }), service: r.service })
    run.links.observe(run.links.annotate(rows({ explicit: true })))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const replaced = await r.service.addConnection({ sourceId: 'la', token: FAKE_LA_READ_TOKEN, replaceId: r.connectionId })
    expect(replaced.ok).toBe(true)
    release('corral-test-mac')
    await run.links.migrationsSettled()
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(0)
    for (let index = 0; index < 5; index += 1) { run.tick(MIGRATE_RETRY_MS * 8); await run.observe(rows({ explicit: true })); await run.fire() }
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(1)
    expect(r.fixture.requests.filter((request) => request.tool === 'issue_work_link_add').map((request) => request.bearer)).toEqual(['life_pat'])
    expect(remoteRows(r.fixture, WT)).toHaveLength(0)
  })

  it('세대가 바뀐 시도의 결과는 실패가 아니라 later — 실패 세대 = 실제로 쓴 자격', async () => {
    let release: (name: string) => void = () => {}
    const gate = new Promise<string>((resolve) => { release = resolve })
    const r = await rig({ machine: () => gate })
    const pending = r.service.migrateLink({ connectionId: r.connectionId, itemId: FIXTURE_IDS.task600, key: 'LIFE-600', link: { kind: 'worktree', path: WT, repoRoot: ROOT } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await r.service.addConnection({ sourceId: 'la', token: FAKE_LA_READ_TOKEN, replaceId: r.connectionId })
    release('corral-test-mac')
    expect(await pending).toEqual({ state: 'later' })
    const next = await r.service.migrateLink({ connectionId: r.connectionId, itemId: FIXTURE_IDS.task600, key: 'LIFE-600', link: { kind: 'worktree', path: WT, repoRoot: ROOT } })
    expect(next).toMatchObject({ state: 'failed', retry: false, generation: r.service.credentialGeneration(r.connectionId) })
  })
})

describe('X1-5 보내는 machine 은 LA 정규화(trim)와 같은 꼴 — 화면 합치기 비교는 work-links-model.test.ts', () => {
  it('64자째가 공백인 컴퓨터 이름 — 보내는 machine 끝 공백 없음 · LA 에 저장된 machine 과 글자로 같다(리뷰 P12 조건)', async () => {
    const raw = `${'A'.repeat(63)} B`
    const r = await rig({ machine: () => readMacName({ exec: async () => raw, hostname: () => 'h' }) })
    expect((await readMacName({ exec: async () => raw, hostname: () => 'h' })).endsWith(' ')).toBe(true)
    const machine = await r.service.machine()
    expect(machine).toBe('A'.repeat(63))
    expect(r.service.settings().machine).toBe(machine)
    await r.service.storeLink({ connectionId: r.connectionId, itemId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: WT, repoRoot: ROOT }, action: 'save' })
    expect(r.fixture.workLinkArgs[0]?.args.machine).toBe(machine)
    expect(r.fixture.workLinks.map((row) => row.machine)).toEqual([machine])
  })
})

describe('X1-6 기존 자동 링크 — 과거 사건이 없어도 실패하면 같은 상한·간격으로 다시', () => {
  it('과거 사건 없음 + 첫 add 503 → 간격 뒤 복구된 서버에 저장(LA 행 1) · 실패 활동은 자동 연결 열쇠로 1줄', async () => {
    const r = await rig()
    const run = clocked({ registry: registryFor({ connectionId: r.connectionId, explicit: false }), service: r.service })
    r.fixture.toolFaults.set('issue_work_link_add', { kind: 'http', status: 503, body: '{}' })
    await run.observe(rows({ auto: true }))
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(1)
    r.fixture.toolFaults.clear()
    await run.observe(rows({ auto: true }))
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(1)
    run.tick(MIGRATE_RETRY_MS)
    await run.observe(rows({ auto: true }))
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(2)
    expect(remoteRows(r.fixture, AUTO_WT)).toHaveLength(1)
    const failures = r.activity.list({ connectionId: r.connectionId, itemId: '', itemKey: 'LIFE-601' }).filter((row) => row.change.field === 'run' && row.change.event === 'source_link_failed')
    expect(failures.map((row) => row.eventKey)).toEqual([`run:srcfail:run:auto:${r.connectionId}:LIFE-601:${AUTO_WT}:g1`])
  })

  it('재시도 타이머만으로도 다시 보낸다(관측 없이 — 리뷰 M15)', async () => {
    const r = await rig()
    const run = clocked({ registry: registryFor({ connectionId: r.connectionId, explicit: true }), service: r.service })
    r.fixture.toolFaults.set('issue_work_link_add', { kind: 'http', status: 503, body: '{}' })
    await run.observe(rows({ explicit: true }))
    r.fixture.toolFaults.clear()
    run.tick(MIGRATE_RETRY_MS)
    await run.fire()
    expect(toolCount(r.fixture, 'issue_work_link_add')).toBe(2)
    expect(remoteRows(r.fixture, WT)).toHaveLength(1)
  })
})

describe('X1-7 LA fixture 는 LA 규칙(issue-work-link.rules)대로 거절·정규화한다', () => {
  const plant = (fixture: LaMcpFixture, link: Record<string, unknown>, extra: { machine?: unknown; repo?: unknown } = {}) =>
    fixture.plantWorkLink({ issueId: FIXTURE_IDS.task600, link, machine: extra.machine ?? null, repo: extra.repo ?? null })

  it('경계 입력 — 상한 초과·비문자열 부가 값·제어 문자·PR url(new URL + http(s)) 는 거절 · 상한 안은 통과', async () => {
    const r = await rig()
    const f = r.fixture
    expect(() => plant(f, { kind: 'worktree', path: '/p', repoRoot: null }, { repo: 'r'.repeat(201) })).toThrow(/repo 가 너무 깁니다/)
    expect(() => plant(f, { kind: 'worktree', path: '/p2', repoRoot: null }, { repo: 'r'.repeat(200) })).not.toThrow()
    expect(() => plant(f, { kind: 'worktree', path: '/p3', repoRoot: 42 })).toThrow(/repoRoot 은 문자열/)
    expect(() => plant(f, { kind: 'worktree', path: `/${'x'.repeat(1024)}` })).toThrow(/path 가 너무 깁니다/)
    expect(() => plant(f, { kind: 'worktree', path: `/${'x'.repeat(1023)}`, repoRoot: null })).not.toThrow()
    expect(() => plant(f, { kind: 'worktree', path: '/p4', repoRoot: null }, { machine: 'a\nb' })).toThrow(/machine 에 제어 문자/)
    expect(() => plant(f, { kind: 'worktree', path: '/p5', repoRoot: null }, { machine: 'm'.repeat(101) })).toThrow(/machine 가 너무 깁니다/)
    expect(() => plant(f, { kind: 'worktree', path: '/p6', repoRoot: null }, { machine: 7 })).toThrow(/machine 은 문자열/)
    expect(() => plant(f, { kind: 'pull_request', url: 'https://', state: null })).toThrow(/http\(s\)/)
    expect(() => plant(f, { kind: 'pull_request', url: 'ftp://x/1', state: null })).toThrow(/http\(s\)/)
    expect(() => plant(f, { kind: 'pull_request', url: 'https://x/1', state: 'draft' })).toThrow(/state/)
    expect(() => plant(f, { kind: 'pull_request', url: 'https://x/1', state: 'open' })).not.toThrow()
    expect(() => plant(f, { kind: 'agent_session', sessionId: 's', agent: 'a'.repeat(101) })).toThrow(/agent 가 너무 깁니다/)
  })

  it('trim 동등 — 핵심 값·machine 앞뒤 공백은 같은 행 · 재추가는 부가 값·repo 통째 교체(생략 = null)', async () => {
    const r = await rig()
    const client = laSourceEntry({ url: r.url, clientVersion: 'test' }).create({ token: FAKE_LA_TOKEN, account: {} })
    const save = (link: WorkLink, machine: string, repo: string | null) => client.call({ op: 'saveWorkLink', itemId: FIXTURE_IDS.task600, link, machine, repo }, { writeId: null })
    await save({ kind: 'worktree', path: ' /t/p ', repoRoot: '/t' }, ' mac ', 'corral')
    await save({ kind: 'worktree', path: '/t/p', repoRoot: null }, 'mac', null)
    expect(r.fixture.workLinks.map((row) => ({ key: row.key, machine: row.machine, extra: row.extra, repo: row.repo }))).toEqual([{ key: '/t/p', machine: 'mac', extra: { repoRoot: null }, repo: null }])
    const removed = await client.call({ op: 'removeWorkLink', itemId: FIXTURE_IDS.task600, link: { kind: 'worktree', path: '/t/p  ', repoRoot: null }, machine: ' mac' }, { writeId: null })
    expect(removed.ok && removed.result.op === 'removeWorkLink' ? removed.result.workLinks : null).toEqual([])
  })

  it('모의 출처 판별도 같은 정규화 — 공백 다른 같은 링크는 한 행, 지우기가 찾는다', async () => {
    const state = seedMockState()
    const client = mockSourceEntry({ state }).create({ token: FAKE_MOCK_TOKEN, account: {} })
    await client.call({ op: 'saveWorkLink', itemId: 'm-1', link: { kind: 'worktree', path: '/t/p ', repoRoot: null }, machine: 'mac ', repo: null }, { writeId: null })
    await client.call({ op: 'saveWorkLink', itemId: 'm-1', link: { kind: 'worktree', path: '/t/p', repoRoot: null }, machine: 'mac', repo: null }, { writeId: null })
    expect(state.items.find((item) => item.id === 'm-1')?.workLinks).toHaveLength(1)
    await client.call({ op: 'removeWorkLink', itemId: 'm-1', link: { kind: 'worktree', path: ' /t/p', repoRoot: null }, machine: ' mac' }, { writeId: null })
    expect(state.items.find((item) => item.id === 'm-1')?.workLinks).toEqual([])
  })
})
