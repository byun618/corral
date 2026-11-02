// 대화 구독 (LIFE-581 X3~X6) — 인증된 연결이 채널 id 로 대화를 열면 그 세션 기록을 말풍선으로 보낸다. electron·소켓을 모른다.
//
// - **열린 대화가 0 이면 아무것도 읽지 않는다**(K9) — 판독자는 첫 구독에 생기고, 마지막 구독이 떠나면 **그 자리에서 읽기를 멈춘다**(stat·꼬리 읽기 0, R1-A3).
//   첫 색인·따라잡기 도중이어도 다음 조각 경계에서 멈춘다 — 다 못 읽은 색인은 공개하지 않고, 다시 열면 처음부터 색인한다(R2-A3).
//   색인은 `graceMs` 동안만 들고 있다가 버린다 — 그 안에 다시 열면 멈춘 동안 늘어난 바이트를 따라잡고 첫 페이지를 보낸다.
// - **파일 하나에 판독자 하나**(Y2ⓒ) — 같은 기록을 여러 연결이 열어도 색인·꼬리 읽기는 한 벌, push 직렬화는 채널마다 한 번.
// - 판독: 처음 한 번 파일 전체를 **비동기로 조각 읽기**(1 MiB 씩, 조각 사이 이벤트 루프 양보 — 동기 전체 읽기 없음, X5) → 말풍선 배열.
//   그 뒤 `pollMs` 마다 stat 하고 늘어난 바이트만 이어 읽는다(바이트 오프셋). 개행으로 끝나지 않은 마지막 줄은 개행이 올 때까지 보류(X4).
// - **세대(gen)** = 색인 한 번마다 새로 뽑는 값 + Claude rewind 수(R1-A4). 처음부터 다시 색인하면(파일 교체·줄어듦·앞부분 덮어쓰기·판독자를 버린 뒤 새로 열기)
//   세대가 반드시 바뀐다 — 옛 세대로 온 이어 받기는 처음부터(`reset`). rewind 로 앞 말풍선이 사라져도 세대가 바뀐다(X6).
//   덮어쓰기 감지: 파일이 바뀔 때마다 이미 읽은 구간의 앞·뒤 4 KiB 해시를 다시 대 본다(같은 크기 덮어쓰기·앞부분 재작성).
// - **변경 순번(cursor)**: 말풍선이 생기거나 바뀔 때마다 판독자 순번을 올리고 그 말풍선에 붙인다(R1-A2). 폰은 받은 가장 큰 순번을 들고 있다가
//   이어 받기 때 `{gen, from, cursor}` 를 보낸다 — 서버는 `from` 이후 말풍선 중 순번이 `cursor` 보다 큰 것(새로 생긴 것 + 끊긴 동안 바뀐 앞 말풍선) 전부를 준다.
//   한 묶음을 여러 프레임으로 나누면 **마지막 프레임만 새 순번**을 싣고 앞 프레임은 묶음 전 순번을 싣는다 — 중간에 끊기면 폰은 묶음 전 순번으로 이어 받아 나머지를 다시 받는다(R2-A1).
// - **구독마다 보낸 범위의 첫 id(`low`)**: 그보다 앞(폰이 아직 불러오지 않은 과거) 말풍선의 갱신은 push 하지 않는다 — 폰 배열 앞에 끼어 과거 요청 경계를 당기지 않게(R2-A2).
//   그 과거 페이지를 나중에 열면 그때의 최신 상태로 받는다.
// - **세션 교체**(R1-A1): 목록 재료가 바뀌면(`changed`) 구독마다 채널 → 세션 → 파일을 다시 고른다. 파일이 바뀌었으면(`/clear`·새 세션) 새 판독자로 옮겨 `reset`,
//   채널이 목록에서 사라지면 `chat.unavailable` 뒤 구독 끝. **일시 부재**(상태 못 읽음·세션 참조 아직 없음·파일 아직 없음)는 `chat.unavailable`(`retrying`)만 보내고
//   구독을 들고 있다가 `CHAT_RETRY_MS` 마다 다시 찾아 회복되면 처음부터 보낸다(R2-A4).
// - **세션 이어 가기**(LIFE-766): 세션이 백그라운드로 옮겨 가면 참조는 그대로이고 목록도 안 바뀐다 — 붙어 있는 Claude 구독은 `CHAT_FOLLOW_MS` 마다 **참조가 찾은 원본**에서
//   `followContinued` 로 다시 걷는다(안 바뀐 파일은 stat 만, 폴더 훑기 없음). 파일이 달라지면 그 세션 id 의 판독자로 옮겨 `reset` — 옛 판독자는 유예 뒤 버린다.
// - 보내는 글은 전부 홈 경로를 가린다(`maskPaths` — 목록과 같은 계약, X3) · 한 글 `ITEM_TEXT_MAX` 자, 넘으면 `clipped`(원래 길이)를 붙여 자른다.
//   말풍선 하나 `ITEM_BYTES_MAX` 바이트 — 질문은 글자 예산 안에서만 싣고 넘치면 `clipped`(R1-A5). 프레임 하나 `MAX_FRAME_BYTES` — 넘으면 페이지를 줄이거나 나눠 보낸다.
// - 폰이 주는 것은 채널 id·세대·말풍선 id(숫자) 뿐이다 — 파일 경로·세션 id 는 서버 안에서 `chatChannel`(목록과 같은 함수로 만든 목록)로만 고른다.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRef, SessionQuestion, TranscriptAgent } from '../../shared/types.js'
import { ChatBuilder, type ChatItem, type ChatTool } from '../chat-parse.js'
import { followContinued } from '../transcript-continued.js'
import { questionDigest } from './keys.js'
import { chatChannel, maskPaths, type ChatChannel, type ListInput } from './list.js'

/** 처음 열 때·과거 요청 한 번에 보내는 말풍선 수(X5). */
export const CHAT_PAGE_SIZE = 40
/** 이어 받기로 보낼 수 있는 최대 말풍선 수 — 넘으면 처음부터(`reset`). */
export const CHAT_RESUME_MAX = 400
/** 기록 파일 확인 주기 — 3초 예산(X4) 안에서 읽기 쪽 몫. */
export const CHAT_POLL_MS = 250
/** 마지막 구독이 떠난 뒤 판독자를 버리기까지 — 짧은 재연결이 다시 색인하지 않게. */
export const CHAT_GRACE_MS = 15_000
/** 한 글(지시·답·질문·카드) 최대 글자 수 — 넘으면 `clipped` 와 함께 자른다(X3). */
export const ITEM_TEXT_MAX = 16_000
/** 도구 대상 한 줄 최대 글자 수. */
export const TOOL_TARGET_MAX = 240
/** 묶음 한 장에 싣는 도구 줄 최대 — 넘는 앞쪽은 개수만(`count`·`names`). */
export const TOOLS_MAX = 120
/** 보내는 프레임 하나 상한(바이트). 받는 쪽 16 KiB 상한(`MAX_MESSAGE_BYTES`)과 별개다. */
export const MAX_FRAME_BYTES = 256 * 1024
/** 말풍선 하나의 직렬화 상한(바이트) — 프레임 상한보다 작아야 어떤 말풍선도 한 프레임에 들어간다(R1-A5). */
export const ITEM_BYTES_MAX = 64 * 1024
/** 질문 카드 한 장에 싣는 글자 예산(문항·머리·선택지·설명 합) — 넘는 글·문항·선택지는 빼고 `clipped`. */
export const QUESTION_CHARS = 8000
/** 도구 이름별 횟수 칸 상한 — 많은 순으로. 나머지는 `count` 에만. */
export const TOOL_NAMES_MAX = 40
/** 목록 재료가 바뀐 뒤 구독의 세션을 다시 고르기까지(뭉침). */
export const CHAT_REFRESH_MS = 100
/** 일시 부재로 기다리는 구독이 있을 때 다시 찾는 주기 — 기다리는 대화가 열려 있을 때만 돈다(R2-A4). */
export const CHAT_RETRY_MS = 1000
/** 붙어 있는 Claude 구독이 세션 이어 가기(`continued-in`)를 확인하는 주기 — 상태 변화 없이도 옮겨 간다(LIFE-766). 3초 예산(X4) 안. */
export const CHAT_FOLLOW_MS = 500
/** 조각 읽기 크기. */
const READ_CHUNK = 1024 * 1024
/** 덮어쓰기 감지 — 이미 읽은 구간의 앞·뒤 이만큼을 해시로 대 본다. */
const ANCHOR_BYTES = 4096

// --- 보내는 모양 -------------------------------------------------------------------------------------

export type WireText = { text: string; clipped: number | null }
export type WireTool = { name: string | null; target: string | null; status: ChatTool['status'] }
export type WireItem =
  | { id: number; kind: 'prompt'; at: number | null; body: WireText }
  | { id: number; kind: 'reply'; at: number | null; body: WireText }
  | { id: number; kind: 'tools'; at: number | null; tools: WireTool[]; count: number; names: Record<string, number>; detail: boolean }
  | { id: number; kind: 'question'; at: number | null; call: string | null; digest: string; questions: SessionQuestion[]; state: 'pending' | 'answered' | 'closed'; answer: string | null; clipped: boolean }
  | { id: number; kind: 'note'; at: number | null; note: 'interrupted' | 'failed' | 'compacted'; text: string | null; clipped: boolean }

export type ChatUnavailable = 'not_listed' | 'no_session' | 'no_file' | 'not_ready' | 'unreadable'
/** 기다리면 회복될 수 있는 부재 — 구독을 끝내지 않는다(R2-A4). `not_listed`(채널이 목록에 없음)·`unreadable` 은 끝. */
const TRANSIENT: ReadonlySet<ChatUnavailable> = new Set(['not_ready', 'no_session', 'no_file'])

type Place = ChatChannel['place']

function clipText(input: { text: string; place: Place; max: number }): WireText {
  // 가림 전에 넉넉히 자른다(비용 상한) — 가림이 글을 줄일 수 있어 두 배 창에서 가린 뒤 다시 잰다.
  const raw = input.text.length > input.max * 2 ? input.text.slice(0, input.max * 2) : input.text
  const masked = maskPaths({ text: raw, worktree: input.place.worktree, home: input.place.home })
  if (masked.length <= input.max && raw.length === input.text.length) return { text: masked, clipped: null }
  return { text: masked.slice(0, input.max), clipped: input.text.length }
}

function maskLine(input: { text: string | null; place: Place; max: number }): string | null {
  if (input.text === null) return null
  const flat = input.text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  // 가림 전에 두 배 창으로 자른다(비용 상한). 그 사전 절단도 잘림이다 — 가림으로 짧아졌어도 생략 표시를 붙인다(R4-A1).
  const precut = flat.length > input.max * 2
  const masked = maskPaths({ text: flat.slice(0, input.max * 2), worktree: input.place.worktree, home: input.place.home })
  if (masked.length > input.max) return `${masked.slice(0, input.max - 1)}…`
  return precut ? `${masked.slice(0, input.max - 1)}…` : masked
}

/** 질문 카드 — 글자 예산(`QUESTION_CHARS`) 안에서 문항 10·선택지 20 까지. 무엇이든 덜어 냈으면 `clipped`(R1-A5). */
function wireQuestions(input: { questions: SessionQuestion[]; place: Place }): { questions: SessionQuestion[]; clipped: boolean } {
  let budget = QUESTION_CHARS
  let clipped = input.questions.length > 10
  const take = (text: string | null, max: number): string | null => {
    if (text === null) return null
    const cut = clipText({ text, place: input.place, max: Math.max(0, Math.min(max, budget)) })
    if (cut.clipped !== null) clipped = true
    budget -= cut.text.length
    return cut.text
  }
  const questions: SessionQuestion[] = []
  for (const question of input.questions.slice(0, 10)) {
    if (budget <= 0) {
      clipped = true
      break
    }
    const text = take(question.question, 2000) ?? ''
    const header = take(question.header, 200)
    const options: SessionQuestion['options'] = []
    for (const option of question.options.slice(0, 20)) {
      if (budget <= 0) {
        clipped = true
        break
      }
      options.push({ label: take(option.label, 300) ?? '', description: take(option.description, 600) })
    }
    if (question.options.length > 20) clipped = true
    const layout: Pick<SessionQuestion, 'preview'> = question.preview === true ? { preview: true } : {}
    questions.push({ question: text, header, options, multiSelect: question.multiSelect, ...layout })
  }
  return { questions, clipped }
}

const itemBytes = (item: WireItem): number => Buffer.byteLength(JSON.stringify(item))

/**
 * 말풍선 하나를 `ITEM_BYTES_MAX` 안으로(R1-A5) — 글자 상한만으로는 바이트가 막히지 않는다(한글 3바이트·이스케이프 6바이트).
 * 넘으면 글을 더 자르고(`clipped` 유지) · 도구는 앞쪽 줄부터 덜고(개수는 `count` 에) · 질문은 뒤 문항부터 던다(`clipped`).
 */
function fitItem(item: WireItem): WireItem {
  let bytes = itemBytes(item)
  if (bytes <= ITEM_BYTES_MAX) return item
  switch (item.kind) {
    case 'prompt':
    case 'reply': {
      const original = item.body.clipped ?? item.body.text.length
      let next: WireItem = item
      let text = item.body.text
      while (bytes > ITEM_BYTES_MAX && text.length > 0) {
        text = text.slice(0, Math.floor((text.length * ITEM_BYTES_MAX * 0.9) / bytes))
        next = { ...item, body: { text, clipped: original } }
        bytes = itemBytes(next)
      }
      return next
    }
    case 'tools': {
      let next: WireItem = item
      let tools = item.tools
      while (bytes > ITEM_BYTES_MAX && tools.length > 0) {
        tools = tools.slice(Math.ceil(tools.length / 4))
        next = { ...item, tools }
        bytes = itemBytes(next)
      }
      return next
    }
    case 'question': {
      let next: WireItem = item
      let questions = item.questions
      while (bytes > ITEM_BYTES_MAX && questions.length > 0) {
        questions = questions.slice(0, -1)
        next = { ...item, questions, clipped: true }
        bytes = itemBytes(next)
      }
      return next
    }
    case 'note':
      return { ...item, text: item.text === null ? null : item.text.slice(0, 500), clipped: true }
  }
}

/** 말풍선 하나 → 보내는 모양. 홈 경로를 가리고 자른다 — 생각·결과 본문은 애초에 말풍선에 없다(`chat-parse.ts`). */
export function wireItem(input: { item: ChatItem; place: Place }): WireItem {
  const { item, place } = input
  switch (item.kind) {
    case 'prompt':
    case 'reply':
      return fitItem({ id: item.id, kind: item.kind, at: item.at, body: clipText({ text: item.text, place, max: ITEM_TEXT_MAX }) })
    case 'tools': {
      const counted: Record<string, number> = {}
      for (const tool of item.tools) {
        const name = maskLine({ text: tool.name, place, max: 80 }) ?? '?'
        counted[name] = (counted[name] ?? 0) + 1
      }
      const names = Object.fromEntries(Object.entries(counted).sort((a, b) => b[1] - a[1]).slice(0, TOOL_NAMES_MAX))
      const tools = item.tools.slice(-TOOLS_MAX).map((tool) => ({ name: maskLine({ text: tool.name, place, max: 80 }), target: maskLine({ text: tool.target, place, max: TOOL_TARGET_MAX }), status: tool.status }))
      return fitItem({ id: item.id, kind: 'tools', at: item.at, tools, count: item.tools.length, names, detail: item.tools.some((tool) => tool.name !== null) })
    }
    case 'question': {
      const wired = wireQuestions({ questions: item.questions, place })
      const answer = item.answer === null ? null : clipText({ text: item.answer, place, max: 2000 })
      return fitItem({ id: item.id, kind: 'question', at: item.at, call: item.call, digest: questionDigest(item.questions), questions: wired.questions, state: item.state, answer: answer?.text ?? null, clipped: wired.clipped || (answer?.clipped ?? null) !== null })
    }
    case 'note': {
      const text = item.text === null ? null : clipText({ text: item.text, place, max: 2000 })
      return fitItem({ id: item.id, kind: 'note', at: item.at, note: item.note, text: text?.text ?? null, clipped: (text?.clipped ?? null) !== null })
    }
  }
}

// --- 판독자 (파일 하나) -------------------------------------------------------------------------------

type ReaderState = { kind: 'indexing' } | { kind: 'ready' } | { kind: 'failed'; reason: ChatUnavailable }

type FileIdentity = { dev: number; ino: number }
/** 이미 읽은 구간의 앞·뒤 해시 — 파일이 바뀔 때 다시 대 보아 덮어쓰기를 잡는다(R1-A4). */
type Anchors = { known: number; head: string; tail: string }

export type ChatReaderDeps = {
  log: (tag: string, fields?: Record<string, unknown>) => void
  pollMs: number
  now: () => number
}

/** `readMs` = 그 변화를 읽은 꼬리 확인 한 번의 시간(stat·덮어쓰기 확인·읽기·파싱·변경 고르기) — push 비용(Y10ⓓ) 의 앞 구간(C2). */
/** `before` = 이 변화 직전의 변경 순번 — 나눠 보내는 앞 프레임에 싣는다(R2-A1). */
export type ChatReaderEvent = { kind: 'ready' } | { kind: 'reset' } | { kind: 'items'; ids: number[]; before: number; readAt: number; readMs: number } | { kind: 'failed' }

/** 한 기록 파일의 색인 + 꼬리. 구독자는 `ChatHub` 가 쥔다 — 판독자는 바뀐 것을 알린다(`onEvent`). */
export class ChatReader {
  readonly file: string
  readonly agent: TranscriptAgent
  readonly sessionId: string | null
  private readonly deps: ChatReaderDeps
  private builder: ChatBuilder
  private identity: FileIdentity | null = null
  private anchors: Anchors | null = null
  /** 다음에 읽을 바이트(마지막 완성 줄의 끝). */
  private end = 0
  private mtimeMs = 0
  private carry: Buffer = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = false
  private rewinds = 0
  /** 색인 한 번마다 새 값 — 세대의 앞부분(R1-A4). */
  private nonce = ''
  /** 변경 순번(R1-A2) — 말풍선이 생기거나 바뀔 때마다 +1, 그 말풍선의 `revs` 에 남는다. */
  private seq = 0
  private readonly revs = new Map<number, number>()
  /** 구독 0 — 읽지 않는다(R1-A3). `resume` 이 따라잡고 다시 돈다. */
  paused = false
  state: ReaderState = { kind: 'indexing' }
  gen = ''
  /** 시험·계측 — 이 판독자가 지금까지 읽은 바이트·색인 횟수·꼬리 확인 횟수. */
  readonly cost = { bytes: 0, indexes: 0, polls: 0 }
  onEvent: (event: ChatReaderEvent) => void = () => {}

  constructor(input: { file: string; agent: TranscriptAgent; sessionId: string | null; deps: ChatReaderDeps }) {
    this.file = input.file
    this.agent = input.agent
    this.sessionId = input.sessionId
    this.deps = input.deps
    this.builder = new ChatBuilder({ agent: input.agent, sessionId: input.sessionId })
  }

  start(): void {
    void this.index().then(() => this.arm())
  }

  stop(): void {
    this.stopped = true
    this.disarm()
  }

  /** 구독 0 — 꼬리 확인을 멈춘다. 색인은 그대로 든다. */
  pause(): void {
    this.paused = true
    this.disarm()
  }

  /** 다시 구독 — 멈춘 동안 늘어난 것을 한 번 따라잡고 꼬리 확인을 다시 돌린다. 도중에 멈춘 첫 색인은 처음부터 다시(R2-A3). */
  async resume(): Promise<void> {
    if (!this.paused) return
    this.paused = false
    if (this.state.kind === 'ready') await this.poll()
    else if (this.state.kind === 'indexing' && !this.busy) await this.index()
    this.arm()
  }

  items(): readonly ChatItem[] {
    return this.builder.items
  }

  /** 지금 변경 순번 — 보내는 페이지·push 에 싣는다. */
  cursor(): number {
    return this.seq
  }

  revOf(id: number): number {
    return this.revs.get(id) ?? 0
  }

  writtenAt(): number {
    return this.mtimeMs
  }

  stats(): ChatBuilder['stats'] {
    return this.builder.stats
  }

  private arm(): void {
    if (this.stopped || this.paused || this.timer !== null || this.state.kind !== 'ready') return
    this.timer = setInterval(() => void this.poll(), this.deps.pollMs)
    this.timer.unref()
  }

  private disarm(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private genOf(): string {
    return `${this.nonce}.${this.rewinds}`
  }

  /** 바뀐 말풍선에 새 순번을 붙인다. */
  private stamp(): number[] {
    const ids = [...this.builder.changed()]
    if (ids.length === 0) return ids
    this.seq += 1
    for (const id of ids) this.revs.set(id, this.seq)
    return ids
  }

  private async hashRange(input: { handle: fs.promises.FileHandle; start: number; end: number }): Promise<string> {
    const length = Math.max(0, input.end - input.start)
    const buffer = Buffer.alloc(length)
    if (length > 0) await input.handle.read(buffer, 0, length, input.start)
    return createHash('sha1').update(buffer).digest('hex')
  }

  /** 지금까지 읽은 구간(`end + carry`)의 앞·뒤 해시. */
  private async readAnchors(known: number): Promise<Anchors> {
    const handle = await fs.promises.open(this.file, 'r')
    try {
      const head = await this.hashRange({ handle, start: 0, end: Math.min(ANCHOR_BYTES, known) })
      const tail = await this.hashRange({ handle, start: Math.max(0, known - ANCHOR_BYTES), end: known })
      return { known, head, tail }
    } finally {
      await handle.close()
    }
  }

  /** 처음부터 색인 — 조각마다 이벤트 루프에 양보한다. 세대는 늘 새로 뽑는다. */
  private async index(): Promise<void> {
    this.busy = true
    const started = performance.now()
    try {
      const stat = await fs.promises.stat(this.file)
      this.builder = new ChatBuilder({ agent: this.agent, sessionId: this.sessionId })
      this.end = 0
      this.carry = Buffer.alloc(0)
      this.identity = { dev: stat.dev, ino: stat.ino }
      this.mtimeMs = stat.mtimeMs
      this.revs.clear()
      this.cost.indexes += 1
      await this.readTo(stat.size)
      if (this.paused && this.end + this.carry.length < stat.size) {
        // 구독이 다 떠났다 — 다 못 읽은 색인은 공개하지 않는다(R2-A3). 다시 열면 `resume` 이 처음부터 색인한다.
        this.state = { kind: 'indexing' }
        this.deps.log('mobile.chat_index_paused', { agent: this.agent, bytes: this.end + this.carry.length, of: stat.size })
        return
      }
      this.stamp()
      this.anchors = await this.readAnchors(this.end + this.carry.length)
      this.rewinds = this.builder.rewinds
      this.nonce = randomBytes(6).toString('hex')
      this.gen = this.genOf()
      const wasReady = this.state.kind === 'ready'
      this.state = { kind: 'ready' }
      this.deps.log('mobile.chat_index', { agent: this.agent, bytes: stat.size, items: this.builder.items.length, ms: Math.round(performance.now() - started), lines: this.builder.stats.lines })
      this.onEvent(wasReady ? { kind: 'reset' } : { kind: 'ready' })
    } catch (error) {
      this.state = { kind: 'failed', reason: 'unreadable' }
      this.deps.log('mobile.chat_index_failed', { agent: this.agent, error: error instanceof Error ? error.name : 'error' })
      this.onEvent({ kind: 'failed' })
    } finally {
      this.busy = false
    }
  }

  /** `end` 부터 `size` 까지 조각 읽기 — 완성된 줄만 조립기에 먹인다(개행 없는 끝은 `carry` 에 보류). */
  private async readTo(size: number): Promise<void> {
    if (size <= this.end + this.carry.length) return
    const handle = await fs.promises.open(this.file, 'r')
    try {
      let position = this.end + this.carry.length
      // 구독 0 이면 다음 조각 전에 멈춘다(R2-A3) — 읽은 데까지는 `end`·`carry` 에 그대로 있다.
      while (position < size && !this.stopped && !this.paused) {
        const length = Math.min(READ_CHUNK, size - position)
        const chunk = Buffer.alloc(length)
        const { bytesRead } = await handle.read(chunk, 0, length, position)
        if (bytesRead === 0) break
        this.cost.bytes += bytesRead
        position += bytesRead
        this.consume(chunk.subarray(0, bytesRead))
        // 다음 조각 전에 양보 — 큰 기록 색인이 main 을 오래 잡지 않게(X5 p99 ≤ 50 ms).
        if (position < size) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      await handle.close()
    }
  }

  private consume(chunk: Buffer): void {
    const buffer = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk])
    let start = 0
    for (;;) {
      const newline = buffer.indexOf(0x0a, start)
      if (newline < 0) break
      const line = buffer.toString('utf8', start, newline)
      this.builder.feed({ offset: this.end + start, line })
      start = newline + 1
    }
    this.end += start
    this.carry = Buffer.from(buffer.subarray(start))
  }

  /** 꼬리 확인 — 커졌으면 이어 읽고, 정체가 바뀌었거나 줄었거나 읽은 구간이 덮어쓰였으면 처음부터. */
  private async poll(): Promise<void> {
    if (this.busy || this.stopped || this.state.kind !== 'ready') return
    this.busy = true
    this.cost.polls += 1
    let reindex = false
    try {
      reindex = await this.tail()
    } catch {
      // 파일이 잠깐 사라졌다(교체 중) — 다음 주기에 다시 본다. 정체가 바뀌었으면 그때 처음부터.
    } finally {
      this.busy = false
    }
    if (reindex && !this.stopped) await this.index()
  }

  /** 늘어난 바이트를 읽는다. 처음부터 다시 읽어야 하면 true. */
  private async tail(): Promise<boolean> {
    const started = performance.now()
    const stat = await fs.promises.stat(this.file)
    const identity = this.identity
    const known = this.end + this.carry.length
    if (identity === null || stat.ino !== identity.ino || stat.dev !== identity.dev || stat.size < known) return true
    if (stat.size === known && stat.mtimeMs === this.mtimeMs) return false
    // 파일이 바뀌었다 — 이어 쓰기면 읽은 구간은 그대로다. 앞·뒤 해시가 다르면 덮어쓰기(같은 크기·앞부분 재작성)다.
    const before = this.anchors
    const now = await this.readAnchors(known)
    if (before === null || before.head !== now.head || before.tail !== now.tail) return true
    this.mtimeMs = stat.mtimeMs
    await this.readTo(stat.size)
    this.anchors = await this.readAnchors(this.end + this.carry.length)
    const readAt = this.deps.now()
    const seqBefore = this.seq
    const ids = this.stamp()
    if (this.builder.rewinds !== this.rewinds) {
      // rewind — 앞 말풍선이 사라졌다. 세대를 바꿔 모두 처음부터 받게 한다(X2ⓘ·X6).
      this.rewinds = this.builder.rewinds
      this.gen = this.genOf()
      this.onEvent({ kind: 'reset' })
      return false
    }
    if (ids.length > 0) this.onEvent({ kind: 'items', ids, before: seqBefore, readAt, readMs: performance.now() - started })
    return false
  }
}

// --- 허브 (구독) ---------------------------------------------------------------------------------------

/** 이어 받기 — 받은 세대 · 들고 있는 첫 말풍선 id · 받은 가장 큰 변경 순번. */
export type ChatResume = { gen: string; from: number; cursor: number } | null

export type ChatSubscription = {
  /** 과거 페이지 — `before` 보다 앞 말풍선. 세대가 다르면 무시한다(폰은 곧 reset 을 받는다). */
  older(input: { gen: string; before: number }): void
  close(): void
}

type ReaderEntry = { reader: ChatReader; subs: Set<Sub>; grace: NodeJS.Timeout | null }

/** 구독이 지금 어디 있나 — 판독자에 붙음 · 일시 부재로 기다림(R2-A4) · 끝. */
type Link = { kind: 'attached'; entry: ReaderEntry; channel: ChatChannel; origin: string } | { kind: 'waiting'; reason: ChatUnavailable } | { kind: 'ended' }

type Sub = {
  channelId: string
  sink: (text: string) => void
  resume: ChatResume
  /** 첫 페이지를 보냈나 — 그 전의 꼬리 변화는 첫 페이지에 들어간다. */
  started: boolean
  /** 세션이 바뀌면 다른 판독자로 옮긴다(R1-A1). 일시 부재면 기다린다(R2-A4). */
  link: Link
  /** 이 구독에 보낸 범위의 첫 id — 그보다 앞 말풍선의 갱신은 보내지 않는다(R2-A2). */
  low: number
  /** 구독 입구(또는 세션 교체·회복으로 다시 붙은) 시각 — 첫 페이지 준비까지의 시간(Y4, C2·R2-A5). */
  since: number
}

export type ChatHubDeps = {
  /** 목록 재료 — 채널 id 를 세션으로 옮길 때만 부른다. */
  read: () => ListInput | null
  /** 세션 참조 → 기록 파일. 기본은 지문과 같은 경로 찾기(`resolveTranscriptFile`) + Grok 은 같은 폴더의 `updates.jsonl`. */
  resolveFile: (input: { session: AgentSessionRef; agent: TranscriptAgent }) => string | null
  log: (tag: string, fields?: Record<string, unknown>) => void
  pollMs?: number
  graceMs?: number
  refreshMs?: number
  retryMs?: number
  followMs?: number
  now?: () => number
}

/** Grok 은 정본 대화가 `updates.jsonl` 이다(X2ⓗ) — 지문이 찾은 `chat_history.jsonl` 의 형제 파일. */
export function chatFileOf(input: { agent: TranscriptAgent; transcript: string }): string {
  return input.agent === 'grok' ? path.join(path.dirname(input.transcript), 'updates.jsonl') : input.transcript
}

/** `origin` = 참조가 찾은 파일, `file`·`sessionId` = 거기서 이어 가기를 따라간 읽을 파일과 그 세션 id(LIFE-766). */
type Located = { ok: true; channel: ChatChannel; origin: string; file: string; sessionId: string | null } | { ok: false; reason: ChatUnavailable }

/** 이어 가기가 있는 참조 — Claude 의 id 참조(`followContinued` 와 같은 조건). */
const followable = (session: AgentSessionRef): boolean => session.kind === 'id' && session.agent === 'claude'

const round = (ms: number): number => Math.round(ms * 100) / 100

export class ChatHub {
  private readonly deps: ChatHubDeps
  private readonly readers = new Map<string, ReaderEntry>()
  private readonly subs = new Set<Sub>()
  private refreshTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private followTimer: NodeJS.Timeout | null = null

  constructor(deps: ChatHubDeps) {
    this.deps = deps
  }

  /** 시험·계측 — 살아 있는 판독자 수와 구독 수(기다리는 구독 포함). */
  readerCount(): number {
    return this.readers.size
  }

  readerFor(file: string): ChatReader | null {
    return this.readers.get(file)?.reader ?? null
  }

  subscriberCount(): number {
    return this.subs.size
  }

  /**
   * 대화 열기. 못 열면 `chat.unavailable` 한 건 — 채널이 목록에 없으면 빈 구독(닫아도 아무 일 없다),
   * 일시 부재(`retrying`)면 구독을 들고 기다렸다가 회복되면 첫 페이지를 보낸다(R2-A4).
   */
  subscribe(input: { channelId: string; resume: ChatResume; sink: (text: string) => void }): ChatSubscription {
    const since = performance.now()
    const none: ChatSubscription = { older: () => {}, close: () => {} }
    const sub: Sub = { channelId: input.channelId, sink: input.sink, resume: input.resume, started: false, link: { kind: 'ended' }, low: Number.NEGATIVE_INFINITY, since }
    const found = this.locate(input.channelId)
    if (!found.ok && !TRANSIENT.has(found.reason)) {
      this.unavailable({ sub, reason: found.reason, retrying: false })
      return none
    }
    this.subs.add(sub)
    if (found.ok) this.attach({ sub, located: found })
    else this.wait({ sub, reason: found.reason })
    if (sub.link.kind === 'ended') return none
    if (found.ok) this.deps.log('mobile.chat_subscribe', { agent: found.channel.agent, status: found.channel.status, readers: this.readers.size })
    return {
      older: (request) => this.older({ sub, ...request }),
      close: () => this.detach(sub),
    }
  }

  /** 목록 재료(main 상태)가 바뀌었다 — 열린 대화가 없으면 아무 일도 없다(K9). 뭉쳐서 구독마다 세션을 다시 고른다(R1-A1). */
  changed(): void {
    if (this.subs.size === 0 || this.refreshTimer !== null) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.refresh()
    }, this.deps.refreshMs ?? CHAT_REFRESH_MS)
    this.refreshTimer.unref()
  }

  stop(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.followTimer !== null) clearInterval(this.followTimer)
    this.followTimer = null
    for (const entry of this.readers.values()) {
      entry.reader.stop()
      if (entry.grace !== null) clearTimeout(entry.grace)
    }
    this.readers.clear()
    for (const sub of this.subs) sub.link = { kind: 'ended' }
    this.subs.clear()
  }

  /**
   * 구독마다 채널 → 세션 → 파일을 다시 고른다. 파일이 바뀌었으면 새 판독자로 옮겨 처음부터(R1-A1), 채널이 목록에서 사라졌으면 `chat.unavailable` 뒤 끝.
   * 일시 부재(R2-A4): 상태를 못 읽음(`not_ready` — 목록 연결 중 포함)이면 붙은 구독은 그대로 읽고, 세션 참조·파일이 아직 없으면 판독자를 떼고 기다린다.
   * 기다리는 구독이 있으면 `CHAT_RETRY_MS` 뒤에 다시 본다 — 회복되면 처음부터(`reset`).
   */
  refresh(): void {
    for (const sub of [...this.subs]) {
      const link = sub.link
      if (link.kind === 'ended') continue
      const found = this.locate(sub.channelId)
      if (!found.ok) {
        if (found.reason === 'not_ready' && link.kind === 'attached') continue
        if (TRANSIENT.has(found.reason)) {
          this.wait({ sub, reason: found.reason })
          continue
        }
        this.detach(sub)
        this.unavailable({ sub, reason: found.reason, retrying: false })
        continue
      }
      if (link.kind === 'attached' && found.file === link.entry.reader.file) {
        sub.link = { ...link, channel: found.channel, origin: found.origin }
        continue
      }
      if (link.kind === 'attached') this.deps.log(found.origin === link.origin ? 'mobile.chat_continued' : 'mobile.chat_session_switch', { agent: found.channel.agent })
      else this.deps.log('mobile.chat_recovered', { agent: found.channel.agent, reason: link.reason })
      this.moveTo({ sub, located: found })
    }
    if ([...this.subs].some((sub) => sub.link.kind === 'waiting')) this.armRetry()
  }

  /** 다른 파일로 옮긴다 — 처음부터(`reset`). */
  private moveTo(input: { sub: Sub; located: Extract<Located, { ok: true }> }): void {
    const { sub } = input
    this.leave(sub)
    sub.started = false
    sub.resume = null
    sub.since = performance.now()
    this.attach(input)
  }

  /** 붙어 있는 Claude 구독의 이어 가기 확인(LIFE-766) — `changed()` 없이 돈다. 판별만 다시 하고 채널·폴더는 다시 찾지 않는다. 볼 구독이 없으면 멈춘다. */
  private followTick(): void {
    let watching = false
    for (const sub of [...this.subs]) {
      const link = sub.link
      if (link.kind !== 'attached' || !followable(link.channel.session)) continue
      watching = true
      const followed = followContinued({ session: link.channel.session, file: link.origin })
      if (followed.file === link.entry.reader.file || !fs.existsSync(followed.file)) continue
      this.deps.log('mobile.chat_continued', { agent: link.channel.agent, hops: followed.hops.length })
      this.moveTo({ sub, located: { ok: true, channel: link.channel, origin: link.origin, file: followed.file, sessionId: followed.sessionId } })
    }
    if (watching || this.followTimer === null) return
    clearInterval(this.followTimer)
    this.followTimer = null
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.refresh()
    }, this.deps.retryMs ?? CHAT_RETRY_MS)
    this.retryTimer.unref()
  }

  private locate(channelId: string): Located {
    const list = this.deps.read()
    if (list === null) return { ok: false, reason: 'not_ready' }
    const found = chatChannel({ list, channelId })
    if (!found.ok) return found
    const file = this.deps.resolveFile({ session: found.channel.session, agent: found.channel.agent })
    if (file === null || !fs.existsSync(file)) return { ok: false, reason: 'no_file' }
    const followed = followContinued({ session: found.channel.session, file })
    return { ok: true, channel: found.channel, origin: file, file: followed.file, sessionId: followed.sessionId }
  }

  private unavailable(input: { sub: Sub; reason: ChatUnavailable; retrying: boolean }): void {
    input.sub.sink(JSON.stringify({ type: 'chat.unavailable', channel: input.sub.channelId, reason: input.reason, retrying: input.retrying }))
    this.deps.log('mobile.chat_unavailable', { reason: input.reason, retrying: input.retrying })
  }

  /** 일시 부재 — 판독자에서 떼고 구독은 든다. 같은 사유로 이미 기다리는 중이면 다시 알리지 않는다(R2-A4). */
  private wait(input: { sub: Sub; reason: ChatUnavailable }): void {
    const { sub } = input
    const was = sub.link
    this.leave(sub)
    sub.started = false
    sub.resume = null
    sub.link = { kind: 'waiting', reason: input.reason }
    if (was.kind !== 'waiting' || was.reason !== input.reason) this.unavailable({ sub, reason: input.reason, retrying: true })
    this.armRetry()
  }

  /** 구독을 판독자에 붙인다 — 멈춰 있던 판독자면 따라잡은 뒤, 준비됐으면 곧장 첫 페이지. */
  private attach(input: { sub: Sub; located: Extract<Located, { ok: true }> }): void {
    const { sub, located } = input
    const entry = this.entry(located)
    entry.subs.add(sub)
    sub.link = { kind: 'attached', entry, channel: located.channel, origin: located.origin }
    if (followable(located.channel.session) && this.followTimer === null) {
      this.followTimer = setInterval(() => this.followTick(), this.deps.followMs ?? CHAT_FOLLOW_MS)
      this.followTimer.unref()
    }
    if (entry.grace !== null) clearTimeout(entry.grace)
    entry.grace = null
    const reader = entry.reader
    if (reader.state.kind === 'failed') {
      const reason = reader.state.reason
      this.detach(sub)
      this.unavailable({ sub, reason, retrying: false })
      return
    }
    if (reader.paused) {
      void reader.resume().then(() => this.startPending(entry))
      return
    }
    if (reader.state.kind === 'ready') this.start(sub)
  }

  /** 구독 끝 — 판독자에서 떼고 구독 목록에서도 뺀다. */
  private detach(sub: Sub): void {
    this.leave(sub)
    this.subs.delete(sub)
  }

  /** 판독자에서만 뗀다. 그 판독자의 마지막 구독이면 그 자리에서 읽기를 멈추고(색인 중이어도, R2-A3) 유예 뒤에 버린다(R1-A3). */
  private leave(sub: Sub): void {
    const link = sub.link
    sub.link = { kind: 'ended' }
    if (link.kind !== 'attached') return
    const entry = link.entry
    if (!entry.subs.delete(sub) || entry.subs.size > 0) return
    entry.reader.pause()
    if (entry.grace !== null) return
    const file = entry.reader.file
    entry.grace = setTimeout(() => {
      entry.grace = null
      if (entry.subs.size > 0) return
      entry.reader.stop()
      this.readers.delete(file)
      this.deps.log('mobile.chat_reader_drop', { readers: this.readers.size })
    }, this.deps.graceMs ?? CHAT_GRACE_MS)
    entry.grace.unref()
  }

  private entry(input: { file: string; channel: ChatChannel; sessionId: string | null }): ReaderEntry {
    const existing = this.readers.get(input.file)
    if (existing !== undefined) return existing
    const reader = new ChatReader({
      file: input.file,
      agent: input.channel.agent,
      sessionId: input.sessionId,
      deps: { log: this.deps.log, pollMs: this.deps.pollMs ?? CHAT_POLL_MS, now: this.deps.now ?? Date.now },
    })
    const entry: ReaderEntry = { reader, subs: new Set(), grace: null }
    reader.onEvent = (event) => this.onReader({ entry, event })
    this.readers.set(input.file, entry)
    reader.start()
    return entry
  }

  private startPending(entry: ReaderEntry): void {
    if (entry.reader.state.kind !== 'ready' || entry.reader.paused) return
    for (const sub of [...entry.subs]) if (!sub.started) this.start(sub)
  }

  private onReader(input: { entry: ReaderEntry; event: ChatReaderEvent }): void {
    const { entry, event } = input
    switch (event.kind) {
      case 'ready':
        return this.startPending(entry)
      case 'reset':
        for (const sub of [...entry.subs]) this.sendPage({ sub, mode: 'reset', items: this.latest(entry) })
        return
      case 'failed':
        for (const sub of [...entry.subs]) {
          this.detach(sub)
          this.unavailable({ sub, reason: 'unreadable', retrying: false })
        }
        return
      case 'items':
        this.broadcast({ entry, ids: event.ids, before: event.before, readAt: event.readAt, readMs: event.readMs })
    }
  }

  /**
   * 첫 페이지 — 이어 받기가 맞으면(같은 세대) `from` 이후 말풍선 중 `cursor` 뒤에 생기거나 바뀐 것 전부(`resume`, R1-A2),
   * 아니면 최근 페이지(`reset`). 이어 받을 것이 `CHAT_RESUME_MAX` 를 넘어도 `reset`.
   */
  private start(sub: Sub): void {
    if (sub.link.kind !== 'attached') return
    const reader = sub.link.entry.reader
    const resume = sub.resume
    if (resume !== null && resume.gen === reader.gen && resume.cursor <= reader.cursor()) {
      const all = reader.items()
      const changed = all.filter((item) => item.id >= resume.from && reader.revOf(item.id) > resume.cursor)
      if (changed.length <= CHAT_RESUME_MAX) {
        this.sendPage({ sub, mode: 'resume', items: changed, hasOlder: (all[0]?.id ?? resume.from) < resume.from, resume })
        return
      }
    }
    this.sendPage({ sub, mode: 'reset', items: this.latest(sub.link.entry) })
  }

  private latest(entry: ReaderEntry): readonly ChatItem[] {
    const items = entry.reader.items()
    return items.slice(Math.max(0, items.length - CHAT_PAGE_SIZE))
  }

  private older(input: { sub: Sub; gen: string; before: number }): void {
    const { sub } = input
    if (sub.link.kind !== 'attached') return
    const reader = sub.link.entry.reader
    if (reader.state.kind !== 'ready' || input.gen !== reader.gen) return
    const items = reader.items()
    let end = items.findIndex((item) => item.id >= input.before)
    if (end < 0) end = items.length
    this.sendPage({ sub, mode: 'older', items: items.slice(Math.max(0, end - CHAT_PAGE_SIZE), end) })
  }

  /**
   * 페이지 보내기. `reset`·`older` 는 프레임 하나 — 넘치면 앞(오래된) 말풍선부터 덜어 낸다(`hasOlder` 가 남은 것을 말한다).
   * `resume` 은 넘치면 첫 프레임 뒤를 `chat.items` 로 나눠 보낸다(빠짐 없이). 말풍선 하나는 `ITEM_BYTES_MAX` 이하라 늘 한 프레임에 든다.
   * 나눈 앞 프레임은 이어 받기 전 순번을 싣는다 — 마지막 프레임을 받아야 새 순번이 확정된다(R2-A1).
   * 보낸 범위의 첫 id 를 구독에 남긴다(`low`, R2-A2).
   */
  private sendPage(input: { sub: Sub; mode: 'reset' | 'resume' | 'older'; items: readonly ChatItem[]; hasOlder?: boolean; resume?: { from: number; cursor: number } }): void {
    const { sub, mode } = input
    if (sub.link.kind !== 'attached') return
    const reader = sub.link.entry.reader
    const place = sub.link.channel.place
    const all = reader.items()
    const wire = input.items.map((item) => wireItem({ item, place }))
    const cursor = reader.cursor()
    const base = { channel: sub.channelId, gen: reader.gen, at: this.now(), writtenAt: reader.writtenAt() }
    let texts: string[]
    let low: number
    if (mode === 'resume') {
      const frames = frameItems(wire)
      const partial = input.resume?.cursor ?? cursor
      texts = frames.map((items, index) => {
        const frameCursor = index === frames.length - 1 ? cursor : partial
        return index === 0
          ? JSON.stringify({ type: 'chat.page', mode, ...base, cursor: frameCursor, hasOlder: input.hasOlder ?? false, items })
          : JSON.stringify({ type: 'chat.items', ...base, cursor: frameCursor, readAt: base.at, items })
      })
      low = input.resume?.from ?? wire[0]?.id ?? Number.NEGATIVE_INFINITY
    } else {
      let items = wire
      let text = ''
      for (;;) {
        const firstId = items[0]?.id
        const hasOlder = firstId !== undefined && (all[0]?.id ?? firstId) < firstId
        text = JSON.stringify({ type: 'chat.page', mode, ...base, cursor, hasOlder, items })
        if (Buffer.byteLength(text) <= MAX_FRAME_BYTES || items.length <= 1) break
        items = items.slice(Math.ceil(items.length / 4))
      }
      texts = [text]
      const first = items[0]?.id
      low = mode === 'older' ? Math.min(sub.low, first ?? sub.low) : (first ?? Number.NEGATIVE_INFINITY)
    }
    // 첫 페이지면 구독 입구부터 보낼 프레임이 다 준비될 때까지(세션 찾기·가림·변환·크기 조절·직렬화 포함 — Y4 「첫 페이지 서버 준비」, C2·R2-A5).
    const firstPageMs = sub.started ? null : round(performance.now() - sub.since)
    sub.started = true
    sub.low = low
    for (const text of texts) sub.sink(text)
    this.deps.log('mobile.chat_page', { mode, items: wire.length, frames: texts.length, bytes: texts.reduce((sum, text) => sum + text.length, 0), firstPageMs })
  }

  /**
   * 바뀐 말풍선 push — 채널·보낸 범위마다 한 번 직렬화해 구독자에게(Y2ⓒ). 첫 페이지 전 구독은 건너뛴다(첫 페이지에 들어간다).
   * 구독이 들고 있지 않은 과거(`low` 앞) 말풍선은 보내지 않는다(R2-A2). 나눈 앞 프레임은 변화 전 순번(R2-A1).
   */
  private broadcast(input: { entry: ReaderEntry; ids: number[]; before: number; readAt: number; readMs: number }): void {
    const { entry } = input
    const started = performance.now()
    const wanted = new Set(input.ids)
    const changed = entry.reader.items().filter((item) => wanted.has(item.id))
    if (changed.length === 0) return
    const cursor = entry.reader.cursor()
    const texts = new Map<string, string[]>()
    let bytes = 0
    let subscribers = 0
    for (const sub of [...entry.subs]) {
      const link = sub.link
      if (!sub.started || link.kind !== 'attached') continue
      const held = changed.filter((item) => item.id >= sub.low)
      if (held.length === 0) continue
      const key = `${sub.channelId}\u0000${sub.low}`
      let frames = texts.get(key)
      if (frames === undefined) {
        const base = { type: 'chat.items', channel: sub.channelId, gen: entry.reader.gen, at: this.now(), readAt: input.readAt, writtenAt: entry.reader.writtenAt() }
        const parts = frameItems(held.map((item) => wireItem({ item, place: link.channel.place })))
        frames = parts.map((items, index) => JSON.stringify({ ...base, cursor: index === parts.length - 1 ? cursor : input.before, items }))
        texts.set(key, frames)
        for (const frame of frames) bytes += frame.length
      }
      for (const frame of frames) sub.sink(frame)
      subscribers += 1
    }
    // 대화 push 1회 비용(Y10ⓓ 재료) — 개수·크기·시간만, 글은 남기지 않는다. `readMs` = 그 변화를 읽은 꼬리 확인(stat·덮어쓰기 확인·읽기·파싱),
    // `sendMs` = 변경 고르기·범위 거르기·변환·직렬화·발송, `totalMs` = 둘의 합(C2·R2-A5).
    const sendMs = performance.now() - started
    this.deps.log('mobile.chat_push', { items: changed.length, bytes, subscribers, readMs: round(input.readMs), sendMs: round(sendMs), totalMs: round(input.readMs + sendMs) })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}

/** 말풍선 배열을 프레임 상한 안의 묶음들로 — 순서 그대로. 말풍선 하나는 `ITEM_BYTES_MAX` 이하(`fitItem`). */
function frameItems(items: WireItem[]): WireItem[][] {
  const frames: WireItem[][] = []
  let current: WireItem[] = []
  let size = 512
  for (const item of items) {
    const itemSize = Buffer.byteLength(JSON.stringify(item))
    if (current.length > 0 && size + itemSize > MAX_FRAME_BYTES) {
      frames.push(current)
      current = []
      size = 512
    }
    current.push(item)
    size += itemSize + 1
  }
  if (current.length > 0 || frames.length === 0) frames.push(current)
  return frames
}
