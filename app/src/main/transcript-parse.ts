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
import type { SessionActivity, SessionTool, TranscriptAgent } from '../shared/types.js'

/** 꼬리 조각에서 뽑아낸 것. 못 찾은 자리는 전부 null 이다. */
export type TranscriptDigest = {
  activity: SessionActivity
  providerTitle: string | null
  /** 마지막 어시스턴트 턴이 도구 호출뿐일 때 그 도구 (B9). 텍스트가 있으면 null. */
  tool: SessionTool | null
  lastActivityAt: number | null
}

export const EMPTY_DIGEST: TranscriptDigest = {
  activity: { state: 'unknown-format' },
  providerTitle: null,
  tool: null,
  lastActivityAt: null,
}


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
 *
 * ## 자르지 않는다 (B5 「전문은 `title` 툴팁으로」)
 *
 * 처음엔 400자에서 잘라 날랐다. 그러면 툴팁에 오는 것이 **전문이 아니다** — 실측상 마지막
 * 어시스턴트 텍스트의 **70.3%** 가 400자를 넘는다(`raw/claude/b5-text-length.json`).
 * 즉 상한을 두면 열에 일곱은 툴팁마저 잘린 채 보인다.
 *
 * 안 잘라도 되는 근거도 같은 실측에 있다: 접은 뒤 길이가 p50 866 · p99 2,413 · 최대 2,760자이고
 * 4KB 를 넘는 것이 **0건**이다. 세션 8개를 동시에 붙여도 p99 기준 약 18KB — IPC 로 나르는 데
 * 문제가 되는 크기가 아니다. 보이는 줄의 말줄임은 CSS 가 한다(`.session-row-second`).
 * 상한이 아예 없는 것도 아니다 — 꼬리 창(`transcript.ts` 의 256KB→2MB)이 위를 막는다.
 */
export function cleanActivityText(raw: string): string | null {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length === 0 ? null : oneLine
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
  let tool: SessionTool | null = null
  let sawAssistant = false
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
    if (type === 'assistant') {
      const message = record['message']
      if (!isRecord(message)) continue
      const text = textFromContent(message['content'])
      // **맨 뒤 어시스턴트 턴**만 도구 자리다 (B9). 그 턴에 텍스트가 없으면 = 지금 도구를
      // 돌리는 중이다. 한 턴이라도 지나간 뒤의 도구는 "지금 무엇을 하나" 가 아니므로 안 싣는다.
      if (!sawAssistant) {
        sawAssistant = true
        if (text === null) tool = toolFromContent(message['content'])
      }
      if (activity !== null) continue
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
    tool,
    lastActivityAt,
  }
}

/**
 * 어시스턴트 content 의 **첫 `tool_use` 블록**을 `{ 이름, 한 줄 미리보기 }` 로 (B9).
 *
 * 미리보기로 쓸 키는 **관측된 것만** 본다 (기준 A9 와 같은 규칙 — 안 나온 모양을 미리 다루지
 * 않는다). 사용자 트랜스크립트 40개의 도구뿐인 턴 405개에서 센 `input` 키 분포
 * (`raw/claude/c5-b9-shapes-r5.json`):
 *
 * | 도구 | 키 | 건수 |
 * | --- | --- | --- |
 * | `Bash` | `command`(+`description`) | 289 |
 * | `Edit`·`Write`·`Read` | `file_path` | 36 |
 * | `WebFetch` | `url`(+`prompt`) | 17 |
 * | `ToolSearch`·`WebSearch` | `query` | 19 |
 * | 나머지(MCP 등) | 제각각 | 44 |
 *
 * 그래서 `command → file_path → url → query → task` 순으로 **문자열인 첫 키**를 쓰고, 그중 어느
 * 것도 없으면 **이름만** 준다(`mcp__playwright__browser_click` 처럼 키가 제각각인 도구가 여기 선다).
 * 지어낸 요약을 만들지 않는다.
 */
function toolFromContent(content: unknown): SessionTool | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] !== 'tool_use') continue
    const name = readString(block, 'name')
    if (name === null || name.trim().length === 0) continue
    return { name: name.trim(), input: toolInputPreview(block['input']) }
  }
  return null
}

/** 관측된 키 순서대로 문자열 하나. 없으면 null (이름만 보인다). */
function toolInputPreview(input: unknown): string | null {
  if (!isRecord(input)) return null
  for (const key of ['command', 'file_path', 'url', 'query', 'task']) {
    const value = readString(input, key)
    if (value === null) continue
    const cleaned = cleanActivityText(value)
    if (cleaned !== null) return cleaned
  }
  return null
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

  // codex 의 도구 호출은 어시스턴트 메시지 **밖**(`response_item/function_call`)에 산다 —
  // B9 은 "마지막 어시스턴트 턴이 tool_use 뿐일 때" 라 codex 에는 해당하는 자리가 없다.
  // 실측 결과는 `raw/claude/c5-b9-shapes-r5.json` 에 부재로 적었다 (기준 A10).
  return { activity: activity ?? { state: 'unknown-format' }, providerTitle: null, tool: null, lastActivityAt }
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

  // grok 도 같다 — 한 줄이 한 메시지이고 도구 레코드가 어시스턴트 메시지 안에 없다.
  return { activity: activity ?? { state: 'unknown-format' }, providerTitle: null, tool: null, lastActivityAt }
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

// --- 머리 읽기: 세션의 첫 사용자 발화 (C5, 수정 라운드 5) ---------------------------
//
// 여기 위의 모든 함수는 **꼬리**를 본다. 첫 발화만 방향이 반대다 — 15MB 파일의 맨 앞이라
// 어떤 꼬리 창으로도 닿지 않는다. 그래서 읽기 경로가 하나 늘었고(`transcript.ts` 의 머리 창),
// 예산은 통과선에 먼저 박혀 있다 (C6 — 256KB · 파일당 1회).
//
// ## 머리 조각은 **마지막 줄**이 잘려 있다 (꼬리와 거울이다)
//
// `tailLines` 는 `partial` 일 때 **첫 줄**을 버린다. 머리는 반대로 끝이 잘리는데, 그 줄은 따로
// 안 버린다 — JSON 파싱이 실패해 어차피 건너뛴다. 꼬리의 마지막 줄을 안 버리는 것과 같은
// 판단이고, 규칙이 하나 적다.

/** 머리에서 찾는 것은 **첫 발화 하나**다. 못 찾으면 null. */
export function headLines(chunk: string): string[] {
  return chunk.split('\n').filter((line) => line.trim().length > 0)
}

/** 정제된 첫 프롬프트 제목의 상한 — Orca `GENERATED_TAB_TITLE_MAX_LENGTH` 와 같은 40자. */
export const FIRST_PROMPT_MAX_LENGTH = 40

/**
 * 정제 전에 훑는 원문 길이 — Orca `GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT`(512) 와 같다.
 * 첫 발화는 붙여넣기로 수십 KB 가 될 수 있는데 쓰는 것은 앞 40자뿐이라, 정규식을 전문에
 * 돌릴 이유가 없다.
 */
const FIRST_PROMPT_SCAN_LIMIT = 512

/**
 * 머리말 필러 — Orca `LEADING_FILLER_PATTERNS`(`shared/agent-tab-title.ts:4-13`) 그대로.
 * 영어 목록인데 그대로 둔다: 한국어 발화에는 안 걸리고(무해), 영어 발화에는 Orca 와 **같은**
 * 제목이 나온다. 목록을 한국어로 지어 넓히지 않는다 — 관측이 아니라 상상이 된다.
 */
const LEADING_FILLER: readonly RegExp[] = [
  /^(?:can|could|would)\s+you(?:\s+please)?\s+/i,
  /^please(?:\s+|$)/i,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^help\s+me(?:\s+to)?\s+/i,
  /^help\s+/i,
  /^let'?s\s+/i,
  /^we\s+need\s+to\s+/i,
  /^need\s+to\s+/i,
]

/** 첫 글자만 대문자로 (Orca `capitalizeFirstLetter`). 한글에는 아무 일도 안 일어난다. */
function capitalizeFirst(value: string): string {
  return value.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase())
}

/**
 * 40자에서 **단어 경계**로 자른다 (Orca `truncateAtWordBoundary`).
 * 마지막 공백이 너무 앞(55% 미만)이면 그냥 자른다 — 띄어쓰기가 드문 한국어 발화가 여기 선다.
 */
function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const rawSlice = value.slice(0, maxLength)
  const sliced = rawSlice.trim()
  if (sliced.length < rawSlice.length) return sliced
  const lastSpace = sliced.lastIndexOf(' ')
  if (lastSpace >= Math.floor(maxLength * 0.55)) return sliced.slice(0, lastSpace).trim()
  return sliced
}

/**
 * 첫 발화 → 제목 (Orca `deriveGeneratedTabTitle` 과 같은 결, `shared/agent-tab-title.ts:69-110`).
 *
 * 순서가 중요하다 — **URL 을 마크다운 기호보다 먼저** 지운다. Orca 주석의 사유 그대로:
 * `/merge_requests/42` 처럼 URL 안에 `_` 가 있으면 기호를 먼저 접을 때 URL 이 쪼개져
 * 조각("requests")이 제목에 샌다.
 *
 * 코드를 옮겨 붙이지 않고 같은 규칙을 다시 썼다 — 검증은 `session-title.test.ts` 가 Orca 의
 * 사례(URL·필러·40자 경계)로 한다.
 */
export function cleanFirstPrompt(raw: string): string | null {
  const preview = raw.slice(0, FIRST_PROMPT_SCAN_LIMIT)
  const firstClause = preview
    .trim()
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_~#>[\]{}()]/g, ' ')
    .replace(/^(?:issue|task|bug|feature|pr)\s*(?:#?\d+)?\s*[:-]\s*/i, '')
    .split(/[.!?;\n\r\u2028\u2029]/u)[0]
    ?.trim()
  if (firstClause === undefined || firstClause.length === 0) return null

  let candidate = firstClause
  for (let round = 0; round < 3; round += 1) {
    const before = candidate
    for (const filler of LEADING_FILLER) candidate = candidate.replace(filler, '')
    candidate = candidate.trim()
    if (candidate === before.trim()) break
  }

  const folded = candidate.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (folded.length === 0) return null
  return truncateAtWordBoundary(capitalizeFirst(folded), FIRST_PROMPT_MAX_LENGTH)
}

/**
 * claude 머리 판독 — **사람이 친 첫 발화**. 없으면 null.
 *
 * 건너뛰는 것은 **관측된 것뿐**이다 (사용자 트랜스크립트 363개 실측,
 * `raw/claude/c5-b9-shapes-r5.json`):
 *
 * | 건너뛰는 것 | 관측 |
 * | --- | --- |
 * | `type` 이 `user` 가 아닌 레코드 (`attachment` 61 · `last-prompt` 34 · `mode` 34 · `file-history-snapshot` 5 …) | 머리에 항상 섞여 있다 |
 * | `isMeta: true` | 34개 파일 |
 * | `<command-message>`·`<command-name>` 봉투 (슬래시 명령) | 33개 파일 |
 * | `<local-command-stdout>` | 29개 파일 |
 *
 * `isSidechain` 은 **첫 발화 자리에서 0건**이라 건너뛰기를 안 만들었다 (기준 A9 — 안 나온
 * 형식을 미리 지우지 않는다). 이 규칙으로 363개 중 **347개**에서 첫 발화가 나왔고, 나머지
 * 16개는 머리 창 안에 사람 발화가 아예 없었다(부재).
 *
 * 소유자 확인은 C2 그대로 — 레코드의 `sessionId` 가 이 세션 참조와 같을 때만 쓴다.
 * 실측에서 347개 전부 일치했고 어긋난 파일은 0개였다.
 */
export function parseClaudeHead(input: { chunk: string; sessionId: string | null }): string | null {
  if (input.sessionId === null) return null
  for (const line of headLines(input.chunk)) {
    const record = safeParse(line)
    if (!isRecord(record)) continue
    if (readString(record, 'type') !== 'user') continue
    if (record['isMeta'] === true) continue
    if (readString(record, 'sessionId') !== input.sessionId) continue
    const message = record['message']
    if (!isRecord(message)) continue
    const text = textFromContent(message['content'])
    if (text === null) continue
    if (text.includes('<command-message>') || text.includes('<command-name>')) continue
    if (text.includes('<local-command-stdout>')) continue
    const title = cleanFirstPrompt(text)
    if (title !== null) return title
  }
  return null
}

/**
 * codex 머리 판독 — `event_msg` 의 `user_message` 가 **사람이 친 것만** 싣는다.
 *
 * 실측(`~/.codex/sessions` 16개 전수): 머리에 `response_item/message/user` 가 먼저 오는데 그건
 * 하네스 주입이다(`<environment_context>`, `AGENTS.md instructions`). 사람 발화는 그 다음
 * `{"type":"event_msg","payload":{"type":"user_message","message":"…"}}` 에 문자열로 온다 —
 * **16/16 에서 나왔다.** 그래서 봉투를 지우는 대신 **그 레코드만** 본다.
 *
 * 소유자 확인(C2)은 파일 해소가 이미 했다 — 파일 이름에 세션 id 가 들어 있어
 * (`rollout-<시각>-<id>.jsonl`) 그 id 로 찾은 파일이다. 레코드 안에 `sessionId` 필드는 없다.
 */
export function parseCodexHead(input: { chunk: string }): string | null {
  for (const line of headLines(input.chunk)) {
    const record = safeParse(line)
    if (!isRecord(record)) continue
    const payload = record['payload']
    if (!isRecord(payload)) continue
    if (payload['type'] !== 'user_message') continue
    const message = readString(payload, 'message')
    if (message === null) continue
    const title = cleanFirstPrompt(message)
    if (title !== null) return title
  }
  return null
}

/** grok 의 사람 발화 봉투 — `<user_query>…</user_query>`. 봉투가 없으면 하네스 주입이다. */
const GROK_USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/

/**
 * grok 머리 판독 — `<user_query>` 봉투 안쪽.
 *
 * 실측(`~/.grok/sessions` 269개 전수): 머리의 user 레코드는 대부분 하네스 주입
 * (`<user_info>`·`<system-reminder>`)이고, 사람 발화는 `<user_query>` 봉투에 싸여 온다.
 * 봉투가 있는 파일은 **44개**, user 레코드가 아예 없는 파일이 202개다 — 즉 grok 은 이 값이
 * **자주 부재**한다. 부재는 부재로 둔다(A10) — 봉투 없는 레코드를 첫 발화로 쓰면 모든 grok 행이
 * `<user_info>` 로 같은 제목이 된다.
 */
export function parseGrokHead(input: { chunk: string }): string | null {
  for (const line of headLines(input.chunk)) {
    const record = safeParse(line)
    if (!isRecord(record)) continue
    if (record['type'] !== 'user' && record['role'] !== 'user') continue
    const text = textFromContent(record['content'])
    if (text === null) continue
    const inside = GROK_USER_QUERY.exec(text)
    if (inside === null) continue
    const title = cleanFirstPrompt(inside[1] ?? '')
    if (title !== null) return title
  }
  return null
}

/** 에이전트별 머리 판독 한 자리 — 꼬리와 같은 결로 switch 로 좁힌다 (기준 E3). */
export function parseHead(input: { agent: TranscriptAgent; chunk: string; sessionId: string | null }): string | null {
  switch (input.agent) {
    case 'claude':
      return parseClaudeHead({ chunk: input.chunk, sessionId: input.sessionId })
    case 'codex':
      return parseCodexHead({ chunk: input.chunk })
    case 'grok':
      return parseGrokHead({ chunk: input.chunk })
  }
}
