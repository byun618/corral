// 기록 → 말풍선 변환 (LIFE-581 Y1ⓑⓒ) — provider 마다 합성 기록(`mobile/chat-fixture.ts`)으로 종류별 대응과 지문과의 동등성을 본다.
import { describe, expect, it } from 'vitest'
import { ChatBuilder, type ChatItem, lineAtoms } from './chat-parse.js'
import {
  CLAUDE_SESSION,
  SECRET_RESULT,
  codexExecOutput,
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

describe('R1-A9 옛 Codex 도구 출력의 성공/실패 — 머리의 종료 코드만 읽고, 못 읽으면 unknown', () => {
  const call = (id: string, name = 'exec_command') => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name, call_id: id, arguments: JSON.stringify({ cmd: `run ${id}` }) } })
  const output = (id: string, value: unknown) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: value } })
  it('종료 코드 0 → ok · 1 → error · 도는 중·종료 코드 없는 글·배열 → unknown(성공으로 단정하지 않는다) · apply_patch `Exit code: N`', () => {
    const lines = [
      call('ok'), output('ok', codexExecOutput({ exit: 0 })),
      call('fail'), output('fail', codexExecOutput({ exit: 1 })),
      call('bg'), output('bg', codexExecOutput({ exit: 'running' })),
      call('plan', 'update_plan'), output('plan', 'Plan updated'),
      call('img', 'view_image'), output('img', [{ type: 'input_image', image_url: 'data:x' }]),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Update File: a.ts' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch', output: `Exit code: 1\nWall time: 0 seconds\nOutput:\n${SECRET_RESULT}` } }),
    ]
    const { items } = build({ agent: 'codex', lines })
    expect(shape(items)).toEqual([['tools', ['exec_command|run ok|ok', 'exec_command|run fail|error', 'exec_command|run bg|unknown', 'update_plan|run plan|unknown', 'view_image|run img|unknown', 'apply_patch|a.ts|error']]])
    expect(JSON.stringify(items)).not.toContain(SECRET_RESULT)
  })

  it('리뷰 P6 — 같은 호출이 function_call 과 item_completed/CommandExecution 두 모양으로 오면 한 칸(실패 상태)', () => {
    const lines = [
      call('t1'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 't1', command: ['zsh', '-lc', 'false'], status: 'failed', exit_code: 1 } } }),
      output('t1', codexExecOutput({ exit: 1 })),
    ]
    const { items } = build({ agent: 'codex', lines })
    expect(shape(items)).toEqual([['tools', ['exec_command|false|error']]])
  })
})

describe('R3-A1 Codex `sleep` 한 호출이 function_call 과 item_completed/Extension 두 모양 — 한 칸', () => {
  // 실물 모양(리뷰어 codex-duplicate · 워커 사본 41파일 중 6쌍 `raw/claude/r3/a1-id-pairs.txt`): 같은 id 로 function_call(sleep) 과 Extension(clock.sleep).
  const sleep = (id: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'sleep', call_id: id, arguments: JSON.stringify({ duration_ms: 1 }) } })
  const extension = (id: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'clock.sleep', id, durationMs: 1 } } })
  const ack = (id: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'SYNTHETIC_ACK' } })
  const tools = (items: readonly ChatItem[]) => items.flatMap((item) => (item.kind === 'tools' ? item.tools : []))

  it('같은 id 두 모양 → 1칸 · 이름은 앞 칸 그대로 · 완료 상태 ok 가 남는다(뒤에 온 판정 못 한 출력이 덮지 않는다) — 순서 둘 다', () => {
    for (const lines of [[sleep('k1'), extension('k1'), ack('k1')], [sleep('k1'), ack('k1'), extension('k1')]]) {
      const got = tools(build({ agent: 'codex', lines }).items)
      expect(got.map((tool) => [tool.name, tool.status])).toEqual([['sleep', 'ok']])
    }
    // 서로 다른 id 두 호출(각각 두 모양)은 두 칸.
    expect(tools(build({ agent: 'codex', lines: [sleep('a'), extension('a'), sleep('b'), extension('b')] }).items)).toHaveLength(2)
  })

  it('양성 대조 — 짝 없는 단독 Extension 은 1칸 그대로 · 짝 없는 sleep 은 출력이 판정 못 함이면 unknown', () => {
    expect(tools(build({ agent: 'codex', lines: [extension('solo')] }).items).map((tool) => [tool.name, tool.status])).toEqual([['clock.sleep', 'ok']])
    expect(tools(build({ agent: 'codex', lines: [sleep('k2'), ack('k2')] }).items).map((tool) => [tool.name, tool.status])).toEqual([['sleep', 'unknown']])
  })
})

describe('C1 rewind 판정 — 격리 Claude 세션에서 본 줄 모양(raw/claude/r1/c1-shapes.txt) 그대로', () => {
  // 실측: 같은 부모를 둔 사람 발화 형제는 ⓐ rewind(Esc Esc → 되돌리기) ⓑ 답 전 Esc 중단(입력창으로 되돌아온 지시)에서만 생겼다 — 둘 다 Claude Code 화면에서 빠진 가지.
  // 작업 중 입력(대기열 → 턴 끝에 보냄 · 턴 중간 주입 attachment · 지금 보내기 = 중단 표식 뒤)은 셋 다 사슬이 이어진다.
  const user = (text: string, uuid: string, parent: string | null) => JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, uuid, parentUuid: parent, promptId: uuid, origin: { kind: 'human' }, message: { role: 'user', content: text } })
  const reply = (text: string, uuid: string, parent: string) => JSON.stringify({ type: 'assistant', sessionId: CLAUDE_SESSION, uuid, parentUuid: parent, message: { id: `m-${uuid}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } })
  const meta = (uuid: string, parent: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', isMeta: true, sessionId: CLAUDE_SESSION, uuid, parentUuid: parent })
  const attach = (uuid: string, parent: string, attachment: Record<string, unknown>) => JSON.stringify({ type: 'attachment', sessionId: CLAUDE_SESSION, uuid, parentUuid: parent, attachment })
  const prompts = (items: readonly ChatItem[]) => items.flatMap((item) => (item.kind === 'prompt' ? [item.text] : []))

  it('ⓐ rewind(A2 를 되돌리고 A3) · ⓑ 답 전 Esc 중단(F1 → F2) — 버려진 가지만 숨는다', () => {
    const lines = [
      user('A1', 'u1', null), reply('A1', 'a1', 'u1'), meta('d1', 'a1'),
      user('A2', 'u2', 'd1'), reply('A2', 'a2', 'u2'), meta('d2', 'a2'),
      user('A3', 'u3', 'd1'), reply('A3', 'a3', 'u3'), meta('d3', 'a3'),
      user('F1', 'f1', 'd3'), attach('f1x', 'f1', { type: 'prompt_snapshot' }),
      user('F2', 'f2', 'd3'), reply('F2', 'f2r', 'f2'),
    ]
    const { builder, items } = build({ agent: 'claude', lines, sessionId: CLAUDE_SESSION })
    expect(prompts(items)).toEqual(['A1', 'A3', 'F2'])
    expect(builder.rewinds).toBe(2)
  })

  it('작업 중 입력 세 모양은 rewind 가 아니다 — 대기열(B2) · 턴 중간 주입(D2, attachment) · 지금 보내기(E2, 중단 표식 뒤)', () => {
    const tool = (uuid: string, parent: string, id: string) => JSON.stringify({ type: 'assistant', sessionId: CLAUDE_SESSION, uuid, parentUuid: parent, message: { id: `m-${uuid}`, role: 'assistant', model: 'x', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }] } })
    const result = (uuid: string, parent: string, id: string) => JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, uuid, parentUuid: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } })
    const queue = (operation: string) => JSON.stringify({ type: 'queue-operation', operation, sessionId: CLAUDE_SESSION, content: 'queued' })
    const lines = [
      user('B1', 'b1', null), queue('enqueue'), queue('dequeue'), reply('B1', 'b1r', 'b1'), meta('bd', 'b1r'),
      user('B2', 'b2', 'bd'), reply('B2', 'b2r', 'b2'), meta('b2d', 'b2r'),
      user('D1', 'd1', 'b2d'), tool('d1t', 'd1', 'td'), queue('enqueue'), queue('remove'), result('d1o', 'd1t', 'td'),
      attach('d2q', 'd1o', { type: 'queued_command', prompt: 'D2', humanTurn: true }), reply('D1 D2', 'd1r', 'd2q'), meta('dd', 'd1r'),
      user('E1', 'e1', 'dd'), tool('e1t', 'e1', 'te'), queue('enqueue'), queue('dequeue'), result('e1o', 'e1t', 'te'),
      JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, uuid: 'e1i', parentUuid: 'e1o', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      user('E2', 'e2', 'e1i'), reply('E2', 'e2r', 'e2'),
    ]
    const { builder, items } = build({ agent: 'claude', lines, sessionId: CLAUDE_SESSION })
    expect(builder.rewinds).toBe(0)
    // D2 는 지문(claudeHumanText)도 사람 발화로 세지 않는다 — X2ⓐ 와 같은 판정(mapping.md 「턴 중간 주입」).
    expect(prompts(items)).toEqual(['B1', 'B2', 'D1', 'E1', 'E2'])
  })

  it('C3 첫 프롬프트까지 rewind — 부모 없는 사람 발화가 또 온다(raw/claude/r2/c3-shapes.txt) → 앞 뿌리 가지 전부를 숨긴다', () => {
    // 격리 실측 모양: R1(parent=null) → 답 → R2 → 답 → Esc Esc 로 R1 앞까지 되돌림 → R3(parent=null, 같은 파일에 이어 씀).
    const lines = [
      user('R1', 'r1', null), attach('r1x', 'r1', { type: 'environment' }), reply('R1', 'r1a', 'r1x'), meta('r1d', 'r1a'),
      user('R2', 'r2', 'r1d'), reply('R2', 'r2a', 'r2'), meta('r2d', 'r2a'),
      user('R3', 'r3', null), attach('r3x', 'r3', { type: 'environment' }), reply('R3', 'r3a', 'r3x'),
    ]
    const { builder, items } = build({ agent: 'claude', lines, sessionId: CLAUDE_SESSION })
    expect(prompts(items)).toEqual(['R3'])
    expect(items.map((item) => item.kind)).toEqual(['prompt', 'reply'])
    expect(builder.rewinds).toBe(1)
  })

  it('C3 양성 대조 — 뿌리가 하나뿐인 보통 대화와 SessionStart 훅 뒤 첫 지시(실물: 첫 사람 발화의 부모 = hook attachment)는 rewind 아님', () => {
    const plain = build({ agent: 'claude', lines: [user('P1', 'p1', null), reply('P1', 'p1a', 'p1'), meta('p1d', 'p1a'), user('P2', 'p2', 'p1d'), reply('P2', 'p2a', 'p2')], sessionId: CLAUDE_SESSION })
    expect([plain.builder.rewinds, prompts(plain.items)]).toEqual([0, ['P1', 'P2']])
    const hooked = build({ agent: 'claude', lines: [attach('h0', 'x', { type: 'hook_additional_context' }), user('H1', 'h1', 'h0'), reply('H1', 'h1a', 'h1'), meta('h1d', 'h1a'), user('H2', 'h2', 'h1d')], sessionId: CLAUDE_SESSION })
    expect([hooked.builder.rewinds, prompts(hooked.items)]).toEqual([0, ['H1', 'H2']])
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
