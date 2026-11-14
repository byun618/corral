// supervisor 재시작 뒤 넘어간 백그라운드 작업의 수명 (LIFE-794) — 판독층 입구(`readSessionDigest`)를 실제 파일·레지스트리로 부른다.
// HOME 은 매번 임시 폴더다(사용자 HOME 을 안 만진다).
//
// **실표본**: `fixtures/lifecycle-restart/` 는 Claude Code 2.1.296 실기(`claude --bg` + `claude respawn <id>`, 구현 전 실측 —
// corral-specs `LIFE-794-supervisor-restart/raw/claude/`·`raw/coordinator/probe3/`)의 세션 파일을 가린 사본이다(`scripts/mask-restart-fixture.py`).
// 줄 순서·type·sessionKind·시각 간격·수명 키·통지 status·continued-in 대상은 실물이고, id·글·경로는 지어낸 값이다.
// 레지스트리(`*-registry.json`)의 startedAt 은 실측 값(옛 bg 프로세스 `before`·재시작한 bg 프로세스 `after`)을 같은 만큼 평행 이동한 것이다.
// pid 는 이 시험 프로세스로 바꿔 「살아 있음」을 만든다.
// - two-shells: bg 세션 셸 2개(task-0·task-1) → respawn → 붙어서 사용자 답 1회 → 하나씩 끝 통지(새 프로세스가 같은 파일에 씀)
// - handoff-off: `--settings` env 로 handoff 끔 → respawn → 새 프로세스가 곧바로 `killed`·`stopped` 통지(셸 죽음) — 코디 probe3
// - monitor: Monitor(task-0) + 셸(task-1) → respawn → Monitor 는 `killed`·`stopped`, 셸은 살아 나중에 `completed`
// - subagent: 비동기 서브에이전트(task-0) → respawn → `<status>` 없는 「restarted」 통지 → 이어 돌다 `completed`
// - left: 시험 pane 셸 A(task-0) → `←` → 첫 입력 → bg 세션에서 셸 B(task-1) → bg 세션 respawn → B 끝 → A 끝(둘 다 새 bg 프로세스가 씀)
// 이름에 「합성」이 붙은 시험만 손으로 지은 줄·값을 쓴다 — 실제 근거로 세지 않는다. 증명하는 것(판별 분기)과 못 하는 것(Claude Code 가 그 모양을 실제로 쓰는지)을 머리에 적는다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMonitoring } from '../shared/lifecycle'
import type { AgentSessionRef, SessionLifecycle } from '../shared/types'
import { clearTranscriptCache, readSessionDigest, readSessionDigests } from './transcript'

const FIXTURES = path.join(__dirname, 'fixtures', 'lifecycle-restart')
type Entry = { sessionId: string; startedAt: number; kind: string }
type Registry = Record<string, Entry>

function lines(input: { name: string; tail: string }): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, `${input.name}-${input.tail}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function registryOf(name: string): Registry {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}-registry.json`), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('registry 모양')
  const registry: Registry = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) throw new Error('registry 항목 모양')
    const { sessionId, startedAt, kind } = { sessionId: Reflect.get(value, 'sessionId'), startedAt: Reflect.get(value, 'startedAt'), kind: Reflect.get(value, 'kind') }
    if (typeof sessionId !== 'string' || typeof startedAt !== 'number' || typeof kind !== 'string') throw new Error('registry 항목 값')
    registry[key] = { sessionId, startedAt, kind }
  }
  return registry
}

function entryOf(input: { registry: Registry; name: string }): Entry {
  const entry = input.registry[input.name]
  if (entry === undefined) throw new Error(`registry 에 ${input.name} 없음`)
  return entry
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
const endOf = (id: string) => (line: string) => line.includes(`<task-id>${id}</task-id>`) && /<status>[^<]*<\/status>/.test(line)
const isCost = (line: string) => typeOf(line) === 'cost-state'
const isConversation = (line: string) => typeOf(line) === 'user' || typeOf(line) === 'assistant'

let home = ''
let realHome: string | undefined
let dir = ''

beforeEach(() => {
  realHome = process.env['HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l794-'))
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

/**
 * 레지스트리 항목 — 관측된 키(`kind`·`jobId`·`parkedJobId`)를 그대로 적는다. 판독은 `pid`·`sessionId`·`startedAt`·`kind`·`jobId` 를 쓴다.
 * 한 세션 id 에 bg 프로세스는 하나다 — `before`·`after` 는 같은 파일 이름(`bg.json`)을 써서 재시작을 흉내 낸다(옛 항목이 사라지고 새 항목이 생긴다).
 */
function register(input: { registry: Registry; name: string; alive: boolean; kind?: string; file?: string; status?: string }) {
  const entry = entryOf({ registry: input.registry, name: input.name })
  const file = path.join(home, '.claude', 'sessions', `${input.file ?? (entry.kind === 'bg' ? 'bg' : input.name)}.json`)
  if (!input.alive) {
    fs.rmSync(file, { force: true })
    return
  }
  const kind = input.kind ?? entry.kind
  const job = entry.sessionId.slice(0, 8)
  const shape = kind === 'bg' ? { jobId: job, parkedJobId: null } : { jobId: null, parkedJobId: null }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: entry.sessionId, status: input.status ?? 'shell', startedAt: entry.startedAt, kind, ...shape }))
  // 레지스트리 캐시는 크기·mtime 으로 다시 읽는다 — 같은 크기로 바꿔 써도 다음 판독이 보게 mtime 을 민다
  const bumped = new Date(Date.now() + registerCount++ * 1000)
  fs.utimesSync(file, bumped, bumped)
}
let registerCount = 1

function known(lifecycle: SessionLifecycle) {
  if (lifecycle.state !== 'known') throw new Error(`known 이 아니다: ${JSON.stringify(lifecycle)}`)
  return lifecycle
}

const refOf = (sessionId: string): AgentSessionRef => ({ kind: 'id', agent: 'claude', source: 'herdr:claude', id: sessionId })
const lifeOf = (sessionId: string) => readSessionDigest(refOf(sessionId)).digest.lifecycle
const taskIds = (sessionId: string) => known(lifeOf(sessionId)).tasks.map((task) => task.id)
const monitoring = (lifecycle: SessionLifecycle) => isMonitoring({ agentStatus: 'idle', turnOutcome: null, lifecycle })

/** 표본 하나 — bg 파일 줄과 재시작 경계(옛 bg 프로세스의 마지막 줄 뒤 첫 `cost-state` 부터 그 뒤 연속한 메타 줄 끝까지). */
function restartSample(name: string) {
  const bg = lines({ name, tail: 'bg' })
  const registry = registryOf(name)
  const sessionId = entryOf({ registry, name: 'after' }).sessionId
  const costAt = indexWhere({ lines: bg, match: isCost })
  /** 재시작 뒤 메타(`cost-state`·`last-prompt`·제목 줄)까지 — 그 뒤 첫 시각 있는 줄 앞. */
  const afterRestart = bg.findIndex((line, at) => at > costAt && !isCost(line) && JSON.parse(line).timestamp !== undefined)
  return { bg, registry, sessionId, costAt, settled: afterRestart === -1 ? bg.length : afterRestart }
}

describe('C1 재시작 구간 판독 (실표본 two-shells) — 재시작 전에 연 셸이 도는 동안 목록에 남는다', () => {
  const { bg, registry, sessionId, costAt, settled } = restartSample('two-shells')
  const firstEnd = indexWhere({ lines: bg, match: endOf('task-0') })
  const secondEnd = indexWhere({ lines: bg, match: endOf('task-1') })
  const reply = indexWhere({ lines: bg, match: (line) => isConversation(line) && !line.includes('<task-notification>'), from: settled })

  it('표본 확인 — 재시작 전 셸 2개, 옛 프로세스 끝은 cost-state → last-prompt → cost-state, 새 프로세스가 사용자 답 뒤 같은 파일에 끝 통지 둘', () => {
    write({ sessionId, lines: bg.slice(0, costAt) })
    register({ registry, name: 'before', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    expect(bg.slice(costAt, costAt + 3).map(typeOf)).toEqual(['cost-state', 'last-prompt', 'cost-state'])
    expect(reply).toBeLessThan(firstEnd)
    expect(firstEnd).toBeLessThan(secondEnd)
    expect(entryOf({ registry, name: 'after' }).startedAt).toBeGreaterThan(entryOf({ registry, name: 'before' }).startedAt)
  })

  it('ⓐ 재시작 직후 — 옛 bg 프로세스가 사라지고 새 bg 프로세스(셸보다 늦게 뜸)가 주인: 셸 둘이 있고 monitoring', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'after', alive: true })
    const lifecycle = lifeOf(sessionId)
    expect(known(lifecycle).tasks.map((task) => task.id)).toEqual(['task-0', 'task-1'])
    expect(monitoring(lifecycle)).toBe(true)
    // 판독을 거듭해도(캐시·빠른 반환) 그대로다
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
  })

  it('ⓐ 콜드 — 재시작 뒤 처음 읽어도(장부 없음) 같다', () => {
    write({ sessionId, lines: bg.slice(0, reply) })
    register({ registry, name: 'after', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
  })

  it('ⓑ 재시작 뒤 사용자 답(user·assistant 줄)이 와도 — 셸 둘이 남는다', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'after', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    write({ sessionId, lines: bg.slice(0, firstEnd) })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
  })

  it('ⓓ 하나만 끝나면 1, ⓒ 둘째 끝 통지 뒤 0 — 2 → 1 → 0', () => {
    register({ registry, name: 'after', alive: true })
    write({ sessionId, lines: bg.slice(0, firstEnd) })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    write({ sessionId, lines: bg.slice(0, firstEnd + 1) })
    expect(taskIds(sessionId)).toEqual(['task-1'])
    write({ sessionId, lines: bg.slice(0, secondEnd + 1) })
    expect(taskIds(sessionId)).toEqual([])
    write({ sessionId, lines: bg })
    expect(taskIds(sessionId)).toEqual([])
    expect(monitoring(lifeOf(sessionId))).toBe(false)
  })
})

describe('C2 넘어가지 못한 것 — 목록 = 실제 생존 (실표본)', () => {
  it('ⓐ handoff 끔 — 새 프로세스의 stopped 통지 뒤 없다(통지 전 창: 재시작 메타 ~ 통지, 실측 1초 안팎)', () => {
    const { bg, registry, sessionId, costAt, settled } = restartSample('handoff-off')
    const stopped = indexWhere({ lines: bg, match: (line) => endOf('task-0')(line) && line.includes('<status>stopped</status>') })
    const killed = indexWhere({ lines: bg, match: endOf('task-0') })
    write({ sessionId, lines: bg.slice(0, costAt) })
    register({ registry, name: 'before', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0'])
    // 통지 전 창 — 셸이 죽었는지 아직 모른다(넘어간 셸과 같은 모양). 허용한 창이다(01-criteria C2ⓐ).
    register({ registry, name: 'after', alive: true })
    write({ sessionId, lines: bg.slice(0, settled) })
    expect(taskIds(sessionId)).toEqual(['task-0'])
    expect(killed).toBeLessThanOrEqual(stopped)
    // 창 밖 — 첫 끝 통지(killed) 뒤부터 끝까지 0건
    for (let end = killed + 1; end <= bg.length; end++) {
      write({ sessionId, lines: bg.slice(0, end) })
      expect(taskIds(sessionId)).toEqual([])
    }
  })

  it('ⓑ Monitor — 재시작 직후부터(멈춤 통지 전에도) 목록에 없고, 같이 연 셸은 남는다', () => {
    const { bg, registry, sessionId, settled } = restartSample('monitor')
    const shellEnd = indexWhere({ lines: bg, match: (line) => endOf('task-1')(line) && line.includes('<status>completed</status>') })
    register({ registry, name: 'after', alive: true })
    write({ sessionId, lines: bg.slice(0, settled) })
    expect(taskIds(sessionId)).toEqual(['task-1'])
    write({ sessionId, lines: bg.slice(0, shellEnd) })
    expect(taskIds(sessionId)).toEqual(['task-1'])
    write({ sessionId, lines: bg.slice(0, shellEnd + 1) })
    expect(taskIds(sessionId)).toEqual([])
  })

  it('ⓒ 비동기 서브에이전트 — 넘어가 이어 돈다(실측: status 없는 restarted 통지 뒤 completed): 그동안 작업·자식 행에 있고 completed 뒤 없다', () => {
    const { bg, registry, sessionId, settled } = restartSample('subagent')
    const restarted = indexWhere({ lines: bg, match: (line) => line.includes('<task-id>task-0</task-id>') })
    const done = indexWhere({ lines: bg, match: endOf('task-0') })
    expect(restarted).toBeLessThan(done)
    register({ registry, name: 'after', alive: true })
    for (const end of [settled, restarted + 1, done]) {
      write({ sessionId, lines: bg.slice(0, end) })
      const lifecycle = known(lifeOf(sessionId))
      expect(lifecycle.tasks.map((task) => task.id)).toEqual(['task-0'])
      expect(lifecycle.subagents.map((subagent) => subagent.id)).toEqual(['task-0'])
    }
    write({ sessionId, lines: bg.slice(0, done + 1) })
    const ended = known(lifeOf(sessionId))
    expect(ended.tasks).toEqual([])
    expect(ended.subagents).toEqual([])
  })
})

describe('C3 기존 계약 유지', () => {
  const { bg, registry, sessionId, settled } = restartSample('two-shells')

  // 합성(레지스트리 kind) — 실표본 기록에 레지스트리 kind 만 'interactive' 로 지어 넣었다. 증명: bg 주인 판별(kind) 분기.
  // 못 하는 것: 대화형 `claude --resume <bg 세션 id>` 의 실제 레지스트리 모양(실기 미확인), 대화형·bg 항목이 함께 사는 경우(아래 M6 시험).
  it('ⓐ 합성(레지스트리 kind) — 같은 파일을 대화형 프로세스가 이어 받으면(kind 가 bg 아님) 옛 세대 열린 작업은 뺀다 — 재시작으로 보지 않는다', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'after', alive: true, kind: 'interactive' })
    expect(taskIds(sessionId)).toEqual([])
  })

  it('ⓐ 합성 — 대화형 프로세스가 쓴 줄(sessionKind 없음)로 연 셸은 bg 주인이 와도 싣지 않는다. 증명: bgOpened 판별 분기. 못 하는 것: 대화형 → bg 로 같은 id 를 잇는 실제 경로가 있는지', () => {
    const interactive = bg.map((line) => line.replace(',"sessionKind":"bg"', ''))
    write({ sessionId, lines: interactive.slice(0, settled) })
    register({ registry, name: 'after', alive: true })
    expect(taskIds(sessionId)).toEqual([])
  })

  it('ⓑ cost-state 뒤 아무 주인도 없으면 — not-running', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    expect(lifeOf(sessionId)).toEqual({ state: 'unknown', reason: 'not-running' })
  })

  it('ⓔ `claude stop` 으로 재시작한 bg 항목이 사라지면 — not-running(셸이 살아 있어도 주인이 없다)', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'after', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    register({ registry, name: 'after', alive: false })
    expect(lifeOf(sessionId)).toEqual({ state: 'unknown', reason: 'not-running' })
  })

  it('합성 — cost-state 를 쓴 bg 프로세스가 아직 살아 있으면(재시작 아님) 그 프로세스가 연 것은 싣지 않는다(고치기 전 동작). 증명: 주인 시작 시각 비교. 못 하는 것: 그런 cost-state 가 실제로 오는지', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'before', alive: true })
    expect(taskIds(sessionId)).toEqual([])
  })
})

describe('C1·ⓔ `←` 로 이어 받은 bg 세션의 재시작 (실표본 left) — 넘겨받은 셸 A·bg 에서 연 셸 B 둘 다', () => {
  const old = lines({ name: 'left', tail: 'old' })
  const bg = lines({ name: 'left', tail: 'bg' })
  const registry = registryOf('left')
  const oldId = entryOf({ registry, name: 'old' }).sessionId
  const bgId = entryOf({ registry, name: 'after' }).sessionId
  const costAt = indexWhere({ lines: bg, match: isCost })
  const bEnd = indexWhere({ lines: bg, match: endOf('task-1') })
  const aEnd = indexWhere({ lines: bg, match: endOf('task-0') })
  const place = (end: number) => {
    write({ sessionId: oldId, lines: old })
    write({ sessionId: bgId, lines: bg.slice(0, end) })
  }

  it('표본 확인 — 재시작 전(옛 bg 프로세스 주인) A·B 둘, B 끝 통지가 A 보다 먼저', () => {
    place(costAt)
    register({ registry, name: 'old', alive: true })
    register({ registry, name: 'before', alive: true })
    expect(taskIds(oldId)).toEqual(['task-0', 'task-1'])
    expect(bEnd).toBeLessThan(aEnd)
  })

  it('재시작 뒤 — 새 bg 프로세스가 주인: A·B 둘 다 남고, B 끝 → A, A 끝 → 0', () => {
    register({ registry, name: 'old', alive: true })
    register({ registry, name: 'after', alive: true })
    place(bEnd)
    expect(taskIds(oldId)).toEqual(['task-0', 'task-1'])
    place(bEnd + 1)
    expect(taskIds(oldId)).toEqual(['task-0'])
    place(aEnd + 1)
    expect(taskIds(oldId)).toEqual([])
  })

  it('재시작 뒤 옛 대화형 pane 을 닫아도 — 같다(넘겨받은 셸의 주인은 bg 세션)', () => {
    register({ registry, name: 'after', alive: true })
    place(bEnd)
    expect(taskIds(oldId)).toEqual(['task-0', 'task-1'])
  })
})

describe('C6ⓕ 합성 — 연속 재시작(두 번째 respawn)', () => {
  // 증명: 두 번째 재시작의 cost-state 쌍이 첫 재시작에서 넘어간 것을 지우지 않는다(누적). 못 하는 것: 실제 두 번째 respawn 의 줄 모양 — 최종 C6ⓕ 에서 잰다.
  const { bg, registry, sessionId, costAt, settled } = restartSample('two-shells')
  const firstEnd = indexWhere({ lines: bg, match: endOf('task-0') })

  it('두 번째 재시작 뒤에도 셸 둘, 이후 끝 통지로 빠진다', () => {
    const second = [...bg.slice(settled, firstEnd), ...bg.slice(costAt, settled)]
    const later = { ...registry, again: { ...entryOf({ registry, name: 'after' }), startedAt: entryOf({ registry, name: 'after' }).startedAt + 60_000 } }
    write({ sessionId, lines: [...bg.slice(0, settled), ...second] })
    register({ registry: later, name: 'again', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    write({ sessionId, lines: [...bg.slice(0, settled), ...second, bg[firstEnd]!] })
    expect(taskIds(sessionId)).toEqual(['task-1'])
  })
})

describe('C5 판독 비용 — 재시작 판독은 파일·레지스트리를 더 읽지 않는다', () => {
  it('재시작 뒤 첫 주기: 파일 크기만 세고, 다음 주기 0바이트, 레지스트리가 바뀐 주기(재시작)에는 레지스트리 몫만 늘고 파일은 0바이트', () => {
    const { bg, registry, sessionId, settled } = restartSample('two-shells')
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'before', alive: true })
    const refs = new Map([['p1', refOf(sessionId)]])
    const size = fs.statSync(path.join(dir, `${sessionId}.jsonl`)).size
    const first = readSessionDigests(refs)
    expect(first.cost.lifecycleBytes).toBe(size)
    expect(first.cost.lifecycleRegistryBytes).toBeGreaterThan(0)
    const second = readSessionDigests(refs)
    expect(second.cost.lifecycleBytes).toBe(0)
    expect(second.cost.statOnly).toBe(1)
    // 재시작 — 레지스트리 항목만 바뀐다. 파일은 그대로라 0바이트, 레지스트리는 그 항목 크기만큼
    register({ registry, name: 'after', alive: true })
    const third = readSessionDigests(refs)
    expect(third.cost.lifecycleBytes).toBe(0)
    expect(third.cost.lifecycleRegistryBytes).toBe(fs.statSync(path.join(home, '.claude', 'sessions', 'bg.json')).size)
    expect(known(third.digests.get('p1')!.lifecycle).tasks.map((task) => task.id)).toEqual(['task-0', 'task-1'])
  })
})

describe('fix1 A·M6 합성 — 같은 세션 id 의 대화형 항목이 사는 채 bg 주인만 나타나거나 죽으면 다시 고른다', () => {
  // 증명: 캐시 빠른 반환이 bg 주인 변화(`Links.restartOwner`)를 본다 — 소유자 시작 시각은 가장 이른 것(대화형)이라 그대로라 `owner` 비교로는 못 본다.
  // 못 하는 것: 같은 세션 id 로 대화형·bg 프로세스가 실제로 함께 사는 경로(대화형 `--resume` 이 bg 와 겹치는지)는 실기 미확인.
  const { bg, registry, sessionId, settled } = restartSample('two-shells')
  const interactive = { ...registry, interactive: { ...entryOf({ registry, name: 'before' }), startedAt: entryOf({ registry, name: 'before' }).startedAt - 60_000, kind: 'interactive' } }

  it('대화형만 → 0, bg 주인이 나타나면 → 셸 둘, bg 주인이 사라지면 → 0 (파일 무변경·대화형 항목 그대로)', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry: interactive, name: 'interactive', alive: true, file: 'interactive' })
    expect(taskIds(sessionId)).toEqual([])
    register({ registry: interactive, name: 'after', alive: true })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    register({ registry: interactive, name: 'after', alive: false })
    expect(taskIds(sessionId)).toEqual([])
  })
})

describe('fix1 B 레지스트리 bg 주인 status:"idle" 이면 재시작 몫을 싣지 않는다(빼는 쪽으로만)', () => {
  // 실측(fix1 b1·b2·h1, r0 a0·a1·e0·m0): 넘어간 셸이 돌면 status shell, 넘어간 서브에이전트가 돌면 busy, 끝 뒤·handoff 끔 재시작 직후 idle.
  // 세션 단위 값이라 idle 일 때만 「도는 것이 없다」로 쓰고 shell·busy·없는 값은 지금처럼 끝 표지로 가른다.
  const { bg, registry, sessionId, settled } = restartSample('two-shells')

  it('실표본 two-shells 재시작 직후 — status shell·busy 이면 셸 둘, idle 이면 0', () => {
    write({ sessionId, lines: bg.slice(0, settled) })
    register({ registry, name: 'after', alive: true, status: 'shell' })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    register({ registry, name: 'after', alive: true, status: 'busy' })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    register({ registry, name: 'after', alive: true, status: 'idle' })
    expect(taskIds(sessionId)).toEqual([])
  })

  it('합성 — 끝 통지가 영영 안 온 셸(통지 줄을 뺀 기록): bg 주인이 idle 이 된 뒤 0. 증명: 상한 분기. 못 하는 것: 통지 없이 죽은 셸에 Claude Code 가 idle 을 쓰는지(실측은 통지가 온 회차뿐)', () => {
    const silent = bg.filter((line) => !/<status>[^<]*<\/status>/.test(line))
    write({ sessionId, lines: silent })
    register({ registry, name: 'after', alive: true, status: 'shell' })
    expect(taskIds(sessionId)).toEqual(['task-0', 'task-1'])
    register({ registry, name: 'after', alive: true, status: 'idle' })
    expect(taskIds(sessionId)).toEqual([])
  })

  it('실표본 subagent — 넘어간 서브에이전트가 도는 동안(status busy) 남고, idle 이면 0', () => {
    const sample = restartSample('subagent')
    register({ registry: sample.registry, name: 'after', alive: true, status: 'busy' })
    write({ sessionId: sample.sessionId, lines: sample.bg.slice(0, sample.settled) })
    expect(known(lifeOf(sample.sessionId)).subagents.map((subagent) => subagent.id)).toEqual(['task-0'])
    register({ registry: sample.registry, name: 'after', alive: true, status: 'idle' })
    expect(known(lifeOf(sample.sessionId)).subagents).toEqual([])
  })
})

describe('fix1 C 합성 — 시작 시각을 모르는 재시작 몫은 목록 전체를 모름(unreadable, R2-F1)', () => {
  // 증명: 재시작 몫의 시각 없는 항목 분기. 못 하는 것: Claude Code 가 시각 없는 tool_use·tool_result 를 실제로 쓰는지(실표본은 전부 시각이 있다).
  const { bg, registry, sessionId, settled } = restartSample('two-shells')

  it('셸을 연 줄들의 timestamp 를 지우면 재시작 뒤 unreadable, 그 셸의 끝 통지 뒤 풀린다', () => {
    const undated = bg.map((line, at) => (at < settled ? line.replace(/"timestamp":"[^"]*",?/, '') : line))
    const firstEnd = indexWhere({ lines: bg, match: endOf('task-0') })
    const secondEnd = indexWhere({ lines: bg, match: endOf('task-1') })
    register({ registry, name: 'after', alive: true })
    write({ sessionId, lines: undated.slice(0, settled) })
    expect(lifeOf(sessionId)).toEqual({ state: 'unknown', reason: 'unreadable' })
    write({ sessionId, lines: undated.slice(0, firstEnd + 1) })
    expect(lifeOf(sessionId)).toEqual({ state: 'unknown', reason: 'unreadable' })
    write({ sessionId, lines: undated.slice(0, secondEnd + 1) })
    expect(taskIds(sessionId)).toEqual([])
  })
})

describe('fix1 D 합성 — `←` 로 복사된 옛 열림 중 781 이 넘기지 않은 것은 재시작 뒤에도 싣지 않는다', () => {
  // 실표본 left 에 지어 넣은 셸 둘:
  //   task-x — 옛 파일에서 옛 대화형 주인 시작 시각보다 먼저 열리고 끝 표지 없음(강제 종료 뒤 재개 전 세대 — 781 세대 거르기가 뺀다)
  //   task-y — 옛 파일에서 열리고 `←` 때 cost-state 와 continued-in 사이 killed 통지로 끝남(781 실표본의 멈춘 에이전트 꼴)
  // bg 파일에는 둘 다 복사된 꼴(`sessionKind:"bg"`·bg 세션 id, 끝 통지 없음)로 열려 있다.
  // 증명: 재시작 몫이 781 넘김 판정을 따른다(`notHanded` 의 넘김 원본·끝 본 id 둘 다), 앞 파일을 따라잡는 동안은 모름.
  // 못 하는 것: 그런 옛 열림이 실제 `←` 복사로 오는지(실기 미확인 — 리뷰 r1 G3·F3 은 코드 경로).
  const old = lines({ name: 'left', tail: 'old' })
  const bg = lines({ name: 'left', tail: 'bg' })
  const registry = registryOf('left')
  const oldId = entryOf({ registry, name: 'old' }).sessionId
  const bgId = entryOf({ registry, name: 'after' }).sessionId
  const oldStart = entryOf({ registry, name: 'old' }).startedAt
  const opened = (input: { sessionId: string; kind: string | null; id: string; at: number }) => {
    const base = { sessionId: input.sessionId, timestamp: new Date(input.at).toISOString(), ...(input.kind === null ? {} : { sessionKind: input.kind }) }
    return [
      JSON.stringify({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu-${input.id}`, name: 'Bash', input: { run_in_background: true } }] } }),
      JSON.stringify({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${input.id}`, content: '가림' }] }, toolUseResult: { backgroundTaskId: input.id } }),
    ]
  }
  const both = (input: { sessionId: string; kind: string | null }) => [
    ...opened({ ...input, id: 'task-x', at: oldStart - 60_000 }),
    ...opened({ ...input, id: 'task-y', at: oldStart + 1_000 }),
  ]
  const killedY = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date(oldStart + 30_000).toISOString(),
    sessionId: oldId,
    content: '<task-notification>\n<task-id>task-y</task-id>\n<status>killed</status>\n<summary>가림</summary>\n</task-notification>',
  })
  const oldOpen = indexWhere({ lines: old, match: (line) => line.includes('"backgroundTaskId":"task-0"') })
  const oldCost = indexWhere({ lines: old, match: isCost })
  const bgOpen = indexWhere({ lines: bg, match: (line) => line.includes('"backgroundTaskId":"task-0"') })
  const oldWith = [...old.slice(0, oldOpen), ...both({ sessionId: oldId, kind: null }), ...old.slice(oldOpen, oldCost + 1), killedY, ...old.slice(oldCost + 1)]
  const bgWith = [...bg.slice(0, bgOpen), ...both({ sessionId: bgId, kind: 'bg' }), ...bg.slice(bgOpen)]
  const costAt = indexWhere({ lines: bgWith, match: isCost })
  const bEnd = indexWhere({ lines: bgWith, match: endOf('task-1') })

  it('재시작 전·뒤 모두 A·B 둘 — task-x·task-y 는 없다', () => {
    write({ sessionId: oldId, lines: oldWith })
    register({ registry, name: 'old', alive: true })
    register({ registry, name: 'before', alive: true })
    write({ sessionId: bgId, lines: bgWith.slice(0, costAt) })
    expect(taskIds(oldId)).toEqual(['task-0', 'task-1'])
    register({ registry, name: 'after', alive: true })
    write({ sessionId: bgId, lines: bgWith.slice(0, bEnd) })
    expect(taskIds(oldId)).toEqual(['task-0', 'task-1'])
  })

  it('합성 앞 파일 5MB 콜드 — 재시작 뒤 처음 읽을 때 앞 파일을 따라잡는 동안은 모름, known 에 task-x·task-y 가 한 번도 없다', () => {
    const big: string[] = []
    for (let left = 5_000_000; left > 0; left -= 500_000) {
      big.push(JSON.stringify({ type: 'assistant', timestamp: new Date(oldStart - 120_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(500_000) }] } }))
    }
    write({ sessionId: oldId, lines: [...big, ...oldWith] })
    write({ sessionId: bgId, lines: bgWith.slice(0, bEnd) })
    register({ registry, name: 'old', alive: true })
    register({ registry, name: 'after', alive: true })
    const seen: SessionLifecycle[] = []
    for (let cycle = 0; cycle < 6; cycle++) seen.push(lifeOf(oldId))
    expect(seen[0]).toEqual({ state: 'unknown', reason: 'catching-up' })
    for (const life of seen) if (life.state === 'known') expect(life.tasks.map((task) => task.id)).toEqual(['task-0', 'task-1'])
    expect(seen.at(-1)?.state).toBe('known')
  })
})
