// 세션 기록 → 대화 말풍선 (LIFE-581 X1·X2) — 순수 함수와 상태 있는 조립기. 파일·소켓·electron 을 모른다.
//
// 두 층이다:
//   ① **줄 → 원자(atom)** — provider 마다 한 함수(`claudeAtoms`·`codexAtoms`·`grokAtoms`). 한 줄이 원자 여럿을 낼 수 있다(Claude 도구 결과 여럿).
//      사람 발화 판정은 지문과 **같은 함수**다(X2ⓐ): Claude `claudeHumanText` · Codex `codexHumanText` · Grok `grokUpdateHumanText`
//      (`grokHumanText` 의 `updates.jsonl` 짝 — 코디 승인, `transcript-parse.ts` 같은 자리). 규칙을 여기서 다시 쓰지 않는다.
//   ② **원자 → 말풍선(item)** — `ChatBuilder`. 파일 순서대로 먹이면 말풍선 배열이 자란다. provider 를 모른다.
//
// 보내지 않는 것(X2ⓑⓒ·X3): 생각(thinking·reasoning·agent_thought) · 도구 결과 본문(성공/실패만 쓴다) · 압축 요약 본문 · 하네스 주입 · 메타 줄.
// 해석하지 못한 줄은 말풍선이 되지 않고 개수만 센다(X2ⓙ). 줄 종류 → 말풍선 대응표는 `specs/LIFE-581-mobile-chat/raw/claude/mapping.md`.
//
// 말풍선 id = 그 말풍선을 연 첫 줄의 **바이트 위치**(파일 안 위치 — X6). 같은 파일·같은 내용이면 판독을 다시 해도 같은 id 다.
import { isRecord, readString, safeParse } from '../shared/json.js'
import type { SessionQuestion, TranscriptAgent } from '../shared/types.js'
import {
  CLAUDE_INTERRUPT_MARKERS,
  CODEX_ASK_TOOL,
  CODEX_QUESTION_REPLY,
  claudeHumanText,
  codexContent,
  codexHumanText,
  codexUserText,
  grokUpdate,
  grokUpdateHumanText,
  readQuestions,
  readTimestamp,
  textFromContent,
  toolInputPreview,
} from './transcript-parse.js'

/** `unknown` = 결과는 왔지만 성공/실패를 기록에서 읽을 수 없다(옛 Codex 출력 중 종료 코드가 없는 모양 — 성공으로 단정하지 않는다, R1-A9). */
export type ChatToolStatus = 'running' | 'ok' | 'error' | 'unknown'
export type ChatTool = { name: string | null; target: string | null; status: ChatToolStatus }
export type ChatQuestionState = 'pending' | 'answered' | 'closed'
export type ChatNoteKind = 'interrupted' | 'failed' | 'compacted'

export type ChatItem =
  | { id: number; kind: 'prompt'; text: string; at: number | null }
  | { id: number; kind: 'reply'; text: string; at: number | null }
  | { id: number; kind: 'tools'; tools: ChatTool[]; at: number | null }
  | { id: number; kind: 'question'; questions: SessionQuestion[]; state: ChatQuestionState; answer: string | null; at: number | null }
  | { id: number; kind: 'note'; note: ChatNoteKind; text: string | null; at: number | null }

/** 한 줄이 낸 것. `skip` 은 알고 버리는 줄(사유), `unknown` 은 모양을 모르는 줄. */
export type ChatAtom =
  | { kind: 'prompt'; text: string }
  /** `key` 가 같은 연속 답은 한 말풍선으로 합친다(X2ⓖ) — Claude `message.id` · Grok chunk. null 이면 합치지 않는다. */
  | { kind: 'reply'; text: string; key: string | null; join: string }
  | { kind: 'tool'; callId: string | null; name: string | null; target: string | null; status: ChatToolStatus }
  /** 도구 이름·대상이 나중 줄에서 채워진다(Grok `tool_call_update` 의 title·rawInput). */
  | { kind: 'tool_info'; callId: string; name: string | null; target: string | null }
  /**
   * 도구 결과 — 상태만(본문은 버린다). `settles` = 이 결과가 같은 id 의 질문을 끝내나: Claude·Grok 은 결과가 답이다,
   * Codex 의 `request_user_input_async` 출력은 접수 확인(`{"accepted":…}`)일 뿐이라 끝내지 않는다(지문 `codexPendingQuestions` 와 같은 판단).
   */
  | { kind: 'result'; callId: string; status: 'ok' | 'error' | 'unknown'; answer: string | null; settles: boolean }
  | { kind: 'question'; callId: string | null; questions: SessionQuestion[] }
  /** 질문 해소 — `callId` null = 열린 질문 전부(Codex: 사람 발화·새 턴·중단). */
  | { kind: 'resolve'; callId: string | null; state: 'answered' | 'closed'; answer: string | null }
  | { kind: 'note'; note: ChatNoteKind; text: string | null }
  | { kind: 'skip'; reason: string }
  | { kind: 'unknown'; shape: string }

/** Claude rewind 판정 재료(X2ⓘ) — 줄의 uuid·부모와 그 줄이 사람 발화인가. */
export type ClaudeLink = { uuid: string | null; parentUuid: string | null; human: boolean }

export type LineAtoms = { atoms: ChatAtom[]; at: number | null; link: ClaudeLink | null }

const TEXT_JOIN = '\n\n'

// --- Claude ------------------------------------------------------------------------------------------

/** 알고 버리는 Claude 줄 종류 — c06 표본 + 웹 서치(00-analysis §3). 그 밖의 type 은 `unknown`. */
const CLAUDE_META_TYPES = new Set([
  'attachment',
  'permission-mode',
  'mode',
  'last-prompt',
  'atis-latch',
  'ai-title',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'summary',
  'custom-title',
  'tag',
  'progress',
  'agent-name',
  'pr-link',
  // 실물 표본 전수(raw/claude/y2-census.json) 에서 본 메타 줄 — 비용·브리지·아티팩트 장부. 대화가 아니다.
  'cost-state',
  'bridge-session',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
])

export function claudeAtoms(input: { record: Record<string, unknown>; sessionId: string | null }): LineAtoms {
  const { record } = input
  const at = readTimestamp(record['timestamp'])
  const type = readString(record, 'type')
  const link: ClaudeLink = {
    uuid: readString(record, 'uuid'),
    parentUuid: readString(record, 'parentUuid'),
    human: false,
  }
  const one = (atom: ChatAtom): LineAtoms => ({ atoms: [atom], at, link })
  if (record['isSidechain'] === true) return one({ kind: 'skip', reason: 'claude:sidechain' })
  switch (type) {
    case 'user': {
      const message = record['message']
      if (!isRecord(message)) return one({ kind: 'unknown', shape: 'claude:user:no-message' })
      if (record['isCompactSummary'] === true) return one({ kind: 'skip', reason: 'claude:compact-summary' })
      if (record['isMeta'] === true) return one({ kind: 'skip', reason: 'claude:meta' })
      const content = message['content']
      if (Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'tool_result')) {
        const atoms: ChatAtom[] = []
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue
          const callId = readString(block, 'tool_use_id')
          if (callId === null) continue
          atoms.push({ kind: 'result', callId, status: block['is_error'] === true ? 'error' : 'ok', answer: claudeAnswer(record['toolUseResult']), settles: true })
        }
        return { atoms: atoms.length === 0 ? [{ kind: 'skip', reason: 'claude:tool-result' }] : atoms, at, link }
      }
      const text = textFromContent(content)
      if (text !== null && CLAUDE_INTERRUPT_MARKERS.includes(text.trim())) return one({ kind: 'note', note: 'interrupted', text: null })
      const human = claudeHumanText({ record, sessionId: input.sessionId })
      if (human !== null) return { atoms: [{ kind: 'prompt', text: human }], at, link: { ...link, human: true } }
      // 슬래시 명령 봉투 · 명령 출력 · 작업 통지 · 다른 세션 id — 사람이 친 지시가 아니다(지문 규칙 그대로).
      return one({ kind: 'skip', reason: 'claude:user-not-human' })
    }
    case 'assistant': {
      const message = record['message']
      if (!isRecord(message)) return one({ kind: 'unknown', shape: 'claude:assistant:no-message' })
      if (record['isApiErrorMessage'] === true) {
        const text = textFromContent(message['content']) ?? readString(record, 'error')
        return one({ kind: 'note', note: 'failed', text })
      }
      if (readString(message, 'model') === '<synthetic>') return one({ kind: 'skip', reason: 'claude:synthetic' })
      const content = message['content']
      const key = readString(message, 'id')
      if (typeof content === 'string') return one(content.trim().length === 0 ? { kind: 'skip', reason: 'claude:empty' } : { kind: 'reply', text: content, key, join: TEXT_JOIN })
      if (!Array.isArray(content)) return one({ kind: 'unknown', shape: 'claude:assistant:content' })
      const atoms: ChatAtom[] = []
      for (const block of content) {
        if (!isRecord(block)) continue
        const blockType = readString(block, 'type')
        if (blockType === 'text') {
          const text = readString(block, 'text')
          if (text !== null && text.trim().length > 0) atoms.push({ kind: 'reply', text, key, join: TEXT_JOIN })
          continue
        }
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          atoms.push({ kind: 'skip', reason: 'claude:thinking' })
          continue
        }
        if (blockType === 'tool_use') {
          const name = readString(block, 'name')
          const callId = readString(block, 'id')
          if (name === 'AskUserQuestion') {
            const toolInput = block['input']
            const questions = isRecord(toolInput) ? readQuestions({ items: toolInput['questions'], textKey: 'question' }) : null
            atoms.push({ kind: 'question', callId, questions: questions ?? [] })
            continue
          }
          atoms.push({ kind: 'tool', callId, name: name?.trim() || null, target: toolInputPreview(block['input']), status: 'running' })
          continue
        }
        // 서버 쪽 도구(advisor 등) — 호출과 결과가 같은 답 줄에 온다. 결과 본문(암호화된 것 포함)은 버리고 성공/실패만.
        if (blockType === 'server_tool_use') {
          atoms.push({ kind: 'tool', callId: readString(block, 'id'), name: readString(block, 'name')?.trim() || null, target: toolInputPreview(block['input']), status: 'running' })
          continue
        }
        if (blockType !== null && blockType.endsWith('_tool_result')) {
          const callId = readString(block, 'tool_use_id')
          const content = block['content']
          const failed = isRecord(content) && (readString(content, 'type') ?? '').includes('error')
          atoms.push(callId === null ? { kind: 'skip', reason: 'claude:server-tool-result' } : { kind: 'result', callId, status: failed ? 'error' : 'ok', answer: null, settles: true })
          continue
        }
        atoms.push({ kind: 'unknown', shape: `claude:block:${blockType ?? '?'}` })
      }
      return { atoms: atoms.length === 0 ? [{ kind: 'skip', reason: 'claude:empty' }] : atoms, at, link }
    }
    case 'system': {
      const subtype = readString(record, 'subtype')
      if (subtype === 'compact_boundary') return one({ kind: 'note', note: 'compacted', text: null })
      return one({ kind: 'skip', reason: `claude:system:${subtype ?? '?'}` })
    }
    default:
      if (type !== null && CLAUDE_META_TYPES.has(type)) return one({ kind: 'skip', reason: `claude:${type}` })
      return one({ kind: 'unknown', shape: `claude:${type ?? '?'}` })
  }
}

/** AskUserQuestion 답 — `toolUseResult.answers` 는 `{문항: 답}`(실측 5/5). 답 글만 ` · ` 로 잇는다. */
function claudeAnswer(value: unknown): string | null {
  if (!isRecord(value)) return null
  const answers = value['answers']
  if (!isRecord(answers)) return null
  const parts = Object.values(answers).filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
  return parts.length === 0 ? null : parts.join(' · ')
}

// --- Codex -------------------------------------------------------------------------------------------

const CODEX_SKIP_EVENTS = new Set([
  'token_count',
  'thread_settings_applied',
  'agent_message', // 옛 모양의 답 중복 — 답 정본은 response_item/message/assistant(X2ⓖ)
  'agent_reasoning',
  'context_compacted', // 압축 정본은 최상위 `compacted`
  'patch_apply_begin',
  'patch_apply_end',
  'web_search_begin',
  'web_search_end',
  'exec_command_begin',
  'exec_command_end',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'thread_rolled_back',
  'item_started',
])

export function codexAtoms(record: Record<string, unknown>): LineAtoms {
  const at = readTimestamp(record['timestamp'])
  const one = (atom: ChatAtom): LineAtoms => ({ atoms: [atom], at, link: null })
  const type = readString(record, 'type')
  const payload = record['payload']
  switch (type) {
    case 'session_meta':
    case 'turn_context':
    case 'world_state':
    case 'token_usage_record':
      return one({ kind: 'skip', reason: `codex:${type}` })
    case 'compacted':
      return one({ kind: 'note', note: 'compacted', text: null })
    case 'response_item':
      return isRecord(payload) ? { atoms: codexResponseItem(payload), at, link: null } : one({ kind: 'unknown', shape: 'codex:response_item' })
    case 'event_msg':
      return isRecord(payload) ? { atoms: codexEvent({ record, payload }), at, link: null } : one({ kind: 'unknown', shape: 'codex:event_msg' })
    default:
      return one({ kind: 'unknown', shape: `codex:${type ?? '?'}` })
  }
}

function codexResponseItem(payload: Record<string, unknown>): ChatAtom[] {
  const type = readString(payload, 'type')
  switch (type) {
    case 'message': {
      const role = readString(payload, 'role')
      // user·developer 는 하네스 주입(AGENTS.md·환경 봉투)이다 — 사람 발화 정본은 event_msg 쪽(codexHumanText).
      if (role !== 'assistant') return [{ kind: 'skip', reason: `codex:message:${role ?? '?'}` }]
      const text = textFromContent(codexContent(payload['content']))
      return text === null ? [{ kind: 'skip', reason: 'codex:empty' }] : [{ kind: 'reply', text, key: null, join: TEXT_JOIN }]
    }
    case 'reasoning':
      return [{ kind: 'skip', reason: 'codex:reasoning' }]
    case 'function_call': {
      const name = readString(payload, 'name')
      const callId = readString(payload, 'call_id')
      const args = readString(payload, 'arguments')
      const parsed = args === null ? null : safeParse(args)
      if (name === CODEX_ASK_TOOL) {
        const questions = isRecord(parsed) ? readQuestions({ items: parsed['questions'], textKey: 'title' }) : null
        return [{ kind: 'question', callId, questions: questions ?? [] }]
      }
      return [{ kind: 'tool', callId, name, target: codexArgsTarget(parsed), status: 'running' }]
    }
    case 'custom_tool_call': {
      const name = readString(payload, 'name')
      // `exec` 는 코드 모드 상자다 — 안에서 돈 명령은 `item_completed/CommandExecution` 으로 따로 남는다(c06·0.155+). 상자를 또 세면 두 번이다.
      if (name === 'exec') return [{ kind: 'skip', reason: 'codex:exec-container' }]
      const callId = readString(payload, 'call_id')
      const input = readString(payload, 'input')
      return [{ kind: 'tool', callId, name, target: name === 'apply_patch' && input !== null ? patchTarget(input) : null, status: 'running' }]
    }
    case 'web_search_call': {
      const action = payload['action']
      return [{ kind: 'tool', callId: readString(payload, 'id'), name: 'web_search', target: isRecord(action) ? readString(action, 'query') : null, status: 'ok' }]
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = readString(payload, 'call_id')
      return callId === null ? [{ kind: 'skip', reason: 'codex:output' }] : [{ kind: 'result', callId, status: codexOutputStatus(payload['output']), answer: null, settles: false }]
    }
    default:
      return [{ kind: 'unknown', shape: `codex:response_item:${type ?? '?'}` }]
  }
}

function codexEvent(input: { record: Record<string, unknown>; payload: Record<string, unknown> }): ChatAtom[] {
  const { record, payload } = input
  const type = readString(payload, 'type')
  switch (type) {
    case 'task_started':
      return [{ kind: 'resolve', callId: null, state: 'closed', answer: null }]
    case 'turn_aborted':
      return [{ kind: 'resolve', callId: null, state: 'closed', answer: null }, { kind: 'note', note: 'interrupted', text: null }]
    case 'task_complete': {
      const error = payload['error']
      if (error === undefined || error === null) return [{ kind: 'skip', reason: 'codex:task_complete' }]
      return [{ kind: 'note', note: 'failed', text: isRecord(error) ? readString(error, 'codex_error_info') : null }]
    }
    case 'user_message':
      return codexUser(record)
    case 'item_completed': {
      const item = payload['item']
      if (!isRecord(item)) return [{ kind: 'unknown', shape: 'codex:item_completed' }]
      return codexItem({ record, item })
    }
    default:
      if (type !== null && CODEX_SKIP_EVENTS.has(type)) return [{ kind: 'skip', reason: `codex:${type}` }]
      return [{ kind: 'unknown', shape: `codex:event:${type ?? '?'}` }]
  }
}

/** 사용자 줄 — 사람 발화면 지시(지문 `codexHumanText` 그대로), 질문 답 봉투면 질문 해소(답 글과 함께). */
function codexUser(record: Record<string, unknown>): ChatAtom[] {
  const human = codexHumanText(record)
  if (human !== null) return [{ kind: 'resolve', callId: null, state: 'answered', answer: null }, { kind: 'prompt', text: human }]
  const raw = codexUserText(record)
  if (raw !== null && raw.trimStart().startsWith(CODEX_QUESTION_REPLY)) return [{ kind: 'resolve', callId: null, state: 'answered', answer: codexReplyAnswer(raw) }]
  return [{ kind: 'skip', reason: 'codex:user-empty' }]
}

/**
 * 도구 출력의 성공/실패 — 본문 앞 머리(`Output:` 줄 앞)의 종료 코드만 읽는다(R1-A9). 실물 모양(이 기계 rollout 전수, `raw/claude/r1/a9-codex-output-shapes.txt`):
 * 0.142 `exec_command`·`write_stdin` = `Chunk ID…/Wall time…/Process exited with code N/…/Output:` · `apply_patch` = `Exit code: N/Wall time…/Output:`.
 * 종료 코드가 없는 모양(`Process running with session ID` · `Wall time` 만 · 글 · 배열 · JSON)은 `unknown` — 성공으로 단정하지 않는다.
 */
function codexOutputStatus(output: unknown): 'ok' | 'error' | 'unknown' {
  if (typeof output !== 'string') return 'unknown'
  const head = output.slice(0, 1000)
  const marker = head.search(/^Output:/m)
  const header = marker < 0 ? head : head.slice(0, marker)
  const exit = /^(?:Process exited with code|Exit code:) (-?\d+)\s*$/m.exec(header)
  if (exit === null) return 'unknown'
  return Number(exit[1]) === 0 ? 'ok' : 'error'
}

/** `<send_user_message_question_reply>[{answer,question,questionItemId}]</…>` 의 답 글. 모양이 아니면 null. */
function codexReplyAnswer(raw: string): string | null {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  const parsed = safeParse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) return null
  const parts = parsed.flatMap((entry) => (isRecord(entry) && typeof entry['answer'] === 'string' && entry['answer'].trim().length > 0 ? [entry['answer']] : []))
  return parts.length === 0 ? null : parts.join(' · ')
}

function codexItem(input: { record: Record<string, unknown>; item: Record<string, unknown> }): ChatAtom[] {
  const { item } = input
  const type = readString(item, 'type')
  const failed = readString(item, 'status') === 'failed'
  switch (type) {
    case 'UserMessage':
      return codexUser(input.record)
    case 'AgentMessage':
      return [{ kind: 'skip', reason: 'codex:item:AgentMessage' }] // response_item/message/assistant 의 중복(X2ⓖ)
    case 'Reasoning':
      return [{ kind: 'skip', reason: 'codex:item:Reasoning' }]
    case 'ContextCompaction':
      return [{ kind: 'skip', reason: 'codex:item:ContextCompaction' }] // 정본은 최상위 `compacted`
    case 'CommandExecution': {
      const exit = item['exit_code']
      const error = failed || (typeof exit === 'number' && exit !== 0)
      // id 가 앞선 function_call 의 call_id 와 같으면 같은 호출이다 — 조립기가 새 칸 대신 그 칸을 고친다(리뷰 P6, 실물 12401건 중 0건 관측).
      return [{ kind: 'tool', callId: readString(item, 'id'), name: 'Shell', target: codexCommand(item['command']), status: error ? 'error' : 'ok' }]
    }
    case 'FileChange': {
      const changes = item['changes']
      const paths = isRecord(changes) ? Object.keys(changes) : []
      const target = paths.length === 0 ? null : paths.length === 1 ? (paths[0] ?? null) : `${paths[0]} 외 ${paths.length - 1}`
      return [{ kind: 'tool', callId: null, name: 'Edit', target, status: failed ? 'error' : 'ok' }]
    }
    case 'McpToolCall': {
      const server = readString(item, 'server')
      const tool = readString(item, 'tool')
      const name = server !== null && tool !== null ? `${server}.${tool}` : (tool ?? server)
      return [{ kind: 'tool', callId: null, name, target: codexArgsTarget(item['arguments']), status: failed || (item['error'] !== undefined && item['error'] !== null) ? 'error' : 'ok' }]
    }
    case 'ImageView':
      return [{ kind: 'tool', callId: null, name: 'View image', target: readString(item, 'path'), status: 'ok' }]
    case 'Extension':
      return [{ kind: 'tool', callId: null, name: readString(item, 'kind') ?? 'Extension', target: readString(item, 'query'), status: 'ok' }]
    default:
      return [{ kind: 'unknown', shape: `codex:item:${type ?? '?'}` }]
  }
}

/** `["/bin/zsh","-lc","<명령>"]` — 마지막 문자열이 명령이다. 문자열이면 그대로. */
function codexCommand(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const last = value[value.length - 1]
  return typeof last === 'string' ? last : null
}

/** function_call 인자의 대상 한 줄 — 관측된 키(`cmd`·`command`·`path`)를 먼저, 그다음 Claude 와 같은 키 순서. */
function codexArgsTarget(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null
  for (const key of ['cmd', 'command', 'path']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
    if (Array.isArray(value)) {
      const command = codexCommand(value)
      if (command !== null) return command
    }
  }
  return toolInputPreview(parsed)
}

/** apply_patch 입력의 첫 파일 — `*** Update File: <경로>` 류. */
function patchTarget(input: string): string | null {
  const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input)
  return match?.[1]?.trim() ?? null
}

// --- Grok (`updates.jsonl`) ---------------------------------------------------------------------------

const GROK_SKIP_UPDATES = new Set([
  'agent_thought_chunk',
  'hook_execution',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'auto_compact_started',
  'auto_compact_completed', // 압축 정본은 compaction_checkpoint
  'background_tasks',
  'task_backgrounded',
  'task_completed',
  'memory_dream_queued',
  'memory_dream_started',
  'memory_dream_completed',
  'session_recap',
  'retry_state',
  'usage_update',
  'session_info_update',
])

export function grokAtoms(record: Record<string, unknown>): LineAtoms {
  const at = grokTime(record['timestamp'])
  const one = (atom: ChatAtom): LineAtoms => ({ atoms: [atom], at, link: null })
  const update = grokUpdate(record)
  if (update === null) return one({ kind: 'unknown', shape: 'grok:no-update' })
  const kind = readString(update, 'sessionUpdate')
  switch (kind) {
    case 'user_message_chunk': {
      const human = grokUpdateHumanText(record)
      return one(human === null ? { kind: 'skip', reason: 'grok:user-hidden' } : { kind: 'prompt', text: human })
    }
    case 'agent_message_chunk': {
      const content = update['content']
      const text = isRecord(content) ? readString(content, 'text') : null
      if (text === null || text.length === 0) return one({ kind: 'skip', reason: 'grok:empty-chunk' })
      // chunk 는 이어 붙인다(구분자 없음). `messageId` 가 있으면 같은 id 끼리만(ACP rfds/message-id), 없으면 연속 chunk 끼리.
      return one({ kind: 'reply', text, key: `grok:${readString(update, 'messageId') ?? '-'}`, join: '' })
    }
    case 'tool_call': {
      const callId = readString(update, 'toolCallId')
      const title = readString(update, 'title')
      if (title === 'ask_user_question') {
        const rawInput = update['rawInput']
        const questions = isRecord(rawInput) ? readQuestions({ items: rawInput['questions'], textKey: 'question' }) : null
        return one({ kind: 'question', callId, questions: questions ?? [] })
      }
      return one({ kind: 'tool', callId, name: title, target: grokTarget(update['rawInput']), status: grokStatus(readString(update, 'status')) ?? 'running' })
    }
    case 'tool_call_update': {
      const callId = readString(update, 'toolCallId')
      if (callId === null) return one({ kind: 'unknown', shape: 'grok:tool_call_update:no-id' })
      const atoms: ChatAtom[] = []
      const title = readString(update, 'title')
      const target = grokTarget(update['rawInput'])
      if (title !== null || target !== null) atoms.push({ kind: 'tool_info', callId, name: title, target })
      const status = grokStatus(readString(update, 'status'))
      if (status === 'ok' || status === 'error') {
        const answer = grokAnswer(update['rawOutput'])
        atoms.push({ kind: 'result', callId, status, answer, settles: true })
      }
      return { atoms: atoms.length === 0 ? [{ kind: 'skip', reason: 'grok:tool_call_update' }] : atoms, at, link: null }
    }
    case 'turn_completed': {
      const stop = readString(update, 'stop_reason')
      if (stop === 'cancelled') return one({ kind: 'note', note: 'interrupted', text: null })
      if (stop === 'error' || stop === 'rate_limit') return one({ kind: 'note', note: 'failed', text: stop })
      return one({ kind: 'skip', reason: `grok:turn_completed:${stop ?? '?'}` })
    }
    case 'compaction_checkpoint':
      return one({ kind: 'note', note: 'compacted', text: null })
    default:
      if (kind !== null && GROK_SKIP_UPDATES.has(kind)) return one({ kind: 'skip', reason: `grok:${kind}` })
      return one({ kind: 'unknown', shape: `grok:${kind ?? '?'}` })
  }
}

function grokStatus(status: string | null): ChatToolStatus | null {
  switch (status) {
    case 'completed':
      return 'ok'
    case 'failed':
      return 'error'
    case 'pending':
    case 'in_progress':
      return 'running'
    default:
      return null
  }
}

/** grok rawInput 의 대상 — 관측된 키(c06·이 작업 실측): `command`·`target_file`·`file_path`·`target_directory`·`pattern`·`url`·`query`. */
function grokTarget(rawInput: unknown): string | null {
  if (!isRecord(rawInput)) return null
  for (const key of ['command', 'target_file', 'file_path', 'target_directory', 'pattern', 'url', 'query', 'path']) {
    const value = rawInput[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

/** `ask_user_question` 의 답 — `rawOutput.UserAnswered`. 글이면 그대로, `answers` 가 있으면 글만 잇는다. 모양을 모르면 null. */
function grokAnswer(rawOutput: unknown): string | null {
  if (!isRecord(rawOutput)) return null
  const answered = rawOutput['UserAnswered']
  if (typeof answered === 'string') return answered.trim().length > 0 ? answered : null
  if (!isRecord(answered)) return null
  const answers = answered['answers']
  const values = Array.isArray(answers) ? answers : isRecord(answers) ? Object.values(answers) : []
  const parts = values.flatMap((value) => (typeof value === 'string' && value.trim().length > 0 ? [value] : isRecord(value) && typeof value['answer'] === 'string' ? [value['answer']] : []))
  return parts.length === 0 ? null : parts.join(' · ')
}

/** grok 시각 — 초 단위 정수(실측) · ms 숫자 · ISO 문자열. */
function grokTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value >= 1e12 ? value : Math.floor(value * 1000)
  return readTimestamp(value)
}

/** provider 갈래 한 자리 — 깨진 줄은 `unknown`. */
export function lineAtoms(input: { agent: TranscriptAgent; line: string; sessionId: string | null }): LineAtoms {
  const record = safeParse(input.line)
  if (!isRecord(record)) return { atoms: [{ kind: 'unknown', shape: 'not-json' }], at: null, link: null }
  switch (input.agent) {
    case 'claude':
      return claudeAtoms({ record, sessionId: input.sessionId })
    case 'codex':
      return codexAtoms(record)
    case 'grok':
      return grokAtoms(record)
  }
}

// --- 조립 ---------------------------------------------------------------------------------------------

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>
type QuestionItem = Extract<ChatItem, { kind: 'question' }>
type ReplyItem = Extract<ChatItem, { kind: 'reply' }>

export type ChatStats = { lines: number; skipped: Record<string, number>; unknown: Record<string, number>; orphanResults: number }

/**
 * 원자 → 말풍선. 파일 순서대로 `feed` 한다. 같은 바이트를 다시 먹이지 않는다(호출자가 오프셋을 쥔다).
 *
 * - 연속 도구 호출 = 묶음 1장(디자인 Q4). 답·지시·질문·카드가 묶음을 닫는다. 건너뛴 줄(생각·메타·결과)은 묶음을 닫지 않는다.
 * - 같은 `key` 의 연속 답 = 한 말풍선(X2ⓖ). 생각·메타 줄은 사이에 있어도 합침을 끊지 않는다.
 * - 도구 결과는 그 호출을 찾아 상태만 바꾼다(본문은 버린다). 답(AskUserQuestion 결과 등)은 질문 말풍선에.
 * - Claude rewind(X2ⓘ): 사람 발화 R 의 부모 P 에 **앞선 사람 발화 자식 S** 가 이미 있으면 S 부터 R 앞까지는 버려진 가지다 —
 *   S 이후의 말풍선을 지우고 `rewinds` 를 올린다(판독자가 세대를 바꿔 폰이 처음부터 받는다). 실측에서 같은 부모를 둔 사람 발화 둘 = rewind 모양뿐이다
 *   (나머지 갈래는 병렬 도구 결과 — `raw/claude/mapping.md`).
 * - `changed()` = 마지막으로 물은 뒤 새로 생기거나 바뀐 말풍선 id.
 */
export class ChatBuilder {
  readonly agent: TranscriptAgent
  private readonly sessionId: string | null
  readonly items: ChatItem[] = []
  private openTools: ToolsItem | null = null
  private openReply: { item: ReplyItem; key: string } | null = null
  private readonly calls = new Map<string, { item: ToolsItem; index: number }>()
  private readonly questions = new Map<string, QuestionItem>()
  private readonly pending: QuestionItem[] = []
  private readonly humanChildOf = new Map<string, number>()
  private dirty = new Set<number>()
  rewinds = 0
  readonly stats: ChatStats = { lines: 0, skipped: {}, unknown: {}, orphanResults: 0 }

  constructor(input: { agent: TranscriptAgent; sessionId: string | null }) {
    this.agent = input.agent
    this.sessionId = input.sessionId
  }

  /** 완성된 한 줄(개행 앞까지) — `offset` 은 그 줄 첫 바이트의 파일 위치. */
  feed(input: { offset: number; line: string }): void {
    if (input.line.trim().length === 0) return
    this.stats.lines += 1
    const parsed = lineAtoms({ agent: this.agent, line: input.line, sessionId: this.sessionId })
    if (parsed.link !== null && parsed.link.human) this.rewindCheck({ link: parsed.link, offset: input.offset })
    for (const atom of parsed.atoms) this.apply({ atom, offset: input.offset, at: parsed.at })
  }

  changed(): Set<number> {
    const out = this.dirty
    this.dirty = new Set()
    return out
  }

  private rewindCheck(input: { link: ClaudeLink; offset: number }): void {
    const parent = input.link.parentUuid
    if (parent === null) return
    const earlier = this.humanChildOf.get(parent)
    if (earlier === undefined) {
      this.humanChildOf.set(parent, input.offset)
      return
    }
    // 버려진 가지 — S(earlier) 이후의 말풍선을 지운다. 그 가지 안의 사람 발화 표지도 버린다(다시 갈라질 수 있다).
    this.rewinds += 1
    const keep = this.items.filter((item) => item.id < earlier)
    this.items.length = 0
    this.items.push(...keep)
    for (const [uuid, offset] of [...this.humanChildOf]) if (offset > earlier) this.humanChildOf.delete(uuid)
    for (const [id, call] of [...this.calls]) if (call.item.id >= earlier) this.calls.delete(id)
    for (const [id, question] of [...this.questions]) if (question.id >= earlier) this.questions.delete(id)
    for (let i = this.pending.length - 1; i >= 0; i -= 1) if ((this.pending[i]?.id ?? 0) >= earlier) this.pending.splice(i, 1)
    this.openTools = null
    this.openReply = null
  }

  private push(item: ChatItem): void {
    this.items.push(item)
    this.dirty.add(item.id)
  }

  private close(): void {
    this.openTools = null
    this.openReply = null
  }

  private apply(input: { atom: ChatAtom; offset: number; at: number | null }): void {
    const { atom, offset, at } = input
    switch (atom.kind) {
      case 'skip':
        this.stats.skipped[atom.reason] = (this.stats.skipped[atom.reason] ?? 0) + 1
        return
      case 'unknown':
        this.stats.unknown[atom.shape] = (this.stats.unknown[atom.shape] ?? 0) + 1
        return
      case 'prompt':
        this.close()
        return this.push({ id: this.freeId(offset), kind: 'prompt', text: atom.text, at })
      case 'reply': {
        this.openTools = null
        const open = this.openReply
        if (open !== null && atom.key !== null && open.key === atom.key) {
          open.item.text = `${open.item.text}${atom.join}${atom.text}`
          this.dirty.add(open.item.id)
          return
        }
        const item: ReplyItem = { id: this.freeId(offset), kind: 'reply', text: atom.text, at }
        this.openReply = atom.key === null ? null : { item, key: atom.key }
        return this.push(item)
      }
      case 'tool': {
        const known = atom.callId === null ? undefined : this.calls.get(atom.callId)
        const existing = known?.item.tools[known.index]
        if (known !== undefined && existing !== undefined) {
          // 같은 호출이 두 모양으로 기록됐다(Codex function_call + item_completed) — 한 칸으로 센다.
          existing.status = atom.status
          if (atom.target !== null) existing.target = atom.target
          this.dirty.add(known.item.id)
          return
        }
        this.openReply = null
        let group = this.openTools
        if (group === null) {
          group = { id: this.freeId(offset), kind: 'tools', tools: [], at }
          this.openTools = group
          this.push(group)
        }
        group.tools.push({ name: atom.name, target: atom.target, status: atom.status })
        if (atom.callId !== null) this.calls.set(atom.callId, { item: group, index: group.tools.length - 1 })
        this.dirty.add(group.id)
        return
      }
      case 'tool_info': {
        const call = this.calls.get(atom.callId)
        const tool = call?.item.tools[call.index]
        if (call === undefined || tool === undefined) return
        if (atom.name !== null) tool.name = atom.name
        if (atom.target !== null) tool.target = atom.target
        this.dirty.add(call.item.id)
        return
      }
      case 'result': {
        const question = this.questions.get(atom.callId)
        if (question !== undefined) {
          if (question.state === 'pending' && atom.settles) this.settle({ question, state: atom.status === 'ok' ? 'answered' : 'closed', answer: atom.answer })
          return
        }
        const call = this.calls.get(atom.callId)
        const tool = call?.item.tools[call.index]
        if (call === undefined || tool === undefined) {
          this.stats.orphanResults += 1
          return
        }
        tool.status = atom.status
        this.dirty.add(call.item.id)
        return
      }
      case 'question': {
        this.close()
        const item: QuestionItem = { id: this.freeId(offset), kind: 'question', questions: atom.questions, state: 'pending', answer: null, at }
        if (atom.callId !== null) this.questions.set(atom.callId, item)
        this.pending.push(item)
        return this.push(item)
      }
      case 'resolve': {
        if (atom.callId !== null) {
          const question = this.questions.get(atom.callId)
          if (question !== undefined && question.state === 'pending') this.settle({ question, state: atom.state, answer: atom.answer })
          return
        }
        for (const question of [...this.pending]) this.settle({ question, state: atom.state, answer: atom.answer })
        return
      }
      case 'note':
        this.close()
        return this.push({ id: this.freeId(offset), kind: 'note', note: atom.note, text: atom.text, at })
    }
  }

  private settle(input: { question: QuestionItem; state: 'answered' | 'closed'; answer: string | null }): void {
    const { question } = input
    question.state = input.state
    question.answer = input.answer
    const index = this.pending.indexOf(question)
    if (index >= 0) this.pending.splice(index, 1)
    this.dirty.add(question.id)
  }

  /**
   * 한 줄에서 말풍선이 둘 이상 열릴 수 있다(Claude 한 줄에 답 + 도구, Codex 중단 = 해소 + 카드). id 는 줄 위치에 줄 안 순번을 소수로 붙인다 —
   * 같은 줄의 둘째 말풍선은 `offset + 0.1`. 줄은 1바이트 이상 떨어져 있으니 다음 줄과 겹치지 않는다(줄 안 말풍선 9개까지).
   */
  private freeId(offset: number): number {
    const last = this.items[this.items.length - 1]
    if (last === undefined || last.id < offset) return offset
    return Math.round((last.id + 0.1) * 10) / 10
  }
}
