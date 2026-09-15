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
  cleanFirstPrompt,
  parseClaudeHead,
  parseClaudeTail,
  parseCodexHead,
  parseCodexTail,
  parseGrokHead,
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

// --- 수정 라운드 5 -------------------------------------------------------------
//
// C5(첫 사용자 발화) · B9(진행 중 도구). fixture 는 여기서도 **손으로 쓴 것**이고, 모양만
// 실측에서 가져왔다 (`raw/claude/c5-b9-shapes-r5.json` — 사용자 파일 363개의 타입·봉투 분포).

function claudeUser(input: { text: string; sessionId?: string; isMeta?: boolean }): string {
  return JSON.stringify({
    type: 'user',
    sessionId: input.sessionId ?? SESSION,
    ...(input.isMeta === true ? { isMeta: true } : {}),
    timestamp: '2026-09-15T01:00:00.000Z',
    message: { role: 'user', content: input.text },
  })
}

describe('parseClaudeHead — 첫 사용자 발화 (C5)', () => {
  it('첫 사람 발화를 집어 40자로 정제한다', () => {
    const chunk = [
      JSON.stringify({ type: 'attachment', sessionId: SESSION }),
      claudeUser({ text: '테스트가 깨진 것을 고쳐라. 그리고 결과를 알려라.' }),
      claudeAssistant('알겠다', '2026-09-15T01:01:00.000Z'),
    ].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('테스트가 깨진 것을 고쳐라')
  })

  it('meta 턴을 건너뛴다 (실측 34개 파일)', () => {
    const chunk = [
      claudeUser({ text: 'Caveat: The messages below were generated by the user', isMeta: true }),
      claudeUser({ text: '릴리스 노트를 써라' }),
    ].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('릴리스 노트를 써라')
  })

  it('슬래시 명령 봉투(`<command-message>`)를 건너뛴다 (실측 33개 파일)', () => {
    const chunk = [
      claudeUser({ text: '<command-message>init is running…</command-message><command-name>/init</command-name>' }),
      claudeUser({ text: '릴리스 노트를 써라' }),
    ].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('릴리스 노트를 써라')
  })

  it('`<local-command-stdout>` 도 건너뛴다 (실측 29개 파일)', () => {
    const chunk = [
      claudeUser({ text: '<local-command-stdout>ok</local-command-stdout>' }),
      claudeUser({ text: '릴리스 노트를 써라' }),
    ].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('릴리스 노트를 써라')
  })

  it('다른 세션의 레코드는 안 쓴다 (C2 소유자 확인)', () => {
    const chunk = claudeUser({ text: '남의 세션 발화', sessionId: 'aaaa-bbbb' })
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBeNull()
  })

  it('참조 id 를 모르면 아예 안 쓴다', () => {
    const chunk = claudeUser({ text: '무언가 해라' })
    expect(parseClaudeHead({ chunk, sessionId: null })).toBeNull()
  })

  it('머리 조각의 **마지막 줄이 잘려 있어도** 죽지 않는다 (꼬리의 거울)', () => {
    const chunk = [claudeUser({ text: '문서를 정리해라' }), '{"type":"user","sessi'].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('문서를 정리해라')
  })

  it('사람 발화가 없으면 null — 지어내지 않는다 (실측 363개 중 16개)', () => {
    const chunk = [
      JSON.stringify({ type: 'file-history-snapshot', sessionId: SESSION }),
      claudeUser({ text: '<command-name>/clear</command-name>' }),
    ].join('\n')
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBeNull()
  })

  it('블록 배열 content 도 받는다 (실측 4개 파일)', () => {
    const chunk = JSON.stringify({
      type: 'user',
      sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'text', text: '빌드를 고쳐라' }] },
    })
    expect(parseClaudeHead({ chunk, sessionId: SESSION })).toBe('빌드를 고쳐라')
  })
})

describe('cleanFirstPrompt — Orca `deriveGeneratedTabTitle` 과 같은 결', () => {
  it('첫 절만 쓴다', () => {
    expect(cleanFirstPrompt('Fix the broken tests. Then write a summary.')).toBe('Fix the broken tests')
  })

  it('머리말 필러를 턴다 (Orca `LEADING_FILLER_PATTERNS`)', () => {
    expect(cleanFirstPrompt('Can you please fix the login bug')).toBe('Fix the login bug')
    expect(cleanFirstPrompt("Let's refactor the parser")).toBe('Refactor the parser')
  })

  it('URL 을 **마크다운 기호보다 먼저** 지운다 — 조각이 새지 않는다', () => {
    expect(cleanFirstPrompt('Review _https://git.example.com/merge_requests/42_ now')).toBe('Review now')
  })

  it('`issue 42:` 꼴 머리표를 턴다', () => {
    expect(cleanFirstPrompt('Issue #42: crash on startup')).toBe('Crash on startup')
  })

  it('40자 단어 경계에서 자른다', () => {
    const title = cleanFirstPrompt('Refactor the transcript reader so that it stops reading the whole file')
    expect(title).toBe('Refactor the transcript reader so that')
    expect(title !== null && title.length <= 40).toBe(true)
  })

  it('띄어쓰기가 드문 한국어는 40자에서 그냥 자른다', () => {
    const long = '트랜스크립트판독층을고쳐서머리읽기를한번만하도록만들고캐시가파일을건너이어지게해라'
    expect(cleanFirstPrompt(long)).toBe(long.slice(0, 40))
  })

  it('여러 줄을 한 줄로 접는다', () => {
    expect(cleanFirstPrompt('첫 줄\n둘째 줄')).toBe('첫 줄')
  })

  it('쓸 글자가 없으면 null — 기호만 있는 발화는 제목이 아니다', () => {
    expect(cleanFirstPrompt('###')).toBeNull()
    expect(cleanFirstPrompt('   ')).toBeNull()
  })
})

describe('parseCodexHead · parseGrokHead (A10 — 실측해서 되는 것만)', () => {
  it('codex 는 `event_msg/user_message` 만 본다 — 하네스 주입은 그 위에 있다', () => {
    const chunk = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '테스트를 고쳐라' } }),
    ].join('\n')
    expect(parseCodexHead({ chunk })).toBe('테스트를 고쳐라')
  })

  it('grok 은 `<user_query>` 봉투 안쪽만 쓴다 — 봉투가 없으면 부재다', () => {
    const wrapped = JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\n빌드를 고쳐라\n</user_query>' }] })
    const harness = JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }] })
    expect(parseGrokHead({ chunk: [harness, wrapped].join('\n') })).toBe('빌드를 고쳐라')
    expect(parseGrokHead({ chunk: harness })).toBeNull()
  })
})

describe('진행 중 도구 (B9)', () => {
  function toolTurn(input: { name: string; input?: Record<string, unknown> }): string {
    return JSON.stringify({
      type: 'assistant',
      sessionId: SESSION,
      timestamp: '2026-09-15T02:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: input.name, input: input.input ?? {} }],
      },
    })
  }

  it('마지막 턴이 도구뿐이면 이름과 입력을 싣는다', () => {
    const chunk = [
      claudeAssistant('앞 턴의 말', '2026-09-15T01:00:00.000Z'),
      toolTurn({ name: 'Bash', input: { command: 'npm run typecheck', description: '타입 검사' } }),
    ].join('\n')
    const parsed = parseClaudeTail({ chunk, partial: false, sessionId: SESSION })
    expect(parsed.tool).toEqual({ name: 'Bash', input: 'npm run typecheck' })
    // 2차 줄의 텍스트 갈래는 그대로 살아 있다 — 화면이 상태를 보고 고른다.
    expect(parsed.activity).toEqual({ state: 'text', text: '앞 턴의 말', at: Date.parse('2026-09-15T01:00:00.000Z') })
  })

  it('마지막 턴에 텍스트가 있으면 도구는 null — 끝난 일을 「하는 중」이라고 하지 않는다', () => {
    const chunk = [
      toolTurn({ name: 'Bash', input: { command: 'npm test' } }),
      claudeAssistant('테스트가 통과했다', '2026-09-15T02:01:00.000Z'),
    ].join('\n')
    expect(parseClaudeTail({ chunk, partial: false, sessionId: SESSION }).tool).toBeNull()
  })

  it('관측된 키 순서대로 미리보기를 고른다 (command → file_path → url → query → task)', () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ file_path: '/tmp/a.ts' }, '/tmp/a.ts'],
      [{ url: 'https://example.com', prompt: '요약' }, 'https://example.com'],
      [{ query: 'vitest 설정' }, 'vitest 설정'],
      [{ element: '버튼', target: 'x' }, null],
    ]
    for (const [input, expected] of cases) {
      const chunk = toolTurn({ name: 'T', input })
      expect(parseClaudeTail({ chunk, partial: false, sessionId: SESSION }).tool).toEqual({ name: 'T', input: expected })
    }
  })

  it('codex·grok 은 도구 자리가 없다 — 어시스턴트 메시지 밖에 살아서 안 지어낸다', () => {
    const codex = JSON.stringify({
      timestamp: '2026-09-15T02:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '완료' }] },
    })
    expect(parseCodexTail({ chunk: codex, partial: false }).tool).toBeNull()
    expect(parseGrokTail({ chunk: JSON.stringify({ type: 'assistant', content: '완료' }), partial: false }).tool).toBeNull()
  })
})
