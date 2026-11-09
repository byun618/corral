// 세션 전환(`←`) 전에 열린 백그라운드 작업의 수명 (LIFE-781) — 판독층 입구(`readSessionDigest`)를 실제 파일·레지스트리로 부른다.
// HOME 은 매번 임시 폴더다(사용자 HOME 을 안 만진다).
//
// **실표본**: `fixtures/lifecycle-handoff/` 는 Claude Code 2.1.296 실기 두 번(사전 실측 Run B·C — corral-specs
// `LIFE-781-background-task-lifetime/raw/claude/pre/`)의 옛·새 세션 파일을 가린 사본이다(`scripts/mask-handoff-fixture.py`).
// 줄 순서·type·시각 간격·수명 키·통지 status·continued-in 대상은 실물이고, id·글·경로는 지어낸 값이다.
// 레지스트리(`*-registry.json`)의 startedAt 은 실측 값을 같은 만큼 평행 이동한 것이다. pid 는 이 시험 프로세스로 바꿔 「살아 있음」을 만든다.
// - shell-monitor: 백그라운드 셸(task-1) + Monitor(task-0) → `←`(Monitor 멈춤 확인) → Enter → 첫 입력 → 옛 pane 닫기 → 셸 끝 통지
// - subagent: 실제로 도는 비동기 서브에이전트(task-0) → `←`(「1 local agent running — they will be stopped」) → 첫 입력
// 이름에 「합성」이 붙은 시험만 손으로 지은 줄을 쓴다 — 실제 근거로 세지 않는다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMonitoring } from '../shared/lifecycle'
import type { AgentSessionRef, SessionLifecycle } from '../shared/types'
import { LIFECYCLE_READ_MAX_BYTES } from './transcript-lifecycle'
import { clearTranscriptCache, readSessionDigest, readSessionDigests } from './transcript'

const FIXTURES = path.join(__dirname, 'fixtures', 'lifecycle-handoff')
type Registry = { old: { sessionId: string; startedAt: number }; bg: { sessionId: string; startedAt: number } }
type Sample = { old: string[]; next: string[]; registry: Registry }

function sample(name: string): Sample {
  const lines = (suffix: string) => fs.readFileSync(path.join(FIXTURES, `${name}-${suffix}.jsonl`), 'utf8').split('\n').filter((line) => line !== '')
  const registry: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}-registry.json`), 'utf8'))
  if (!isRegistry(registry)) throw new Error('registry 모양')
  return { old: lines('old'), next: lines('new'), registry }
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === 'object' && value !== null && 'old' in value && 'bg' in value
}

const typeOf = (line: string): unknown => {
  const record: unknown = JSON.parse(line)
  return typeof record === 'object' && record !== null && 'type' in record ? record.type : null
}
/** 조건을 만족하는 첫 줄 번호 — 없으면 시험이 틀렸다. */
function indexWhere(input: { lines: string[]; match: (line: string) => boolean; from?: number }): number {
  const index = input.lines.findIndex((line, at) => at >= (input.from ?? 0) && input.match(line))
  if (index === -1) throw new Error('표본에 그 줄이 없다')
  return index
}
const isConversation = (line: string) => typeOf(line) === 'user' || typeOf(line) === 'assistant'

let home = ''
let realHome: string | undefined
let dir = ''

beforeEach(() => {
  realHome = process.env['HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l781-'))
  process.env['HOME'] = home
  dir = path.join(home, '.claude', 'projects', '-tmp-x')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
  clearTranscriptCache()
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
})

const write = (input: { sessionId: string; lines: string[] }) => fs.writeFileSync(path.join(dir, `${input.sessionId}.jsonl`), `${input.lines.join('\n')}\n`)

/** 레지스트리 항목 — 관측된 키(`kind`·`parkedJobId`·`jobId`)를 그대로 적는다. 판독은 `pid`·`sessionId`·`startedAt` 만 쓴다. */
function register(input: { name: 'old' | 'bg'; registry: Registry; alive: boolean; kind?: string }) {
  const entry = input.registry[input.name]
  const file = path.join(home, '.claude', 'sessions', `${input.name}.json`)
  if (!input.alive) {
    fs.rmSync(file, { force: true })
    return
  }
  const job = input.registry.bg.sessionId.slice(0, 8)
  const shape = input.name === 'old' ? { kind: 'interactive', parkedJobId: job, jobId: null } : { kind: input.kind ?? 'bg', parkedJobId: null, jobId: job }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: entry.sessionId, status: 'shell', startedAt: entry.startedAt, ...shape }))
}

function known(lifecycle: SessionLifecycle) {
  if (lifecycle.state !== 'known') throw new Error(`known 이 아니다: ${JSON.stringify(lifecycle)}`)
  return lifecycle
}

const refOf = (registry: Registry): AgentSessionRef => ({ kind: 'id', agent: 'claude', source: 'herdr:claude', id: registry.old.sessionId })
const lifeOf = (registry: Registry) => readSessionDigest(refOf(registry)).digest.lifecycle
const taskIds = (registry: Registry) => known(lifeOf(registry)).tasks.map((task) => task.id)
const monitoring = (lifecycle: SessionLifecycle) => isMonitoring({ agentStatus: 'idle', turnOutcome: null, lifecycle })

describe('C1 전환 구간 판독 (실표본 shell-monitor) — 전환 전에 연 셸이 도는 동안 목록에 남는다', () => {
  const { old, next, registry } = sample('shell-monitor')
  const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
  const metaEnd = indexWhere({ lines: next, match: isConversation })
  const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })

  it('표본 확인 — 전환 전에는 셸·Monitor 둘 다 열려 있고, 옛 파일 끝은 cost-state → Monitor killed → continued-in → (pane 닫기) cost-state', () => {
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, costAt) })
    register({ name: 'old', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1', 'task-0'])
    expect(old.slice(costAt, continuedAt + 1).map(typeOf)).toEqual(['cost-state', 'last-prompt', 'ai-title', 'mode', 'permission-mode', 'atis-latch', 'queue-operation', 'continued-in'])
    expect(old.slice(costAt).some((line) => line.includes('<task-id>task-0</task-id>') && line.includes('<status>killed</status>'))).toBe(true)
    expect(old.slice(continuedAt + 1).map(typeOf)).toEqual(['cost-state'])
  })

  it('ⓐ `←` 직후 — 옛 파일 끝 cost-state·continued-in, 새 파일은 메타뿐(옛 파일에 머묾) → 셸은 있고 멈춘 Monitor 는 없다', () => {
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, metaEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const lifecycle = lifeOf(registry)
    expect(known(lifecycle).tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(monitoring(lifecycle)).toBe(true)
  })

  it('ⓑ Enter 복귀 뒤 첫 입력 전 — 기록은 그대로, 판독을 거듭해도(캐시·빠른 반환) 셸이 남는다', () => {
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, metaEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    for (let round = 0; round < 3; round += 1) expect(taskIds(registry)).toEqual(['task-1'])
  })

  it('ⓒ 첫 입력 뒤 — 새 파일로 옮김(옛 대화가 원래 시각으로 복사, 세대 경계 = bg 시작) → 셸은 있고 Monitor(새 파일 stopped)는 없다', () => {
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const lifecycle = lifeOf(registry)
    expect(known(lifecycle).tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(known(lifecycle).tasks[0]!.startedAt).toBeLessThan(registry.bg.startedAt) // 경계 앞의 항목이다
    expect(monitoring(lifecycle)).toBe(true)
    clearTranscriptCache() // 캐시 없이(앞 파일 장부를 처음부터) 읽어도 같다
    expect(taskIds(registry)).toEqual(['task-1'])
  })

  it('ⓓ 새 파일의 <task-notification> 뒤 — 없다', () => {
    write({ sessionId: registry.old.sessionId, lines: old })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1'])
    write({ sessionId: registry.bg.sessionId, lines: next })
    const lifecycle = lifeOf(registry)
    expect(known(lifecycle).tasks).toEqual([])
    expect(monitoring(lifecycle)).toBe(false)
  })
})

describe('C2 다른 종류 — 목록 = 실제 생존 (실표본)', () => {
  it('ⓐ 실제로 도는 비동기 서브에이전트는 `←` 때 멈췄다(실측) — 전환 직후·첫 입력 뒤 모두 작업·자식 행에 없다', () => {
    const { old, next, registry } = sample('subagent')
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, costAt) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const before = known(lifeOf(registry))
    expect(before.subagents.map((row) => row.id)).toEqual(['task-0'])
    expect(old.slice(costAt).some((line) => line.includes('<task-id>task-0</task-id>') && line.includes('<status>killed</status>'))).toBe(true)
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
    write({ sessionId: registry.bg.sessionId, lines: next })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
  })

  it('ⓑ Monitor 는 `Background this session?` 확인 뒤 멈췄다(실측) — 전환 직후(옛 파일 killed)·첫 입력 뒤(새 파일 stopped) 모두 없다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(known(lifeOf(registry)).tasks.map((task) => task.kind)).toEqual(['shell'])
    // 새 파일의 Monitor stopped 통지 바로 앞까지 — 복사분에 Monitor 가 열려 있어도 옛 파일이 넘기지 않았으니 싣지 않는다
    const stoppedAt = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-0</task-id>') && line.includes('<status>stopped</status>') })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, stoppedAt) })
    expect(known(lifeOf(registry)).tasks.map((task) => task.kind)).toEqual(['shell'])
  })
})

describe('C3 재개 계약 유지', () => {
  it('ⓒ 전환 뒤 옛 pane 을 닫아 옛 대화형 프로세스가 죽어도 셸은 살았다(실측 ppid→1) — 이어 받은 세션이 사는 동안 남는다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
    write({ sessionId: registry.old.sessionId, lines: old }) // 닫을 때 찍힌 두 번째 cost-state 까지
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'old', registry, alive: false })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1'])
    // 이어 받은 세션까지 죽으면 끝 통지를 쓸 쪽이 없다 — 지금처럼 not-running(거짓 「지켜보는 중」 없음)
    register({ name: 'bg', registry, alive: false })
    expect(lifeOf(registry)).toEqual({ state: 'unknown', reason: 'not-running' })
  })

  it('ⓒ 첫 입력 전에 옛 pane 을 닫아도 — 옛 파일에 머무는 동안 넘긴 셸의 주인은 이어 받은 세션이다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    register({ name: 'old', registry, alive: false })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1'])
    // 이어 받은 세션이 없으면(옛 프로세스만 산다) 넘긴 것은 싣지 않는다 — 끝 통지를 받을 쪽이 없다
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: false })
    expect(taskIds(registry)).toEqual([])
  })

  it('ⓐ 전환 뒤 같은 파일을 재개하면(continued-in 뒤 사람 줄, 새 소유자) 넘긴 것은 버린다 — 이어 받은 세션이 살아 있어도', () => {
    const { old, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const human = old[indexWhere({ lines: old, match: (line) => typeOf(line) === 'user' && line.includes('가린 지시') })]!
    write({ sessionId: registry.old.sessionId, lines: [...old, human] })
    const resumed = { ...registry, old: { ...registry.old, startedAt: registry.bg.startedAt + 600_000 } }
    register({ name: 'old', registry: resumed, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(old.length).toBeGreaterThan(continuedAt)
    expect(taskIds(registry)).toEqual([])
  })

  it('ⓑ 합성 — continued-in 이 없는 cost-state(정상 종료)는 지금처럼 닫는다, 뒤에 통지만 와도 되살리지 않는다', () => {
    const { old, registry } = sample('shell-monitor')
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, costAt + 1) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual([])
  })

  it('합성 — 관측 밖 모양(cost-state 없이 온 continued-in · 모양이 아닌 대상 id)은 아무것도 넘기지 않는다(지금 동작)', () => {
    const { old, registry } = sample('shell-monitor')
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    const continued = old[indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })]!
    // cost-state 없이 continued-in — 열린 것은 옛 소유자 몫으로 남는다(넘기지 않는다)
    write({ sessionId: registry.old.sessionId, lines: [...old.slice(0, costAt), continued] })
    register({ name: 'old', registry, alive: false })
    register({ name: 'bg', registry, alive: true })
    expect(lifeOf(registry)).toEqual({ state: 'unknown', reason: 'not-running' })
    clearTranscriptCache()
    write({ sessionId: registry.old.sessionId, lines: [...old.slice(0, costAt + 1), continued.replace(registry.bg.sessionId, 'not-a-session-id')] })
    expect(lifeOf(registry)).toEqual({ state: 'unknown', reason: 'not-running' })
  })
})

describe('C5 판독 비용 — 앞 파일 장부는 기존 계정에 잡히고, 바뀌지 않으면 0바이트', () => {
  it('첫 입력 뒤 처음 보는 참조: 새 파일 + 앞 파일을 각자 ≤2MB 로 세고, 다음 주기 0바이트, 옛 pane 닫기(cost-state 한 줄)는 그 줄 + 닻만', () => {
    const { old, next, registry } = sample('shell-monitor')
    const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
    const oldLines = old.slice(0, -1) // 닫기 전
    write({ sessionId: registry.old.sessionId, lines: oldLines })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const refs = new Map([['p1', refOf(registry)]])
    const oldBytes = fs.statSync(path.join(dir, `${registry.old.sessionId}.jsonl`)).size
    const newBytes = fs.statSync(path.join(dir, `${registry.bg.sessionId}.jsonl`)).size
    const first = readSessionDigests(refs)
    expect(known(first.digests.get('p1')!.lifecycle).tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(first.cost.lifecycleBytes).toBe(oldBytes + newBytes)
    expect(first.cost.lifecycleMaxFileBytes).toBe(Math.max(oldBytes, newBytes))
    expect(first.cost.lifecycleMaxFileBytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
    expect(first.cost.lifecycleRegistryBytes).toBeGreaterThan(0)
    const second = readSessionDigests(refs)
    expect(second.cost.lifecycleBytes).toBe(0)
    expect(second.cost.statOnly).toBe(1)
    // 옛 pane 닫기 — 앞 파일에 cost-state 한 줄이 붙고 옛 프로세스가 사라진다
    const closing = `${old.at(-1)!}\n`
    fs.appendFileSync(path.join(dir, `${registry.old.sessionId}.jsonl`), closing)
    register({ name: 'old', registry, alive: false })
    const third = readSessionDigests(refs)
    expect(third.cost.lifecycleBytes).toBe(Buffer.byteLength(closing) + 1024)
    expect(known(third.digests.get('p1')!.lifecycle).tasks.map((task) => task.id)).toEqual(['task-1'])
  })
})

// === 수정 r1 (리뷰 r1 A~F) =============================================================

/** 표지 없는 큰 어시스턴트 줄 — 실표본 옛 파일 앞쪽에 끼워 크기만 키운다(합성). 보류 전이라 넘김 판정에 안 걸린다. */
const bigLines = (bytes: number) => {
  const lines: string[] = []
  for (let left = bytes; left > 0; left -= 500_000) {
    lines.push(JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(Math.min(500_000, left)) }] } }))
  }
  return lines
}

describe('F1 (리뷰 r1 A) 첫 입력으로 옮겨 갈 때·콜드 스타트 — 넘김을 모르는 동안 빈 known 을 내지 않는다', () => {
  const { old, next, registry } = sample('shell-monitor')
  const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
  const metaEnd = indexWhere({ lines: next, match: isConversation })
  const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
  // 합성 — 실표본 옛 파일 첫 줄 뒤에 표지 없는 줄 5MB 를 끼웠다(크기만 키움)
  const bigOld = [old[0]!, ...bigLines(5_000_000), ...old.slice(1, continuedAt + 1)]
  const refs = () => new Map([['p1', refOf(registry)]])
  const ids = (lifecycle: SessionLifecycle) => (lifecycle.state === 'known' ? lifecycle.tasks.map((task) => task.id).join(',') : `unknown:${lifecycle.reason}`)

  it('합성 앞 파일 5MB — 이미 따라가던 세션의 첫 입력 전후 연속 주기에 known 0건이 한 번도 없고, 옮긴 뒤 앞 파일은 다시 안 읽는다', () => {
    write({ sessionId: registry.old.sessionId, lines: bigOld })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, metaEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const seen: string[] = []
    for (let round = 0; round < 5; round += 1) seen.push(ids(readSessionDigests(refs()).digests.get('p1')!.lifecycle))
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) }) // 첫 입력 — 복사분이 붙는다
    const costs: number[] = []
    for (let round = 0; round < 5; round += 1) {
      const read = readSessionDigests(refs())
      seen.push(ids(read.digests.get('p1')!.lifecycle))
      costs.push(read.cost.lifecycleMaxFileBytes)
    }
    expect(seen.filter((value) => value === '')).toEqual([]) // known 0건 0회
    expect(seen.slice(0, 2)).toEqual(['unknown:catching-up', 'unknown:catching-up'])
    expect(seen.slice(-6)).toEqual(Array(6).fill('task-1'))
    // 옮긴 주기는 새 파일 증분만(앞 파일 5MB 를 다시 읽지 않는다), 그다음은 0
    expect(costs[0]).toBeLessThan(LIFECYCLE_READ_MAX_BYTES)
    expect(costs.slice(1)).toEqual([0, 0, 0, 0])
  })

  it('합성 앞 파일 5MB — 콜드 스타트(앞 장부가 메모리에 없음) 첫 주기들은 모름, known 0건 0회, 따라잡으면 셸', () => {
    write({ sessionId: registry.old.sessionId, lines: bigOld })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const seen: string[] = []
    const costs: number[] = []
    for (let round = 0; round < 6; round += 1) {
      const read = readSessionDigests(refs())
      seen.push(ids(read.digests.get('p1')!.lifecycle))
      costs.push(read.cost.lifecycleMaxFileBytes)
    }
    expect(seen.filter((value) => value === '')).toEqual([])
    expect(seen.slice(0, 2)).toEqual(['unknown:catching-up', 'unknown:catching-up'])
    expect(seen.at(-1)).toBe('task-1')
    expect(Math.max(...costs)).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
    expect(costs.at(-1)).toBe(0) // 따라잡은 뒤 무변경 0바이트
  })

  it('작은 실표본 — 첫 입력으로 옮긴 주기는 새 파일 증분만 읽고 앞 파일은 0바이트, 다음 주기 0', () => {
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, metaEnd) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    readSessionDigests(refs())
    const before = fs.statSync(path.join(dir, `${registry.bg.sessionId}.jsonl`)).size
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    const after = fs.statSync(path.join(dir, `${registry.bg.sessionId}.jsonl`)).size
    const switched = readSessionDigests(refs())
    expect(known(switched.digests.get('p1')!.lifecycle).tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(switched.cost.lifecycleBytes).toBe(after - before + Math.min(before, 1024)) // 새 파일 증분 + 닻, 앞 파일 0
    expect(readSessionDigests(refs()).cost.lifecycleBytes).toBe(0)
  })
})

describe('F2 (리뷰 r1 B) 넘김도 세대 경계를 지킨다', () => {
  it('합성 T1 꼴 — 소유 대화형 프로세스가 셸보다 늦게 떴다(강제 종료 뒤 재개한 프로세스)가 `←` 하면 그 셸은 넘기지 않는다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
    const shellAt = known(((): SessionLifecycle => {
      write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
      register({ name: 'old', registry, alive: true })
      register({ name: 'bg', registry, alive: true })
      return lifeOf(registry)
    })()).tasks[0]!.startedAt!
    clearTranscriptCache()
    const resumed = { ...registry, old: { ...registry.old, startedAt: shellAt + 1000 } }
    register({ name: 'old', registry: resumed, alive: true })
    expect(taskIds(registry)).toEqual([]) // 첫 입력 전
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    expect(taskIds(registry)).toEqual([]) // 첫 입력 뒤
  })
})

describe('F3 (리뷰 r1 C) Monitor 는 넘기지 않는다 — 전환 때 멈춘다(문서·실측)', () => {
  it('합성 T13 꼴 — 실표본에서 Monitor killed 통지만 뺀 옛 파일: 첫 입력 전·뒤 모두 Monitor 가 없다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const noKilled = old.slice(0, continuedAt + 1).filter((line, at) => !(at > costAt && line.includes('<status>killed</status>')))
    expect(noKilled.length).toBe(continuedAt) // 한 줄 뺐다
    write({ sessionId: registry.old.sessionId, lines: noKilled })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1'])
    const stoppedAt = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-0</task-id>') && line.includes('<status>stopped</status>') })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, stoppedAt) })
    expect(taskIds(registry)).toEqual(['task-1'])
  })
})

describe('F4·C2ⓐ (리뷰 r1 D) 전환 뒤 계속 도는 비동기 에이전트 — 실제 기록(2.1.296, 가림) · 레지스트리 시계는 합성(시계)', () => {
  // agent-continues: 비동기 에이전트(task-7)가 `←` 뒤 약 9분 30초 살아 끝났다. 끝 통지는 첫 입력 **전** 새 파일 queue-operation 으로 왔고,
  // 첫 입력 때 옛 대화가 그 뒤에 복사됐다. 레지스트리 startedAt 은 실측 값이 없어 지었다(합성) — 옛 대화형은 재개 무렵, bg 는 continued-in 직후.
  const { old, next, registry } = sample('agent-continues')
  const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
  const endAt = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-7</task-id>') && line.includes('<status>') })

  it('합성(시계) — 끝 통지 전(첫 입력 전 구간)에는 에이전트 작업·자식 행에 있고, 새 파일 끝 통지 뒤에는 없다 — 첫 입력 뒤 전체 파일에서도 없다', () => {
    expect(next.slice(0, endAt + 1).some(isConversation)).toBe(false) // 통지가 복사보다 먼저다
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, endAt) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const running = known(lifeOf(registry))
    expect(running.tasks.map((task) => `${task.id}:${task.kind}`)).toEqual(['task-7:agent'])
    expect(running.subagents.map((row) => row.id)).toEqual(['task-7'])
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, endAt + 1) })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
    write({ sessionId: registry.old.sessionId, lines: old })
    write({ sessionId: registry.bg.sessionId, lines: next })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
  })
})

describe('F5 (리뷰 r1 E) 넘김 주인은 이어 받은 bg 항목뿐', () => {
  it('같은 id 의 kind:interactive 항목(bg 가 죽은 뒤 --resume)은 주인이 아니다 — 첫 입력 전·뒤', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true, kind: 'interactive' })
    expect(taskIds(registry)).toEqual([])
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    expect(taskIds(registry)).toEqual([])
  })
})

describe('F6 (리뷰 r1 F) 보류 중에 오는 통지 user 줄은 재개가 아니다', () => {
  it('합성 — cost-state 와 continued-in 사이의 통지 user 줄(실제 기록 1085 중 1건 관측 꼴)은 보류분을 버리지 않는다', () => {
    const { old, registry } = sample('shell-monitor')
    const costAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'cost-state' })
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const notice = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:03:32.300Z',
      sessionId: registry.old.sessionId,
      message: { role: 'user', content: '<task-notification>\n<task-id>task-x</task-id>\n<status>killed</status>\n<summary>가림</summary>\n</task-notification>' },
    })
    write({ sessionId: registry.old.sessionId, lines: [...old.slice(0, costAt + 1), notice, ...old.slice(costAt + 1, continuedAt + 1)] })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual(['task-1'])
  })
})

// === 수정 r2 (리뷰 r2 A~D) =============================================================

const C_ID = '00000000-0000-4000-8000-0000000000c3'

/** 이어 받은 세션 C 의 bg 항목(합성) — 관측된 키 모양. */
function registerC(input: { startedAt: number }) {
  fs.writeFileSync(
    path.join(home, '.claude', 'sessions', 'c.json'),
    JSON.stringify({ pid: process.pid, sessionId: C_ID, kind: 'bg', status: 'shell', startedAt: input.startedAt, parkedJobId: null, jobId: C_ID.slice(0, 8) }),
  )
}

describe('F1 (리뷰 r2 A) 연쇄 `←` — 이어 받은 파일에서 다시 cost-state 가 와도 넘겨받은 셸을 다음 보류분으로 이어 넘긴다', () => {
  const { old, next, registry } = sample('shell-monitor')
  const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
  const metaEnd = indexWhere({ lines: next, match: isConversation })
  const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
  // 합성 — 실표본 B(첫 입력까지) 끝에 두 번째 전환(cost-state → continued-in C)을 붙이고, C 는 메타뿐/대화 복사로 짓는다
  const secondHop = [
    JSON.stringify({ type: 'cost-state', sessionId: registry.bg.sessionId }),
    JSON.stringify({ type: 'continued-in', timestamp: '2026-01-01T00:05:00.000Z', sessionId: registry.bg.sessionId, continuedInSessionId: C_ID }),
  ]
  const cMeta = [JSON.stringify({ type: 'mode', sessionId: C_ID })]
  const cCopy = next.slice(metaEnd, shellEnd).map((line) => line.split(registry.bg.sessionId).join(C_ID))
  const setup = () => {
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
  }

  it('합성 — B 가 살아 있는 bg(셸보다 늦게 뜸)로 두 번째 `←`: C 가 빈 대상·대화 복사·콜드 판독 모두 셸이 남는다', () => {
    setup()
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    expect(taskIds(registry)).toEqual(['task-1'])
    registerC({ startedAt: registry.bg.startedAt + 60_000 })
    write({ sessionId: registry.bg.sessionId, lines: [...next.slice(0, shellEnd), ...secondHop] })
    write({ sessionId: C_ID, lines: cMeta })
    expect(taskIds(registry)).toEqual(['task-1']) // C 빈 대상 — B 에 머문다
    write({ sessionId: C_ID, lines: [...cMeta, ...cCopy] })
    expect(taskIds(registry)).toEqual(['task-1']) // C 로 옮김
    clearTranscriptCache()
    readSessionDigest(refOf(registry)) // 콜드 — 옆 파일을 처음부터
    expect(taskIds(registry)).toEqual(['task-1'])
  })

  it('합성 — 두 번째 전환 뒤 C 에 셸 끝 통지가 오면 빠진다', () => {
    setup()
    registerC({ startedAt: registry.bg.startedAt + 60_000 })
    write({ sessionId: registry.bg.sessionId, lines: [...next.slice(0, shellEnd), ...secondHop] })
    const end = next[shellEnd]!.split(registry.bg.sessionId).join(C_ID)
    write({ sessionId: C_ID, lines: [...cMeta, ...cCopy, end] })
    expect(taskIds(registry)).toEqual([])
  })
})

describe('F2 (리뷰 r2 B) 첫 입력 전 대상 파일의 한도보다 긴 줄 — 넘긴 것의 끝을 놓쳤을 수 있으면 모름', () => {
  it('합성 — 대상 파일에 task-1 끝 통지가 2MB 넘는 한 줄로 오면 도는 중이 아니라 모름, 짧은 끝 통지가 오면 풀린다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const metaEnd = indexWhere({ lines: next, match: isConversation })
    const notice = (summary: string) =>
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-01-01T00:04:00.000Z',
        sessionId: registry.bg.sessionId,
        content: `<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
      })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: [...next.slice(0, metaEnd), notice('z'.repeat(LIFECYCLE_READ_MAX_BYTES + 10_000))] })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    const seen: SessionLifecycle[] = []
    for (let round = 0; round < 4; round += 1) seen.push(lifeOf(registry))
    expect(seen.some((lifecycle) => lifecycle.state === 'known')).toBe(false)
    expect(seen.at(-1)).toEqual({ state: 'unknown', reason: 'unreadable' })
    fs.appendFileSync(path.join(dir, `${registry.bg.sessionId}.jsonl`), `${notice('가림')}\n`)
    expect(taskIds(registry)).toEqual([])
  })
})

describe('F3 (리뷰 r2 C) 콜드 스타트 — 기다려도 답이 안 바뀌면 앞 파일 따라잡기에 묶지 않는다', () => {
  it('합성 앞 파일 5MB — 이 파일에 경계 앞 열린 항목이 없으면(셸 끝난 뒤) 첫 주기부터 known', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    write({ sessionId: registry.old.sessionId, lines: [old[0]!, ...bigLines(5_000_000), ...old.slice(1, continuedAt + 1)] })
    write({ sessionId: registry.bg.sessionId, lines: next })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(known(lifeOf(registry)).tasks).toEqual([])
  })
})

describe('F4 (리뷰 r2 D) 변이 생존 가드를 묶는다', () => {
  it('합성(시계) M1 — 첫 입력 뒤, 복사가 다시 연 에이전트라도 복사 앞에서 끝 통지를 봤으면 싣지 않는다', () => {
    const { old, next, registry } = sample('agent-continues')
    const endAt = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-7</task-id>') && line.includes('<status>') })
    const reopened = indexWhere({ lines: next, match: (line) => line.includes('"agentId":"task-7"'), from: endAt })
    const copyEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-7</task-id>') && line.includes('<status>'), from: reopened })
    write({ sessionId: registry.old.sessionId, lines: old })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, copyEnd) })
    register({ name: 'bg', registry, alive: true })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
  })

  it('M2 — bg 항목의 jobId 가 대상 id 앞부분이 아니면 주인이 아니다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, indexWhere({ lines: next, match: isConversation })) })
    register({ name: 'old', registry, alive: true })
    const shifted = { ...registry, bg: { ...registry.bg, sessionId: registry.bg.sessionId } }
    register({ name: 'bg', registry: { ...shifted, bg: { ...shifted.bg } }, alive: true })
    const file = path.join(home, '.claude', 'sessions', 'bg.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`"jobId":"${registry.bg.sessionId.slice(0, 8)}"`, '"jobId":"ffffffff"'))
    expect(taskIds(registry)).toEqual([])
  })

  it('합성(시계) M3 — 서브에이전트도 세대를 거른다: 에이전트보다 늦게 뜬(재개한) 소유자가 `←` 하면 넘기지 않는다', () => {
    const { old, next, registry } = sample('agent-continues')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const endAt = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-7</task-id>') && line.includes('<status>') })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, endAt) })
    register({ name: 'old', registry: { ...registry, old: { ...registry.old, startedAt: registry.bg.startedAt - 1000 } }, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(known(lifeOf(registry))).toMatchObject({ tasks: [], subagents: [] })
  })

  it('합성 T1 꼴 콜드 — 첫 입력 뒤에 처음 읽어도(앞 파일을 소유자 시작 시각으로 읽는다) 옛 세대 셸은 없다', () => {
    const { old, next, registry } = sample('shell-monitor')
    const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
    const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
    write({ sessionId: registry.old.sessionId, lines: old.slice(0, continuedAt + 1) })
    write({ sessionId: registry.bg.sessionId, lines: next.slice(0, shellEnd) })
    register({ name: 'old', registry: { ...registry, old: { ...registry.old, startedAt: registry.bg.startedAt - 1000 } }, alive: true })
    register({ name: 'bg', registry, alive: true })
    expect(taskIds(registry)).toEqual([])
  })
})

// === 수정 r3 (리뷰 r3 A·B) =============================================================

describe('r3 원본이 큰 2홉 연쇄 콜드 — 원본을 따라잡는 동안 모름, 따라잡으면 셸(합성)', () => {
  const { old, next, registry } = sample('shell-monitor')
  const continuedAt = indexWhere({ lines: old, match: (line) => typeOf(line) === 'continued-in' })
  const metaEnd = indexWhere({ lines: next, match: isConversation })
  const shellEnd = indexWhere({ lines: next, match: (line) => line.includes('<task-id>task-1</task-id>') && line.includes('<status>') })
  // 합성 — 원본 A 에 표지 없는 줄 5MB 를 끼웠고, B 끝에 두 번째 전환을, C 는 메타뿐/B 대화 복사로 지었다
  const bigA = [old[0]!, ...bigLines(5_000_000), ...old.slice(1, continuedAt + 1)]
  const secondHop = [
    JSON.stringify({ type: 'cost-state', sessionId: registry.bg.sessionId }),
    JSON.stringify({ type: 'continued-in', timestamp: '2026-01-01T00:05:00.000Z', sessionId: registry.bg.sessionId, continuedInSessionId: C_ID }),
  ]
  const cMeta = [JSON.stringify({ type: 'mode', sessionId: C_ID })]
  const cCopy = next.slice(metaEnd, shellEnd).map((line) => line.split(registry.bg.sessionId).join(C_ID))
  const ids = (lifecycle: SessionLifecycle) => (lifecycle.state === 'known' ? lifecycle.tasks.map((task) => task.id).join(',') : `unknown:${lifecycle.reason}`)
  const cycles = (count: number) => {
    const refs = new Map([['p1', refOf(registry)]])
    const out: { life: string; bytes: number }[] = []
    for (let round = 0; round < count; round += 1) {
      const read = readSessionDigests(refs)
      out.push({ life: ids(read.digests.get('p1')!.lifecycle), bytes: read.cost.lifecycleBytes })
    }
    return out
  }
  const setup = (c: string[]) => {
    write({ sessionId: registry.old.sessionId, lines: bigA })
    write({ sessionId: registry.bg.sessionId, lines: [...next.slice(0, shellEnd), ...secondHop] })
    write({ sessionId: C_ID, lines: c })
    register({ name: 'old', registry, alive: true })
    register({ name: 'bg', registry, alive: true })
    registerC({ startedAt: registry.bg.startedAt + 60_000 })
  }

  it('A 합성 — 본 파일 = 셋째 파일(C, 대화 복사): catching-up 뒤 원본을 따라잡은 주기부터 셸 1건, 무변경 0바이트 주기에도 유지', () => {
    setup([...cMeta, ...cCopy])
    const seen = cycles(8)
    expect(seen.filter((cycle) => cycle.life === '')).toEqual([])
    expect(seen[0]!.life).toBe('unknown:catching-up')
    const first = seen.findIndex((cycle) => cycle.life === 'task-1')
    expect(first).toBeGreaterThan(0)
    expect(seen.slice(first).map((cycle) => cycle.life)).toEqual(Array(8 - first).fill('task-1'))
    expect(seen.at(-1)!.bytes).toBe(0)
  })

  it('B 합성 — 본 파일 = 중간 파일(B, C 는 메타뿐): 원본을 따라잡는 동안 known 0건 0회, 따라잡으면 셸', () => {
    setup(cMeta)
    const seen = cycles(8)
    expect(seen.filter((cycle) => cycle.life === '')).toEqual([])
    expect(seen[0]!.life).toBe('unknown:catching-up')
    expect(seen.at(-1)).toEqual({ life: 'task-1', bytes: 0 })
  })
})
