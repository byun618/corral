// 기록 → 말풍선 변환 (LIFE-581 Y1ⓑⓒ) — provider 마다 합성 기록(`mobile/chat-fixture.ts`)으로 종류별 대응과 지문과의 동등성을 본다.
import { describe, expect, it } from 'vitest'
import { ChatBuilder, type ChatItem, lineAtoms } from './chat-parse.js'
import {
  CLAUDE_SESSION,
  SECRET_RESULT,
  SECRET_THOUGHT,
  claudeLines,
  codexNewLines,
  codexOldLines,
  grokChatHistoryLines,
  grokUpdateLines,
} from './mobile/chat-fixture.js'
import { cleanPromptLine, parseClaudeTail, parseCodexTail, parseGrokTail } from './transcript-parse.js'
import type { TranscriptAgent } from '../shared/types.js'

function build(input: { agent: TranscriptAgent; lines: string[]; sessionId?: string | null }): { builder: ChatBuilder; items: ChatItem[] } {
  const builder = new ChatBuilder({ agent: input.agent, sessionId: input.sessionId ?? null })
  let offset = 0
  for (const line of input.lines) {
    builder.feed({ offset, line })
    offset += Buffer.byteLength(line) + 1
  }
  return { builder, items: builder.items }
}

/** 말풍선을 비교하기 쉬운 모양으로 — id·시각은 뺀다. */
function shape(items: readonly ChatItem[]): unknown[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'prompt':
      case 'reply':
        return [item.kind, item.text]
      case 'tools':
        return ['tools', item.tools.map((tool) => `${tool.name}|${tool.target}|${tool.status}`)]
      case 'question':
        return ['question', item.questions.map((question) => question.question), item.state, item.answer]
      case 'note':
        return ['note', item.note, item.text]
    }
  })
}

const lastPrompt = (items: readonly ChatItem[]): string | null => {
  const prompt = [...items].reverse().find((item) => item.kind === 'prompt')
  return prompt === undefined || prompt.kind !== 'prompt' ? null : cleanPromptLine(prompt.text)
}

describe('Claude (Y1ⓑ)', () => {
  const { builder, items } = build({ agent: 'claude', lines: claudeLines(), sessionId: CLAUDE_SESSION })

  it('종류별 대응 — 사람 발화만 지시 · 생각 제외 · 같은 message.id 합치기 · 도구 묶음/실패 · 질문 답함 · 중단·압축·실패 카드 · rewind 가지 제거', () => {
    expect(shape(items)).toEqual([
      ['prompt', '첫 지시 — /Users/fxuser/repos/demo/src/a.ts 를 고쳐 줘'],
      ['reply', '먼저 파일을 봅니다.\n\n두 번째 덩어리.'],
      ['tools', ['Read|/Users/fxuser/repos/demo/src/a.ts|ok', 'Bash|ls /Users/fxuser/secret|error']],
      ['reply', '읽었습니다. 다음은 질문입니다.'],
      ['question', ['어느 쪽?'], 'answered', 'B'],
      ['prompt', '두 번째 지시'],
      ['tools', ['Edit|/Users/fxuser/repos/demo/src/b.ts|running']],
      ['note', 'interrupted', null],
      ['note', 'compacted', null],
      ['prompt', '압축 뒤 지시'],
      ['note', 'failed', 'API Error: overloaded'],
      ['prompt', '되감은 뒤 지시'],
      ['reply', '마지막 답'],
    ])
    expect(builder.rewinds).toBe(1)
  })

  it('명령 봉투·meta·작업 통지·압축 요약은 건너뛴 줄로만 센다 — 생각·결과 본문은 말풍선에 없다', () => {
    expect(builder.stats.skipped['claude:user-not-human']).toBe(2)
    expect(builder.stats.skipped['claude:meta']).toBe(1)
    expect(builder.stats.skipped['claude:compact-summary']).toBe(1)
    expect(builder.stats.skipped['claude:thinking']).toBe(1)
    expect(Object.keys(builder.stats.unknown)).toEqual([])
    const text = JSON.stringify(items)
    expect(text).not.toContain(SECRET_THOUGHT)
    expect(text).not.toContain(SECRET_RESULT)
    expect(text).not.toContain('compact summary body')
  })

  it('질문이 아직 답을 못 받았으면 pending · 중단(is_error)이면 closed', () => {
    const lines = claudeLines()
    const askAt = lines.findIndex((line) => line.includes('"AskUserQuestion"'))
    const pending = build({ agent: 'claude', lines: lines.slice(0, askAt + 1), sessionId: CLAUDE_SESSION }).items
    expect(pending.at(-1)).toMatchObject({ kind: 'question', state: 'pending', answer: null })
    const errored = lines.slice(0, askAt + 1).concat(JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, uuid: 'rx', parentUuid: 'a7', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'rejected' }] } }))
    expect(build({ agent: 'claude', lines: errored, sessionId: CLAUDE_SESSION }).items.at(-1)).toMatchObject({ kind: 'question', state: 'closed' })
  })

  it('다른 세션 id 의 사람 발화는 지시가 아니다(지문과 같은 소유 규칙)', () => {
    const { items: other } = build({ agent: 'claude', lines: claudeLines(), sessionId: 'someone-else' })
    expect(other.filter((item) => item.kind === 'prompt')).toEqual([])
  })
})

describe('Claude 실물 표본에서 본 줄 (raw/claude/y2-census.json)', () => {
  it('서버 도구(advisor) 호출·결과는 도구 묶음 한 칸 — 결과 본문(암호문)은 싣지 않는다 · 비용·브리지·아티팩트 장부 줄은 건너뛴다', () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: CLAUDE_SESSION, timestamp: '2026-10-10T00:00:00Z', message: { role: 'user', content: '지시' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-10-10T00:00:01Z',
        message: { id: 'm1', role: 'assistant', model: 'claude-x', content: [{ type: 'server_tool_use', id: 'st1', name: 'advisor', input: {} }, { type: 'advisor_tool_result', tool_use_id: 'st1', content: { type: 'advisor_redacted_result', encrypted_content: SECRET_RESULT } }] },
      }),
      ...['cost-state', 'bridge-session', 'frame-link', 'artifact-comment-monitor', 'artifact-autoreact-ledger'].map((type) => JSON.stringify({ type, sessionId: CLAUDE_SESSION })),
    ]
    const { builder, items } = build({ agent: 'claude', lines, sessionId: CLAUDE_SESSION })
    expect(shape(items)).toEqual([
      ['prompt', '지시'],
      ['tools', ['advisor|null|ok']],
    ])
    expect(builder.stats.unknown).toEqual({})
    expect(JSON.stringify(items)).not.toContain(SECRET_RESULT)
  })
})

describe('Codex (Y1ⓑ)', () => {
  it('0.159 모양 — item_completed UserMessage 가 지시, response_item user(주입) 제외 · 답은 response_item 한 번(AgentMessage 중복 제외) · exec 상자 대신 CommandExecution', () => {
    const { builder, items } = build({ agent: 'codex', lines: codexNewLines() })
    expect(shape(items)).toEqual([
      ['prompt', '새 지시'],
      ['tools', ['Shell|ls -la|ok', 'Shell|false|error', 'Edit|/Users/fxuser/repos/demo/src/y.ts|ok']],
      ['reply', '새 답'],
      ['question', ['진행할까?'], 'answered', '예'],
      ['prompt', '중단될 지시'],
      ['note', 'interrupted', null],
      ['note', 'compacted', null],
      ['prompt', '마지막 지시'],
      ['note', 'failed', 'usage_limit_exceeded'],
    ])
    expect(builder.stats.skipped['codex:item:AgentMessage']).toBe(1)
    expect(builder.stats.skipped['codex:exec-container']).toBe(1)
    expect(builder.stats.skipped['codex:message:user']).toBe(1)
    expect(Object.keys(builder.stats.unknown)).toEqual([])
    expect(JSON.stringify(items)).not.toContain(SECRET_THOUGHT)
    expect(JSON.stringify(items)).not.toContain(SECRET_RESULT)
  })

  it('0.153 이전 모양 — event_msg user_message 가 지시 · agent_message 중복 1회 · function_call 도구', () => {
    const { builder, items } = build({ agent: 'codex', lines: codexOldLines() })
    expect(shape(items)).toEqual([
      ['prompt', '옛 지시'],
      ['tools', ['exec_command|cat /Users/fxuser/repos/demo/README.md|ok', 'apply_patch|src/x.ts|ok']],
      ['reply', '옛 답'],
    ])
    expect(builder.stats.skipped['codex:agent_message']).toBe(1)
    expect(Object.keys(builder.stats.unknown)).toEqual([])
  })

  it('질문 뒤 사람 발화가 오면 답함(답 글 없음) · 새 턴이면 closed', () => {
    const lines = codexNewLines()
    const ask = lines.findIndex((line) => line.includes('request_user_input_async'))
    const human = JSON.stringify({ timestamp: '2026-10-10T03:00:09Z', type: 'event_msg', payload: { type: 'user_message', message: '직접 답' } })
    expect(build({ agent: 'codex', lines: [...lines.slice(0, ask + 1), human] }).items.find((item) => item.kind === 'question')).toMatchObject({ state: 'answered', answer: null })
    const started = JSON.stringify({ timestamp: '2026-10-10T03:00:09Z', type: 'event_msg', payload: { type: 'task_started' } })
    expect(build({ agent: 'codex', lines: [...lines.slice(0, ask + 1), started] }).items.find((item) => item.kind === 'question')).toMatchObject({ state: 'closed' })
  })
})

describe('Grok (Y1ⓑ)', () => {
  it('updates.jsonl — 숨김 표시 user chunk 제외 · 생각 제외 · 연속 chunk 합치기 · 도구 성공/실패 · 질문 답함 · 중단·압축·실패', () => {
    const { builder, items } = build({ agent: 'grok', lines: grokUpdateLines() })
    expect(shape(items)).toEqual([
      ['prompt', '그록 첫 지시'],
      ['reply', '나뉜 답 하나'],
      ['tools', ['read_file|/Users/fxuser/repos/demo/a.md|ok', 'run_terminal_command|make test|error']],
      ['question', ['그록 질문?'], 'answered', 'X'],
      ['prompt', '그록 둘째 지시'],
      ['note', 'interrupted', null],
      ['note', 'compacted', null],
      ['prompt', '그록 마지막 지시'],
      ['note', 'failed', 'error'],
    ])
    expect(builder.stats.skipped['grok:user-hidden']).toBe(1)
    expect(builder.stats.skipped['grok:agent_thought_chunk']).toBe(1)
    expect(Object.keys(builder.stats.unknown)).toEqual([])
    expect(JSON.stringify(items)).not.toContain(SECRET_THOUGHT)
    expect(JSON.stringify(items)).not.toContain(SECRET_RESULT)
  })

  it('도구 사이에 끼인 hook 줄은 묶음을 끊지 않는다 · 생각 chunk 는 답 합치기를 끊지 않는다', () => {
    const lines = grokUpdateLines()
    const thought = lines.find((line) => line.includes('agent_thought_chunk')) ?? ''
    const chunks = lines.filter((line) => line.includes('agent_message_chunk'))
    const { items } = build({ agent: 'grok', lines: [chunks[0] ?? '', thought, chunks[1] ?? ''] })
    expect(shape(items)).toEqual([['reply', '나뉜 답 ']])
  })
})

describe('사람 발화 동등 시험 (Y1ⓒ) — 같은 기록에서 대화의 마지막 「내 지시」 = 지문 lastPrompt', () => {
  it('Claude — 본 파일 하나', () => {
    const lines = claudeLines()
    const digest = parseClaudeTail({ chunk: lines.join('\n'), partial: false, sessionId: CLAUDE_SESSION })
    expect(lastPrompt(build({ agent: 'claude', lines, sessionId: CLAUDE_SESSION }).items)).toBe(digest.lastPrompt)
    expect(digest.lastPrompt).toBe('되감은 뒤 지시')
  })

  it('Codex — 0.159 · 0.153 이전 두 모양', () => {
    for (const lines of [codexNewLines(), codexOldLines()]) {
      const digest = parseCodexTail({ chunk: lines.join('\n'), partial: false })
      expect(digest.lastPrompt).not.toBeNull()
      expect(lastPrompt(build({ agent: 'codex', lines }).items)).toBe(digest.lastPrompt)
    }
  })

  it('Grok — 같은 세션의 두 파일(updates · chat_history), chat_history 가 압축으로 앞 발화를 잃은 경우 포함', () => {
    const digest = parseGrokTail({ chunk: grokChatHistoryLines().join('\n'), partial: false })
    const items = build({ agent: 'grok', lines: grokUpdateLines() }).items
    expect(digest.lastPrompt).toBe('그록 마지막 지시')
    expect(lastPrompt(items)).toBe(digest.lastPrompt)
    // 대화는 압축 전 발화도 보인다(chat_history 에는 없는 것) — 목록 접미사가 같다.
    expect(items.filter((item) => item.kind === 'prompt')).toHaveLength(3)
  })

  it('턴마다 잘라도 같다 — 기록의 모든 사람 발화 지점에서 마지막 지시 = 지문', () => {
    const cases: { agent: TranscriptAgent; lines: string[]; digest: (chunk: string) => string | null }[] = [
      { agent: 'claude', lines: claudeLines(), digest: (chunk) => parseClaudeTail({ chunk, partial: false, sessionId: CLAUDE_SESSION }).lastPrompt },
      { agent: 'codex', lines: codexNewLines(), digest: (chunk) => parseCodexTail({ chunk, partial: false }).lastPrompt },
    ]
    for (const { agent, lines, digest } of cases) {
      for (let end = 1; end <= lines.length; end += 1) {
        const prefix = lines.slice(0, end)
        // rewind 가 일어난 직후는 지문이 버려진 가지의 발화를 볼 수 있다 — 같은 부모를 둔 되감기 발화가 들어온 뒤부터는 같아야 한다.
        if (agent === 'claude' && prefix.some((line) => line.includes('버려질 지시')) && !prefix.some((line) => line.includes('되감은 뒤 지시'))) continue
        expect([agent, end, lastPrompt(build({ agent, lines: prefix, sessionId: CLAUDE_SESSION }).items)]).toEqual([agent, end, digest(prefix.join('\n'))])
      }
    }
  })
})

describe('알 수 없는 줄 (X2ⓙ)', () => {
  it('깨진 줄·모르는 type 은 말풍선이 되지 않고 개수만 센다', () => {
    const { builder, items } = build({ agent: 'claude', lines: ['not json {', JSON.stringify({ type: 'brand-new', text: 'LEAK' })], sessionId: CLAUDE_SESSION })
    expect(items).toEqual([])
    expect(builder.stats.unknown).toEqual({ 'not-json': 1, 'claude:brand-new': 1 })
    expect(lineAtoms({ agent: 'grok', line: JSON.stringify({ params: { update: { sessionUpdate: 'new_kind', text: 'LEAK' } } }), sessionId: null }).atoms).toEqual([{ kind: 'unknown', shape: 'grok:new_kind' }])
  })
})
