// 트랜스크립트 **꼬리 한 조각**에서 지문을 뽑는 순수 함수들 (LIFE-366).
//
// 파일도 herdr 도 모른다 — 입력은 문자열, 출력은 corral 타입이다. `git-status.ts` 의
// `parseGitStatus` 와 같은 결로 갈라 둔다: I/O 는 `transcript.ts`, 판독은 여기, 그래서 고의로
// 망가뜨린 입력(기준 A8)을 단위 테스트로 때릴 수 있다.
//
// ## 지켜야 하는 것 하나 — **모르면 모른다고 한다**
//
// claude 트랜스크립트 모양은 **공개 계약이 아니다** (`00-analysis.md` §9.1·§9.2 — 공식 문서가
// 직접 파싱 대신 훅을 권한다). 그러니 여기 적힌 필드 이름은 언제든 바뀔 수 있고, 바뀌었을 때
// 이 층이 할 일은 **빈 손으로 돌아오는 것**이지 그럴듯한 문자열을 만들어 내는 게 아니다.
// 예외를 밖으로 던지지도 않는다 — 한 세션의 판독 실패가 목록 전체를 무너뜨리면 안 된다.

import { isRecord, readString, safeParse } from '../shared/json.js'
import type { SessionActivity, TranscriptAgent } from '../shared/types.js'

/** 꼬리 조각에서 뽑아낸 것. 못 찾은 자리는 전부 null 이다. */
export type TranscriptDigest = {
  activity: SessionActivity
  providerTitle: string | null
  lastActivityAt: number | null
}

export const EMPTY_DIGEST: TranscriptDigest = {
  activity: { state: 'unknown-format' },
  providerTitle: null,
  lastActivityAt: null,
}

/** 2차 줄에 실을 길이 상한 — 한 줄 말줄임(B5)은 CSS 가 하지만, IPC 로 문단을 나르지는 않는다. */
export const MAX_ACTIVITY_CHARS = 400

/**
 * 꼬리 조각을 줄로 자른다.
 *
 * `partial` 이면 파일 중간부터 읽었다는 뜻이라 **첫 줄을 버린다** — 그 줄은 잘려 있다.
 * 마지막 줄도 쓰다 만 것일 수 있는데, 그건 버리지 않는다: JSON 파싱이 실패하면 어차피
 * 건너뛰고, 성공하면 온전한 줄이다. 판정을 파싱에 맡기는 쪽이 규칙이 하나 적다.
 */
export function tailLines(chunk: string, { partial }: { partial: boolean }): string[] {
  const lines = chunk.split('\n')
  if (partial) lines.shift()
  return lines.filter((line) => line.trim().length > 0)
}

/** ISO 시각 → epoch ms. 모양이 아니면 null (Date 가 NaN 을 조용히 흘리는 것을 여기서 막는다). */
export function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * 어시스턴트 레코드의 content 에서 **보일 텍스트**를 뽑는다. 없으면 null.
 *
 * content 는 블록 배열이고 `text` 블록만 사람이 읽을 것이다. `tool_use` 뿐인 턴이 실제로 있다
 * (`raw/analysis/transcript-shape.json`: 20개 중 3개) — 그때는 null 을 주고, 그 위 층이
 * 한 턴 더 거슬러 올라간다. 문자열 content 를 주는 옛 모양도 같이 받는다.
 *
 * herdr-studio `server/src/agent/session-utils.ts` 의 `textFromContent` 와 같은 판단이다
 * (MIT, https://github.com/herdr-dev/herdr-studio) — 코드를 옮기지는 않았다.
 */
export function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim().length === 0 ? null : content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] !== 'text') continue
    const text = readString(block, 'text')
    if (text === null) continue
    parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined.length === 0 ? null : joined
}

/**
 * 2차 줄에 실을 수 있게 한 줄로 다듬는다 (기준 A9 — 원문 오염 제거).
 *
 * ## 지우는 코드가 **한 줄도 없는** 이유 — 실측이 그렇게 말했다
 *
 * A9 이 이름을 댄 오염 형식(`<command-message>` 류, `<local-command-stdout>`,
 * `[Request interrupted by user]`, tool 결과 JSON)을 사용자 트랜스크립트 30개에서 찾아봤다
 * (`raw/claude/a9-contamination.json`, 어시스턴트 텍스트가 있는 28개 기준):
 *
 * | 형식 | 어시스턴트 레인 | user 레인 |
 * | --- | --- | --- |
 * | `<command-*>` 봉투 | **0 / 28** | 1 / 30 |
 * | `<local-command-stdout>` | **0 / 28** | 1 / 30 |
 * | `[Request interrupted…]` | **0 / 28** | 0 / 30 |
 * | tool 결과 JSON | **0 / 28** | 0 / 30 |
 * | 마크다운 줄바꿈(`\n#`·`\n*`) | **15 / 28** | 7 / 30 |
 *
 * 즉 그 봉투들은 **user 레코드에 산다.** 2차 줄은 어시스턴트 텍스트만 보므로 애초에 닿지 않는다.
 * 기준 A9 이 스스로 정한 규칙("관측된 형식만 다룬다 — 안 나온 형식을 미리 지우는 코드는 만들지
 * 않는다")을 그대로 따르면 **지울 것이 없다.** `session-title.ts` 의 거절 목록과 같은 원칙이고,
 * 없는 형식을 지우는 정규식은 영영 대조할 수 없는 코드가 된다.
 *
 * 실제로 관측된 유일한 문제는 **여러 줄**이다(15/28). 그건 공백으로 접는다 — B5 가 요구하는
 * 한 줄이 되고, `title` 툴팁도 같은 한 줄을 쓴다.
 */
export function cleanActivityText(raw: string): string | null {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return null
  return oneLine.length > MAX_ACTIVITY_CHARS ? `${oneLine.slice(0, MAX_ACTIVITY_CHARS)}…` : oneLine
}

/**
 * claude 트랜스크립트 꼬리 판독.
 *
 * **뒤에서 앞으로** 훑는다 — 찾는 것이 전부 "가장 최근" 이라서 앞에서부터 읽을 이유가 없다.
 * 세 가지를 한 번에 집는다:
 *   ① 마지막 어시스턴트 **텍스트** (tool_use 뿐인 턴은 건너뛰고 더 거슬러 올라간다)
 *   ② provider 제목 (`ai-title` 레코드) — `sessionId` 가 이 세션 것일 때만 (기준 C2)
 *   ③ 마지막 활동 시각 — 꼬리에서 본 **어떤 레코드든** 가장 큰 timestamp
 *
 * `sessionId` 를 받는 이유가 ② 다. Orca 도 provider 제목을 `agent`+`sessionId` 가 맞을 때만
 * 쓴다 (`agent-row-conversation-name.ts:139-148`).
 */
export function parseClaudeTail(input: { chunk: string; partial: boolean; sessionId: string | null }): TranscriptDigest {
  const lines = tailLines(input.chunk, { partial: input.partial })
  let activity: SessionActivity | null = null
  let providerTitle: string | null = null
  let lastActivityAt: number | null = null

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = safeParse(lines[i] ?? '')
    if (!isRecord(record)) continue

    const at = readTimestamp(record['timestamp'])
    if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at

    const type = readString(record, 'type')
    if (type === 'ai-title' && providerTitle === null) {
      // 이 레코드가 **이 세션의 것**인가. 참조 id 를 모르면(있을 수 없지만) 쓰지 않는다.
      const owner = readString(record, 'sessionId')
      if (input.sessionId !== null && owner === input.sessionId) {
        const title = readString(record, 'aiTitle')
        if (title !== null && title.trim().length > 0) providerTitle = title.trim()
      }
      continue
    }
    if (type === 'assistant' && activity === null) {
      const message = record['message']
      if (!isRecord(message)) continue
      const text = textFromContent(message['content'])
      if (text === null) continue // tool_use 뿐인 턴 — 한 턴 더 거슬러 올라간다
      const cleaned = cleanActivityText(text)
      if (cleaned === null) continue
      activity = { state: 'text', text: cleaned, at }
      continue
    }
    if (activity !== null && providerTitle !== null) break
  }

  return {
    activity: activity ?? { state: 'unknown-format' },
    providerTitle,
    lastActivityAt,
  }
}

/**
 * codex `rollout-*.jsonl` 꼬리 판독.
 *
 * 실측 모양 (`raw/claude/a10-foreign-shapes.json`): 첫 줄이 `session_meta`, 이후는
 * `{"timestamp":…,"type":"response_item","payload":{"type":"message","role":"assistant",
 * "content":[{"type":"output_text","text":…}]}}`. provider 제목에 해당하는 레코드는 없다.
 */
export function parseCodexTail(input: { chunk: string; partial: boolean }): TranscriptDigest {
  const lines = tailLines(input.chunk, { partial: input.partial })
  let activity: SessionActivity | null = null
  let lastActivityAt: number | null = null

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = safeParse(lines[i] ?? '')
    if (!isRecord(record)) continue
    const at = readTimestamp(record['timestamp'])
    if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
    if (activity !== null) continue
    const payload = record['payload']
    if (!isRecord(payload)) continue
    if (payload['role'] !== 'assistant') continue
    const text = textFromContent(codexContent(payload['content']))
    if (text === null) continue
    const cleaned = cleanActivityText(text)
    if (cleaned === null) continue
    activity = { state: 'text', text: cleaned, at }
  }

  return { activity: activity ?? { state: 'unknown-format' }, providerTitle: null, lastActivityAt }
}

/** codex 블록의 `output_text` 를 공용 `text` 모양으로 옮긴다 — `textFromContent` 를 그대로 쓰려고. */
function codexContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!isRecord(block)) return block
    if (block['type'] !== 'output_text') return block
    return { type: 'text', text: block['text'] }
  })
}

/**
 * grok `chat_history.jsonl` 꼬리 판독.
 *
 * 실측 모양 (`raw/claude/a10-foreign-shapes.json`): `{"type":"assistant","content":"…"}`
 * — 한 줄이 한 메시지이고 content 가 문자열이다. timestamp 가 없어 활동 시각은 파일 mtime 으로
 * 떨어진다 (`transcript.ts` 가 메운다).
 */
export function parseGrokTail(input: { chunk: string; partial: boolean }): TranscriptDigest {
  const lines = tailLines(input.chunk, { partial: input.partial })
  let activity: SessionActivity | null = null
  let lastActivityAt: number | null = null

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = safeParse(lines[i] ?? '')
    if (!isRecord(record)) continue
    const at = readTimestamp(record['timestamp'] ?? record['ts'])
    if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
    if (activity !== null) continue
    if (record['type'] !== 'assistant' && record['role'] !== 'assistant') continue
    const text = textFromContent(record['content'])
    if (text === null) continue
    const cleaned = cleanActivityText(text)
    if (cleaned === null) continue
    activity = { state: 'text', text: cleaned, at }
  }

  return { activity: activity ?? { state: 'unknown-format' }, providerTitle: null, lastActivityAt }
}

/** 에이전트별 판독기 한 자리 — 갈래를 switch 로 좁힌다 (기준 E3). */
export function parseTail(input: {
  agent: TranscriptAgent
  chunk: string
  partial: boolean
  sessionId: string | null
}): TranscriptDigest {
  switch (input.agent) {
    case 'claude':
      return parseClaudeTail({ chunk: input.chunk, partial: input.partial, sessionId: input.sessionId })
    case 'codex':
      return parseCodexTail({ chunk: input.chunk, partial: input.partial })
    case 'grok':
      return parseGrokTail({ chunk: input.chunk, partial: input.partial })
  }
}
