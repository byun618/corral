// 이어 간 세션의 폰 쓰기 (LIFE-766 C6) — 실제 찾기(`resolveTranscriptUnique`) + 격리 HOME. 가짜 백엔드의 넣기는 Claude 처럼 **이어 간 파일에 새 id 로** 줄을 쓴다.
// 이 시험은 base 에서 `unconfirmed/record_missing` 으로 실패해야 한다(대조, F7).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import { resolveTranscriptUnique } from '../transcript.js'
import { CLAUDE_SESSION, chatListState } from './chat-fixture.js'
import { ChatHub, questionSource } from './chat.js'
import { InputHub, observedSessionKey, type InputBackend, type InputWire, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './input.js'
import { questionDigest } from './keys.js'

const TARGET = '00000000-0000-4000-8000-00000000000b'
const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const QUESTION = { question: 'Q-1 어느 쪽?', header: 'Pick', multiSelect: false, options: [{ label: 'o0', description: null }, { label: 'o1', description: null }] }
const QUESTION_SCREEN = ['', RULE, ' ☐ Pick', 'Q-1 어느 쪽?', '❯ 1. o0', '  2. o1', '  3. Type something.', RULE, '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\r\n')

const row = (value: unknown): string => `${JSON.stringify(value)}\n`
const human = (text: string, sessionId: string, at = new Date()): string => row({ type: 'user', sessionId, origin: { kind: 'human' }, uuid: `u-${text}-${at.getTime()}`, parentUuid: null, timestamp: at.toISOString(), message: { role: 'user', content: text } })
const metas = (sessionId: string): string => row({ type: 'ai-title', sessionId }) + row({ type: 'agent-name', sessionId })
const fork = (to: string): string => row({ type: 'continued-in', sessionId: CLAUDE_SESSION, continuedInSessionId: to })
const asked = (sessionId: string): string => row({ type: 'assistant', sessionId, uuid: 'a-q', parentUuid: null, timestamp: new Date().toISOString(), message: { id: 'm-q', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'call-1', name: 'AskUserQuestion', input: { questions: [QUESTION] } }] } })
const answered = (sessionId: string): string => row({ type: 'user', sessionId, uuid: 'r-q', parentUuid: 'a-q', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }, toolUseResult: { answers: { [QUESTION.question]: 'o1' } } })

class ForkedBackend implements InputBackend {
  status = 'idle'
  screenText = EMPTY
  input = { revision: 1, idleMs: 10_000 }
  /** Claude 가 지금 쓰는 파일과 그 세션 id. */
  live: { file: string; sessionId: string }
  observed: string | null = null
  readonly prompts: string[] = []
  readonly keys: string[] = []
  /** 화면을 읽을 때 부른다 — 관문을 도는 사이의 이동을 끼운다. */
  onScreen: (() => void) | null = null
  /** 넣기가 일으키는 복사(LIFE-766) — 지시 줄보다 먼저 파일에 붙는다. */
  copy: (() => string) | null = null
  /** false 면 지시 줄을 쓰지 않는다(복사만 오고 지시는 안 들어간 경우). */
  records = true
  /** 키를 넣을 때 기록에 쓰는 줄 — 기본은 질문의 답. */
  keyLine: () => string = () => answered(this.live.sessionId)

  constructor(live: { file: string; sessionId: string }) {
    this.live = live
  }

  async locate(paneId: string): Promise<TerminalIdentity | null> {
    return { epoch: 'e', ptyId: 't', paneId, tabId: 'tab', workspaceId: 'ws', path: '/w', repo: '/w', title: 'x' }
  }

  async observe(): Promise<PaneObservation> {
    return { status: this.status, seq: 1, quiet: true, unmanaged: false, input: this.input, anyInput: null, session: this.observed }
  }

  unmanagedPrompt(): boolean {
    return true
  }

  async manifestVerified(): Promise<boolean> {
    return true
  }

  async screen(): Promise<ScreenRead> {
    this.onScreen?.()
    return { text: this.screenText, input: this.input, anyInput: null, seq: 1 }
  }

  async prompt(_pane: TerminalIdentity, input: { text: string; inputRevision: number }): Promise<SendResult> {
    if (input.inputRevision !== this.input.revision) return 'refused'
    this.input = { ...this.input, revision: this.input.revision + 1 }
    this.prompts.push(input.text)
    if (this.copy !== null) fs.appendFileSync(this.live.file, this.copy())
    if (this.records) fs.appendFileSync(this.live.file, human(input.text, this.live.sessionId))
    return 'sent'
  }

  async send(_pane: TerminalIdentity, input: { text: string; inputRevision: number | null }): Promise<KeyResult> {
    this.input = { ...this.input, revision: this.input.revision + 1 }
    this.keys.push(input.text)
    fs.appendFileSync(this.live.file, this.keyLine())
    return { kind: 'sent', revision: input.inputRevision === null ? null : this.input.revision, anyRevision: null }
  }
}

const cleanups: (() => void)[] = []
let home = ''
let realHome: string | undefined
let dir = ''
const fileOf = (id: string): string => path.join(dir, `${id}.jsonl`)

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l766i-'))
  realHome = process.env['HOME']
  process.env['HOME'] = home
  dir = path.join(home, '.claude', 'projects', 'proj')
  fs.mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

function setup(input: { followMs?: number } = {}) {
  const state = chatListState()
  const list = () => ({ state, prefs: null })
  const backend = new ForkedBackend({ file: fileOf(TARGET), sessionId: TARGET })
  // herdr 는 전환 뒤에도 옛 id 를 말한다 — 목록과 같은 값(F6).
  backend.observed = observedSessionKey({ source: 'herdr:claude', kind: 'id', value: CLAUDE_SESSION })
  const pane = state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)).find((one) => one.paneId === 'c1')
  const session = pane?.agentSession
  if (session === null || session === undefined) throw new Error('참조 없음')
  backend.observed = observedSessionKey({ source: session.source, kind: session.kind, value: CLAUDE_SESSION })
  const chat = new ChatHub({
    read: list,
    resolveFile: ({ session: ref }) => (ref.kind === 'id' && fs.existsSync(fileOf(ref.id)) ? fileOf(ref.id) : null),
    log: () => {},
    pollMs: 20,
    graceMs: 50,
    refreshMs: 10,
    followMs: input.followMs,
  })
  cleanups.push(() => chat.stop())
  const logs: string[] = []
  const looked: string[] = []
  const source = questionSource(chat)
  const hub = new InputHub({
    read: list,
    backend: () => backend,
    resolveFile: (channel) => resolveTranscriptUnique(channel.session),
    questionItems: (file) => {
      looked.push(file)
      return source.questionItems(file)
    },
    questionReady: source.questionReady,
    log: (tag) => logs.push(tag),
    timing: { pollMs: 5, gateMs: 5, quietMs: 500, confirmMs: 300, recordPollMs: 10, stepGapMs: 1, answerConfirmMs: 300, stopConfirmMs: 200 },
  })
  cleanups.push(() => hub.stop())
  const wires: InputWire[] = []
  hub.attach({ device: 'd1', sink: (text) => wires.push(JSON.parse(text)) })
  const settled = async (id: string, timeoutMs = 2000): Promise<InputWire> => {
    const started = Date.now()
    for (;;) {
      const wire = wires.filter((one) => one.id === id).at(-1)
      if (wire !== undefined && !['queued', 'sending'].includes(wire.state)) return wire
      if (Date.now() - started > timeoutMs) throw new Error(`settle timeout ${id}: ${JSON.stringify(wire)}`)
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  const lastWire = (id: string): InputWire | undefined => wires.filter((one) => one.id === id).at(-1)
  return { hub, chat, backend, settled, logs, looked, lastWire }
}

describe('C6 이어 간 세션의 폰 쓰기', () => {
  it('이동 뒤 폰 지시가 새 파일에서 확인돼 delivered · 전환만으로 target_changed 없음', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-l766-0001', channel: 'c1', text: '폰 지시' })
    // 상태와 사유를 함께 단언한다 — base 대조의 실패 원문에 `unconfirmed/record_missing` 이 남는다.
    const { state, reason } = await t.settled('msg-l766-0001')
    expect({ state, reason }).toEqual({ state: 'delivered', reason: null })
    expect(t.backend.prompts).toEqual(['폰 지시'])
    expect(t.logs).not.toContain('mobile.input_target_changed')
  })

  it('이어 가기가 없는 세션의 옛 경로는 그대로 — 그 파일·그 id 로 delivered', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION))
    const t = setup()
    t.backend.live = { file: fileOf(CLAUDE_SESSION), sessionId: CLAUDE_SESSION }
    t.hub.send({ device: 'd1', id: 'msg-l766-0002', channel: 'c1', text: '폰 지시' })
    expect(await t.settled('msg-l766-0002')).toMatchObject({ state: 'delivered' })
  })

  it('옛 id 로 찍힌 줄을 새 파일에서 들어감으로 세지 않는다 — 세션 대조는 유지된다', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const t = setup()
    t.backend.live = { file: fileOf(TARGET), sessionId: CLAUDE_SESSION }
    t.hub.send({ device: 'd1', id: 'msg-l766-0003', channel: 'c1', text: '폰 지시' })
    expect(await t.settled('msg-l766-0003')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
  })

  it('대상 후보 둘 이상 → failed/record_ambiguous · 넣지 않는다', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const other = path.join(home, '.claude', 'projects', 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, `${TARGET}.jsonl`), human('사본', TARGET))
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-l766-0004', channel: 'c1', text: '폰 지시' })
    expect(await t.settled('msg-l766-0004')).toMatchObject({ state: 'failed', reason: 'record_ambiguous' })
    expect(t.backend.prompts).toEqual([])
  })

  it('폴더를 못 읽으면 기다린다 — 끝나지 않고 넣지 않으며, 풀리면 들어간다', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const locked = path.join(home, '.claude', 'projects', 'locked')
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)
    cleanups.push(() => fs.chmodSync(locked, 0o755))
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-l766-0005', channel: 'c1', text: '폰 지시' })
    await new Promise((done) => setTimeout(done, 150))
    expect(t.lastWire('msg-l766-0005')?.state).toBe('queued')
    expect(t.backend.prompts).toEqual([])
    fs.chmodSync(locked, 0o755)
    expect(await t.settled('msg-l766-0005')).toMatchObject({ state: 'delivered' })
  })

  it('관문을 도는 사이(화면 읽기 안)에 이동하면 커서 직전에 쌍을 다시 풀어 delivered', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION))
    const t = setup()
    t.backend.live = { file: fileOf(CLAUDE_SESSION), sessionId: CLAUDE_SESSION }
    t.backend.onScreen = () => {
      t.backend.onScreen = null
      fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
      fs.appendFileSync(fileOf(CLAUDE_SESSION), fork(TARGET))
      t.backend.live = { file: fileOf(TARGET), sessionId: TARGET }
    }
    t.hub.send({ device: 'd1', id: 'msg-l766-0006', channel: 'c1', text: '폰 지시' })
    const { state, reason } = await t.settled('msg-l766-0006')
    expect({ state, reason }).toEqual({ state: 'delivered', reason: null })
  })

  it('다시 푼 결과가 모호하면 넣지 않고 failed/record_ambiguous', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION))
    const t = setup()
    t.backend.onScreen = () => {
      t.backend.onScreen = null
      fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
      fs.appendFileSync(fileOf(CLAUDE_SESSION), fork(TARGET))
      const other = path.join(home, '.claude', 'projects', 'other')
      fs.mkdirSync(other)
      fs.writeFileSync(path.join(other, `${TARGET}.jsonl`), human('사본', TARGET))
    }
    t.hub.send({ device: 'd1', id: 'msg-l766-0007', channel: 'c1', text: '폰 지시' })
    expect(await t.settled('msg-l766-0007')).toMatchObject({ state: 'failed', reason: 'record_ambiguous' })
    expect(t.backend.prompts).toEqual([])
  })

  it('다시 푼 결과가 못 읽음이면 기다린다 — 넣지 않고, 풀리면 들어간다', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const locked = path.join(home, '.claude', 'projects', 'locked')
    const t = setup()
    t.backend.onScreen = () => {
      t.backend.onScreen = null
      fs.mkdirSync(locked)
      fs.chmodSync(locked, 0o000)
      cleanups.push(() => fs.chmodSync(locked, 0o755))
    }
    t.hub.send({ device: 'd1', id: 'msg-l766-0008', channel: 'c1', text: '폰 지시' })
    await new Promise((done) => setTimeout(done, 150))
    expect(t.lastWire('msg-l766-0008')?.state).toBe('queued')
    expect(t.backend.prompts).toEqual([])
    fs.chmodSync(locked, 0o755)
    expect(await t.settled('msg-l766-0008')).toMatchObject({ state: 'delivered' })
  })

  it('커서 뒤 주입 사이의 이동은 넓히지 않는다 — 정직한 unconfirmed/record_missing', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const t = setup()
    // 커서는 옛 파일, 주입 줄은 새 파일 — 커서 뒤에 이동이 끝난 모양
    t.hub.send({ device: 'd1', id: 'msg-l766-0009', channel: 'c1', text: '폰 지시' })
    const { state, reason } = await t.settled('msg-l766-0009')
    expect({ state, reason }).toEqual({ state: 'unconfirmed', reason: 'record_missing' })
    expect(t.backend.prompts).toEqual(['폰 지시'])
  })

  it('중단 확인도 이어 간 파일을 읽는다(runStop)', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const t = setup()
    t.backend.status = 'working'
    t.backend.keyLine = () => row({ type: 'user', sessionId: TARGET, uuid: 'u-int', parentUuid: 'u-새', timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: 'user', content: '[Request interrupted by user]' } })
    t.hub.stopTurn({ device: 'd1', id: 'stp-l766-0001', channel: 'c1' })
    const { state, reason } = await t.settled('stp-l766-0001')
    expect({ state, reason }).toEqual({ state: 'stopped', reason: 'record' })
    expect(t.backend.keys.length).toBe(1)
  })

  it('이동 확인 주기 전에 온 질문 답도 새 파일 판독자로 처리한다 — question_closed 없음', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION))
    // 확인 주기가 끼지 않게 늘린다 — 답 직전 재확인만이 옮긴다.
    const t = setup({ followMs: 60_000 })
    t.backend.status = 'blocked'
    t.backend.screenText = QUESTION_SCREEN
    t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
    const started = Date.now()
    while (t.chat.readerFor(fileOf(CLAUDE_SESSION))?.state.kind !== 'ready' && Date.now() - started < 2000) await new Promise((done) => setTimeout(done, 5))
    const text = human('새', TARGET) + asked(TARGET)
    fs.writeFileSync(fileOf(TARGET), text)
    fs.appendFileSync(fileOf(CLAUDE_SESSION), fork(TARGET))
    expect(t.chat.readerFor(fileOf(TARGET))).toBeNull()
    t.hub.answer({ device: 'd1', id: 'ans-l766-0002', channel: 'c1', question: Buffer.byteLength(human('새', TARGET)), call: 'call-1', digest: questionDigest([QUESTION]), answers: [{ choices: [1], other: null }] })
    const { state, reason } = await t.settled('ans-l766-0002')
    expect({ state, reason }).toEqual({ state: 'delivered', reason: null })
    expect(t.backend.keys.length).toBeGreaterThan(0)
  })

  it('이동 전 질문 id 의 답은 question_closed — 키를 보내지 않는다', async () => {
    const before = human('옛', CLAUDE_SESSION)
    fs.writeFileSync(fileOf(CLAUDE_SESSION), before + asked(CLAUDE_SESSION) + fork(TARGET))
    const leading = human('새 파일의 더 긴 첫 지시', TARGET)
    fs.writeFileSync(fileOf(TARGET), leading + asked(TARGET))
    const oldId = Buffer.byteLength(before)
    expect(Buffer.byteLength(leading)).not.toBe(oldId)
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = QUESTION_SCREEN
    t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
    t.hub.answer({ device: 'd1', id: 'ans-l766-0004', channel: 'c1', question: oldId, call: 'call-1', digest: questionDigest([QUESTION]), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('ans-l766-0004')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.keys).toEqual([])
    expect(t.chat.readerFor(fileOf(TARGET))?.items().some((item) => item.kind === 'question' && item.state === 'pending')).toBe(true)
  })

  it('옮겨 간 id 의 후보 폴더만 오류면 기다린다 — 넣지 않고, 풀리면 들어간다', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET))
    const other = path.join(home, '.claude', 'projects', 'other')
    fs.mkdirSync(other)
    const loop = path.join(other, `${TARGET}.jsonl`)
    fs.symlinkSync(loop, loop)
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-l766-0010', channel: 'c1', text: '폰 지시' })
    await new Promise((done) => setTimeout(done, 150))
    expect(t.lastWire('msg-l766-0010')?.state).toBe('queued')
    expect(t.backend.prompts).toEqual([])
    fs.rmSync(loop)
    expect(await t.settled('msg-l766-0010')).toMatchObject({ state: 'delivered' })
  })

  it('이동한 대화를 연 구독이 없으면 판독자가 없어 키를 보내지 않는다 — question_closed', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET) + asked(TARGET))
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = QUESTION_SCREEN
    t.hub.answer({ device: 'd1', id: 'ans-l766-0003', channel: 'c1', question: 1, call: 'call-1', digest: questionDigest([QUESTION]), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('ans-l766-0003')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.keys).toEqual([])
  })

  it('질문 답이 그 대화 판독자를 찾는다 — 대화와 같은 새 파일', async () => {
    fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
    fs.writeFileSync(fileOf(TARGET), human('새', TARGET) + asked(TARGET))
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = QUESTION_SCREEN
    t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
    const started = Date.now()
    let item = t.chat.readerFor(fileOf(TARGET))?.items().find((one) => one.kind === 'question')
    while (item === undefined && Date.now() - started < 2000) {
      await new Promise((done) => setTimeout(done, 10))
      item = t.chat.readerFor(fileOf(TARGET))?.items().find((one) => one.kind === 'question')
    }
    if (item?.kind !== 'question') throw new Error('질문 없음')
    t.hub.answer({ device: 'd1', id: 'ans-l766-0001', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [1], other: null }] })
    await t.settled('ans-l766-0001')
    expect(new Set(t.looked)).toEqual(new Set([fileOf(TARGET)]))
    expect(t.backend.keys.length).toBeGreaterThan(0)
  })

  describe('C13 빈 대상', () => {
    const TEXT = '같은 글 지시'
    const ready = async (t: ReturnType<typeof setup>, file: string): Promise<void> => {
      const started = Date.now()
      while (t.chat.readerFor(file)?.state.kind !== 'ready' && Date.now() - started < 2000) await new Promise((done) => setTimeout(done, 5))
    }

    it('ⓒ 커서가 빈 대상을 쓰고, 복사가 들어와도 새 지시만 delivered · 이어서 화면도 옮겨 간다', async () => {
      const old = new Date(Date.now() - 60_000)
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human(TEXT, CLAUDE_SESSION, old) + fork(TARGET))
      fs.writeFileSync(fileOf(TARGET), metas(TARGET))
      const t = setup({ followMs: 20 })
      t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
      await ready(t, fileOf(CLAUDE_SESSION))
      expect(t.chat.readerFor(fileOf(TARGET))).toBeNull()
      t.backend.copy = () => human(TEXT, TARGET, old)
      t.hub.send({ device: 'd1', id: 'send-l766-c13a', channel: 'c1', text: TEXT })
      const { state, reason } = await t.settled('send-l766-c13a')
      expect({ state, reason }).toEqual({ state: 'delivered', reason: null })
      expect(t.backend.prompts).toEqual([TEXT])
      await ready(t, fileOf(TARGET))
      expect(t.chat.readerFor(fileOf(TARGET))?.state.kind).toBe('ready')
    })

    it('ⓒ 복사분의 같은 글만 오면 배달이 아니다 — 같은 초의 옛 지시여도 unconfirmed/record_missing', async () => {
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
      fs.writeFileSync(fileOf(TARGET), metas(TARGET))
      const t = setup()
      // 제출 시각은 화면을 읽은 뒤다 — 복사분 시각을 그 직전에 잡아, 같은 초 안에서 ms 로만 갈린다.
      let beforeSubmit = new Date()
      t.backend.onScreen = () => {
        beforeSubmit = new Date(Date.now() - 1)
      }
      t.backend.records = false
      t.backend.copy = () => human(TEXT, TARGET, beforeSubmit)
      t.hub.send({ device: 'd1', id: 'send-l766-c13b', channel: 'c1', text: TEXT })
      const { state, reason } = await t.settled('send-l766-c13b')
      expect({ state, reason }).toEqual({ state: 'unconfirmed', reason: 'record_missing' })
    })

    it('빈 대상 구간의 대기 질문은 관측에 없다(질문·검토·권한 화면에서 ← 는 포크하지 않는다) — 그런 순서가 오면 키 0회 failed/question_closed', async () => {
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + asked(CLAUDE_SESSION))
      fs.writeFileSync(fileOf(TARGET), metas(TARGET))
      const t = setup()
      t.backend.status = 'blocked'
      t.backend.screenText = QUESTION_SCREEN
      t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
      await ready(t, fileOf(CLAUDE_SESSION))
      fs.appendFileSync(fileOf(CLAUDE_SESSION), fork(TARGET))
      const item = t.chat.readerFor(fileOf(CLAUDE_SESSION))?.items().find((one) => one.kind === 'question')
      if (item?.kind !== 'question') throw new Error('질문 없음')
      t.hub.answer({ device: 'd1', id: 'ans-l766-c13c', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [1], other: null }] })
      const { state, reason } = await t.settled('ans-l766-c13c')
      expect({ state, reason }).toEqual({ state: 'failed', reason: 'question_closed' })
      expect(t.backend.keys).toEqual([])
    })

    it('작업 중 포크(실측) — 복사가 바로 되어 대상이 비지 않고, 대기 질문도 답도 대상 파일이다', async () => {
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
      fs.writeFileSync(fileOf(TARGET), metas(TARGET) + human('옛', TARGET) + asked(TARGET))
      const t = setup()
      t.backend.status = 'blocked'
      t.backend.screenText = QUESTION_SCREEN
      t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
      await ready(t, fileOf(TARGET))
      const item = t.chat.readerFor(fileOf(TARGET))?.items().find((one) => one.kind === 'question')
      if (item?.kind !== 'question') throw new Error('질문 없음')
      t.hub.answer({ device: 'd1', id: 'ans-l766-c13d', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [1], other: null }] })
      const { state, reason } = await t.settled('ans-l766-c13d')
      expect({ state, reason }).toEqual({ state: 'delivered', reason: null })
      expect(t.backend.keys.length).toBeGreaterThan(0)
    })
  })

  describe('C14 이름 붙은 입력 상자', () => {
    const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'continued-in', name), 'utf8')

    it('이름 붙은 빈 상자에 폰 지시 → delivered · 글이 있으면 failed/mac_draft', async () => {
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
      fs.writeFileSync(fileOf(TARGET), metas(TARGET))
      const t = setup()
      t.backend.screenText = fixture('screen-named-empty.ansi')
      t.hub.send({ device: 'd1', id: 'send-l766-c14a', channel: 'c1', text: '지시' })
      const sent = await t.settled('send-l766-c14a')
      expect({ state: sent.state, reason: sent.reason }).toEqual({ state: 'delivered', reason: null })
      t.backend.screenText = fixture('screen-named-draft.ansi')
      t.hub.send({ device: 'd1', id: 'send-l766-c14b', channel: 'c1', text: '다음' })
      const refused = await t.settled('send-l766-c14b')
      expect({ state: refused.state, reason: refused.reason }).toEqual({ state: 'failed', reason: 'mac_draft' })
    })
  })

  describe('C15 이름 붙은 질문 화면', () => {
    const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'continued-in', name), 'utf8')
    const ask = (questions: unknown[]): string => row({ type: 'assistant', sessionId: TARGET, uuid: 'a-q', parentUuid: null, timestamp: new Date().toISOString(), message: { id: 'm-q', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'call-1', name: 'AskUserQuestion', input: { questions } }] } })
    const reply = (answers: Record<string, string>): string => row({ type: 'user', sessionId: TARGET, uuid: 'r-q', parentUuid: 'a-q', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }, toolUseResult: { answers } })
    const start = async (questions: unknown[]) => {
      fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛', CLAUDE_SESSION) + fork(TARGET))
      fs.writeFileSync(fileOf(TARGET), human('새', TARGET) + ask(questions))
      const t = setup()
      t.backend.status = 'blocked'
      t.chat.subscribe({ channelId: 'c1', resume: null, sink: () => {} })
      const started = Date.now()
      while (t.chat.readerFor(fileOf(TARGET))?.state.kind !== 'ready' && Date.now() - started < 2000) await new Promise((done) => setTimeout(done, 5))
      const item = t.chat.readerFor(fileOf(TARGET))?.items().find((one) => one.kind === 'question')
      if (item?.kind !== 'question') throw new Error('질문 없음')
      return { t, item }
    }

    it('ⓓ 이름 줄이 있는 실표본 질문 화면에 폰 답 → 키가 나가고 delivered', async () => {
      const question = { question: '어느쪽 이고?', header: '선택', multiSelect: false, options: [{ label: '가', description: '가 선택' }, { label: '나', description: '나 선택' }] }
      const { t, item } = await start([question])
      t.backend.screenText = fixture('screen-question.ansi')
      t.backend.keyLine = () => reply({ [question.question]: '나' })
      t.hub.answer({ device: 'd1', id: 'ans-l766-c15a', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [1], other: null }] })
      const { state, reason } = await t.settled('ans-l766-c15a')
      expect({ state, reason, keys: t.backend.keys }).toEqual({ state: 'delivered', reason: null, keys: ['2'] })
    })

    it('ⓓ 잘린 이름 줄이면 키 0회 failed/question_changed', async () => {
      const question = { question: '어느쪽 이고?', header: '선택', multiSelect: false, options: [{ label: '가', description: '가 선택' }, { label: '나', description: '나 선택' }] }
      const { t, item } = await start([question])
      t.backend.screenText = fixture('screen-question.ansi').replace(/─+ 세션 이름 ─/, ' 세션 이름 … ─')
      t.hub.answer({ device: 'd1', id: 'ans-l766-c15b', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [1], other: null }] })
      const { state, reason } = await t.settled('ans-l766-c15b')
      expect({ state, reason, keys: t.backend.keys }).toEqual({ state: 'failed', reason: 'question_changed', keys: [] })
    })

    it('ⓓ 문항 둘 — 이름 줄이 있는 탭 화면·검토 화면을 거쳐 delivered', async () => {
      const first = { question: '하나', header: '일', multiSelect: false, options: [{ label: '가', description: '가' }, { label: '나', description: '나' }] }
      const second = { question: '둘', header: '이', multiSelect: false, options: [{ label: '다', description: '다' }, { label: '라', description: '라' }] }
      const { t, item } = await start([first, second])
      const screens = ['screen-named-tabs.ansi', 'screen-named-tabs-2.ansi', 'screen-named-review.ansi'].map(fixture)
      t.backend.screenText = screens[0]!
      t.backend.onScreen = () => {
        t.backend.screenText = screens[Math.min(t.backend.keys.length, 2)]!
      }
      t.backend.keyLine = () => (t.backend.keys.length >= 3 ? reply({ 하나: '가', 둘: '다' }) : '')
      t.hub.answer({ device: 'd1', id: 'ans-l766-c15c', channel: 'c1', question: item.id, call: 'call-1', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }, { choices: [0], other: null }] })
      const { state, reason } = await t.settled('ans-l766-c15c')
      expect({ state, reason, keys: t.backend.keys }).toEqual({ state: 'delivered', reason: null, keys: ['1', '1', '1'] })
    })
  })
})
