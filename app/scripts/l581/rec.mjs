// LIFE-581 최종 관문 — 격리 합성 기록(글은 전부 지어낸 것, 표지 `L581-…` 로 회차를 짝짓는다). 모양은 `src/main/mobile/chat-fixture.ts`(실물에서 딴 키·종류)와 같다.
// 기록은 격리 앱의 가짜 HOME(`<ROOT>/home`) 아래 provider 기본 자리에 둔다 — 격리 앱은 `HOME=<ROOT>/home` 으로 띄운다(g-up.sh 덧붙인 KEY=VALUE).
// 제품의 세션 참조 → 파일 찾기(`resolveTranscriptFile`, HOME 기준)를 그대로 탄다. 사용자 HOME 의 기록 폴더는 건드리지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { herdr, freshPane } from './lib.mjs'

/** 기록 파일 자리 — 제품이 id 로 찾는 그 자리(transcript.ts `findClaudeFile`·`findCodexFile`·`findGrokFile`). Grok 은 updates.jsonl(대화 정본)과 형제 chat_history.jsonl. */
export function recordFile({ root, agent, id }) {
  const home = path.join(root, 'home')
  switch (agent) {
    case 'claude':
      return path.join(home, '.claude/projects/-l581-synthetic', `${id}.jsonl`)
    case 'codex':
      return path.join(home, '.codex/sessions/2026/10/10', `rollout-2026-10-10T00-00-00-${id}.jsonl`)
    case 'grok':
      return path.join(home, '.grok/sessions/%2Ftmp%2Fl581', id, 'updates.jsonl')
  }
  throw new Error(`모르는 provider ${agent}`)
}

/** 대화 하나 — 줄 쓰기(append, 개행까지 한 번에) · 쓴 시각(쓰기 **직전**) 기록. */
export class Conversation {
  constructor({ root, agent, id }) {
    this.agent = agent
    this.id = id
    this.file = recordFile({ root, agent, id })
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    if (agent === 'grok') fs.writeFileSync(path.join(path.dirname(this.file), 'chat_history.jsonl'), JSON.stringify({ type: 'system', content: 'synthetic' }) + '\n')
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '')
    this.n = 0
    this.last = null
    if (agent === 'codex') this.append([this.codex('session_meta', { id, cli_version: '0.159.2', cwd: '/tmp/l581' })])
  }

  iso() {
    return new Date().toISOString()
  }

  /** 줄들을 한 번에 append — 반환 = 쓰기 직전 시각(ⓑ 시작). */
  append(lines) {
    const writeAt = Date.now()
    fs.appendFileSync(this.file, lines.map((line) => JSON.stringify(line) + '\n').join(''))
    return writeAt
  }

  /** 반쯤 쓴 줄(개행 없음) — 판독기가 보류해야 한다. `finish` 로 나머지를 쓴다. */
  appendPartial(line, cut) {
    const text = JSON.stringify(line)
    fs.appendFileSync(this.file, text.slice(0, cut))
    return () => {
      const writeAt = Date.now()
      fs.appendFileSync(this.file, text.slice(cut) + '\n')
      return writeAt
    }
  }

  next() {
    this.n += 1
    return this.n
  }

  // --- provider 별 줄 모양 -----------------------------------------------------------------------------

  claude(type, message, extra = {}) {
    const uuid = `${this.id}-u${this.next()}`
    const line = { parentUuid: this.last, isSidechain: false, type, message, uuid, timestamp: this.iso(), sessionId: this.id, ...extra }
    this.last = uuid
    return line
  }

  codex(type, payload) {
    return { timestamp: this.iso(), type, payload }
  }

  grok(update) {
    return { timestamp: Math.floor(Date.now() / 1000), method: 'session/update', params: { sessionId: this.id, update } }
  }

  /** 종류 하나(prompt·reply·tool·question·tool_result·note 등)의 줄들. `marker` 가 글·대상·질문에 들어간다. */
  lines(kind, marker, opts = {}) {
    const n = this.next()
    switch (this.agent) {
      case 'claude':
        switch (kind) {
          case 'prompt':
            return [this.claude('user', { role: 'user', content: `${marker} 합성 지시` })]
          case 'reply':
            return [this.claude('assistant', { id: opts.messageId ?? `m${n}`, role: 'assistant', model: 'claude-synthetic', content: [{ type: 'text', text: opts.text ?? `${marker} 합성 답` }] })]
          case 'tool':
            return [this.claude('assistant', { id: opts.messageId ?? `m${n}`, role: 'assistant', model: 'claude-synthetic', content: [{ type: 'tool_use', id: opts.callId ?? `tu${n}`, name: opts.name ?? 'Bash', input: opts.input ?? { command: `echo ${marker}`, description: 'synthetic' } }] })]
          case 'tool_result':
            return [this.claude('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: opts.callId, content: 'SYNTHETIC_RESULT_BODY', is_error: opts.error === true }] }, opts.toolUseResult === undefined ? {} : { toolUseResult: opts.toolUseResult })]
          case 'question':
            return [this.claude('assistant', { id: `m${n}`, role: 'assistant', model: 'claude-synthetic', content: [{ type: 'tool_use', id: opts.callId ?? `q${n}`, name: 'AskUserQuestion', input: { questions: [{ question: `${marker} 합성 질문?`, header: '선택', multiSelect: false, options: [{ label: '예', description: 'y' }, { label: '아니오', description: 'n' }] }] } }] })]
          case 'interrupt':
            return [this.claude('user', { role: 'user', content: '[Request interrupted by user]' })]
          case 'api_error':
            return [this.claude('assistant', { id: `m${n}`, role: 'assistant', model: 'claude-synthetic', content: [{ type: 'text', text: `API Error: ${marker}` }] }, { isApiErrorMessage: true, error: 'overloaded' })]
          case 'thinking':
            return [this.claude('assistant', { id: `m${n}`, role: 'assistant', model: 'claude-synthetic', content: [{ type: 'thinking', thinking: `${marker} SECRET_THOUGHT_MARKER`, signature: 's' }] })]
        }
        break
      case 'codex':
        switch (kind) {
          case 'prompt':
            return [this.codex('event_msg', { type: 'task_started' }), this.codex('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: `i${n}`, content: [{ type: 'text', text: `${marker} 합성 지시` }] } })]
          case 'reply':
            return [this.codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: opts.text ?? `${marker} 합성 답` }] })]
          case 'tool':
            return [this.codex('response_item', { type: 'function_call', name: opts.name ?? 'exec_command', arguments: JSON.stringify({ cmd: `echo ${marker}` }), call_id: opts.callId ?? `c${n}` })]
          case 'tool_result':
            return [this.codex('response_item', { type: 'function_call_output', call_id: opts.callId, output: `Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code ${opts.error === true ? 1 : 0}\nOutput:\nSYNTHETIC_RESULT_BODY` })]
          case 'question':
            return [this.codex('response_item', { type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ id: 'q', title: `${marker} 합성 질문?`, options: ['예', '아니오'] }] }), call_id: opts.callId ?? `qq${n}` })]
          case 'thinking':
            return [this.codex('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: `${marker} SECRET_THOUGHT_MARKER` }] })]
        }
        break
      case 'grok':
        switch (kind) {
          case 'prompt':
            return [this.grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `${marker} 합성 지시` }, _meta: { promptIndex: n } })]
          case 'reply':
            return [this.grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: opts.text ?? `${marker} 합성 답` } })]
          case 'tool':
            // opts.name === null 이면 title 을 빼 이름 없는 도구(C15 — 상세 없는 묶음)를 만든다.
            return [this.grok({ sessionUpdate: 'tool_call', toolCallId: opts.callId ?? `g${n}`, ...(opts.name === null ? {} : { title: opts.name ?? 'run_terminal_command' }), rawInput: { command: `echo ${marker}`, description: 'synthetic' }, _meta: {} })]
          case 'tool_result':
            return [this.grok({ sessionUpdate: 'tool_call_update', toolCallId: opts.callId, status: opts.error === true ? 'failed' : 'completed', rawOutput: { content: 'SYNTHETIC_RESULT_BODY' } })]
          case 'question':
            return [this.grok({ sessionUpdate: 'tool_call', toolCallId: opts.callId ?? `gq${n}`, title: 'ask_user_question', rawInput: { questions: [{ question: `${marker} 합성 질문?`, options: [{ label: '예', description: 'y' }] }] } })]
          case 'turn_end':
            return [this.grok({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' })]
          case 'thinking':
            return [this.grok({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${marker} SECRET_THOUGHT_MARKER` } })]
        }
        break
    }
    throw new Error(`${this.agent} 에 ${kind} 모양이 없다`)
  }

  write(kind, marker, opts) {
    return this.append(this.lines(kind, marker, opts))
  }
}

/**
 * 격리 레포 pane 하나를 그 provider 의 에이전트 세션으로 — 먼저 상태(`l581-measure`), 다음 세션 참조(`herdr:<provider>` 의 `report_agent_session`).
 * 순서가 거꾸로면 herdr 가 상태 보고를 받지 않는다(격리 탐침 `raw/claude/final` F-H 행) — 상태는 이 첫 보고로 정해진다(뒤 보고는 무시됨).
 */
export async function agentPane({ root, name, agent, id, state = 'idle', states = null }) {
  const { paneId, repo } = await freshPane(root, { name })
  // `states` = 세션 참조 전에 차례로 보고할 상태(예: working → idle = 포커스 안 된 pane 이면 done — 보존 행 대상).
  for (const each of states ?? [state]) {
    await herdr(root, 'pane.report_agent', { pane_id: paneId, source: 'l581-measure', agent, state: each })
    if ((states ?? []).length > 1) await new Promise((resolve) => setTimeout(resolve, 600))
  }
  await herdr(root, 'pane.report_agent_session', { pane_id: paneId, source: `herdr:${agent}`, agent, seq: 1, agent_session_id: id, session_start_source: 'startup' })
  return { paneId, repo }
}
