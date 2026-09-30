// 백그라운드 작업·서브에이전트 누적 판독 (LIFE-462 L1~L9) — 파일을 실제로 깔고 판독층 입구(`readSessionDigest`)와
// 누적 판독기(`advanceLedger`)를 부른다. HOME 은 매번 임시 폴더다(사용자 HOME 을 안 만진다).
//
// fixture 레코드는 **키·순서는 실물, 값은 합성**이다 — 뼈대 원본은
// `specs/LIFE-462-task-lifecycle/raw/claude/f1-lifecycle-shapes.json`(사용자 기록에서 키 순서만 뽑은 것).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMonitoring } from '../shared/lifecycle'
import type { AgentSessionRef, AgentStatus, BackgroundTask, SessionLifecycle, SessionSubagent, TurnOutcome } from '../shared/types'
import { LIFECYCLE_MAX_ITEMS } from '../shared/types'
import { LIFECYCLE_READ_MAX_BYTES, advanceLedger, ledgerView } from './transcript-lifecycle'
import type { Ledger } from './transcript-lifecycle'
import { clearTranscriptCache, digestsEqual, lifecycleLedgerCount, readSessionDigest, readSessionDigests } from './transcript'

const SESSION_ID = '11111111-2222-4333-8444-777777777777'
const T0 = Date.parse('2026-09-30T01:00:00.000Z')
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString()

let home = ''
let realHome: string | undefined

beforeEach(() => {
  realHome = process.env['HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l462-life-'))
  process.env['HOME'] = home
  clearTranscriptCache()
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
})

const jsonl = (records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

// --- claude 레코드 (키 순서 = f1-lifecycle-shapes.json) ------------------------------------

const envelope = { userType: 'external', entrypoint: 'cli', cwd: '/tmp/x', sessionId: SESSION_ID, version: '2.1.280', gitBranch: 'main' }

function toolUse(input: { id: string; name: string; toolInput: Record<string, unknown>; at: number }) {
  return {
    parentUuid: 'p',
    isSidechain: false,
    message: {
      model: 'claude-opus-5-5',
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: input.id, name: input.name, input: input.toolInput, caller: { type: 'direct' } }],
      stop_reason: 'tool_use',
    },
    requestId: 'req',
    type: 'assistant',
    uuid: `u-${input.id}`,
    timestamp: iso(input.at),
    ...envelope,
  }
}

function toolResult(input: { id: string; result: Record<string, unknown>; at: number; content?: unknown }) {
  return {
    parentUuid: 'p',
    isSidechain: false,
    promptId: 'pr',
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: input.id, type: 'tool_result', content: input.content ?? 'ok' }] },
    uuid: `r-${input.id}`,
    timestamp: iso(input.at),
    toolUseResult: input.result,
    sourceToolAssistantUUID: `u-${input.id}`,
    ...envelope,
  }
}

const bashBg = (input: { toolId: string; taskId: string; at: number; description?: string; command?: string }) => [
  toolUse({
    id: input.toolId,
    name: 'Bash',
    toolInput: { command: input.command ?? 'sleep 600', ...(input.description === undefined ? {} : { description: input.description }), run_in_background: true },
    at: input.at,
  }),
  toolResult({
    id: input.toolId,
    at: input.at,
    result: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: input.taskId },
  }),
]

const monitor = (input: { toolId: string; taskId: string; at: number }) => [
  toolUse({ id: input.toolId, name: 'Monitor', toolInput: { command: 'tail -f log', description: '로그 감시', persistent: true, timeout_ms: 60000 }, at: input.at }),
  toolResult({ id: input.toolId, at: input.at, result: { taskId: input.taskId, timeoutMs: 60000, persistent: true } }),
]

const agentCall = (input: { toolId: string; at: number; background: boolean; name?: string }) =>
  toolUse({
    id: input.toolId,
    name: 'Agent',
    toolInput: {
      description: '코드 찾기',
      prompt: '합성 프롬프트',
      subagent_type: 'Explore',
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.background ? { run_in_background: true } : {}),
    },
    at: input.at,
  })

const agentLaunched = (input: { toolId: string; agentId: string; at: number }) =>
  toolResult({
    id: input.toolId,
    at: input.at,
    content: [{ type: 'text', text: 'launched' }],
    result: {
      isAsync: true,
      status: 'async_launched',
      agentId: input.agentId,
      description: '코드 찾기',
      resolvedModel: 'claude-sonnet-5',
      prompt: '합성 프롬프트',
      outputFile: '/tmp/out',
      canReadOutputFile: true,
    },
  })

const notification = (input: { ids: string[]; status: string | null; at: number; event?: boolean }) =>
  [
    '<task-notification>',
    ...input.ids.map((id) => `<task-id>${id}</task-id>`),
    '<tool-use-id>toolu_x</tool-use-id>',
    '<output-file>/tmp/o</output-file>',
    ...(input.status === null ? [] : [`<status>${input.status}</status>`]),
    '<summary>합성 요약</summary>',
    ...(input.event === true ? ['<event>합성 이벤트</event>'] : []),
    '</task-notification>',
  ].join('\n')

const enqueue = (input: { text: string; at: number }) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(input.at), sessionId: SESSION_ID, content: input.text })

const userNotification = (input: { text: string; at: number }) => ({
  parentUuid: 'p',
  isSidechain: false,
  promptId: 'pr',
  type: 'user',
  message: { role: 'user', content: input.text },
  uuid: 'n',
  timestamp: iso(input.at),
  permissionMode: 'default',
  origin: { kind: 'task-notification' },
  promptSource: 'queued',
  queueSkipAttachments: true,
  ...envelope,
})

const taskStop = (input: { toolId: string; taskId: string; at: number }) => [
  toolUse({ id: input.toolId, name: 'TaskStop', toolInput: { task_id: input.taskId }, at: input.at }),
  toolResult({ id: input.toolId, at: input.at, result: { message: 'stopped', task_id: input.taskId, task_type: 'local_bash', command: 'sleep 600' } }),
]

const costState = () => ({
  type: 'cost-state',
  sessionId: SESSION_ID,
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalAPIDurationWithoutRetries: 0,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalDuration: 0,
  startTime: 0,
  modelUsage: {},
  hasUnknownModelCost: false,
})

const agentsKilled = (at: number) => ({ parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'agents_killed', timestamp: iso(at), uuid: 'k', isMeta: false, ...envelope })

/** 꼬리 창을 밀어내는 표지 없는 줄 (어시스턴트 텍스트). */
const filler = (bytes: number) => {
  const lines: unknown[] = []
  const unit = 60_000
  for (let left = bytes; left > 0; left -= unit) {
    lines.push({ type: 'assistant', timestamp: iso(1), message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(Math.min(unit, left)) }] } })
  }
  return lines
}

// --- 입구 준비 -------------------------------------------------------------------------

const claudeRef: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: SESSION_ID }
let claudeFile = ''

/** claude 기록 + 살아 있는 소유 프로세스 레지스트리(이 테스트 프로세스의 pid). */
function setupClaude(input: { records: unknown[]; live?: boolean; startedAt?: number }) {
  const dir = path.join(home, '.claude', 'projects', '-tmp-x')
  fs.mkdirSync(dir, { recursive: true })
  claudeFile = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(claudeFile, jsonl(input.records))
  if (input.live !== false) registerLive({ startedAt: input.startedAt ?? 0 })
}

/** 살아 있는 소유 프로세스 등록 — 키는 관측된 레지스트리의 일부, `startedAt` = 프로세스 시작 시각(세대 경계). */
function registerLive(input: { startedAt: number; pid?: number }) {
  const sessions = path.join(home, '.claude', 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const pid = input.pid ?? process.pid
  fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION_ID, kind: 'interactive', status: 'idle', startedAt: input.startedAt }))
}

const append = (records: unknown[]) => fs.appendFileSync(claudeFile, jsonl(records))

/** 키 하나를 뺀 레코드 — 필드 누락 모양. */
const without = (input: { record: Record<string, unknown>; key: string }) => Object.fromEntries(Object.entries(input.record).filter(([key]) => key !== input.key))

function known(lifecycle: SessionLifecycle) {
  if (lifecycle.state !== 'known') throw new Error(`known 이 아니다: ${JSON.stringify(lifecycle)}`)
  return lifecycle
}

const life = () => readSessionDigest(claudeRef).digest.lifecycle
const taskIds = () => known(life()).tasks.map((task) => task.id)

// === L1 Claude 백그라운드 작업 ========================================================

describe('L1 claude 백그라운드 작업 — 시작·끝 신호', () => {
  it('Bash·Monitor 는 에이전트가 아닌 작업, 비동기 Agent 는 에이전트 작업으로 — 식별자·종류·이름·시작 시각', () => {
    setupClaude({ records: [
      ...bashBg({ toolId: 't1', taskId: 'b1', at: 10, description: '개발 서버' }),
      ...bashBg({ toolId: 't2', taskId: 'b2', at: 20, command: 'npm   run\n watch' }),
      ...monitor({ toolId: 't3', taskId: 'm1', at: 30 }),
      agentCall({ toolId: 't4', at: 40, background: true, name: 'finder' }),
      agentLaunched({ toolId: 't4', agentId: 'a1', at: 41 }),
    ] })
    expect(known(life()).tasks).toEqual([
      { id: 'b1', kind: 'shell', label: '개발 서버', startedAt: T0 + 10_000 },
      { id: 'b2', kind: 'shell', label: 'npm run watch', startedAt: T0 + 20_000 },
      { id: 'm1', kind: 'monitor', label: '로그 감시', startedAt: T0 + 30_000 },
      { id: 'a1', kind: 'agent', label: '코드 찾기', startedAt: T0 + 40_000 },
    ])
  })

  it('<task-notification> 의 status 는 원문 값 그대로 끝이다 — completed·failed·killed·stopped 밖의 값도', () => {
    setupClaude({ records: [
      ...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }),
      ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 }),
      ...bashBg({ toolId: 't3', taskId: 'b3', at: 3 }),
      ...bashBg({ toolId: 't4', taskId: 'b4', at: 4 }),
      ...bashBg({ toolId: 't5', taskId: 'b5', at: 5 }),
    ] })
    append([
      enqueue({ text: notification({ ids: ['b1'], status: 'completed', at: 6 }), at: 6 }),
      enqueue({ text: notification({ ids: ['b2'], status: 'killed', at: 6 }), at: 6 }),
      userNotification({ text: notification({ ids: ['b3'], status: 'failed', at: 6 }), at: 6 }),
      enqueue({ text: notification({ ids: ['b4'], status: 'some-new-status', at: 6 }), at: 6 }),
    ])
    expect(taskIds()).toEqual(['b5'])
  })

  it('TaskStop 결과로 끝난다', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...monitor({ toolId: 't2', taskId: 'm1', at: 2 })] })
    append(taskStop({ toolId: 't3', taskId: 'm1', at: 3 }))
    expect(taskIds()).toEqual(['b1'])
  })

  it('Monitor 의 <event> 통지(status 없음)는 끝이 아니다 — status 와 event 가 같이 오면 끝이다', () => {
    setupClaude({ records: monitor({ toolId: 't1', taskId: 'm1', at: 1 }) })
    append([enqueue({ text: notification({ ids: ['m1'], status: null, event: true, at: 2 }), at: 2 })])
    expect(taskIds()).toEqual(['m1'])
    append([enqueue({ text: notification({ ids: ['m1'], status: 'completed', event: true, at: 3 }), at: 3 })])
    expect(taskIds()).toEqual([])
  })

  it('U8 — 같은 id 의 끝이 두 번(enqueue + user) 와도, 모르는 id 의 끝이 와도 던지지 않고 틀어지지 않는다', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 })] })
    const text = notification({ ids: ['b1'], status: 'completed', at: 3 })
    append([enqueue({ text, at: 3 }), userNotification({ text, at: 4 }), enqueue({ text: notification({ ids: ['ghost'], status: 'completed', at: 5 }), at: 5 })])
    expect(taskIds()).toEqual(['b2'])
    append([userNotification({ text, at: 6 })])
    expect(taskIds()).toEqual(['b2'])
  })

  it('한 통지에 task-id 가 여럿이면 전부 닫는다 (관측 2건)', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 }), ...bashBg({ toolId: 't3', taskId: 'b3', at: 3 })] })
    append([enqueue({ text: notification({ ids: ['b1', 'b2'], status: 'completed', at: 4 }), at: 4 })])
    expect(taskIds()).toEqual(['b3'])
  })

  it('사람이 친 글 한가운데의 태그는 통지가 아니다 — 통지는 <task-notification> 으로 시작한다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    append([userNotification({ text: `이거 봐 ${notification({ ids: ['b1'], status: 'completed', at: 2 })}`, at: 2 })])
    expect(taskIds()).toEqual(['b1'])
  })

  it('system/agents_killed 는 비동기 에이전트 작업만 닫는다', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), agentCall({ toolId: 't2', at: 2, background: true }), agentLaunched({ toolId: 't2', agentId: 'a1', at: 2 })] })
    append([agentsKilled(3)])
    const view = known(life())
    expect(view.tasks.map((task) => task.id)).toEqual(['b1'])
    expect(view.subagents).toEqual([])
  })

  it('run_in_background 없이 돌다 백그라운드로 옮겨진 Bash 도 결과의 backgroundTaskId 로 잡힌다', () => {
    setupClaude({ records: [
      toolUse({ id: 't1', name: 'Bash', toolInput: { command: 'npm test', description: '테스트' }, at: 1 }),
      toolResult({ id: 't1', at: 5, result: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b9' } }),
    ] })
    expect(known(life()).tasks).toEqual([{ id: 'b9', kind: 'shell', label: '테스트', startedAt: T0 + 5_000 }])
  })
})

// === L2 창 밖 시작 ===================================================================

describe('L2 시작 레코드가 꼬리 창(2MB) 밖으로 밀려나도 끝나기 전까지 남는다', () => {
  it('시작 뒤 2MB 넘게 자란 기록 — 열린 작업이 남고, 끝 신호가 오면 빠진다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    expect(taskIds()).toEqual(['b1'])
    for (let round = 0; round < 3; round += 1) {
      append(filler(1_000_000))
      expect(taskIds()).toEqual(['b1'])
    }
    expect(fs.statSync(claudeFile).size).toBeGreaterThan(2 * 1024 * 1024 + 1000)
    append([enqueue({ text: notification({ ids: ['b1'], status: 'completed', at: 9 }), at: 9 })])
    expect(taskIds()).toEqual([])
  })
})

// === L3 서브에이전트 자식 행 ==========================================================

describe('L3 서브에이전트 — 동기·비동기, 이름·유형·시작 시각·상태, 상한', () => {
  it('동기 Agent 는 tool_result 가 오기 전까지 도는 중이다', () => {
    setupClaude({ records: [agentCall({ toolId: 't1', at: 5, background: false, name: 'reviewer' })] })
    expect(known(life()).subagents).toEqual([
      { id: 't1', name: 'reviewer', description: '코드 찾기', agentType: 'Explore', background: false, startedAt: T0 + 5_000, status: 'running' },
    ])
    expect(known(life()).tasks).toEqual([]) // 동기는 백그라운드 작업이 아니다
    append([toolResult({ id: 't1', at: 9, content: [{ type: 'text', text: '끝' }], result: { status: 'completed', agentId: 'a0' } })])
    expect(known(life()).subagents).toEqual([])
  })

  it('동기 Agent 가 오류·중단 결과를 받아도 끝이다', () => {
    setupClaude({ records: [agentCall({ toolId: 't1', at: 5, background: false })] })
    append([toolResult({ id: 't1', at: 6, content: '[Request interrupted by user for tool use]', result: {} })])
    expect(known(life()).subagents).toEqual([])
  })

  it('비동기 Agent 는 async_launched 부터 끝 통지(task-id = agentId)까지 — 이름 없으면 null, 설명은 남는다', () => {
    setupClaude({ records: [agentCall({ toolId: 't1', at: 5, background: true }), agentLaunched({ toolId: 't1', agentId: 'a1', at: 6 })] })
    expect(known(life()).subagents).toEqual([
      { id: 'a1', name: null, description: '코드 찾기', agentType: 'Explore', background: true, startedAt: T0 + 5_000, status: 'running' },
    ])
    append([enqueue({ text: notification({ ids: ['a1'], status: 'completed', at: 9 }), at: 9 })])
    const view = known(life())
    expect(view.subagents).toEqual([])
    expect(view.tasks).toEqual([])
  })

  it(`상한 ${LIFECYCLE_MAX_ITEMS} — 넘친 수를 함께 싣는다`, () => {
    const records: unknown[] = []
    for (let i = 0; i < LIFECYCLE_MAX_ITEMS + 3; i += 1) {
      records.push(agentCall({ toolId: `t${i}`, at: i, background: true }), agentLaunched({ toolId: `t${i}`, agentId: `a${i}`, at: i }))
    }
    setupClaude({ records: records })
    const view = known(life())
    expect(view.subagents).toHaveLength(LIFECYCLE_MAX_ITEMS)
    expect(view.subagentOverflow).toBe(3)
    expect(view.tasks).toHaveLength(LIFECYCLE_MAX_ITEMS)
    expect(view.taskOverflow).toBe(3)
  })
})

// === L4 monitoring ===================================================================

describe('L4 isMonitoring — 턴 진행/끝 × 작업 없음/에이전트 아닌 작업/서브에이전트만/둘 다', () => {
  const shell: BackgroundTask = { id: 'b1', kind: 'shell', label: null, startedAt: 1 }
  const agentTask: BackgroundTask = { id: 'a1', kind: 'agent', label: null, startedAt: 1 }
  const sub: SessionSubagent = { id: 'a1', name: null, description: null, agentType: null, background: true, startedAt: 1, status: 'running' }
  const syncSub: SessionSubagent = { ...sub, id: 't1', background: false }
  const lifecycleOf = (input: { tasks: BackgroundTask[]; subagents: SessionSubagent[] }): SessionLifecycle => ({
    state: 'known',
    tasks: input.tasks,
    taskOverflow: 0,
    subagents: input.subagents,
    subagentOverflow: 0,
  })
  const sets = {
    none: lifecycleOf({ tasks: [], subagents: [] }),
    nonAgent: lifecycleOf({ tasks: [shell], subagents: [] }),
    subagentOnly: lifecycleOf({ tasks: [agentTask], subagents: [sub] }),
    syncSubagentOnly: lifecycleOf({ tasks: [], subagents: [syncSub] }),
    both: lifecycleOf({ tasks: [shell, agentTask], subagents: [sub] }),
    bothSync: lifecycleOf({ tasks: [shell], subagents: [syncSub] }),
  }
  // 턴 진행 = herdr working + 턴 결과 없음(새 턴이 시작됨). 턴 끝 = idle·done, 또는 working 인데 턴 결과가 있음(grok — n34)
  const completed: TurnOutcome = { outcome: 'completed' }
  const table: { status: AgentStatus; turn: TurnOutcome | null; set: keyof typeof sets; want: boolean }[] = [
    { status: 'working', turn: null, set: 'none', want: false },
    { status: 'working', turn: null, set: 'nonAgent', want: false },
    { status: 'working', turn: null, set: 'subagentOnly', want: false },
    { status: 'working', turn: null, set: 'both', want: false },
    { status: 'blocked', turn: completed, set: 'nonAgent', want: false },
    { status: 'idle', turn: completed, set: 'none', want: false },
    { status: 'idle', turn: completed, set: 'nonAgent', want: true },
    { status: 'idle', turn: null, set: 'nonAgent', want: true },
    { status: 'idle', turn: completed, set: 'subagentOnly', want: false },
    { status: 'idle', turn: completed, set: 'syncSubagentOnly', want: false },
    { status: 'idle', turn: completed, set: 'both', want: false },
    { status: 'idle', turn: completed, set: 'bothSync', want: false },
    { status: 'done', turn: completed, set: 'nonAgent', want: true },
    { status: 'done', turn: completed, set: 'both', want: false },
    { status: 'working', turn: completed, set: 'none', want: false },
    { status: 'working', turn: completed, set: 'nonAgent', want: true },
    { status: 'working', turn: { outcome: 'interrupted', reason: null }, set: 'nonAgent', want: true },
    { status: 'working', turn: completed, set: 'subagentOnly', want: false },
    { status: 'working', turn: completed, set: 'both', want: false },
    { status: 'unknown', turn: completed, set: 'nonAgent', want: false },
  ]
  it.each(table)('$status · turn=$turn.outcome × $set → $want', ({ status, turn, set, want }) => {
    expect(isMonitoring({ agentStatus: status, turnOutcome: turn, lifecycle: sets[set] })).toBe(want)
  })
  it('모름(따라잡기·출처 없음·프로세스 없음)은 monitoring 이 아니다', () => {
    const unknowns: SessionLifecycle[] = [
      { state: 'unknown', reason: 'catching-up' },
      { state: 'unknown', reason: 'no-source' },
      { state: 'unknown', reason: 'unreadable' },
      { state: 'unknown', reason: 'not-running' },
    ]
    for (const lifecycle of unknowns) expect(isMonitoring({ agentStatus: 'idle', turnOutcome: { outcome: 'completed' }, lifecycle })).toBe(false)
  })
})

// === L5 grok =========================================================================

describe('L5 grok updates.jsonl — background_tasks 스냅샷', () => {
  const grokRef: AgentSessionRef = { kind: 'id', agent: 'grok', source: 'herdr:grok', id: SESSION_ID }
  let updates = ''
  // grok 의 세대 경계는 소유 프로세스(여기선 이 테스트 프로세스)의 `ps` 시작 시각이다 — 항목 시각은 그 뒤여야 도는 것으로 실린다.
  const G0 = Math.floor(Date.now() / 1000) * 1000 + 60_000
  // 키 순서 = f1-lifecycle-shapes.json grok.*
  const update = (value: Record<string, unknown>) => ({ timestamp: 1, method: 'session/update', params: { sessionId: 'ID', update: value, _meta: { eventId: 'e', agentTimestampMs: 1 } } })
  const task = (id: string, status: string, kind = 'bash') => ({
    task_id: id,
    command: `sleep ${id}`,
    cwd: '/tmp',
    description: `설명 ${id}`,
    kind,
    output_file: '/tmp/o',
    started_at: new Date(G0 + 5_123).toISOString().replace('Z', '456789Z'),
    status,
  })
  const snapshot = (tasks: unknown[]) => update({ sessionUpdate: 'background_tasks', tasks })
  const completed = (id: string) =>
    update({ sessionUpdate: 'task_completed', task_snapshot: { task_id: id, command: 'x', kind: 'bash', exit_code: 0, explicitly_killed: false }, will_wake: false })

  beforeEach(() => {
    const dir = path.join(home, '.grok', 'sessions', '%2Ftmp', SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), jsonl([{ type: 'user', content: [{ type: 'text', text: '<user_query>해</user_query>' }] }]))
    updates = path.join(dir, 'updates.jsonl')
    registerGrok([{ session_id: SESSION_ID, pid: process.pid, cwd: '/tmp' }])
  })
  const grokLife = () => readSessionDigest(grokRef).digest.lifecycle
  // 키 순서 = `~/.grok/active_sessions.json` 관측(runs-r2/n44 원자료 옆 모양)
  const registerGrok = (rows: unknown[]) => fs.writeFileSync(path.join(home, '.grok', 'active_sessions.json'), JSON.stringify(rows))

  it('L8 grok — /exit(레지스트리 행 삭제)·강제 종료(죽은 pid) 뒤엔 not-running, 재개(새 pid + 빈 스냅샷)면 다시 known', () => {
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running')])]))
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
    registerGrok([{ session_id: 'other', pid: process.pid, cwd: '/tmp' }])
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'not-running' })
    registerGrok([{ session_id: SESSION_ID, pid: 2 ** 22 + 12345, cwd: '/tmp' }])
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'not-running' })
    fs.writeFileSync(path.join(home, '.grok', 'active_sessions.json'), '[{"session_id": ')
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'not-running' })
    registerGrok([{ session_id: SESSION_ID, pid: process.pid, cwd: '/tmp' }])
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
    fs.appendFileSync(updates, jsonl([snapshot([])]))
    expect(known(grokLife()).tasks).toEqual([])
  })

  it('마지막 스냅샷의 running 만 — 끝난 것(completed·failed)과 모르는 kind 는 빼고', () => {
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running'), task('2', 'completed'), task('3', 'failed'), task('4', 'running', 'mystery')])]))
    expect(known(grokLife()).tasks).toEqual([{ id: '1', kind: 'shell', label: '설명 1', startedAt: G0 + 5_123 }])
    fs.appendFileSync(updates, jsonl([snapshot([task('1', 'completed')])]))
    expect(known(grokLife()).tasks).toEqual([])
  })

  it('task_completed 가 스냅샷보다 먼저 와도 빠진다', () => {
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running'), task('2', 'running')]), completed('1')]))
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['2'])
  })

  it('마지막 스냅샷이 형제 파일 창(256KB) 밖이어도 잃지 않는다 (P1)', () => {
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running')])]))
    expect(known(grokLife()).tasks).toHaveLength(1)
    const noise = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y'.repeat(50_000) } })
    fs.appendFileSync(updates, jsonl(Array.from({ length: 12 }, () => noise)))
    expect(fs.statSync(updates).size).toBeGreaterThan(512 * 1024)
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
    clearTranscriptCache() // 처음부터 읽어도(따라잡기) 같은 답
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
  })

  // 서브에이전트 레코드 — 키 순서는 네이티브 표본(`runs-r2/n41` 의 기록: tool_call → subagent_spawned → tool_call_update)
  const meta = (ms: number) => ({ eventId: 'e', agentTimestampMs: ms })
  const spawnCall = (input: { callId: string; background: boolean }) => ({
    timestamp: 1,
    method: 'session/update',
    params: {
      sessionId: 'ID',
      update: { sessionUpdate: 'tool_call', toolCallId: input.callId, title: 'spawn_subagent', rawInput: { description: 'd', prompt: 'p', background: input.background }, _meta: {} },
      _meta: meta(G0),
    },
  })
  const callResult = (input: { callId: string; status: 'completed' | 'failed'; subagentId?: string }) => {
    // 봉투 = 네이티브 표본 4/4 (`raw/claude/r2-u6-spawn-envelope.txt`)
    const text = input.subagentId === undefined ? 'spawn failed' : `Subagent started in background.\nsubagent_id: ${input.subagentId}\ndescription: d\n`
    return {
      timestamp: 1,
      method: 'session/update',
      params: {
        sessionId: 'ID',
        update: { sessionUpdate: 'tool_call_update', toolCallId: input.callId, status: input.status, content: [{ type: 'content', content: { type: 'text', text } }], rawOutput: { type: 'Text', text } },
        _meta: meta(G0),
      },
    }
  }
  const spawned = (id: string, ms: number) => ({
    timestamp: 1,
    method: 'session/update',
    params: {
      sessionId: 'ID',
      update: { sessionUpdate: 'subagent_spawned', subagent_id: id, attempt_id: 'a', parent_session_id: 'p', parent_prompt_id: 'q', child_session_id: 'c', subagent_type: 'general', description: `서브 ${id}`, effective_context_source: 'x', model: 'm' },
      _meta: meta(ms),
    },
  })
  const finished = (id: string) => ({ timestamp: 1, method: 'session/update', params: { sessionId: 'ID', update: { sessionUpdate: 'subagent_finished', subagent_id: id, attempt_id: 'a', child_session_id: 'c', status: 'completed', tool_calls: 1, turns: 1, duration_ms: 1, tokens_used: 1, output: 'o', will_wake: true }, _meta: meta(G0 + 9_000) } })
  const backgrounds = () => Object.fromEntries(known(grokLife()).subagents.map((row) => [row.id, row.background]))

  it('서브에이전트 — subagent_spawned 부터 subagent_finished 까지, background 는 자식 id 를 돌려준 호출 결과로만 확정', () => {
    fs.writeFileSync(updates, jsonl([spawnCall({ callId: 'c1', background: true }), spawned('s1', G0 + 1_000)]))
    // 호출 결과 전 — 어느 호출의 자식인지 아직 증명 못 했다
    expect(known(grokLife()).subagents).toEqual([
      { id: 's1', name: null, description: '서브 s1', agentType: 'general', background: null, startedAt: G0 + 1_000, status: 'running' },
    ])
    fs.appendFileSync(updates, jsonl([callResult({ callId: 'c1', status: 'completed', subagentId: 's1' })]))
    expect(backgrounds()).toEqual({ s1: true })
    fs.appendFileSync(updates, jsonl([finished('s1'), finished('ghost')]))
    expect(known(grokLife()).subagents).toEqual([])
  })

  it('F4 — 자식을 못 만든(실패) 호출은 다음 자식의 background 를 오염시키지 않는다', () => {
    fs.writeFileSync(
      updates,
      jsonl([
        spawnCall({ callId: 'c1', background: true }),
        callResult({ callId: 'c1', status: 'failed' }),
        spawnCall({ callId: 'c2', background: false }),
        spawned('s2', G0 + 2_000),
      ]),
    )
    expect(backgrounds()).toEqual({ s2: null })
    fs.appendFileSync(updates, jsonl([callResult({ callId: 'c2', status: 'completed', subagentId: 's2' })]))
    expect(backgrounds()).toEqual({ s2: false })
  })

  it('F4 — 병렬 두 호출: 생성 순서가 호출 순서와 달라도, 결과가 시작보다 먼저 와도 제 호출과 묶인다', () => {
    fs.writeFileSync(
      updates,
      jsonl([
        spawnCall({ callId: 'c1', background: true }),
        spawnCall({ callId: 'c2', background: false }),
        spawned('s2', G0 + 1_000),
        spawned('s1', G0 + 2_000),
        callResult({ callId: 'c2', status: 'completed', subagentId: 's2' }),
        callResult({ callId: 'c1', status: 'completed', subagentId: 's1' }),
        spawnCall({ callId: 'c3', background: true }),
        callResult({ callId: 'c3', status: 'completed', subagentId: 's3' }),
        spawned('s3', G0 + 3_000),
      ]),
    )
    expect(backgrounds()).toEqual({ s1: true, s2: false, s3: true })
  })

  it('F3 — tasks 가 배열이 아닌 스냅샷(null·키 없음·문자열)은 작업 없음이 아니라 모름, 다음 온전한 스냅샷에서 풀린다', () => {
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running')])]))
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
    for (const bad of [update({ sessionUpdate: 'background_tasks', tasks: null }), update({ sessionUpdate: 'background_tasks' }), update({ sessionUpdate: 'background_tasks', tasks: 'x' })]) {
      fs.appendFileSync(updates, jsonl([snapshot([task('1', 'running')]), bad]))
      expect(grokLife()).toEqual({ state: 'unknown', reason: 'unreadable' })
    }
    fs.appendFileSync(updates, jsonl([snapshot([])]))
    expect(known(grokLife()).tasks).toEqual([])
  })

  it('F1 grok — 끝 신호 없이 프로세스와 같이 죽은 자식은 재개(새 프로세스·빈 스냅샷) 뒤 싣지 않는다, 캐시 없이 다시 읽어도', async () => {
    // 옛 프로세스 시절에 열린 자식 — 새 소유 프로세스(아래 자식 프로세스)보다 확실히 먼저
    const old = Date.now() - 5_000
    fs.writeFileSync(updates, jsonl([spawned('old-child', old), snapshot([])]))
    registerGrok([{ session_id: SESSION_ID, pid: 2 ** 22 + 12345, cwd: '/tmp' }]) // 강제 종료 — 행은 남고 pid 는 죽음
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'not-running' })
    const owner = spawn('/bin/sleep', ['30'])
    try {
      await new Promise((resolve) => owner.once('spawn', resolve))
      registerGrok([{ session_id: SESSION_ID, pid: owner.pid, cwd: '/tmp' }]) // 재개 — 새 pid
      fs.appendFileSync(updates, jsonl([snapshot([]), spawned('new-child', Date.now() + 60_000)]))
      expect(known(grokLife()).subagents.map((row) => row.id)).toEqual(['new-child'])
      clearTranscriptCache()
      expect(known(grokLife()).subagents.map((row) => row.id)).toEqual(['new-child'])
    } finally {
      owner.kill()
    }
  })

  it('R2-F5 — 실패한 spawn 호출 결과도 사전 필터를 지나 기다리는 호출에서 치워진다(applyLines 경로)', () => {
    fs.writeFileSync(updates, jsonl([spawnCall({ callId: 'c1', background: true }), callResult({ callId: 'c1', status: 'failed' })]))
    const step = advanceLedger({ file: updates, stat: fs.statSync(updates), agent: 'grok', prior: null })
    expect(step.ledger.state.agent === 'grok' ? step.ledger.state.spawnCalls.size : -1).toBe(0)
  })

  it('U6 — 봉투 맨 앞이 아닌 자리의 subagent_id: (인용·자식 응답)는 짝으로 쓰지 않는다', () => {
    const quoted = (input: { callId: string; text: string }) => ({
      timestamp: 1,
      method: 'session/update',
      params: { sessionId: 'ID', update: { sessionUpdate: 'tool_call_update', toolCallId: input.callId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: input.text } }], rawOutput: { type: 'Text', text: input.text } }, _meta: meta(G0) },
    })
    fs.writeFileSync(
      updates,
      jsonl([
        spawnCall({ callId: 'c1', background: false }),
        spawned('s1', G0 + 1_000),
        quoted({ callId: 'c1', text: 'child said:\nsubagent_id: s1\nok' }),
        spawnCall({ callId: 'c2', background: true }),
        spawned('s2', G0 + 2_000),
        quoted({ callId: 'c2', text: 'Subagent started in background.\nsubagent_id: s2\ndescription: d\n' }),
      ]),
    )
    expect(backgrounds()).toEqual({ s1: null, s2: true })
  })

  it('R2-F1 grok — started_at 없는 running 작업이 열려 있으면 모름, 끝나면 회복', () => {
    const noTime = without({ record: task('9', 'running'), key: 'started_at' })
    fs.writeFileSync(updates, jsonl([snapshot([task('1', 'running'), noTime])]))
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'unreadable' })
    fs.appendFileSync(updates, jsonl([completed('9')]))
    expect(known(grokLife()).tasks.map((row) => row.id)).toEqual(['1'])
  })

  it('updates.jsonl 이 없으면 출처 없음', () => {
    expect(grokLife()).toEqual({ state: 'unknown', reason: 'no-source' })
  })
})

// === L6 누적 판독과 초기화 ===========================================================

describe('L6 누적 판독 — 새 바이트만, 판독 전제 ①②③ 에서 다시 쌓기, 따라잡기 전은 모름', () => {
  function step(prior: Ledger | null) {
    return advanceLedger({ file: claudeFile, stat: fs.statSync(claudeFile), agent: 'claude', prior })
  }

  it('두 번째 판독은 새로 붙은 바이트(+ 닻 1KiB)만 읽는다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    const first = step(null)
    expect(first.bytes).toBe(fs.statSync(claudeFile).size)
    const before = fs.statSync(claudeFile).size
    append(bashBg({ toolId: 't2', taskId: 'b2', at: 2 }))
    const added = fs.statSync(claudeFile).size - before
    const second = step(first.ledger)
    expect(second.reset).toBeNull()
    expect(second.bytes).toBe(added + Math.min(1024, before))
    expect(known(ledgerView({ ledger: second.ledger, since: 0 })).tasks.map((task) => task.id)).toEqual(['b1', 'b2'])
  })

  it('① 파일 교체(정체성 변경) — 누적 상태를 버리고 새 파일로 다시 쌓는다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    const first = step(null)
    const replacement = `${claudeFile}.new`
    fs.writeFileSync(replacement, jsonl([...bashBg({ toolId: 't9', taskId: 'b9', at: 1 }), ...filler(10)]))
    fs.renameSync(replacement, claudeFile)
    const second = step(first.ledger)
    expect(second.reset).toBe('identity')
    expect(known(ledgerView({ ledger: second.ledger, since: 0 })).tasks.map((task) => task.id)).toEqual(['b9'])
  })

  it('② 축소 — 지난 끝보다 짧아지면 다시 쌓는다', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...filler(5000)] })
    const first = step(null)
    fs.truncateSync(claudeFile, 0)
    fs.appendFileSync(claudeFile, jsonl(bashBg({ toolId: 't2', taskId: 'b2', at: 2 })))
    const second = step(first.ledger)
    expect(second.reset).toBe('shrunk')
    expect(known(ledgerView({ ledger: second.ledger, since: 0 })).tasks.map((task) => task.id)).toEqual(['b2'])
  })

  it('③ 지난 끝 앞의 변경(같은 정체성·크기 증가) — 닻이 달라지면 다시 쌓는다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    const first = step(null)
    const text = fs.readFileSync(claudeFile, 'utf8').replace('"b1"', '"c1"')
    const handle = fs.openSync(claudeFile, 'r+') // 같은 inode 제자리 쓰기
    fs.writeSync(handle, text, 0)
    fs.closeSync(handle)
    append(filler(10))
    const second = step(first.ledger)
    expect(second.reset).toBe('anchor')
    expect(known(ledgerView({ ledger: second.ledger, since: 0 })).tasks.map((task) => task.id)).toEqual(['c1'])
  })

  it('따라잡기 전(긴 파일 첫 판독이 여러 주기) 은 빈 목록이 아니라 모름 — 주기당 ≤2MB, 끝에 닿으면 known', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...filler(5 * 1024 * 1024)] })
    const views: SessionLifecycle[] = []
    const costs: number[] = []
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const read = readSessionDigests(new Map([['pane', claudeRef]]))
      costs.push(read.cost.lifecycleMaxFileBytes)
      const digest = read.digests.get('pane')
      if (digest === undefined) throw new Error('지문 없음')
      views.push(digest.lifecycle)
      if (digest.lifecycle.state === 'known') break
    }
    expect(views.slice(0, -1).every((view) => view.state === 'unknown' && view.reason === 'catching-up')).toBe(true)
    expect(views.length).toBe(3) // 5MB+ / 2MB → 세 주기
    expect(known(views[views.length - 1]!).tasks.map((task) => task.id)).toEqual(['b1'])
    expect(Math.max(...costs)).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES + 4096) // 레지스트리 파일 몇 바이트 포함
  })

  it('한도보다 긴 한 줄은 건너뛰고 그 뒤 표지를 읽는다', () => {
    setupClaude({ records: [{ type: 'user', message: { role: 'user', content: 'x'.repeat(LIFECYCLE_READ_MAX_BYTES + 100) } }, ...bashBg({ toolId: 't1', taskId: 'b1', at: 1 })] })
    let ledger: Ledger | null = null
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const next = step(ledger)
      expect(next.bytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
      ledger = next.ledger
      if (ledger.caughtUp) break
    }
    expect(ledger?.caughtUp).toBe(true)
    expect(known(ledgerView({ ledger: ledger!, since: 0 })).tasks.map((task) => task.id)).toEqual(['b1'])
  })

  it('무변경 파일은 읽기 0바이트 — 따라잡았고 그대로면 stat 만', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    readSessionDigest(claudeRef)
    const spy = vi.spyOn(fs, 'readSync')
    try {
      const again = readSessionDigest(claudeRef)
      expect(again.statOnly).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('쓰다 만 끝줄(줄바꿈 없음)은 다음 주기에 읽는다', () => {
    setupClaude({ records: [] })
    const [use, result] = bashBg({ toolId: 't1', taskId: 'b1', at: 1 })
    fs.appendFileSync(claudeFile, `${JSON.stringify(use)}\n${JSON.stringify(result).slice(0, 40)}`)
    expect(taskIds()).toEqual([])
    fs.appendFileSync(claudeFile, `${JSON.stringify(result).slice(40)}\n`)
    expect(taskIds()).toEqual(['b1'])
  })
})

// === L8 끝 신호 없는 죽음 ============================================================

describe('L8 프로세스가 끝난 뒤의 열린 작업은 도는 중으로 싣지 않는다', () => {
  it('cost-state(정상 종료 표지) 뒤에는 열린 작업·서브에이전트가 없다 — 재개의 stopped 통지는 모르는 id 로 무해', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), agentCall({ toolId: 't2', at: 2, background: false })] })
    append([costState()])
    expect(known(life())).toMatchObject({ tasks: [], subagents: [] })
    append([enqueue({ text: notification({ ids: ['b1'], status: 'stopped', at: 9 }), at: 9 }), ...bashBg({ toolId: 't3', taskId: 'b3', at: 10 })])
    expect(taskIds()).toEqual(['b3'])
  })

  it('살아 있는 소유 프로세스가 없으면 not-running — 기록이 그대로여도 생존이 바뀌면 다시 싣는다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), live: false })
    expect(life()).toEqual({ state: 'unknown', reason: 'not-running' })
    registerLive({ startedAt: 0 })
    expect(taskIds()).toEqual(['b1'])
    // 강제 종료 — 기록엔 아무것도 안 남고 레지스트리의 pid 가 죽는다
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: SESSION_ID }))
    expect(life()).toEqual({ state: 'unknown', reason: 'not-running' })
  })

  it('레지스트리에 다른 세션만 있거나 깨진 파일이면 not-running', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), live: false })
    const sessions = path.join(home, '.claude', 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'other' }))
    fs.writeFileSync(path.join(sessions, '1.json'), '{"pid": 1, "sessionId": ')
    expect(life()).toEqual({ state: 'unknown', reason: 'not-running' })
  })
})

// === L9 형식 비계약·공급 ==============================================================

describe('L9 낯선 모양에서 던지지 않는다 · 한 세션 실패가 다른 세션을 안 무너뜨린다 · 값 하나만 바뀌어도 emit', () => {
  it('잘린 줄·필드 누락·타입 어긋남', () => {
    setupClaude({ records: [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 5, name: 'Bash', input: 'x' }] } },
      { type: 'assistant', message: { content: 'tool_use 문자열' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: null }] }, toolUseResult: { backgroundTaskId: 7 } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q' }] }, toolUseResult: 'Error: toolUseResult 문자열' },
      { type: 'queue-operation', operation: 'enqueue', content: { text: '<task-notification>' } },
      { type: 'system', subtype: 'agents_killed' },
      { type: 'cost-state', sessionId: 5 },
      ...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }),
    ] })
    append([{ type: 'user', message: { content: '<task-notification><task-id></task-id><status>completed</status>' } }])
    fs.appendFileSync(claudeFile, '{"type":"user","toolUseResult":{"backgroundTaskId":"b2"\n[1,2]\nnull\n"str"\n')
    expect(() => life()).not.toThrow()
    expect(taskIds()).toEqual(['b1'])
  })

  it('한 참조의 판독 실패가 다른 참조를 무너뜨리지 않는다', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }) })
    const broken: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: path.join(home, 'no-such.jsonl') }
    const read = readSessionDigests(new Map<string, AgentSessionRef>([['a', broken], ['b', claudeRef]]))
    expect(read.digests.get('a')?.lifecycle.state).toBe('unknown')
    expect(known(read.digests.get('b')!.lifecycle).tasks.map((task) => task.id)).toEqual(['b1'])
  })

  it('codex 는 출처 없음 — 거짓 빈 목록을 싣지 않는다', () => {
    const day = path.join(home, '.codex', 'sessions', '2026', '09', '30')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, `rollout-2026-09-30T00-00-00-${SESSION_ID}.jsonl`), jsonl([{ type: 'session_meta', payload: {} }]))
    const codexRef: AgentSessionRef = { kind: 'id', agent: 'codex', source: 'herdr:codex', id: SESSION_ID }
    expect(readSessionDigest(codexRef).digest.lifecycle).toEqual({ state: 'unknown', reason: 'no-source' })
  })

  it('작업 하나가 끝나기만 해도 지문이 달라진다 (emit)', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 })] })
    const before = readSessionDigest(claudeRef).digest
    append([enqueue({ text: notification({ ids: ['b2'], status: 'completed', at: 3 }), at: 3 })])
    const after = readSessionDigest(claudeRef).digest
    expect(digestsEqual({ a: before, b: after })).toBe(false)
    expect(digestsEqual({ a: after, b: readSessionDigest(claudeRef).digest })).toBe(true)
  })
})

// === 수정 라운드 1 (05-fix-r1) ======================================================

describe('F1 claude — 강제 종료 중 열린 작업·자식은 재개(새 프로세스) 뒤 싣지 않는다', () => {
  it('비동기 Agent·동기 Agent·셸이 열린 채 kill -9 → not-running → 재개(startedAt 이 그 뒤인 새 소유자)면 옛 열림은 빠지고 새 것만', () => {
    setupClaude({
      records: [
        agentCall({ toolId: 't1', at: 10, background: true }),
        agentLaunched({ toolId: 't1', agentId: 'a-old', at: 11 }),
        agentCall({ toolId: 't2', at: 20, background: false }), // 동기 — 결과 전
        ...bashBg({ toolId: 't3', taskId: 'b-old', at: 30 }),
      ],
    })
    expect(known(life()).subagents.map((row) => row.id)).toEqual(['a-old', 't2'])
    // 강제 종료 — 레지스트리 파일이 사라진다(n19), 기록엔 아무것도 없다
    fs.rmSync(path.join(home, '.claude', 'sessions', `${process.pid}.json`))
    expect(life()).toEqual({ state: 'unknown', reason: 'not-running' })
    // 재개 — 같은 파일에 잇고, 새 프로세스의 시작 시각은 옛 열림보다 뒤다
    registerLive({ startedAt: T0 + 100_000 })
    expect(known(life())).toMatchObject({ tasks: [], subagents: [] })
    append(bashBg({ toolId: 't4', taskId: 'b-new', at: 200 }))
    expect(taskIds()).toEqual(['b-new'])
    clearTranscriptCache() // 캐시 없이 처음부터 읽어도 같다 — 기록 순서가 아니라 시각으로 가른다
    expect(taskIds()).toEqual(['b-new'])
  })

  it('살아 있는 소유자의 시작 시각을 모르면(레지스트리에 startedAt 없음) 세대를 못 갈라 모름', () => {
    setupClaude({ records: bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), live: false })
    const sessions = path.join(home, '.claude', 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION_ID }))
    expect(life()).toEqual({ state: 'unknown', reason: 'unreadable' })
  })
})

describe('F2 같은 파일을 가리키는 pane 여럿 — 주기당 한 번 판독, 모든 pane 같은 값, 비용은 파일별', () => {
  it('같은 참조 pane 2개 + 경로 참조 1개, 3MB 기록 → 파일당 주기 ≤2MB, 세 pane 이 매 주기 같은 lifecycle', () => {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...filler(3_000_000), ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 })] })
    const pathRef: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: claudeFile }
    const refs = new Map<string, AgentSessionRef>([
      ['p1', claudeRef],
      ['p2', claudeRef],
      ['p3', pathRef],
    ])
    const states: string[] = []
    for (let round = 0; round < 3; round += 1) {
      const read = readSessionDigests(refs)
      expect(read.cost.lifecycleMaxFileBytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
      expect(read.cost.lifecycleBytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
      const values = [...read.digests.values()].map((digest) => JSON.stringify(digest.lifecycle))
      expect(new Set(values).size).toBe(1)
      states.push(read.digests.get('p1')!.lifecycle.state)
      if (round === 0) expect(read.cost.lifecycleRegistryBytes).toBeGreaterThan(0)
    }
    expect(states).toEqual(['unknown', 'known', 'known'])
    expect(known(readSessionDigests(refs).digests.get('p3')!.lifecycle).tasks.map((task) => task.id)).toEqual(['b1', 'b2'])
  })
})

describe('U2 claude 사전 필터 — toolUseResult 키 없는 tool_result 도 동기 Agent 를 닫는다', () => {
  it('키 없는 결과(오류) → 자식 빠짐', () => {
    setupClaude({ records: [agentCall({ toolId: 't1', at: 1, background: false })] })
    expect(known(life()).subagents.map((row) => row.id)).toEqual(['t1'])
    const record = toolResult({ id: 't1', at: 2, result: {}, content: 'Error: 중단' })
    append([Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'toolUseResult'))])
    expect(known(life()).subagents).toEqual([])
  })
})

describe('U3 한도보다 긴 줄을 건너뛰면 그때 열려 있던 것은 모름', () => {
  it('열린 동기 Agent 의 끝(2MB 넘는 결과)을 건너뜀 → unreadable, 세대가 바뀌면(재개) 풀린다', () => {
    setupClaude({ records: [agentCall({ toolId: 't1', at: 1, background: false })] })
    expect(known(life()).subagents.map((row) => row.id)).toEqual(['t1'])
    append([toolResult({ id: 't1', at: 2, result: { status: 'completed' }, content: 'x'.repeat(LIFECYCLE_READ_MAX_BYTES + 100_000) })])
    // 긴 줄은 두 주기에 걸쳐 건너뛴다 — 끝까지 따라잡은 뒤의 값이 모름이어야 한다
    let lifecycle = life()
    for (let step = 0; step < 3 && lifecycle.state === 'unknown' && lifecycle.reason === 'catching-up'; step += 1) lifecycle = life()
    expect(lifecycle).toEqual({ state: 'unknown', reason: 'unreadable' })
    append(bashBg({ toolId: 't2', taskId: 'b1', at: 3 }))
    expect(life()).toEqual({ state: 'unknown', reason: 'unreadable' }) // 불확실한 t1 이 아직 열려 있다
    registerLive({ startedAt: T0 + 2_500 }) // 재개 — t1 은 옛 세대라 빠지고 불확실도 풀린다
    expect(known(life())).toMatchObject({ subagents: [], tasks: [{ id: 'b1' }] })
  })

  it('건너뛸 때 열린 것이 없었으면 known 그대로', () => {
    setupClaude({ records: [toolResult({ id: 'zz', at: 1, result: {}, content: 'x'.repeat(LIFECYCLE_READ_MAX_BYTES + 100_000) })] })
    let lifecycle = life()
    for (let step = 0; step < 3 && lifecycle.state === 'unknown'; step += 1) lifecycle = life()
    expect(known(lifecycle).tasks).toEqual([])
  })
})

// === 수정 라운드 2 (07-fix-r2) ======================================================

describe('R2-F1 claude — 시작 시각을 모르는 열린 항목이 있으면 모름(빼고 known 을 내지 않는다)', () => {
  it('시각 없는 동기 Agent + 시각 있는 셸 → unreadable·monitoring false, 결과가 오면 회복', () => {
    const noTime = without({ record: agentCall({ toolId: 't1', at: 1, background: false }), key: 'timestamp' })
    setupClaude({ records: [noTime, ...bashBg({ toolId: 't2', taskId: 'b1', at: 2 })] })
    const lifecycle = life()
    expect(lifecycle).toEqual({ state: 'unknown', reason: 'unreadable' })
    expect(isMonitoring({ agentStatus: 'idle', turnOutcome: null, lifecycle })).toBe(false)
    append([toolResult({ id: 't1', at: 3, result: { status: 'completed' } })])
    expect(taskIds()).toEqual(['b1'])
  })
})

describe('R2-F2 같은 실제 파일을 다른 경로(별칭)로 가리켜도 장부·주기 판독·비용이 하나', () => {
  function aliasSetup() {
    setupClaude({ records: [...bashBg({ toolId: 't1', taskId: 'b1', at: 1 }), ...filler(3_000_000), ...bashBg({ toolId: 't2', taskId: 'b2', at: 2 })] })
    const alias = path.join(home, 'alias-dir')
    fs.symlinkSync(path.dirname(claudeFile), alias)
    const aliasRef: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: path.join(alias, path.basename(claudeFile)) }
    return aliasRef
  }

  it('id 참조 + 심볼릭 링크 경로 참조 → 파일당 주기 ≤2MB, lifecycleMaxFileBytes = 실제 파일 합, 두 pane 같은 값', () => {
    const aliasRef = aliasSetup()
    const refs = new Map<string, AgentSessionRef>([
      ['p1', claudeRef],
      ['p2', aliasRef],
    ])
    for (let round = 0; round < 3; round += 1) {
      const read = readSessionDigests(refs)
      expect(read.cost.lifecycleBytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
      expect(read.cost.lifecycleMaxFileBytes).toBe(read.cost.lifecycleBytes) // 파일이 하나다
      expect(JSON.stringify(read.digests.get('p1')!.lifecycle)).toBe(JSON.stringify(read.digests.get('p2')!.lifecycle))
    }
  })

  it('별칭 pane 이 따라잡은 뒤에 추가돼도 같은 주기에 같은 값(다시 따라잡지 않는다)', () => {
    const aliasRef = aliasSetup()
    const only = new Map<string, AgentSessionRef>([['p1', claudeRef]])
    readSessionDigests(only)
    expect(known(readSessionDigests(only).digests.get('p1')!.lifecycle).tasks.map((task) => task.id)).toEqual(['b1', 'b2'])
    const both = new Map<string, AgentSessionRef>([
      ['p1', claudeRef],
      ['p2', aliasRef],
    ])
    const read = readSessionDigests(both)
    expect(read.cost.lifecycleBytes).toBe(0)
    expect(JSON.stringify(read.digests.get('p2')!.lifecycle)).toBe(JSON.stringify(read.digests.get('p1')!.lifecycle))
  })
})

describe('R3-F1 provider 가 다른 참조가 같은 실제 파일을 가리켜도 서로의 parser 상태를 안 쓴다 — 참조 순서 무관', () => {
  const G0 = Math.floor(Date.now() / 1000) * 1000 + 60_000
  const grokRef: AgentSessionRef = { kind: 'id', agent: 'grok', source: 'herdr:grok', id: SESSION_ID }
  const running = {
    timestamp: 1,
    method: 'session/update',
    params: {
      sessionId: 'ID',
      update: { sessionUpdate: 'background_tasks', tasks: [{ task_id: 'g1', kind: 'bash', description: 'd', started_at: new Date(G0).toISOString(), status: 'running' }] },
      _meta: { eventId: 'e', agentTimestampMs: 1 },
    },
  }
  function crossSetup(link: 'symlink' | 'hardlink') {
    const dir = path.join(home, '.grok', 'sessions', '%2Ftmp', SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), jsonl([{ type: 'user', content: [{ type: 'text', text: '<user_query>해</user_query>' }] }]))
    const updates = path.join(dir, 'updates.jsonl')
    fs.writeFileSync(updates, jsonl([running]))
    fs.writeFileSync(path.join(home, '.grok', 'active_sessions.json'), JSON.stringify([{ session_id: SESSION_ID, pid: process.pid, cwd: '/tmp' }]))
    registerLive({ startedAt: 0 })
    const alias = path.join(home, `${SESSION_ID}.jsonl`)
    if (link === 'symlink') fs.symlinkSync(updates, alias)
    else fs.linkSync(updates, alias)
    const claudeAlias: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: alias }
    return claudeAlias
  }
  const lifecycles = (read: ReturnType<typeof readSessionDigests>) => JSON.stringify(Object.fromEntries([...read.digests].sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => [id, digest.lifecycle])))

  for (const link of ['symlink', 'hardlink'] as const) {
    it(`${link} — 한 주기에 둘이 같이 있으면 두 순서 모두 둘 다 unreadable(거짓 항목 0), 파일은 한 번만 읽고, 풀리면 grok 은 제 작업을 낸다`, () => {
      const claudeAlias = crossSetup(link)
      const results: string[] = []
      for (const order of [
        [['grok', grokRef], ['claude', claudeAlias]],
        [['claude', claudeAlias], ['grok', grokRef]],
      ] as const) {
        clearTranscriptCache()
        const refs = new Map<string, AgentSessionRef>(order)
        const read = readSessionDigests(refs)
        expect(read.cost.lifecycleMaxFileBytes).toBeLessThanOrEqual(LIFECYCLE_READ_MAX_BYTES)
        expect(read.cost.lifecycleBytes).toBe(read.cost.lifecycleMaxFileBytes) // 파일 하나를 한 번만 읽었다
        results.push(lifecycles(readSessionDigests(refs)))
        expect(read.digests.get('grok')!.lifecycle).toEqual({ state: 'unknown', reason: 'unreadable' })
        expect(read.digests.get('claude')!.lifecycle).toEqual({ state: 'unknown', reason: 'unreadable' })
        const alone = readSessionDigests(new Map([['grok', grokRef]]))
        expect(known(alone.digests.get('grok')!.lifecycle).tasks.map((task) => task.id)).toEqual(['g1'])
      }
      expect(results[0]).toBe(results[1])
    })
  }

  it('따로 읽는 주기(단독 호출)에서도 어느 쪽을 먼저 읽든 grok 은 제 작업, claude 는 grok 항목을 안 낸다', () => {
    const claudeAlias = crossSetup('symlink')
    const seen: string[] = []
    for (const first of ['grok', 'claude'] as const) {
      clearTranscriptCache()
      const firstLife = readSessionDigest(first === 'grok' ? grokRef : claudeAlias).digest.lifecycle
      const secondLife = readSessionDigest(first === 'grok' ? claudeAlias : grokRef).digest.lifecycle
      const grok = first === 'grok' ? firstLife : secondLife
      const claude = first === 'grok' ? secondLife : firstLife
      expect(known(grok).tasks.map((task) => task.id)).toEqual(['g1'])
      expect(JSON.stringify(claude)).not.toContain('g1')
      seen.push(JSON.stringify({ grok, claude }))
    }
    expect(seen[0]).toBe(seen[1])
  })
})

describe('R3-F2 교체돼 아무 참조도 안 쓰는 inode 의 장부는 회수한다', () => {
  const swap = (at: number) => {
    fs.writeFileSync(`${claudeFile}.tmp`, jsonl(bashBg({ toolId: `t${at}`, taskId: `b${at}`, at })))
    fs.renameSync(`${claudeFile}.tmp`, claudeFile)
  }

  it('같은 경로 20회 교체 → 장부 1, 참조 0 주기 뒤 0', () => {
    setupClaude({ records: bashBg({ toolId: 't0', taskId: 'b0', at: 1 }) })
    for (let n = 1; n <= 20; n += 1) {
      swap(n)
      expect(taskIds()).toEqual([`b${n}`])
      expect(lifecycleLedgerCount()).toBe(1)
    }
    readSessionDigests(new Map())
    expect(lifecycleLedgerCount()).toBe(0)
  })

  it('별칭 두 참조 + 교체 → 장부 1(공유 유지), 한쪽만 남아도 공유 장부는 산다', () => {
    setupClaude({ records: bashBg({ toolId: 't0', taskId: 'b0', at: 1 }) })
    const alias = path.join(home, 'alias-dir')
    fs.symlinkSync(path.dirname(claudeFile), alias)
    const aliasRef: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: path.join(alias, path.basename(claudeFile)) }
    const both = new Map<string, AgentSessionRef>([
      ['p1', claudeRef],
      ['p2', aliasRef],
    ])
    for (let n = 1; n <= 5; n += 1) {
      swap(n)
      const read = readSessionDigests(both)
      expect(lifecycleLedgerCount()).toBe(1)
      expect(known(read.digests.get('p2')!.lifecycle).tasks.map((task) => task.id)).toEqual([`b${n}`])
    }
    const read = readSessionDigests(new Map([['p2', aliasRef]]))
    expect(read.cost.lifecycleBytes).toBe(0)
    expect(lifecycleLedgerCount()).toBe(1)
  })
})
