// 대화 구독 (LIFE-581 X3~X6) — 인증된 연결이 채널 id 로 대화를 열면 그 세션 기록을 말풍선으로 보낸다. electron·소켓을 모른다.
//
// - **열린 대화가 0 이면 아무것도 읽지 않는다**(K9) — 판독자는 첫 구독에 생기고 마지막 구독이 떠난 뒤 `graceMs` 에 사라진다.
// - **파일 하나에 판독자 하나**(Y2ⓒ) — 같은 기록을 여러 연결이 열어도 색인·꼬리 읽기는 한 벌, push 직렬화는 채널마다 한 번.
// - 판독: 처음 한 번 파일 전체를 **비동기로 조각 읽기**(1 MiB 씩, 조각 사이 이벤트 루프 양보 — 동기 전체 읽기 없음, X5) → 말풍선 배열.
//   그 뒤 `pollMs` 마다 stat 하고 늘어난 바이트만 이어 읽는다(바이트 오프셋). 개행으로 끝나지 않은 마지막 줄은 개행이 올 때까지 보류(X4).
// - **세대(gen)** = 파일 정체(장치·inode·생성 시각·첫 줄 해시) + Claude rewind 수. 파일이 바뀌거나(교체·줄어듦) rewind 로 앞 말풍선이 사라지면
//   세대가 바뀌고 구독자 모두에게 처음부터(`reset`) 보낸다(X6). 같은 파일·같은 내용이면 다시 색인해도 같은 세대·같은 id 다 — 재연결 이어 받기의 근거.
// - 보내는 글은 전부 홈 경로를 가린다(`maskPaths` — 목록과 같은 계약, X3) · 한 글 `ITEM_TEXT_MAX` 자, 넘으면 `clipped`(원래 길이)를 붙여 자른다.
//   프레임 하나 `MAX_FRAME_BYTES` — 넘으면 페이지를 줄이거나 나눠 보낸다.
// - 폰이 주는 것은 채널 id·세대·말풍선 id(숫자) 뿐이다 — 파일 경로·세션 id 는 서버 안에서 `chatChannel`(목록과 같은 함수로 만든 목록)로만 고른다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRef, SessionQuestion, TranscriptAgent } from '../../shared/types.js'
import { ChatBuilder, type ChatItem, type ChatTool } from '../chat-parse.js'
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
/** 조각 읽기 크기. */
const READ_CHUNK = 1024 * 1024
/** 세대에 넣는 첫 줄 해시 범위. */
const HEAD_HASH_BYTES = 4096

// --- 보내는 모양 -------------------------------------------------------------------------------------

export type WireText = { text: string; clipped: number | null }
export type WireTool = { name: string | null; target: string | null; status: ChatTool['status'] }
export type WireItem =
  | { id: number; kind: 'prompt'; at: number | null; body: WireText }
  | { id: number; kind: 'reply'; at: number | null; body: WireText }
  | { id: number; kind: 'tools'; at: number | null; tools: WireTool[]; count: number; names: Record<string, number>; detail: boolean }
  | { id: number; kind: 'question'; at: number | null; questions: SessionQuestion[]; state: 'pending' | 'answered' | 'closed'; answer: string | null }
  | { id: number; kind: 'note'; at: number | null; note: 'interrupted' | 'failed' | 'compacted'; text: string | null }

export type ChatUnavailable = 'not_listed' | 'no_session' | 'no_file' | 'not_ready' | 'unreadable'

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
  const masked = maskPaths({ text: flat.slice(0, input.max * 2), worktree: input.place.worktree, home: input.place.home })
  return masked.length > input.max ? `${masked.slice(0, input.max - 1)}…` : masked
}

function maskQuestion(input: { question: SessionQuestion; place: Place }): SessionQuestion {
  const { question, place } = input
  const line = (text: string | null): string | null => (text === null ? null : clipText({ text, place, max: 2000 }).text)
  return {
    question: line(question.question) ?? '',
    header: line(question.header),
    options: question.options.slice(0, 20).map((option) => ({ label: line(option.label) ?? '', description: line(option.description) })),
    multiSelect: question.multiSelect,
  }
}

/** 말풍선 하나 → 보내는 모양. 홈 경로를 가리고 자른다 — 생각·결과 본문은 애초에 말풍선에 없다(`chat-parse.ts`). */
export function wireItem(input: { item: ChatItem; place: Place }): WireItem {
  const { item, place } = input
  switch (item.kind) {
    case 'prompt':
    case 'reply':
      return { id: item.id, kind: item.kind, at: item.at, body: clipText({ text: item.text, place, max: ITEM_TEXT_MAX }) }
    case 'tools': {
      const names: Record<string, number> = {}
      for (const tool of item.tools) {
        const name = maskLine({ text: tool.name, place, max: 80 }) ?? '?'
        names[name] = (names[name] ?? 0) + 1
      }
      const tools = item.tools.slice(-TOOLS_MAX).map((tool) => ({ name: maskLine({ text: tool.name, place, max: 80 }), target: maskLine({ text: tool.target, place, max: TOOL_TARGET_MAX }), status: tool.status }))
      return { id: item.id, kind: 'tools', at: item.at, tools, count: item.tools.length, names, detail: item.tools.some((tool) => tool.name !== null) }
    }
    case 'question':
      return {
        id: item.id,
        kind: 'question',
        at: item.at,
        questions: item.questions.slice(0, 10).map((question) => maskQuestion({ question, place })),
        state: item.state,
        answer: item.answer === null ? null : clipText({ text: item.answer, place, max: 2000 }).text,
      }
    case 'note':
      return { id: item.id, kind: 'note', at: item.at, note: item.note, text: item.text === null ? null : clipText({ text: item.text, place, max: 2000 }).text }
  }
}

// --- 판독자 (파일 하나) -------------------------------------------------------------------------------

type ReaderState = { kind: 'indexing' } | { kind: 'ready' } | { kind: 'failed'; reason: ChatUnavailable }

type FileIdentity = { dev: number; ino: number; birth: number; head: string }

export type ChatReaderDeps = {
  log: (tag: string, fields?: Record<string, unknown>) => void
  pollMs: number
  now: () => number
}

/** 한 기록 파일의 색인 + 꼬리. 구독자는 `ChatHub` 가 쥔다 — 판독자는 바뀐 것을 알린다(`onEvent`). */
export class ChatReader {
  readonly file: string
  readonly agent: TranscriptAgent
  readonly sessionId: string | null
  private readonly deps: ChatReaderDeps
  private builder: ChatBuilder
  private identity: FileIdentity | null = null
  /** 다음에 읽을 바이트(마지막 완성 줄의 끝). */
  private end = 0
  private mtimeMs = 0
  private carry: Buffer = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = false
  private rewinds = 0
  state: ReaderState = { kind: 'indexing' }
  gen = ''
  /** 시험·계측 — 이 판독자가 지금까지 읽은 바이트·색인 횟수. */
  readonly cost = { bytes: 0, indexes: 0, polls: 0 }
  onEvent: (event: { kind: 'ready' } | { kind: 'reset' } | { kind: 'items'; ids: number[]; readAt: number } | { kind: 'failed' }) => void = () => {}

  constructor(input: { file: string; agent: TranscriptAgent; sessionId: string | null; deps: ChatReaderDeps }) {
    this.file = input.file
    this.agent = input.agent
    this.sessionId = input.sessionId
    this.deps = input.deps
    this.builder = new ChatBuilder({ agent: input.agent, sessionId: input.sessionId })
  }

  start(): void {
    void this.index().then(() => {
      if (this.stopped) return
      this.timer = setInterval(() => void this.poll(), this.deps.pollMs)
      this.timer.unref()
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  items(): readonly ChatItem[] {
    return this.builder.items
  }

  writtenAt(): number {
    return this.mtimeMs
  }

  stats(): ChatBuilder['stats'] {
    return this.builder.stats
  }

  private async identify(stat: fs.Stats): Promise<FileIdentity> {
    const handle = await fs.promises.open(this.file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_HASH_BYTES, stat.size))
      await handle.read(buffer, 0, buffer.length, 0)
      const newline = buffer.indexOf(0x0a)
      const head = createHash('sha1').update(newline < 0 ? buffer : buffer.subarray(0, newline)).digest('hex').slice(0, 12)
      return { dev: stat.dev, ino: stat.ino, birth: Math.round(stat.birthtimeMs), head }
    } finally {
      await handle.close()
    }
  }

  private genOf(identity: FileIdentity): string {
    const base = createHash('sha1').update(`${this.agent}\u0000${identity.dev}:${identity.ino}:${identity.birth}:${identity.head}`).digest('hex').slice(0, 12)
    return `${base}.${this.rewinds}`
  }

  /** 처음부터 색인 — 조각마다 이벤트 루프에 양보한다. */
  private async index(): Promise<void> {
    this.busy = true
    const started = performance.now()
    try {
      const stat = await fs.promises.stat(this.file)
      const identity = await this.identify(stat)
      this.builder = new ChatBuilder({ agent: this.agent, sessionId: this.sessionId })
      this.end = 0
      this.carry = Buffer.alloc(0)
      this.identity = identity
      this.mtimeMs = stat.mtimeMs
      this.cost.indexes += 1
      await this.readTo(stat.size)
      this.builder.changed()
      this.rewinds = this.builder.rewinds
      this.gen = this.genOf(identity)
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
      while (position < size && !this.stopped) {
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

  /** 꼬리 확인 — 커졌으면 이어 읽고, 정체가 바뀌었거나 줄었으면 처음부터. */
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
    const stat = await fs.promises.stat(this.file)
    const identity = this.identity
    if (identity === null || stat.ino !== identity.ino || stat.dev !== identity.dev || stat.size < this.end + this.carry.length) return true
    if (stat.size === this.end + this.carry.length && stat.mtimeMs === this.mtimeMs) return false
    this.mtimeMs = stat.mtimeMs
    await this.readTo(stat.size)
    const readAt = this.deps.now()
    const ids = [...this.builder.changed()]
    if (this.builder.rewinds !== this.rewinds) {
      // rewind — 앞 말풍선이 사라졌다. 세대를 바꿔 모두 처음부터 받게 한다(X2ⓘ·X6).
      this.rewinds = this.builder.rewinds
      this.gen = this.genOf(identity)
      this.onEvent({ kind: 'reset' })
      return false
    }
    if (ids.length > 0) this.onEvent({ kind: 'items', ids, readAt })
    return false
  }
}

// --- 허브 (구독) ---------------------------------------------------------------------------------------

export type ChatResume = { gen: string; after: number } | null

export type ChatSubscription = {
  /** 과거 페이지 — `before` 보다 앞 말풍선. 세대가 다르면 무시한다(폰은 곧 reset 을 받는다). */
  older(input: { gen: string; before: number }): void
  close(): void
}

type Sub = {
  channelId: string
  channel: ChatChannel
  sink: (text: string) => void
  resume: ChatResume
  /** 첫 페이지를 보냈나 — 그 전의 꼬리 변화는 첫 페이지에 들어간다. */
  started: boolean
}

type ReaderEntry = { reader: ChatReader; subs: Set<Sub>; grace: NodeJS.Timeout | null }

export type ChatHubDeps = {
  /** 목록 재료 — 채널 id 를 세션으로 옮길 때만 부른다. */
  read: () => ListInput | null
  /** 세션 참조 → 기록 파일. 기본은 지문과 같은 경로 찾기(`resolveTranscriptFile`) + Grok 은 같은 폴더의 `updates.jsonl`. */
  resolveFile: (input: { session: AgentSessionRef; agent: TranscriptAgent }) => string | null
  log: (tag: string, fields?: Record<string, unknown>) => void
  pollMs?: number
  graceMs?: number
  now?: () => number
}

/** Grok 은 정본 대화가 `updates.jsonl` 이다(X2ⓗ) — 지문이 찾은 `chat_history.jsonl` 의 형제 파일. */
export function chatFileOf(input: { agent: TranscriptAgent; transcript: string }): string {
  return input.agent === 'grok' ? path.join(path.dirname(input.transcript), 'updates.jsonl') : input.transcript
}

export class ChatHub {
  private readonly deps: ChatHubDeps
  private readonly readers = new Map<string, ReaderEntry>()

  constructor(deps: ChatHubDeps) {
    this.deps = deps
  }

  /** 시험·계측 — 살아 있는 판독자 수와 구독 수. */
  readerCount(): number {
    return this.readers.size
  }

  readerFor(file: string): ChatReader | null {
    return this.readers.get(file)?.reader ?? null
  }

  subscriberCount(): number {
    let count = 0
    for (const entry of this.readers.values()) count += entry.subs.size
    return count
  }

  /** 대화 열기. 못 열면 `chat.unavailable` 한 건을 보내고 빈 구독을 돌려준다(닫아도 아무 일 없다). */
  subscribe(input: { channelId: string; resume: ChatResume; sink: (text: string) => void }): ChatSubscription {
    const none: ChatSubscription = { older: () => {}, close: () => {} }
    const unavailable = (reason: ChatUnavailable): ChatSubscription => {
      input.sink(JSON.stringify({ type: 'chat.unavailable', channel: input.channelId, reason }))
      this.deps.log('mobile.chat_unavailable', { reason })
      return none
    }
    const list = this.deps.read()
    if (list === null) return unavailable('not_ready')
    const found = chatChannel({ list, channelId: input.channelId })
    if (!found.ok) return unavailable(found.reason)
    const channel = found.channel
    const file = this.deps.resolveFile({ session: channel.session, agent: channel.agent })
    if (file === null || !fs.existsSync(file)) return unavailable('no_file')
    const entry = this.entry({ file, channel })
    const sub: Sub = { channelId: input.channelId, channel, sink: input.sink, resume: input.resume, started: false }
    entry.subs.add(sub)
    if (entry.grace !== null) clearTimeout(entry.grace)
    entry.grace = null
    if (entry.reader.state.kind === 'ready') this.start({ entry, sub })
    else if (entry.reader.state.kind === 'failed') {
      entry.subs.delete(sub)
      this.release(file)
      return unavailable(entry.reader.state.reason)
    }
    this.deps.log('mobile.chat_subscribe', { agent: channel.agent, status: channel.status, readers: this.readers.size })
    return {
      older: (request) => this.older({ entry, sub, ...request }),
      close: () => {
        if (!entry.subs.delete(sub)) return
        this.release(file)
      },
    }
  }

  stop(): void {
    for (const entry of this.readers.values()) {
      entry.reader.stop()
      if (entry.grace !== null) clearTimeout(entry.grace)
    }
    this.readers.clear()
  }

  private entry(input: { file: string; channel: ChatChannel }): ReaderEntry {
    const existing = this.readers.get(input.file)
    if (existing !== undefined) return existing
    const session = input.channel.session
    const reader = new ChatReader({
      file: input.file,
      agent: input.channel.agent,
      sessionId: session.kind === 'id' ? session.id : null,
      deps: { log: this.deps.log, pollMs: this.deps.pollMs ?? CHAT_POLL_MS, now: this.deps.now ?? Date.now },
    })
    const entry: ReaderEntry = { reader, subs: new Set(), grace: null }
    reader.onEvent = (event) => this.onReader({ entry, event })
    this.readers.set(input.file, entry)
    reader.start()
    return entry
  }

  private release(file: string): void {
    const entry = this.readers.get(file)
    if (entry === undefined || entry.subs.size > 0 || entry.grace !== null) return
    entry.grace = setTimeout(() => {
      entry.grace = null
      if (entry.subs.size > 0) return
      entry.reader.stop()
      this.readers.delete(file)
      this.deps.log('mobile.chat_reader_drop', { readers: this.readers.size })
    }, this.deps.graceMs ?? CHAT_GRACE_MS)
    entry.grace.unref()
  }

  private onReader(input: { entry: ReaderEntry; event: Parameters<ChatReader['onEvent']>[0] }): void {
    const { entry, event } = input
    switch (event.kind) {
      case 'ready':
        for (const sub of [...entry.subs]) if (!sub.started) this.start({ entry, sub })
        return
      case 'reset':
        for (const sub of [...entry.subs]) this.sendPage({ entry, sub, mode: 'reset', items: this.latest(entry) })
        return
      case 'failed':
        for (const sub of [...entry.subs]) sub.sink(JSON.stringify({ type: 'chat.unavailable', channel: sub.channelId, reason: 'unreadable' }))
        return
      case 'items':
        this.broadcast({ entry, ids: event.ids, readAt: event.readAt })
    }
  }

  /** 첫 페이지 — 이어 받기가 맞으면 그 뒤 전부(`resume`), 아니면 최근 페이지(`reset`). */
  private start(input: { entry: ReaderEntry; sub: Sub }): void {
    const { entry, sub } = input
    sub.started = true
    const items = entry.reader.items()
    const resume = sub.resume
    if (resume !== null && resume.gen === entry.reader.gen) {
      const from = items.findIndex((item) => item.id === resume.after)
      if (from >= 0 && items.length - from <= CHAT_RESUME_MAX) {
        this.sendPage({ entry, sub, mode: 'resume', items: items.slice(from) })
        return
      }
    }
    this.sendPage({ entry, sub, mode: 'reset', items: this.latest(entry) })
  }

  private latest(entry: ReaderEntry): readonly ChatItem[] {
    const items = entry.reader.items()
    return items.slice(Math.max(0, items.length - CHAT_PAGE_SIZE))
  }

  private older(input: { entry: ReaderEntry; sub: Sub; gen: string; before: number }): void {
    const { entry, sub } = input
    if (!entry.subs.has(sub) || entry.reader.state.kind !== 'ready' || input.gen !== entry.reader.gen) return
    const items = entry.reader.items()
    let end = items.findIndex((item) => item.id >= input.before)
    if (end < 0) end = items.length
    this.sendPage({ entry, sub, mode: 'older', items: items.slice(Math.max(0, end - CHAT_PAGE_SIZE), end) })
  }

  /**
   * 페이지 보내기. `reset`·`older` 는 프레임 하나 — 넘치면 앞(오래된) 말풍선부터 덜어 낸다(`hasOlder` 가 남은 것을 말한다).
   * `resume` 은 넘치면 첫 프레임 뒤를 `chat.items` 로 나눠 보낸다(빠짐 없이).
   */
  private sendPage(input: { entry: ReaderEntry; sub: Sub; mode: 'reset' | 'resume' | 'older'; items: readonly ChatItem[] }): void {
    const { entry, sub, mode } = input
    const all = entry.reader.items()
    const wire = input.items.map((item) => wireItem({ item, place: sub.channel.place }))
    const base = { channel: sub.channelId, gen: entry.reader.gen, at: this.now(), writtenAt: entry.reader.writtenAt() }
    if (mode === 'resume') {
      const frames = frameItems(wire)
      const [first, ...rest] = frames
      sub.sink(JSON.stringify({ type: 'chat.page', mode, ...base, hasOlder: (all[0]?.id ?? 0) < (wire[0]?.id ?? 0), items: first ?? [] }))
      for (const items of rest) sub.sink(JSON.stringify({ type: 'chat.items', ...base, readAt: base.at, items }))
      return
    }
    let items = wire
    let text = ''
    for (;;) {
      const firstId = items[0]?.id
      const hasOlder = firstId !== undefined && (all[0]?.id ?? firstId) < firstId
      text = JSON.stringify({ type: 'chat.page', mode, ...base, hasOlder, items })
      if (Buffer.byteLength(text) <= MAX_FRAME_BYTES || items.length <= 1) break
      items = items.slice(Math.ceil(items.length / 4))
    }
    sub.sink(text)
    this.deps.log('mobile.chat_page', { mode, items: items.length, bytes: text.length })
  }

  /** 바뀐 말풍선 push — 채널마다 한 번 직렬화해 그 채널 구독자 모두에게(Y2ⓒ). 첫 페이지 전 구독은 건너뛴다(첫 페이지에 들어간다). */
  private broadcast(input: { entry: ReaderEntry; ids: number[]; readAt: number }): void {
    const { entry } = input
    const wanted = new Set(input.ids)
    const changed = entry.reader.items().filter((item) => wanted.has(item.id))
    if (changed.length === 0) return
    const started = performance.now()
    const texts = new Map<string, string[]>()
    let bytes = 0
    let subscribers = 0
    for (const sub of [...entry.subs]) {
      if (!sub.started) continue
      let frames = texts.get(sub.channelId)
      if (frames === undefined) {
        const base = { type: 'chat.items', channel: sub.channelId, gen: entry.reader.gen, at: this.now(), readAt: input.readAt, writtenAt: entry.reader.writtenAt() }
        frames = frameItems(changed.map((item) => wireItem({ item, place: sub.channel.place }))).map((items) => JSON.stringify({ ...base, items }))
        texts.set(sub.channelId, frames)
        for (const frame of frames) bytes += frame.length
      }
      for (const frame of frames) sub.sink(frame)
      subscribers += 1
    }
    // 대화 push 1회 비용(Y10ⓓ 재료) — 개수·크기·시간만, 글은 남기지 않는다.
    this.deps.log('mobile.chat_push', { items: changed.length, bytes, subscribers, sendMs: Math.round((performance.now() - started) * 100) / 100 })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}

/** 말풍선 배열을 프레임 상한 안의 묶음들로 — 순서 그대로. 말풍선 하나는 상한보다 작다(글 상한 `ITEM_TEXT_MAX`). */
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
