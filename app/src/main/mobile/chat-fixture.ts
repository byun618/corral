// 대화 판독 합성 기록 (LIFE-581 Y1ⓑ·G5) — 시험·repro·측정 스크립트가 같이 쓴다. 모양(키·종류)은 이 기계 실물에서 땄고(`raw/coordinator/c06`·
// `raw/claude/mapping.md`) 글은 전부 지어낸 것이다. 실물 대화 본문은 여기 없다.
//
// 각 provider 기록에 담은 종류: 사람 발화 · 명령/meta(지시 아님) · 에이전트 글 · 생각(보내지 않음) · 도구 연속 묶음 · 도구 실패 · 질문(미답·답함) ·
// 중단 · 실패 · 여러 줄 한 응답 · 중복 기록(Codex 두 모양) · 압축 경계 · Claude rewind 가지 · Grok chunk. 홈 아래 절대경로(가림 확인용)도 섞었다.
import { emptyAgentState } from '../../shared/agent-state.js'
import type { AgentSessionRef, RepoRow, RetainedAgentRow } from '../../shared/types.js'
import { fixturePane, fixtureWorktree, liveLink } from './list-fixture.js'
import type { ListState } from './list.js'

export const CHAT_HOME = '/Users/fxuser'
export const CHAT_WORKTREE = '/Users/fxuser/repos/demo'
export const CLAUDE_SESSION = 'cfx-0000-1111'
export const T0 = Date.parse('2026-10-10T03:00:00.000Z')

/** 생각·결과 본문에만 넣는 표지 — 페이로드에 나오면 안 된다(Y9ⓓ). */
export const SECRET_THOUGHT = 'SECRET_THOUGHT_MARKER'
export const SECRET_RESULT = 'SECRET_RESULT_MARKER'

const iso = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const line = (value: unknown): string => JSON.stringify(value)

// --- Claude ------------------------------------------------------------------------------------------

type ClaudeOpts = { uuid: string; parent: string | null; t: number }

function claudeUser(content: unknown, opts: ClaudeOpts, extra: Record<string, unknown> = {}): string {
  return line({ parentUuid: opts.parent, isSidechain: false, type: 'user', message: { role: 'user', content }, uuid: opts.uuid, timestamp: iso(opts.t), sessionId: CLAUDE_SESSION, ...extra })
}

function claudeAssistant(id: string, blocks: unknown[], opts: ClaudeOpts, extra: Record<string, unknown> = {}): string {
  return line({ parentUuid: opts.parent, isSidechain: false, type: 'assistant', message: { id, role: 'assistant', model: 'claude-fx', content: blocks }, uuid: opts.uuid, timestamp: iso(opts.t), sessionId: CLAUDE_SESSION, ...extra })
}

/** Claude 본 세션 파일 — 한 줄씩. */
export function claudeLines(): string[] {
  return [
    line({ type: 'permission-mode', permissionMode: 'default', sessionId: CLAUDE_SESSION }),
    line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
    claudeUser('<command-name>/model</command-name><command-message>model</command-message>', { uuid: 'u0', parent: null, t: 0 }),
    claudeUser('meta caveat', { uuid: 'u0m', parent: 'u0', t: 0 }, { isMeta: true }),
    claudeUser(`첫 지시 — ${CHAT_WORKTREE}/src/a.ts 를 고쳐 줘`, { uuid: 'u1', parent: 'u0m', t: 1 }),
    line({ type: 'attachment', parentUuid: 'u1', uuid: 'att1', attachment: { type: 'x' }, sessionId: CLAUDE_SESSION }),
    claudeAssistant('m1', [{ type: 'thinking', thinking: SECRET_THOUGHT, signature: 's' }], { uuid: 'a1', parent: 'u1', t: 2 }),
    claudeAssistant('m1', [{ type: 'text', text: '먼저 파일을 봅니다.' }], { uuid: 'a2', parent: 'a1', t: 2 }),
    claudeAssistant('m1', [{ type: 'text', text: '두 번째 덩어리.' }], { uuid: 'a3', parent: 'a2', t: 2 }),
    claudeAssistant('m1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: `${CHAT_WORKTREE}/src/a.ts` } }], { uuid: 'a4', parent: 'a3', t: 3 }),
    claudeAssistant('m1', [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: `ls ${CHAT_HOME}/secret`, description: 'list' } }], { uuid: 'a5', parent: 'a4', t: 3 }),
    claudeUser([{ type: 'tool_result', tool_use_id: 'tu1', content: SECRET_RESULT }], { uuid: 'r1', parent: 'a5', t: 4 }, { toolUseResult: { stdout: SECRET_RESULT } }),
    claudeUser([{ type: 'tool_result', tool_use_id: 'tu2', content: SECRET_RESULT, is_error: true }], { uuid: 'r2', parent: 'r1', t: 4 }),
    claudeAssistant('m2', [{ type: 'text', text: '읽었습니다. 다음은 질문입니다.' }], { uuid: 'a6', parent: 'r2', t: 5 }),
    claudeAssistant('m2', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: '어느 쪽?', header: '선택', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } }], { uuid: 'a7', parent: 'a6', t: 5 }),
    claudeUser([{ type: 'tool_result', tool_use_id: 'q1', content: 'User answered' }], { uuid: 'r3', parent: 'a7', t: 6 }, { toolUseResult: { questions: [], answers: { '어느 쪽?': 'B' } } }),
    line({ parentUuid: 'r3', type: 'system', subtype: 'turn_duration', durationMs: 1, uuid: 's1', timestamp: iso(7), sessionId: CLAUDE_SESSION }),
    claudeUser('<task-notification>bg done</task-notification>', { uuid: 'u2n', parent: 's1', t: 8 }),
    claudeUser('두 번째 지시', { uuid: 'u2', parent: 'u2n', t: 9 }),
    claudeAssistant('m3', [{ type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: `${CHAT_WORKTREE}/src/b.ts`, old_string: 'x', new_string: 'y' } }], { uuid: 'a8', parent: 'u2', t: 10 }),
    claudeUser('[Request interrupted by user for tool use]', { uuid: 'u3i', parent: 'a8', t: 11 }),
    line({ parentUuid: null, logicalParentUuid: 'u3i', type: 'system', subtype: 'compact_boundary', uuid: 'cb1', timestamp: iso(12), sessionId: CLAUDE_SESSION }),
    claudeUser('This session is being continued… (compact summary body)', { uuid: 'cs1', parent: 'cb1', t: 12 }, { isCompactSummary: true }),
    claudeUser('압축 뒤 지시', { uuid: 'u4', parent: 'cs1', t: 13 }),
    claudeAssistant('m4', [{ type: 'text', text: 'API Error: overloaded' }], { uuid: 'a9', parent: 'u4', t: 14 }, { isApiErrorMessage: true, error: 'overloaded' }),
    // rewind — u5(버려질 가지) 와 u6 이 같은 부모 a9 를 둔 사람 발화다.
    claudeUser('버려질 지시', { uuid: 'u5', parent: 'a9', t: 15 }),
    claudeAssistant('m5', [{ type: 'text', text: '버려질 답' }], { uuid: 'a10', parent: 'u5', t: 16 }),
    claudeUser('되감은 뒤 지시', { uuid: 'u6', parent: 'a9', t: 17 }),
    claudeAssistant('m6', [{ type: 'text', text: '마지막 답' }], { uuid: 'a11', parent: 'u6', t: 18 }),
  ]
}

// --- Codex -------------------------------------------------------------------------------------------

function codex(type: string, payload: Record<string, unknown> | null, t: number): string {
  return line(payload === null ? { timestamp: iso(t), type } : { timestamp: iso(t), type, payload })
}

/** 0.153 이전 모양 — event_msg user_message·agent_message 중복, function_call exec_command. */
export function codexOldLines(): string[] {
  return [
    codex('session_meta', { id: 'cx-old', cli_version: '0.142.4', cwd: CHAT_WORKTREE }, 0),
    codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>주입</environment_context>' }] }, 0),
    codex('event_msg', { type: 'task_started' }, 1),
    codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '옛 지시' }] }, 1),
    codex('event_msg', { type: 'user_message', message: '옛 지시' }, 1),
    codex('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: SECRET_THOUGHT }] }, 2),
    codex('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${CHAT_WORKTREE}/README.md` }), call_id: 'c1' }, 2),
    codex('response_item', { type: 'function_call_output', call_id: 'c1', output: SECRET_RESULT }, 3),
    codex('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch' }, 3),
    codex('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: SECRET_RESULT }, 3),
    codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '옛 답' }] }, 4),
    codex('event_msg', { type: 'agent_message', message: '옛 답' }, 4),
    codex('event_msg', { type: 'token_count', info: null }, 4),
    codex('event_msg', { type: 'task_complete', last_agent_message: '옛 답' }, 5),
  ]
}

/** 0.159 모양 — item_completed(UserMessage·AgentMessage·CommandExecution) 와 response_item 양쪽, exec 상자. */
export function codexNewLines(): string[] {
  return [
    codex('session_meta', { id: 'cx-new', cli_version: '0.159.2', cwd: CHAT_WORKTREE }, 0),
    codex('turn_context', { model: 'gpt-fx' }, 0),
    codex('event_msg', { type: 'task_started' }, 1),
    codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '새 지시 + 주입 맥락' }] }, 1),
    codex('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'i1', content: [{ type: 'text', text: '새 지시' }] } }, 1),
    codex('response_item', { type: 'reasoning', summary: [], encrypted_content: SECRET_THOUGHT }, 2),
    codex('event_msg', { type: 'item_completed', item: { type: 'Reasoning', id: 'i2', summary_text: [SECRET_THOUGHT] } }, 2),
    codex('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: 'await tools.shell("ls")', status: 'completed' }, 2),
    codex('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i3', command: ['/bin/zsh', '-lc', 'ls -la'], status: 'completed', exit_code: 0, aggregated_output: SECRET_RESULT } }, 3),
    codex('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i4', command: ['/bin/zsh', '-lc', 'false'], status: 'failed', exit_code: 1, aggregated_output: SECRET_RESULT } }, 3),
    codex('response_item', { type: 'custom_tool_call_output', call_id: 'e1', output: [{ type: 'input_text', text: SECRET_RESULT }] }, 3),
    codex('event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'i5', status: 'completed', changes: { [`${CHAT_WORKTREE}/src/y.ts`]: {} } } }, 3),
    codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '새 답' }] }, 4),
    codex('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'i6', content: [{ type: 'Text', text: '새 답' }] } }, 4),
    codex('response_item', { type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ id: 'q', title: '진행할까?', options: ['예', '아니오'] }] }), call_id: 'qq1' }, 5),
    codex('response_item', { type: 'function_call_output', call_id: 'qq1', output: '{"accepted":true}' }, 5),
    codex('event_msg', { type: 'task_complete' }, 6),
    codex('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'i7', content: [{ type: 'text', text: '<send_user_message_question_reply>[{"answer":"예","question":"진행할까?","questionItemId":"q"}]</send_user_message_question_reply>' }] } }, 7),
    codex('event_msg', { type: 'task_started' }, 8),
    codex('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'i8', content: [{ type: 'text', text: '중단될 지시' }] } }, 8),
    codex('event_msg', { type: 'turn_aborted', reason: 'interrupted' }, 9),
    codex('compacted', { message: '', replacement_history: [] }, 10),
    codex('event_msg', { type: 'task_started' }, 11),
    codex('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'i9', content: [{ type: 'text', text: '마지막 지시' }] } }, 11),
    codex('event_msg', { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } }, 12),
  ]
}

// --- Grok ----------------------------------------------------------------------------------------------

function grok(update: Record<string, unknown>, t: number, method = 'session/update'): string {
  return line({ timestamp: Math.floor((T0 + t * 1000) / 1000), method, params: { sessionId: 'gfx', update } })
}

/** Grok `updates.jsonl`. */
export function grokUpdateLines(): string[] {
  return [
    grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<system-reminder>주입</system-reminder>' }, _meta: { hideFromScrollback: true, promptIndex: 0 } }, 0),
    grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '그록 첫 지시' }, _meta: { promptIndex: 0, modelId: 'grok-fx' } }, 1),
    grok({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: SECRET_THOUGHT } }, 2),
    grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '나뉜 ' } }, 2),
    grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '답 ' } }, 2),
    grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '하나' } }, 2),
    grok({ event_name: 'PreToolUse', runs: [], sessionUpdate: 'hook_execution' }, 3, '_x.ai/session/update'),
    grok({ sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'read_file', rawInput: { target_file: `${CHAT_WORKTREE}/a.md` }, _meta: {} }, 3),
    grok({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed', rawOutput: { content: SECRET_RESULT } }, 3),
    grok({ sessionUpdate: 'tool_call', toolCallId: 'g2', title: 'run_terminal_command', rawInput: { command: 'make test', description: 'test' }, _meta: {} }, 4),
    grok({ sessionUpdate: 'tool_call_update', toolCallId: 'g2', status: 'failed', rawOutput: { stderr: SECRET_RESULT } }, 4),
    grok({ sessionUpdate: 'tool_call', toolCallId: 'g3', title: 'ask_user_question', rawInput: { questions: [{ question: '그록 질문?', options: [{ label: 'X', description: 'x' }] }] } }, 5),
    grok({ sessionUpdate: 'tool_call_update', toolCallId: 'g3', status: 'completed', rawOutput: { UserAnswered: { answers: ['X'] } } }, 6),
    grok({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }, 6),
    grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '그록 둘째 지시' }, _meta: { promptIndex: 1 } }, 7),
    grok({ sessionUpdate: 'turn_completed', stop_reason: 'cancelled' }, 8),
    grok({ sessionUpdate: 'compaction_checkpoint' }, 9),
    grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '그록 마지막 지시' }, _meta: { promptIndex: 2 } }, 10),
    grok({ sessionUpdate: 'turn_completed', stop_reason: 'error' }, 11),
  ]
}

/** 같은 세션의 Grok `chat_history.jsonl` — 압축으로 앞 발화(첫·둘째)를 잃은 모양(실측 3/40 세션, `y1-grok-human-equiv.txt`). */
export function grokChatHistoryLines(): string[] {
  return [
    line({ type: 'system', content: 'system prompt' }),
    line({ type: 'user', content: '<user_info>환경</user_info>' }),
    line({ type: 'user', content: '<user_info>환경</user_info>\n<user_query>그록 마지막 지시</user_query>' }),
    line({ type: 'assistant', content: '', model_id: 'grok-fx' }),
  ]
}

// --- 목록 상태 -------------------------------------------------------------------------------------------

export const CHAT_SESSIONS = {
  claude: { kind: 'id', agent: 'claude', source: 'herdr', id: CLAUDE_SESSION },
  codex: { kind: 'id', agent: 'codex', source: 'herdr', id: 'cx-new' },
  grok: { kind: 'id', agent: 'grok', source: 'herdr', id: 'gfx' },
  retained: { kind: 'id', agent: 'claude', source: 'herdr', id: 'cfx-closed' },
} satisfies Record<string, AgentSessionRef>

/**
 * 대화 시험 목록 — 한 작업에 Claude·Codex·Grok live 채널 + 셸 pane + 세션 참조 없는 Claude + 보존 행(참조 있음 `r-claude` · 없음 `r-old`).
 * 채널 id: `c1`·`c2`·`c3`·`c4`(참조 없음) · 셸 `s1` · `retained:r-claude` · `retained:r-old`.
 */
export function chatListState(): ListState {
  const panes = [
    fixturePane('c1', 'claude', { agentSession: CHAT_SESSIONS.claude, cwd: CHAT_WORKTREE }),
    fixturePane('c2', 'codex', { agentSession: CHAT_SESSIONS.codex, cwd: CHAT_WORKTREE }),
    fixturePane('c3', 'grok', { agentSession: CHAT_SESSIONS.grok, cwd: CHAT_WORKTREE }),
    fixturePane('c4', 'claude', { agentSession: null, cwd: CHAT_WORKTREE }),
    fixturePane('s1', null, { cwd: CHAT_WORKTREE }),
  ]
  const repo: RepoRow = { root: CHAT_WORKTREE, name: 'demo', error: null, worktrees: [fixtureWorktree({ path: CHAT_WORKTREE, branch: 'main', repoName: 'demo', isLinked: false, panes })] }
  const retained = (paneId: string, session: AgentSessionRef | null): RetainedAgentRow => ({
    paneId,
    tabId: `t-${paneId}`,
    workspaceId: 'ws-main',
    title: `닫힌 ${paneId}`,
    agent: 'claude',
    agentStatus: 'done',
    agentState: { ...emptyAgentState(T0), enteredDoneAt: T0 },
    cwd: CHAT_WORKTREE,
    retainedAt: T0,
    agentSession: session,
  })
  return {
    repos: [repo],
    retainedAgents: [retained('r-claude', CHAT_SESSIONS.retained), retained('r-old', null)],
    orchestrationLineage: { state: 'ready', entries: [] },
    integrations: [],
    home: CHAT_HOME,
    link: liveLink(),
  }
}
