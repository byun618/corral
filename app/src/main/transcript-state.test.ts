// 턴 결과·모델·최근 발화·질문 판독 단위 테스트 (LIFE-458 T1~T6·T8).
//
// **레코드 모양은 실물이다** — `transcript-state.fixture.json` 은 사용자 기록에서 provider·모양마다
// 한 줄씩 뽑아 **키·키 순서·구조는 그대로, 값은 가린 것**이다(추출 스크립트와 가림 규칙:
// `specs/LIFE-458-state-sources/raw/claude/f1_extract_shapes.py`). 남은 값은 판독이 가르는 열거 값
// (`type`·`stop_reason`·`error`·`reason` …)과 중단 표지 문자열뿐이다. 테스트는 그 줄을 복제해
// id·본문처럼 **판독이 보는 칸만** 합성 값으로 바꿔 끼운다(T2 — "값은 가려도 키·순서는 실물").

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isRecord } from '../shared/json.js'
import { EMPTY_SESSION_DIGEST } from '../shared/types.js'
import type { SessionDigest } from '../shared/types.js'
import {
  cleanFirstPrompt,
  cleanPromptLine,
  parseClaudeHead,
  parseClaudeTail,
  parseCodexHead,
  parseCodexTail,
  parseGrokHead,
  parseGrokTail,
  parseGrokUpdates,
} from './transcript-parse.js'
import { digestsEqual } from './transcript.js'

const SESSION = '11111111-2222-4333-8444-555555555555'

const SHAPES: unknown = JSON.parse(fs.readFileSync(new URL('./transcript-state.fixture.json', import.meta.url), 'utf8'))

/** 실물 모양 한 줄을 깊은 복제로 꺼낸다. */
function shape(name: string): Record<string, unknown> {
  if (!isRecord(SHAPES)) throw new Error('fixture 가 객체가 아니다')
  const found = SHAPES[name]
  if (found === undefined) throw new Error(`fixture 에 ${name} 이 없다`)
  const copy: unknown = JSON.parse(JSON.stringify(found))
  if (!isRecord(copy)) throw new Error(`${name} 이 객체가 아니다`)
  return copy
}

/** 경로를 따라 내려간 객체 — 없으면 테스트가 틀린 것이라 던진다. */
function dig(record: Record<string, unknown>, ...keys: (string | number)[]): Record<string, unknown> {
  let node: unknown = record
  for (const key of keys) {
    node = Array.isArray(node) && typeof key === 'number' ? node[key] : isRecord(node) ? node[String(key)] : undefined
  }
  if (!isRecord(node)) throw new Error(`경로 ${keys.join('.')} 가 객체가 아니다`)
  return node
}

/** claude user/assistant 의 본문 텍스트를 바꾼다 — 문자열 content 면 통째로, 블록이면 첫 text 블록. */
function withText(record: Record<string, unknown>, text: string): Record<string, unknown> {
  const message = dig(record, 'message')
  const content = message['content']
  if (typeof content === 'string') message['content'] = text
  else if (Array.isArray(content)) {
    const block = content.find((item) => isRecord(item) && item['type'] === 'text')
    if (!isRecord(block)) throw new Error('text 블록이 없다')
    block['text'] = text
  }
  return record
}

const line = (record: Record<string, unknown>): string => JSON.stringify(record)
const chunkOf = (records: Record<string, unknown>[]): string => `${records.map(line).join('\n')}\n`

// --- claude 레코드 ---------------------------------------------------------------

function own(record: Record<string, unknown>): Record<string, unknown> {
  record['sessionId'] = SESSION
  return record
}
const cHuman = (text: string) => withText(own(shape('claude.user.human')), text)
const cInterrupt = () => own(shape('claude.user.interrupt'))
const cInterruptTool = () => own(shape('claude.user.interrupt_tool'))
const cTurnDuration = () => own(shape('claude.system.turn_duration'))
const cText = (text: string, model = 'claude-opus-5-5') => {
  const record = withText(own(shape('claude.assistant.text')), text)
  dig(record, 'message')['model'] = model
  return record
}
const cToolUse = () => own(shape('claude.assistant.tool_use'))
const cToolResult = () => own(shape('claude.user.tool_result'))
const cApiError = (kind: 'rate_limit' | 'server_error') => {
  const record = own(shape(`claude.assistant.api_error.${kind}`))
  dig(record, 'message')['model'] = '<synthetic>' // 실측: 오류 레코드의 모델은 전부 <synthetic> (15/15)
  return record
}
function cAsk(id: string): Record<string, unknown> {
  const record = own(shape('claude.assistant.ask'))
  const block = dig(record, 'message', 'content', 0)
  block['id'] = id
  const question = dig(block, 'input', 'questions', 0)
  question['question'] = '어느 쪽으로 갈까요?'
  question['header'] = '방향'
  dig(question, 'options', 0)['label'] = '가'
  dig(question, 'options', 1)['label'] = '나'
  return record
}
function cAskResult(id: string, kind: 'answered' | 'error'): Record<string, unknown> {
  const record = own(shape(kind === 'answered' ? 'claude.user.ask_answered' : 'claude.user.tool_result_error'))
  dig(record, 'message', 'content', 0)['tool_use_id'] = id
  return record
}

const claude = (records: Record<string, unknown>[], partial = false) =>
  parseClaudeTail({ chunk: chunkOf(records), partial, sessionId: SESSION })

// --- codex 레코드 ----------------------------------------------------------------

const xTaskStarted = () => shape('codex.event.task_started')
const xUserMessage = (text: string) => {
  const record = shape('codex.event.user_message')
  dig(record, 'payload')['message'] = text
  return record
}
/** codex 0.158 의 사람 발화 모양 — `item_completed` 의 `UserMessage` (u5 실측). */
const xUserItem = (text: string) => {
  const record = shape('codex.event.item_completed_user_message')
  dig(record, 'payload', 'item', 'content', 0)['text'] = text
  return record
}
const xAborted = () => shape('codex.event.turn_aborted')
const xComplete = () => shape('codex.event.task_complete')
const xCompleteError = (info: string) => {
  const record = shape('codex.event.task_complete_error')
  dig(record, 'payload', 'error')['codex_error_info'] = info
  return record
}
const xTurnContext = (model: string) => {
  const record = shape('codex.turn_context')
  dig(record, 'payload')['model'] = model
  return record
}
const xThreadSettings = (model: string) => {
  const record = shape('codex.event.thread_settings_applied')
  dig(record, 'payload', 'thread_settings')['model'] = model
  return record
}
const xAssistant = () => shape('codex.response.assistant')
const xAsk = () => {
  const record = shape('codex.response.ask_call')
  dig(record, 'payload')['arguments'] = JSON.stringify({ questions: [{ title: '계속할까요?', options: ['예', '아니오'] }] })
  return record
}
const xCallOutput = () => shape('codex.response.call_output')

const codex = (records: Record<string, unknown>[], partial = false) => parseCodexTail({ chunk: chunkOf(records), partial })

// --- grok 레코드 -----------------------------------------------------------------

const gTurn = (stop: string) => shape(`grok.update.turn_completed.${stop}`)
const gUserChunk = () => shape('grok.update.user_message_chunk')
const gHook = () => shape('grok.update.hook_execution')
const gAsk = (id: string) => {
  const record = shape('grok.update.ask')
  const update = dig(record, 'params', 'update')
  update['toolCallId'] = id
  dig(update, 'rawInput', 'questions', 0)['question'] = '어느 파일?'
  dig(update, 'rawInput', 'questions', 0, 'options', 0)['label'] = 'a.ts'
  dig(update, 'rawInput', 'questions', 0, 'options', 1)['label'] = 'b.ts'
  return record
}
const gAskAnswered = (id: string) => {
  const record = shape('grok.update.ask_answered')
  dig(record, 'params', 'update')['toolCallId'] = id
  return record
}
const gChatUser = (text: string) => {
  const record = shape('grok.chat.user_query')
  const block = dig(record, 'content', 0)
  block['text'] = `<user_query>${text}</user_query>`
  return record
}
const gChatSynthetic = () => shape('grok.chat.user_synthetic')
const gChatAssistant = (model: string) => {
  const record = shape('grok.chat.assistant')
  record['model_id'] = model
  return record
}

const grokUpdates = (records: Record<string, unknown>[], partial = false) =>
  parseGrokUpdates({ chunk: chunkOf(records), partial })

// === T1·T2 턴 결과와 해소 ==========================================================

describe('T1·T2 claude 턴 결과 — 네 모양', () => {
  it('ⓐ 중단 표지만 있으면 interrupted — reason 은 표지 원문', () => {
    expect(claude([cHuman('일해'), cToolUse(), cToolResult(), cInterrupt()]).turnOutcome).toEqual({
      outcome: 'interrupted',
      reason: '[Request interrupted by user]',
    })
    // 도구 실행 중 중단 — 실측 순서: tool_result(is_error) → 표지 → turn_duration
    expect(claude([cHuman('일해'), cToolUse(), cToolResult(), cInterruptTool(), cTurnDuration()]).turnOutcome).toEqual({
      outcome: 'interrupted',
      reason: '[Request interrupted by user for tool use]',
    })
  })

  it('ⓑ 표지 뒤 새 사용자 발화가 오면 풀린다 (null — 새 턴이 도는 중)', () => {
    const digest = claude([cHuman('일해'), cInterrupt(), cHuman('다시')])
    expect(digest.turnOutcome).toBeNull()
    expect(digest.lastPrompt).toBe('다시')
  })

  it('ⓒ 표지 뒤 새 턴이 정상 종료하면 completed', () => {
    expect(claude([cHuman('일해'), cInterrupt(), cHuman('다시'), cText('됐다'), cTurnDuration()]).turnOutcome).toEqual({
      outcome: 'completed',
    })
  })

  it('ⓓ 꼬리 창 경계 — 잘린 첫 줄의 표지는 없는 것이고, 창 안의 표지는 읽는다', () => {
    const cut = line(cInterrupt()).slice(12) // 창 시작이 이 줄 중간에 걸렸다
    const after = chunkOf([cTurnDuration()])
    expect(parseClaudeTail({ chunk: `${cut}\n${after}`, partial: true, sessionId: SESSION }).turnOutcome).toBeNull()
    const cutHuman = line(cHuman('앞')).slice(12)
    const inside = chunkOf([cInterrupt()])
    expect(parseClaudeTail({ chunk: `${cutHuman}\n${inside}`, partial: true, sessionId: SESSION }).turnOutcome).toEqual({
      outcome: 'interrupted',
      reason: '[Request interrupted by user]',
    })
  })

  it('failed — API 오류 레코드의 error 원문, 새 발화로 풀린다', () => {
    expect(claude([cHuman('일해'), cApiError('rate_limit'), cTurnDuration()]).turnOutcome).toEqual({
      outcome: 'failed',
      error: 'rate_limit',
    })
    expect(claude([cHuman('일해'), cApiError('server_error')]).turnOutcome).toEqual({ outcome: 'failed', error: 'server_error' })
    expect(claude([cApiError('server_error'), cTurnDuration(), cHuman('다시')]).turnOutcome).toBeNull()
  })

  it('정상 종료 표지(turn_duration)가 없으면 completed 로 읽지 않는다 — null', () => {
    expect(claude([cHuman('일해'), cText('됐다')]).turnOutcome).toBeNull()
    expect(claude([cHuman('일해'), cText('됐다'), cTurnDuration()]).turnOutcome).toEqual({ outcome: 'completed' })
  })

  it('중단 뒤 로컬 명령(메타·명령 봉투·stdout)은 새 턴이 아니다 — 표지가 남는다', () => {
    const meta = own(shape('claude.user.meta'))
    const command = withText(own(shape('claude.user.command')), '<command-name>/model</command-name>')
    const stdout = withText(own(shape('claude.user.local_stdout')), '<local-command-stdout>ok</local-command-stdout>')
    expect(claude([cInterrupt(), meta, command, stdout]).turnOutcome?.outcome).toBe('interrupted')
  })

  it('task-notification 은 새 턴을 연다 — 표지가 풀린다', () => {
    const notice = withText(own(shape('claude.user.task_notification')), '<task-notification>done</task-notification>')
    expect(claude([cInterrupt(), notice]).turnOutcome).toBeNull()
  })
})

describe('T1·T2 codex 턴 결과 — 네 모양', () => {
  it('ⓐ turn_aborted → interrupted (reason 원문)', () => {
    expect(codex([xTaskStarted(), xAssistant(), xAborted()]).turnOutcome).toEqual({ outcome: 'interrupted', reason: 'interrupted' })
  })
  it('ⓑ 뒤에 task_started 가 오면 풀린다', () => {
    expect(codex([xAborted(), xTaskStarted(), xTurnContext('gpt-6')]).turnOutcome).toBeNull()
    expect(codex([xAborted(), xUserMessage('다시')]).turnOutcome).toBeNull()
    expect(codex([xAborted(), xUserItem('다시')]).turnOutcome).toBeNull()
  })
  it('ⓒ 새 턴이 정상 종료하면 completed', () => {
    expect(codex([xAborted(), xTaskStarted(), xAssistant(), xComplete()]).turnOutcome).toEqual({ outcome: 'completed' })
  })
  it('ⓓ 꼬리 창 경계 — 잘린 첫 줄은 버린다', () => {
    const cut = line(xAborted()).slice(10)
    expect(parseCodexTail({ chunk: `${cut}\n${chunkOf([xAssistant()])}`, partial: true }).turnOutcome).toBeNull()
    expect(parseCodexTail({ chunk: `${cut}\n${chunkOf([xAborted()])}`, partial: true }).turnOutcome?.outcome).toBe('interrupted')
  })
  it('failed — task_complete.error.codex_error_info 원문', () => {
    expect(codex([xTaskStarted(), xCompleteError('usage_limit_exceeded')]).turnOutcome).toEqual({
      outcome: 'failed',
      error: 'usage_limit_exceeded',
    })
    expect(codex([xCompleteError('other'), xTaskStarted()]).turnOutcome).toBeNull()
  })
})

describe('T1·T2 grok 턴 결과 (updates.jsonl) — 네 모양', () => {
  it('ⓐ stop_reason cancelled → interrupted', () => {
    expect(grokUpdates([gUserChunk(), gHook(), gTurn('cancelled'), gHook()]).turnOutcome).toEqual({
      outcome: 'interrupted',
      reason: 'cancelled',
    })
  })
  it('ⓑ 뒤에 user_message_chunk 가 오면 풀린다', () => {
    expect(grokUpdates([gTurn('cancelled'), gHook(), gUserChunk()]).turnOutcome).toBeNull()
  })
  it('ⓒ 새 턴이 end_turn 으로 끝나면 completed', () => {
    expect(grokUpdates([gTurn('cancelled'), gUserChunk(), gTurn('end_turn')]).turnOutcome).toEqual({ outcome: 'completed' })
  })
  it('ⓓ 꼬리 창 경계 — 잘린 첫 줄은 버린다', () => {
    const cut = line(gTurn('cancelled')).slice(10)
    expect(parseGrokUpdates({ chunk: `${cut}\n${chunkOf([gHook()])}`, partial: true }).turnOutcome).toBeNull()
  })
  it('failed — error·rate_limit 원문', () => {
    expect(grokUpdates([gUserChunk(), gTurn('error')]).turnOutcome).toEqual({ outcome: 'failed', error: 'error' })
    expect(grokUpdates([gUserChunk(), gTurn('rate_limit')]).turnOutcome).toEqual({ outcome: 'failed', error: 'rate_limit' })
  })
  it('안 본 stop_reason 은 결과로 옮기지 않는다 (지어내지 않는다)', () => {
    const odd = gTurn('end_turn')
    dig(odd, 'params', 'update')['stop_reason'] = 'max_tokens'
    expect(grokUpdates([gUserChunk(), odd]).turnOutcome).toBeNull()
  })
  it('chat_history 판독은 턴 결과를 싣지 않는다 — 형제 파일 몫', () => {
    expect(parseGrokTail({ chunk: chunkOf([gChatUser('해'), gChatAssistant('grok-4.7')]), partial: false }).turnOutcome).toBeNull()
  })
})

// === T3 모델 =======================================================================

describe('T3 모델', () => {
  it('claude — 마지막 assistant message.model, <synthetic>·API 오류 레코드는 건너뛴다', () => {
    expect(claude([cText('a', 'claude-fable-5-1'), cText('b', 'claude-opus-5-5')]).model).toBe('claude-opus-5-5')
    expect(claude([cText('a', 'claude-opus-5-5'), cApiError('rate_limit')]).model).toBe('claude-opus-5-5')
    expect(claude([cText('a', 'claude-opus-5-5'), cText('합성', '<synthetic>')]).model).toBe('claude-opus-5-5')
    expect(claude([cApiError('server_error')]).model).toBeNull()
  })
  it('codex — turn_context·thread_settings_applied 중 더 뒤의 것', () => {
    expect(codex([xThreadSettings('gpt-5'), xTurnContext('gpt-6-astra'), xAssistant()]).model).toBe('gpt-6-astra')
    expect(codex([xTurnContext('gpt-5'), xThreadSettings('gpt-6-astra')]).model).toBe('gpt-6-astra')
    expect(codex([xAssistant()]).model).toBeNull()
  })
  it('grok — chat_history assistant model_id', () => {
    expect(parseGrokTail({ chunk: chunkOf([gChatAssistant('grok-4.6'), gChatAssistant('grok-4.7-build')]), partial: false }).model).toBe(
      'grok-4.7-build',
    )
  })
})

// === T4 최근 사용자 발화 ===========================================================

describe('T4 최근 사용자 발화 — 머리와 같은 규칙', () => {
  it('claude — 중단 표지·통지·압축 요약·메타·명령 봉투·도구 결과는 사람 발화가 아니다', () => {
    const notice = withText(own(shape('claude.user.task_notification')), '<task-notification>x</task-notification>')
    const compact = withText(own(shape('claude.user.compact_summary')), '이전 대화 요약')
    const meta = withText(own(shape('claude.user.meta')), '메타')
    const command = withText(own(shape('claude.user.command')), '<command-message>x</command-message>')
    const digest = claude([cHuman('진짜\n마지막'), cInterrupt(), notice, compact, meta, command, cToolResult()])
    expect(digest.lastPrompt).toBe('진짜 마지막')
  })
  it('claude — 한 발화뿐인 세션이면 첫 발화와 **같은 레코드**에서 나온다(모순 없음)', () => {
    const raw = '로그인 버그 고쳐줘. 급해'
    const chunk = chunkOf([cHuman(raw), cText('네')])
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe(cleanFirstPrompt(raw))
    expect(parseClaudeTail({ chunk, partial: false, sessionId: SESSION }).lastPrompt).toBe(cleanPromptLine(raw))
  })
  it('claude — 머리 판독도 압축 요약·통지를 첫 발화로 쓰지 않는다(같은 함수)', () => {
    const compact = withText(own(shape('claude.user.compact_summary')), '요약입니다')
    expect(parseClaudeHead({ chunk: chunkOf([compact, cHuman('진짜 첫 말')]), sessionId: SESSION })).toBe('진짜 첫 말')
  })
  it('claude — 다른 세션의 발화는 쓰지 않는다 (C2)', () => {
    const foreign = cHuman('남의 말')
    foreign['sessionId'] = 'other'
    expect(claude([cHuman('내 말'), foreign]).lastPrompt).toBe('내 말')
  })
  it('길이 — 앞 2,000자만 한 줄로 접는다', () => {
    expect(claude([cHuman('가'.repeat(5000))]).lastPrompt?.length).toBe(2000)
  })
  it('codex — user_message 만 (머리와 같은 레코드)', () => {
    const chunk = chunkOf([xUserMessage('첫 말'), xAssistant(), xUserMessage('둘째 말')])
    expect(parseCodexTail({ chunk, partial: false }).lastPrompt).toBe('둘째 말')
    expect(parseCodexHead({ chunk })).toBe('첫 말')
  })
  it('codex 0.158 — item_completed/UserMessage 도 사람 발화다(머리·꼬리 같은 함수)', () => {
    const injected = shape('codex.response.assistant')
    dig(injected, 'payload')['role'] = 'user' // 하네스 주입 자리(response_item/message/user) — 사람 발화 아님
    const chunk = chunkOf([xTaskStarted(), injected, xUserItem('첫 부탁'), xAssistant(), xAborted(), xTaskStarted(), xUserItem('다음 부탁')])
    expect(parseCodexTail({ chunk, partial: false }).lastPrompt).toBe('다음 부탁')
    expect(parseCodexHead({ chunk })).toBe('첫 부탁')
  })
  it('grok — <user_query> 봉투 안쪽만, 합성 user 줄은 아니다', () => {
    const chunk = chunkOf([gChatUser('첫 말'), gChatAssistant('grok-4.7'), gChatUser('둘째 말'), gChatSynthetic()])
    expect(parseGrokTail({ chunk, partial: false }).lastPrompt).toBe('둘째 말')
    expect(parseGrokHead({ chunk })).toBe('첫 말')
  })
})

// === T5 질문 선택지 ================================================================

describe('T5 대기 중인 질문 — 답 전/후', () => {
  const expected = [
    {
      question: '어느 쪽으로 갈까요?',
      header: '방향',
      options: [
        { label: '가', description: 'x' },
        { label: '나', description: 'x' },
      ],
      multiSelect: false,
    },
  ]
  it('claude — 답 전: tool_result 없는 AskUserQuestion 을 싣는다', () => {
    expect(claude([cHuman('정해'), cAsk('q1')]).pendingQuestions).toEqual(expected)
  })
  it('claude — 답 후(answers)·중단(is_error) 모두 싣지 않는다', () => {
    expect(claude([cHuman('정해'), cAsk('q1'), cAskResult('q1', 'answered')]).pendingQuestions).toBeNull()
    expect(claude([cHuman('정해'), cAsk('q1'), cAskResult('q1', 'error'), cInterruptTool()]).pendingQuestions).toBeNull()
  })
  it('claude — 가장 최근 질문만 본다(앞 질문이 답을 받았어도 새 질문은 대기)', () => {
    expect(claude([cAsk('q1'), cAskResult('q1', 'answered'), cAsk('q2')]).pendingQuestions).toEqual(expected)
  })
  describe('codex — 비동기 질문(호출 출력은 답이 아니다): 질문 호출 뒤에 무엇이 왔나', () => {
    const asked = [xTaskStarted(), xUserItem('부탁'), xAssistant(), xAsk(), xCallOutput(), xAssistant()]
    const expected = [
      {
        question: '계속할까요?',
        header: null,
        options: [
          { label: '예', description: null },
          { label: '아니오', description: null },
        ],
        multiSelect: null,
      },
    ]
    it('답 전 — 대기. 턴이 끝나도(task_complete) 답을 기다린다', () => {
      expect(codex(asked).pendingQuestions).toEqual(expected)
      expect(codex([...asked, xComplete()]).pendingQuestions).toEqual(expected)
    })
    it('같은 턴 안의 답 — 0.158 UserMessage·옛 user_message 둘 다 해소, 최근 발화는 답', () => {
      const answered = codex([...asked, xUserItem('예')])
      expect(answered.pendingQuestions).toBeNull()
      expect(answered.lastPrompt).toBe('예')
      expect(answered.turnOutcome).toBeNull()
      expect(codex([...asked, xUserMessage('예')]).pendingQuestions).toBeNull()
      expect(codex([...asked, xUserItem('예'), xAssistant(), xComplete()]).pendingQuestions).toBeNull()
    })
    it('중단 뒤 — 해소, 턴 결과는 interrupted', () => {
      const aborted = codex([...asked, xAborted()])
      expect(aborted.pendingQuestions).toBeNull()
      expect(aborted.turnOutcome).toEqual({ outcome: 'interrupted', reason: 'interrupted' })
    })
    it('새 턴 — 해소', () => {
      expect(codex([...asked, xComplete(), xTaskStarted()]).pendingQuestions).toBeNull()
      expect(codex([...asked, xComplete(), xTaskStarted(), xUserItem('예')]).pendingQuestions).toBeNull()
    })
    it('해소된 뒤 새 질문 — 새 질문만 대기', () => {
      expect(codex([...asked, xUserItem('예'), xAsk()]).pendingQuestions).toEqual(expected)
    })
  })
  it('grok — 답 전: status 없는 ask_user_question, 답 후: 같은 id 의 tool_call_update status', () => {
    expect(grokUpdates([gUserChunk(), gAsk('t1'), gHook()]).pendingQuestions).toEqual([
      {
        question: '어느 파일?',
        header: null,
        options: [
          { label: 'a.ts', description: 'x' },
          { label: 'b.ts', description: 'x' },
        ],
        multiSelect: null,
      },
    ])
    expect(grokUpdates([gUserChunk(), gAsk('t1'), gAskAnswered('t1'), gTurn('end_turn')]).pendingQuestions).toBeNull()
    expect(grokUpdates([gAsk('t1'), gUserChunk()]).pendingQuestions).toBeNull()
  })
})

// === T6 형식 비계약 ================================================================

describe('T6 망가뜨린 입력 — 던지지 않고 칸이 null', () => {
  it('잘린 줄·JSON 아닌 줄·배열 줄', () => {
    const chunk = ['{"type":"user","mess', 'not json', '[1,2]', '42', ''].join('\n')
    for (const parse of [
      () => parseClaudeTail({ chunk, partial: false, sessionId: SESSION }),
      () => parseCodexTail({ chunk, partial: false }),
      () => parseGrokTail({ chunk, partial: false }),
    ]) {
      const digest = parse()
      expect(digest.turnOutcome).toBeNull()
      expect(digest.model).toBeNull()
      expect(digest.lastPrompt).toBeNull()
      expect(digest.pendingQuestions).toBeNull()
    }
    expect(parseGrokUpdates({ chunk, partial: false })).toEqual({ turnOutcome: null, pendingQuestions: null })
  })
  it('필드 누락·타입 어긋남', () => {
    const noError = cApiError('rate_limit')
    delete noError['error']
    expect(claude([noError]).turnOutcome).toEqual({ outcome: 'failed', error: null })
    const numericModel = cText('a')
    dig(numericModel, 'message')['model'] = 42
    expect(claude([numericModel]).model).toBeNull()
    const badQuestions = cAsk('q1')
    dig(badQuestions, 'message', 'content', 0)['input'] = { questions: 'not an array' }
    expect(claude([badQuestions]).pendingQuestions).toBeNull()
    const badOptions = cAsk('q1')
    dig(badOptions, 'message', 'content', 0, 'input', 'questions', 0)['options'] = [7, null, { label: 3 }]
    expect(claude([badOptions]).pendingQuestions?.[0]?.options).toEqual([])
    const badArgs = xAsk()
    dig(badArgs, 'payload')['arguments'] = '{"questions": [잘림'
    expect(codex([xTaskStarted(), badArgs]).pendingQuestions).toBeNull()
    const badInfo = xCompleteError('x')
    dig(badInfo, 'payload', 'error')['codex_error_info'] = { nested: true }
    expect(codex([badInfo]).turnOutcome).toEqual({ outcome: 'failed', error: null })
    const badStop = gTurn('error')
    dig(badStop, 'params', 'update')['stop_reason'] = 5
    expect(grokUpdates([badStop]).turnOutcome).toBeNull()
  })
})

// === T8 emit 판정 ==================================================================

describe('T8 digestsEqual — 필드 하나만 바뀌어도 다르다', () => {
  const base: SessionDigest = {
    activity: { state: 'text', text: '말', at: 1 },
    providerTitle: '제목',
    firstPrompt: '첫 말',
    tool: { name: 'Bash', input: 'ls' },
    lastActivityAt: 1,
    turnOutcome: { outcome: 'completed' },
    model: 'claude-opus-5-5',
    lastPrompt: '최근 말',
    pendingQuestions: [{ question: 'q', header: null, options: [{ label: 'a', description: null }], multiSelect: null }],
  }
  const variants: { field: keyof SessionDigest; digest: SessionDigest }[] = [
    { field: 'activity', digest: { ...base, activity: { state: 'text', text: '다른 말', at: 1 } } },
    { field: 'providerTitle', digest: { ...base, providerTitle: '다른 제목' } },
    { field: 'firstPrompt', digest: { ...base, firstPrompt: '다른 첫 말' } },
    { field: 'tool', digest: { ...base, tool: { name: 'Bash', input: 'pwd' } } },
    { field: 'lastActivityAt', digest: { ...base, lastActivityAt: 2 } },
    { field: 'turnOutcome', digest: { ...base, turnOutcome: { outcome: 'interrupted', reason: 'interrupted' } } },
    { field: 'model', digest: { ...base, model: 'claude-fable-5-1' } },
    { field: 'lastPrompt', digest: { ...base, lastPrompt: '다른 최근 말' } },
    { field: 'pendingQuestions', digest: { ...base, pendingQuestions: null } },
  ]
  it('모든 필드가 표에 있다', () => {
    expect(variants.map((variant) => variant.field).sort()).toEqual(Object.keys(EMPTY_SESSION_DIGEST).sort())
  })
  it.each(variants)('$field 만 바뀌면 emit', ({ digest }) => {
    expect(digestsEqual({ a: base, b: digest })).toBe(false)
  })
  it('같으면 emit 하지 않는다', () => {
    expect(digestsEqual({ a: base, b: { ...base } })).toBe(true)
  })
})
