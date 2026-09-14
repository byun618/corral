// 트랜스크립트 판독 단위 테스트 (LIFE-366 A5·A8·A9·C2).
//
// **fixture 는 전부 여기서 손으로 쓴 것이다** — 사용자 대화 내용을 레포에 넣지 않는다
// (킥오프 원자료 규칙). 모양은 실측에서 가져왔다 (`raw/claude/a10-foreign-shapes.json`,
// `raw/analysis/transcript-shape.json`).
//
// A8("포맷이 깨져도 화면이 거짓말하지 않는다")이 여기 사는 이유: 고의로 망가뜨린 입력을
// 실제 herdr·실제 파일 없이 때릴 수 있는 자리라서다. 화면 쪽 확인은 하네스가 따로 한다.

import { describe, expect, it } from 'vitest'
import {
  cleanActivityText,
  parseClaudeTail,
  parseCodexTail,
  parseGrokTail,
  textFromContent,
} from './transcript-parse.js'

const SESSION = '11111111-2222-3333-4444-555555555555'

function claudeAssistant(text: string | null, at: string): string {
  const content = text === null ? [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] : [{ type: 'text', text }]
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    timestamp: at,
    message: { role: 'assistant', type: 'message', content },
  })
}

function claudeTitle(title: string, sessionId = SESSION): string {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId })
}

describe('parseClaudeTail', () => {
  it('마지막 어시스턴트 텍스트와 시각을 집는다', () => {
    const chunk = [
      claudeAssistant('첫 턴', '2026-09-14T10:00:00.000Z'),
      claudeAssistant('마지막 턴', '2026-09-14T11:00:00.000Z'),
      '',
    ].join('\n')
    const digest = parseClaudeTail({ chunk, partial: false, sessionId: SESSION })
    expect(digest.activity).toEqual({ state: 'text', text: '마지막 턴', at: Date.parse('2026-09-14T11:00:00.000Z') })
    expect(digest.lastActivityAt).toBe(Date.parse('2026-09-14T11:00:00.000Z'))
  })

  it('마지막 턴이 tool_use 뿐이면 **한 턴 더 거슬러 올라간다**', () => {
    // 실측 20개 중 3개가 이 모양이었다 (raw/analysis/transcript-shape.json).
    const chunk = [
      claudeAssistant('보여 줄 마지막 말', '2026-09-14T10:00:00.000Z'),
      claudeAssistant(null, '2026-09-14T11:00:00.000Z'),
      '',
    ].join('\n')
    const digest = parseClaudeTail({ chunk, partial: false, sessionId: SESSION })
    expect(digest.activity).toEqual({
      state: 'text',
      text: '보여 줄 마지막 말',
      at: Date.parse('2026-09-14T10:00:00.000Z'),
    })
    // 활동 **시각**은 최신 턴 것이다 — 말은 낡아도 "언제 움직였나" 는 안 낡는다.
    expect(digest.lastActivityAt).toBe(Date.parse('2026-09-14T11:00:00.000Z'))
  })

  it('provider 제목은 **그 세션의 것일 때만** 쓴다 (C2)', () => {
    const mine = parseClaudeTail({
      chunk: [claudeTitle('내 제목'), claudeAssistant('말', '2026-09-14T10:00:00.000Z')].join('\n'),
      partial: false,
      sessionId: SESSION,
    })
    expect(mine.providerTitle).toBe('내 제목')

    const foreign = parseClaudeTail({
      chunk: [claudeTitle('남의 제목', 'other-session'), claudeAssistant('말', '2026-09-14T10:00:00.000Z')].join('\n'),
      partial: false,
      sessionId: SESSION,
    })
    expect(foreign.providerTitle).toBeNull()
  })

  it('partial 이면 첫 줄(잘린 줄)을 버린다', () => {
    const chunk = ['ent":"assistant"}}쓰레기', claudeAssistant('온전한 말', '2026-09-14T10:00:00.000Z')].join('\n')
    expect(parseClaudeTail({ chunk, partial: true, sessionId: SESSION }).activity).toEqual({
      state: 'text',
      text: '온전한 말',
      at: Date.parse('2026-09-14T10:00:00.000Z'),
    })
  })

  // --- A8 고의 손상 3종 — **지어내지 않고 모른다고 한다** -------------------------
  it('빈 파일 → unknown-format', () => {
    expect(parseClaudeTail({ chunk: '', partial: false, sessionId: SESSION }).activity).toEqual({
      state: 'unknown-format',
    })
  })

  it('알 수 없는 type 만 있으면 → unknown-format', () => {
    const chunk = [
      JSON.stringify({ type: 'quantum-flux', payload: { text: '지어내면 안 되는 값' } }),
      JSON.stringify({ type: 'assistant-v2', body: '이것도' }),
    ].join('\n')
    const digest = parseClaudeTail({ chunk, partial: false, sessionId: SESSION })
    expect(digest.activity).toEqual({ state: 'unknown-format' })
    expect(digest.providerTitle).toBeNull()
  })

  it('마지막 줄이 잘려 있어도 그 앞 줄에서 읽어 낸다', () => {
    const chunk = [claudeAssistant('앞 줄', '2026-09-14T10:00:00.000Z'), '{"type":"assist'].join('\n')
    expect(parseClaudeTail({ chunk, partial: false, sessionId: SESSION }).activity).toMatchObject({
      state: 'text',
      text: '앞 줄',
    })
  })

  it('content 가 통째로 낯선 모양이면 건너뛴다 (예외를 던지지 않는다)', () => {
    const chunk = [
      JSON.stringify({ type: 'assistant', sessionId: SESSION, message: { role: 'assistant', content: 42 } }),
      JSON.stringify({ type: 'assistant', sessionId: SESSION, message: 'not-a-record' }),
    ].join('\n')
    expect(parseClaudeTail({ chunk, partial: false, sessionId: SESSION }).activity).toEqual({
      state: 'unknown-format',
    })
  })
})

describe('parseCodexTail', () => {
  it('response_item/message/assistant 의 output_text 를 집는다', () => {
    const chunk = [
      JSON.stringify({
        timestamp: '2026-09-14T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '코덱스 말' }] },
      }),
      JSON.stringify({
        timestamp: '2026-09-14T10:01:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell' },
      }),
    ].join('\n')
    const digest = parseCodexTail({ chunk, partial: false })
    expect(digest.activity).toMatchObject({ state: 'text', text: '코덱스 말' })
    expect(digest.lastActivityAt).toBe(Date.parse('2026-09-14T10:01:00.000Z'))
    expect(digest.providerTitle).toBeNull() // codex 에는 제목 레코드가 없다 (실측)
  })
})

describe('parseGrokTail', () => {
  it('문자열 content 를 그대로 집는다', () => {
    const chunk = [
      JSON.stringify({ type: 'assistant', content: '그록 말' }),
      JSON.stringify({ type: 'tool_result', content: '도구 결과' }),
    ].join('\n')
    expect(parseGrokTail({ chunk, partial: false }).activity).toMatchObject({ state: 'text', text: '그록 말' })
  })

  it('시각 필드가 없으면 lastActivityAt 은 null 이다 (파일 mtime 으로 떨어진다)', () => {
    const chunk = JSON.stringify({ type: 'assistant', content: '말' })
    expect(parseGrokTail({ chunk, partial: false }).lastActivityAt).toBeNull()
  })
})

describe('cleanActivityText', () => {
  it('여러 줄을 한 줄로 접는다 — 실측에서 유일하게 나온 오염이 이것이다 (15/28)', () => {
    expect(cleanActivityText('첫 줄\n\n## 헤더\n* 항목')).toBe('첫 줄 ## 헤더 * 항목')
  })

  it('공백뿐이면 null — 빈 문자열을 2차 줄에 싣지 않는다', () => {
    expect(cleanActivityText('   \n  ')).toBeNull()
  })

  it('길어도 자르지 않는다 — 툴팁이 전문을 받아야 한다 (B5)', () => {
    // 실측: 마지막 어시스턴트 텍스트의 70.3% 가 400자를 넘는다 (raw/claude/b5-text-length.json).
    // 상한을 두면 열에 일곱은 툴팁까지 잘린다. 보이는 줄의 말줄임은 CSS 몫이다.
    const long = 'x'.repeat(3000)
    expect(cleanActivityText(long)).toBe(long)
  })
})

describe('textFromContent', () => {
  it('text 블록만 모은다 — tool_use 는 안 센다', () => {
    expect(textFromContent([{ type: 'tool_use', name: 'Read' }])).toBeNull()
    expect(textFromContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    )
  })
})
