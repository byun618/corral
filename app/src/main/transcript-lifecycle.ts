// 백그라운드 작업·서브에이전트 수명 — **기록 누적(증분) 판독** (LIFE-462 #10·#11). herdr 를 모르는 층이다.
//
// # 왜 꼬리 창이 아닌가
//
// 458 의 판독은 "마지막 값" 이라 꼬리 창(≤2MB)으로 됐다. 여기서 싣는 것은 **열린 집합**(시작 ↔ 끝 짝)이고, 시작 레코드가
// 꼬리 창 밖에 있는 일이 흔하다 — 사용자 기록에서 끝까지 >2MB 떨어진 백그라운드 Bash 34/869 · Monitor 3/100 · 비동기 Agent
// 1/106 (00-analysis P1). 그래서 파일마다 **지난 판독 끝 위치 + 열린 집합**을 들고 가서 새 바이트만 읽어 갱신한다.
//
// # 판독 전제 — append-only (01-criteria)
//
// ① 파일 정체성(dev·ino)이 바뀌었거나 ② 파일이 지난 판독 끝보다 짧아졌거나 ③ 지난 판독 끝 바로 앞 1KiB(닻)가 달라졌으면
// 누적 상태를 버리고 0 부터 다시 쌓는다. 같은 정체성으로 제자리 재작성하되 크기·닻이 유지되는 경우는 전제 밖이다.
//
// # 비용 — 파일 하나·주기 1회 ≤2MB (L7)
//
// 첫 판독(따라잡기)도 이 한도로 나눈다. 끝에 못 닿은 동안은 목록을 **모름**(`catching-up`)으로 싣는다 — 빈 목록이 아니다.
// 한 줄이 한도보다 길면 그 줄은 건너뛴다(`skipping`) — 시작·끝 표지 레코드는 짧다(도구 결과 본문이 든 긴 줄이 아니다).
//
// # 표지 — 전부 실측(관측)이다. 형식 계약이 아니다
//
// claude (`raw/claude/u1-u4-out.txt` · `u3-cost-state-out.txt` · `u5-shapes-out.txt`, 00-analysis §2·§5):
//   시작  · `Bash`·`Monitor`·`Agent` tool_use (이름·설명·명령·시각을 쥔다)
//         · 그 tool_result 레코드의 `toolUseResult` — `backgroundTaskId`(셸) · `taskId`+`timeoutMs`(Monitor) ·
//           `status:'async_launched'`+`agentId`(비동기 Agent). 동기 Agent 는 tool_result 가 오기 전까지가 수명이다
//   끝    · `<task-notification>` 에 `<status>` 가 있으면 그 안의 `<task-id>` 전부가 끝났다 — status 값은 가리지 않는다
//           (`completed·failed·killed·stopped` 로 닫지 않는다). `<status>` 없는 Monitor `<event>` 통지는 끝이 아니다.
//           queue-operation enqueue 와 user 레코드로 두 번 오는데, 둘 다 같은 id 를 닫으니 두 번째는 무해하다(U8)
//         · `TaskStop` 결과 `toolUseResult{task_id, task_type}`
//         · `system/agents_killed` — 열린 비동기 에이전트 전부 (실측 1건, 그때 열린 것 0 — 이름 그대로의 뜻으로 쓴다)
//         · **`cost-state` 레코드 = 그 프로세스가 끝났다** (L8). 프로세스가 끝나면 백그라운드 작업도 같이 죽는데 끝 통지가
//           없다(#72171). 재개하면 하네스가 `status:stopped` 통지를 같은 파일에 쓰지만(`raw/claude/u3-resume-probe.txt`),
//           재개 전까지는 열린 채로 남는다. 사용자 기록 242 파일 · cost-state 426 중 그 뒤에 닫힌 작업 8/8 이 전부 재개 통지였다.
//
// # 끝 표지 없는 죽음 — 프로세스 생존 (L8)
//
// 강제 종료(SIGKILL·pane 닫기)는 `cost-state` 도 안 남긴다 — 사용자 기록에서 끝에 "열림" 이 남은 파일 21 이 전부 cost-state 가
// 없었다(`raw/claude/u3b-open-at-eof-out.txt`). 그래서 claude 는 **살아 있는 소유 프로세스**를 따로 본다: claude 는 대화형
// 프로세스마다 `~/.claude/sessions/<pid>.json`(`pid`·`sessionId`…)을 쓴다(관측). 그 세션 id 를 가진 항목의 pid 가 살아 있을
// 때만 목록을 싣고, 아니면 `not-running` 이다. 누적 상태는 계속 쌓는다 — 재개하면 하네스의 `stopped` 통지가 옛 id 를 닫는다.
// grok (`updates.jsonl`, 00-analysis P6):
//   `background_tasks` 는 **전체 스냅샷**이라 마지막 스냅샷의 `status:'running'` 이 지금 도는 작업이다. `task_completed` 는
//   스냅샷이 오기 전의 끝을 보탠다. 형제 파일 꼬리 창(256KB) 밖의 스냅샷도 누적 판독이라 잃지 않는다(P1 — 12 중 8).
//   서브에이전트(네이티브 유도 표본 1건, grok 1.0.44 — `raw/claude/l10/runs/n37-grok-subagent-attempt.txt`·`n38-grok-subagent-shape.txt`):
//   `subagent_spawned{subagent_id, subagent_type, description…}` 가 시작, `subagent_finished{subagent_id, status}` 가 끝이다.
//   시작 시각은 줄의 `params._meta.agentTimestampMs`. `background` 는 앞선 `spawn_subagent` 호출의 `rawInput.background` 를
//   **호출 순서대로** 짝짓는다(시작 레코드에 호출 id 가 없다) — 짝이 없으면 false.
import fs from 'node:fs'
import { isRecord, readString } from '../shared/json.js'
import type { BackgroundTask, SessionLifecycle, SessionSubagent } from '../shared/types.js'
import { LIFECYCLE_MAX_ITEMS } from '../shared/types.js'
import { cleanActivityText, readTimestamp } from './transcript-parse.js'

/** 파일 하나를 한 주기에 읽는 상한 (L7) — 닻 확인 판독을 포함한다. */
export const LIFECYCLE_READ_MAX_BYTES = 2 * 1024 * 1024
/** 닻 — 지난 판독 끝 바로 앞 바이트. 판독 전제 ③(끝 앞 변경)을 알아채는 데 쓴다. */
export const LIFECYCLE_ANCHOR_BYTES = 1024

type ClaudeCall = { label: string | null; at: number | null }

export type LedgerState =
  | {
      agent: 'claude'
      tasks: Map<string, BackgroundTask>
      /** 결과를 아직 못 본 `Bash`·`Monitor`·`Agent` 호출 — tool_use id → 이름 재료. */
      calls: Map<string, ClaudeCall>
      /** 도는 서브에이전트 — 동기는 tool_use id, 비동기는 agentId 로 잡는다. */
      subagents: Map<string, SessionSubagent>
    }
  | {
      agent: 'grok'
      tasks: Map<string, BackgroundTask>
      subagents: Map<string, SessionSubagent>
      /** 아직 `subagent_spawned` 를 못 본 `spawn_subagent` 호출의 `background` — 호출 순서대로 짝짓는다. */
      spawnQueue: boolean[]
    }

/** 파일 하나의 누적 판독 상태. */
export type Ledger = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  /** 온전한 줄로 소비한 끝 위치(줄바꿈 뒤). */
  offset: number
  /** `offset` 바로 앞 ≤1KiB — 다음 판독에서 같은지 본다(③). */
  anchor: Buffer
  /** 한도보다 긴 줄 한가운데다 — 다음 줄바꿈까지 버린다. */
  skipping: boolean
  /** 지난 판독이 파일 끝에 닿았나. 아니면 목록은 `catching-up` 이다. */
  caughtUp: boolean
  state: LedgerState
}

export function emptyLedgerState(agent: 'claude' | 'grok'): LedgerState {
  return agent === 'claude'
    ? { agent: 'claude', tasks: new Map(), calls: new Map(), subagents: new Map() }
    : { agent: 'grok', tasks: new Map(), subagents: new Map(), spawnQueue: [] }
}

/** 이번 stat 에서 다시 읽을 게 없나 — 끝까지 따라잡았고 파일이 그대로다. */
export function ledgerSettled(input: { ledger: Ledger | null; stat: fs.Stats }): boolean {
  const { ledger, stat } = input
  return (
    ledger !== null &&
    ledger.caughtUp &&
    ledger.dev === stat.dev &&
    ledger.ino === stat.ino &&
    ledger.size === stat.size &&
    ledger.mtimeMs === stat.mtimeMs
  )
}

/**
 * 누적 판독 한 걸음 — 지난 끝에서부터 새 바이트를 ≤2MB 읽어 열린 집합을 갱신한다. 읽은 바이트를 같이 돌려준다.
 * ①②③ 이면 상태를 버리고 0 부터 다시 쌓는다(남은 예산 안에서).
 */
export function advanceLedger(input: { file: string; stat: fs.Stats; agent: 'claude' | 'grok'; prior: Ledger | null }): {
  ledger: Ledger
  bytes: number
  reset: 'identity' | 'shrunk' | 'anchor' | null
} {
  const { file, stat, agent } = input
  let budget = LIFECYCLE_READ_MAX_BYTES
  let bytes = 0
  let reset: 'identity' | 'shrunk' | 'anchor' | null = null
  let prior = input.prior
  if (prior !== null && (prior.dev !== stat.dev || prior.ino !== stat.ino)) reset = 'identity'
  else if (prior !== null && stat.size < prior.offset) reset = 'shrunk'
  else if (prior !== null && prior.anchor.length > 0) {
    const from = prior.offset - prior.anchor.length
    const now = readBytes({ file, from, to: prior.offset })
    bytes += now.length
    budget -= now.length
    if (!now.equals(prior.anchor)) reset = 'anchor'
  }
  if (reset !== null) prior = null

  const start = prior?.offset ?? 0
  const to = Math.min(stat.size, start + budget)
  const chunk = readBytes({ file, from: start, to })
  bytes += chunk.length
  const state = prior?.state ?? emptyLedgerState(agent)
  let skipping = prior?.skipping ?? false
  let consumed = 0
  const lastNewline = chunk.lastIndexOf(0x0a)
  if (lastNewline !== -1) {
    let begin = 0
    if (skipping) {
      begin = chunk.indexOf(0x0a) + 1
      skipping = false
    }
    consumed = lastNewline + 1
    if (begin < consumed) applyLines({ state, text: chunk.subarray(begin, consumed).toString('utf8') })
  } else if (start + chunk.length < stat.size) {
    // 한도를 다 채웠는데 줄바꿈이 없다 — 한도보다 긴 줄이다. 건너뛰고 다음 줄바꿈부터 다시 읽는다.
    consumed = chunk.length
    skipping = true
  }
  const offset = start + consumed
  const anchor = Buffer.concat([prior?.anchor ?? Buffer.alloc(0), chunk.subarray(0, consumed)])
  const ledger: Ledger = {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset,
    anchor: Buffer.from(anchor.subarray(Math.max(0, anchor.length - LIFECYCLE_ANCHOR_BYTES))),
    skipping,
    // 파일 끝까지 읽었으면 따라잡은 것이다 — 줄바꿈 없는 끝줄은 아직 쓰는 중이라 다음 주기에 온다.
    caughtUp: to === stat.size,
    state,
  }
  return { ledger, bytes, reset }
}

/** 지금 목록 — 따라잡기 전이면 모름. 시작 시각 순, 상한 32 + 넘친 수. */
export function ledgerView(ledger: Ledger): SessionLifecycle {
  if (!ledger.caughtUp) return { state: 'unknown', reason: 'catching-up' }
  return stateView(ledger.state)
}

export function stateView(state: LedgerState): SessionLifecycle {
  const tasks = byStart([...state.tasks.values()])
  const subagents = byStart([...state.subagents.values()])
  return {
    state: 'known',
    tasks: tasks.slice(0, LIFECYCLE_MAX_ITEMS),
    taskOverflow: Math.max(0, tasks.length - LIFECYCLE_MAX_ITEMS),
    subagents: subagents.slice(0, LIFECYCLE_MAX_ITEMS),
    subagentOverflow: Math.max(0, subagents.length - LIFECYCLE_MAX_ITEMS),
  }
}

function byStart<T extends { startedAt: number | null; id: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
}

// --- 줄 → 상태 -----------------------------------------------------------------

/**
 * claude 는 표지가 들 수 있는 줄만 파싱한다 — 대부분의 줄(훅 결과·첨부·텍스트 응답)은 문자열 검사로 건너뛴다.
 * 걸러도 틀리지 않는 이유: 아래 표지 전부가 이 문자열 중 하나를 원문 그대로 품는다.
 */
const CLAUDE_MARKERS = ['"tool_use"', '"toolUseResult"', '<task-notification>', '"agents_killed"', '"cost-state"']
const GROK_MARKERS = ['"background_tasks"', '"task_completed"', '"spawn_subagent"', '"subagent_spawned"', '"subagent_finished"']

export function applyLines(input: { state: LedgerState; text: string }): void {
  const markers = input.state.agent === 'claude' ? CLAUDE_MARKERS : GROK_MARKERS
  for (const line of input.text.split('\n')) {
    if (!markers.some((marker) => line.includes(marker))) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue // 잘린 줄·깨진 줄 — 던지지 않는다 (L9)
    }
    if (!isRecord(record)) continue
    applyRecord({ state: input.state, record })
  }
}

export function applyRecord(input: { state: LedgerState; record: Record<string, unknown> }): void {
  const { state, record } = input
  switch (state.agent) {
    case 'claude':
      applyClaudeRecord({ state, record })
      return
    case 'grok':
      applyGrokRecord({ state, record })
      return
  }
}

type ClaudeState = Extract<LedgerState, { agent: 'claude' }>
type GrokState = Extract<LedgerState, { agent: 'grok' }>

const CLAUDE_TRACKED_TOOLS = new Set(['Bash', 'Monitor', 'Agent', 'Task'])

function applyClaudeRecord(input: { state: ClaudeState; record: Record<string, unknown> }): void {
  const { state, record } = input
  const at = readTimestamp(record['timestamp'])
  switch (readString(record, 'type')) {
    case 'cost-state':
      // 프로세스가 끝났다 (L8) — 그 프로세스의 작업·서브에이전트는 끝 통지 없이 같이 죽는다.
      state.tasks.clear()
      state.calls.clear()
      state.subagents.clear()
      return
    case 'system':
      if (readString(record, 'subtype') === 'agents_killed') {
        for (const [id, task] of state.tasks) if (task.kind === 'agent') closeClaude({ state, id })
      }
      return
    case 'queue-operation':
      if (readString(record, 'operation') === 'enqueue') applyNotification({ state, text: readString(record, 'content') })
      return
    case 'assistant':
      applyClaudeToolUses({ state, record, at })
      return
    case 'user':
      applyClaudeUser({ state, record, at })
      return
    default:
      return
  }
}

function claudeContent(record: Record<string, unknown>): unknown {
  const message = record['message']
  return isRecord(message) ? message['content'] : null
}

function applyClaudeToolUses(input: { state: ClaudeState; record: Record<string, unknown>; at: number | null }): void {
  const content = claudeContent(input.record)
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue
    const id = readString(block, 'id')
    const name = readString(block, 'name')
    if (id === null || name === null || !CLAUDE_TRACKED_TOOLS.has(name)) continue
    const toolInput = isRecord(block['input']) ? block['input'] : {}
    const description = oneLine(readString(toolInput, 'description'))
    input.state.calls.set(id, { label: description ?? oneLine(readString(toolInput, 'command')), at: input.at })
    if (name === 'Agent' || name === 'Task') {
      input.state.subagents.set(id, {
        id,
        name: oneLine(readString(toolInput, 'name')),
        description,
        agentType: readString(toolInput, 'subagent_type'),
        background: toolInput['run_in_background'] === true,
        startedAt: input.at,
        status: 'running',
      })
    }
  }
}

function applyClaudeUser(input: { state: ClaudeState; record: Record<string, unknown>; at: number | null }): void {
  const { state, record, at } = input
  const content = claudeContent(record)
  if (typeof content === 'string') {
    applyNotification({ state, text: content })
    return
  }
  if (!Array.isArray(content)) return
  const resultIds: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') applyNotification({ state, text: readString(block, 'text') })
    if (block['type'] !== 'tool_result') continue
    const id = readString(block, 'tool_use_id')
    if (id !== null) resultIds.push(id)
  }
  // `toolUseResult` 는 레코드에 하나다 — 결과 블록이 하나일 때만 그 호출의 결과로 읽는다.
  const result = record['toolUseResult']
  const only = resultIds.length === 1 ? resultIds[0] : undefined
  const call = only === undefined ? undefined : state.calls.get(only)
  const syncAgent = only === undefined ? undefined : state.subagents.get(only)
  for (const id of resultIds) {
    state.calls.delete(id)
    state.subagents.delete(id) // 동기 서브에이전트는 결과가 오면 끝이다(성공·오류·중단 모두 tool_result 로 온다)
  }
  if (!isRecord(result)) return
  const backgroundTaskId = readString(result, 'backgroundTaskId')
  const taskId = readString(result, 'taskId')
  const agentId = readString(result, 'agentId')
  const stoppedId = readString(result, 'task_id')
  if (backgroundTaskId !== null) {
    state.tasks.set(backgroundTaskId, { id: backgroundTaskId, kind: 'shell', label: call?.label ?? null, startedAt: at ?? call?.at ?? null })
  } else if (taskId !== null && 'timeoutMs' in result) {
    state.tasks.set(taskId, { id: taskId, kind: 'monitor', label: call?.label ?? null, startedAt: at ?? call?.at ?? null })
  } else if (agentId !== null && readString(result, 'status') === 'async_launched') {
    const description = syncAgent?.description ?? oneLine(readString(result, 'description'))
    const startedAt = syncAgent?.startedAt ?? at
    state.tasks.set(agentId, { id: agentId, kind: 'agent', label: description, startedAt })
    state.subagents.set(agentId, {
      id: agentId,
      name: syncAgent?.name ?? null,
      description,
      agentType: syncAgent?.agentType ?? null,
      background: true,
      startedAt,
      status: 'running',
    })
  } else if (stoppedId !== null && 'task_type' in result) {
    closeClaude({ state, id: stoppedId }) // TaskStop 결과
  }
}

const NOTIFICATION_ID = /<task-id>([^<]+)<\/task-id>/g

/** `<task-notification>` 에 `<status>` 가 있으면 그 안의 task-id 전부를 닫는다. 모르는 id 는 무시한다(U8). */
function applyNotification(input: { state: ClaudeState; text: string | null }): void {
  const text = input.text?.trimStart() ?? null
  if (text === null || !text.startsWith('<task-notification>')) return
  if (!/<status>[^<]*<\/status>/.test(text)) return // Monitor `<event>` 통지 — 끝이 아니다
  for (const match of text.matchAll(NOTIFICATION_ID)) {
    const id = match[1]
    if (id !== undefined) closeClaude({ state: input.state, id: id.trim() })
  }
}

function closeClaude(input: { state: ClaudeState; id: string }): void {
  input.state.tasks.delete(input.id)
  input.state.subagents.delete(input.id)
}

function applyGrokRecord(input: { state: GrokState; record: Record<string, unknown> }): void {
  const params = input.record['params']
  const update = isRecord(params) && isRecord(params['update']) ? params['update'] : null
  if (update === null) return
  const meta = isRecord(params) && isRecord(params['_meta']) ? params['_meta'] : null
  const at = meta !== null && typeof meta['agentTimestampMs'] === 'number' ? meta['agentTimestampMs'] : null
  switch (readString(update, 'sessionUpdate')) {
    case 'tool_call': {
      if (update['title'] !== 'spawn_subagent') return
      const rawInput = update['rawInput']
      input.state.spawnQueue.push(isRecord(rawInput) && rawInput['background'] === true)
      return
    }
    case 'subagent_spawned': {
      const id = readString(update, 'subagent_id')
      const background = input.state.spawnQueue.shift() ?? false
      if (id === null) return
      input.state.subagents.set(id, {
        id,
        name: null,
        description: oneLine(readString(update, 'description')),
        agentType: readString(update, 'subagent_type'),
        background,
        startedAt: at,
        status: 'running',
      })
      return
    }
    case 'subagent_finished': {
      const id = readString(update, 'subagent_id')
      if (id !== null) input.state.subagents.delete(id)
      return
    }
    case 'background_tasks': {
      // 전체 스냅샷 — 지금 도는 것만 남긴다. `kind` 는 관측된 `bash` 만 옮긴다(다른 값은 지어내지 않는다).
      const tasks = Array.isArray(update['tasks']) ? update['tasks'] : []
      input.state.tasks.clear()
      for (const task of tasks) {
        if (!isRecord(task) || task['status'] !== 'running' || task['kind'] !== 'bash') continue
        const id = readString(task, 'task_id')
        if (id === null) continue
        const label = oneLine(readString(task, 'description')) ?? oneLine(readString(task, 'command'))
        input.state.tasks.set(id, { id, kind: 'shell', label, startedAt: readTimestamp(task['started_at']) })
      }
      return
    }
    case 'task_completed': {
      const snapshot = update['task_snapshot']
      const id = isRecord(snapshot) ? readString(snapshot, 'task_id') : null
      if (id !== null) input.state.tasks.delete(id)
      return
    }
    default:
      return
  }
}

/** 이름 한 줄 상한 — 명령 미리보기가 수 KB 여도 IPC 로 통째 나르지 않는다(워커 재량). */
const LABEL_MAX_CHARS = 200

function oneLine(value: string | null): string | null {
  const cleaned = value === null ? null : cleanActivityText(value)
  return cleaned === null ? null : cleaned.slice(0, LABEL_MAX_CHARS)
}

function readBytes(input: { file: string; from: number; to: number }): Buffer {
  const length = Math.max(0, input.to - input.from)
  const buffer = Buffer.alloc(length)
  if (length === 0) return buffer
  const handle = fs.openSync(input.file, 'r')
  try {
    let read = 0
    while (read < length) {
      const count = fs.readSync(handle, buffer, read, length - read, input.from + read)
      if (count === 0) break
      read += count
    }
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(handle)
  }
}

// --- claude 프로세스 레지스트리 (L8) -----------------------------------------------------

type RegistryEntry = { size: number; mtimeMs: number; pid: number | null; sessionId: string | null }
const registry = new Map<string, RegistryEntry>()

/**
 * 이 세션 id 를 가진 **살아 있는** claude 대화형 프로세스가 있나 — `<HOME>/.claude/sessions/<pid>.json` 을 본다(관측, 계약 아님).
 * 파일마다 mtime·size 캐시라 안 바뀐 파일은 `stat` 만 한다. 읽은 바이트를 같이 돌려준다(L7 누적 판독 계정).
 * 폴더가 없거나 못 읽으면 "없다" 다 — 모르는 생존을 살아 있다고 치지 않는다. pid 재사용은 가리지 못한다(한계).
 */
export function claudeSessionAlive(input: { dir: string; sessionId: string }): { alive: boolean; bytes: number } {
  let names: string[]
  try {
    names = fs.readdirSync(input.dir).filter((name) => name.endsWith('.json'))
  } catch {
    registry.clear()
    return { alive: false, bytes: 0 }
  }
  let bytes = 0
  let alive = false
  const seen = new Set<string>()
  for (const name of names) {
    const file = `${input.dir}/${name}`
    seen.add(file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    let entry = registry.get(file) ?? null
    if (entry === null || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        bytes += stat.size
      } catch {
        parsed = null // 쓰는 중·깨진 파일 — 이 주기엔 없는 것으로 본다
      }
      const pid = isRecord(parsed) && typeof parsed['pid'] === 'number' ? parsed['pid'] : null
      entry = { size: stat.size, mtimeMs: stat.mtimeMs, pid, sessionId: isRecord(parsed) ? readString(parsed, 'sessionId') : null }
      registry.set(file, entry)
    }
    if (!alive && entry.sessionId === input.sessionId && entry.pid !== null && processAlive(entry.pid)) alive = true
  }
  for (const file of registry.keys()) if (!seen.has(file)) registry.delete(file)
  return { alive, bytes }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 있는데 남의 프로세스다 — 살아 있다.
    return isRecord(error) && error['code'] === 'EPERM'
  }
}

// --- grok 프로세스 레지스트리 (L8) -------------------------------------------------------

let grokRegistry: { size: number; mtimeMs: number; entries: { sessionId: string; pid: number }[] } | null = null

/**
 * 이 세션 id 를 가진 **살아 있는** grok 프로세스가 있나 — `<HOME>/.grok/active_sessions.json`(`[{session_id, pid, cwd}]`)을 본다
 * (네이티브 관측 `raw/claude/l10/runs-r2/n44`·`n45`, 계약 아님). grok 은 `/exit` 에 그 행을 지우고, `--resume` 에 새 pid 로 다시 쓴다.
 * 강제 종료는 행을 남기므로 `kill(pid, 0)` 으로 본다. mtime·size 캐시, 못 읽으면 "없다" — claude 레지스트리와 같은 규칙.
 */
export function grokSessionAlive(input: { file: string; sessionId: string }): { alive: boolean; bytes: number } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(input.file)
  } catch {
    grokRegistry = null
    return { alive: false, bytes: 0 }
  }
  let bytes = 0
  if (grokRegistry === null || grokRegistry.size !== stat.size || grokRegistry.mtimeMs !== stat.mtimeMs) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(fs.readFileSync(input.file, 'utf8'))
      bytes = stat.size
    } catch {
      parsed = null // 쓰는 중·깨진 파일 — 이 주기엔 없는 것으로 본다
    }
    const entries: { sessionId: string; pid: number }[] = []
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        const sessionId = isRecord(row) ? readString(row, 'session_id') : null
        const pid = isRecord(row) && typeof row['pid'] === 'number' ? row['pid'] : null
        if (sessionId !== null && pid !== null) entries.push({ sessionId, pid })
      }
    }
    grokRegistry = { size: stat.size, mtimeMs: stat.mtimeMs, entries }
  }
  const alive = grokRegistry.entries.some((entry) => entry.sessionId === input.sessionId && processAlive(entry.pid))
  return { alive, bytes }
}

/** 레지스트리 캐시를 비운다 — `clearTranscriptCache` 가 같이 부른다. */
export function clearClaudeRegistry(): void {
  registry.clear()
  grokRegistry = null
}
