// 대화 메시지 (LIFE-581) — 서버 `chat.page`·`chat.items`·`chat.unavailable` 의 앱 쪽 사본. 정본은 `app/src/main/mobile/SURFACE.md`「대화」.
// RN 을 모른다. 모양이 틀린 말풍선은 버리고(그 프레임 전체를 버리지 않는다 — 대화는 목록과 달리 증분이라 한 칸 때문에 나머지를 잃지 않게) 개수만 센다.

export type ChatText = { text: string; clipped: number | null }
/** `unknown` = 결과는 왔으나 성공/실패를 기록에서 읽지 못했다(옛 Codex 출력 — 서버가 성공으로 단정하지 않는다, R1-A9). */
export type ChatToolStatus = 'running' | 'ok' | 'error' | 'unknown'
export type ChatTool = { name: string | null; target: string | null; status: ChatToolStatus }
export type ChatQuestion = { question: string; header: string | null; options: { label: string; description: string | null }[]; multiSelect: boolean | null }

export type ChatItem =
  | { id: number; kind: 'prompt'; at: number | null; body: ChatText }
  | { id: number; kind: 'reply'; at: number | null; body: ChatText }
  | { id: number; kind: 'tools'; at: number | null; tools: ChatTool[]; count: number; names: Record<string, number>; detail: boolean }
  /** `clipped` = 서버가 글·문항·선택지 일부를 덜어 냈다(크기 상한, R1-A5) — 화면에 잘림을 보인다. */
  | { id: number; kind: 'question'; at: number | null; questions: ChatQuestion[]; state: 'pending' | 'answered' | 'closed'; answer: string | null; clipped: boolean }
  | { id: number; kind: 'note'; at: number | null; note: 'interrupted' | 'failed' | 'compacted'; text: string | null; clipped: boolean }

/** `cursor` = 서버 판독자의 변경 순번 — 이어 받기에 돌려준다(R1-A2). */
export type ChatTimes = { at: number | null; readAt: number | null; writtenAt: number | null; cursor: number | null }

export type ChatMessage =
  | ({ type: 'page'; channel: string; gen: string; mode: 'reset' | 'resume' | 'older'; hasOlder: boolean; items: ChatItem[]; dropped: number } & ChatTimes)
  | ({ type: 'items'; channel: string; gen: string; items: ChatItem[]; dropped: number } & ChatTimes)
  | { type: 'unavailable'; channel: string; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function readText(value: unknown): ChatText | null {
  if (!isRecord(value)) return null
  const text = str(value.text)
  if (text === null) return null
  return { text, clipped: num(value.clipped) }
}

function readTool(value: unknown): ChatTool | null {
  if (!isRecord(value)) return null
  const status = value.status === 'running' || value.status === 'ok' || value.status === 'error' || value.status === 'unknown' ? value.status : null
  if (status === null) return null
  return { name: str(value.name), target: str(value.target), status }
}

function readQuestion(value: unknown): ChatQuestion | null {
  if (!isRecord(value)) return null
  const question = str(value.question)
  if (question === null) return null
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => (isRecord(option) && typeof option.label === 'string' ? [{ label: option.label, description: str(option.description) }] : []))
    : []
  return { question, header: str(value.header), options, multiSelect: typeof value.multiSelect === 'boolean' ? value.multiSelect : null }
}

export function readChatItem(value: unknown): ChatItem | null {
  if (!isRecord(value)) return null
  const id = num(value.id)
  if (id === null) return null
  const at = num(value.at)
  switch (value.kind) {
    case 'prompt':
    case 'reply': {
      const body = readText(value.body)
      return body === null ? null : { id, kind: value.kind, at, body }
    }
    case 'tools': {
      if (!Array.isArray(value.tools)) return null
      const tools = value.tools.map(readTool)
      if (tools.some((tool) => tool === null)) return null
      const names: Record<string, number> = {}
      if (isRecord(value.names)) for (const [name, count] of Object.entries(value.names)) if (typeof count === 'number') names[name] = count
      return { id, kind: 'tools', at, tools: tools.filter((tool): tool is ChatTool => tool !== null), count: num(value.count) ?? tools.length, names, detail: value.detail === true }
    }
    case 'question': {
      const state = value.state === 'pending' || value.state === 'answered' || value.state === 'closed' ? value.state : null
      if (state === null || !Array.isArray(value.questions)) return null
      const questions = value.questions.flatMap((question) => {
        const read = readQuestion(question)
        return read === null ? [] : [read]
      })
      return { id, kind: 'question', at, questions, state, answer: str(value.answer), clipped: value.clipped === true }
    }
    case 'note': {
      const note = value.note === 'interrupted' || value.note === 'failed' || value.note === 'compacted' ? value.note : null
      return note === null ? null : { id, kind: 'note', at, note, text: str(value.text), clipped: value.clipped === true }
    }
    default:
      return null
  }
}

function readItems(value: unknown): { items: ChatItem[]; dropped: number } | null {
  if (!Array.isArray(value)) return null
  const items: ChatItem[] = []
  let dropped = 0
  for (const raw of value) {
    const item = readChatItem(raw)
    if (item === null) dropped += 1
    else items.push(item)
  }
  return { items, dropped }
}

/** `chat.*` 프레임 읽기 — 봉투(채널·세대·말풍선 배열)가 틀리면 null. */
export function parseChatMessage(value: Record<string, unknown>): ChatMessage | null {
  const channel = str(value.channel)
  if (channel === null) return null
  if (value.type === 'chat.unavailable') return { type: 'unavailable', channel, reason: str(value.reason) ?? 'unknown' }
  const gen = str(value.gen)
  const read = readItems(value.items)
  if (gen === null || read === null) return null
  const times: ChatTimes = { at: num(value.at), readAt: num(value.readAt), writtenAt: num(value.writtenAt), cursor: num(value.cursor) }
  if (value.type === 'chat.items') return { type: 'items', channel, gen, ...read, ...times }
  if (value.type !== 'chat.page') return null
  const mode = value.mode === 'reset' || value.mode === 'resume' || value.mode === 'older' ? value.mode : null
  if (mode === null) return null
  return { type: 'page', channel, gen, mode, hasOlder: value.hasOlder === true, ...read, ...times }
}

/** id 로 합친다 — 같은 id 는 새 값이 이긴다(묶음·질문·답이 자란다). 결과는 id 오름차순(= 기록 순서). */
export function mergeItems(input: { have: readonly ChatItem[]; incoming: readonly ChatItem[] }): ChatItem[] {
  const byId = new Map<number, ChatItem>()
  for (const item of input.have) byId.set(item.id, item)
  for (const item of input.incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}
