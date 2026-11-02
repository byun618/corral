// 이어 간 세션의 폰 쓰기 (LIFE-766 C6) — 실제 찾기(`resolveTranscriptUnique`) + 격리 HOME. 가짜 백엔드의 넣기는 Claude 처럼 **이어 간 파일에 새 id 로** 줄을 쓴다.
// 이 시험은 base 에서 `unconfirmed/record_missing` 으로 실패해야 한다(대조, F7).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import { resolveTranscriptUnique } from '../transcript.js'
import { CLAUDE_SESSION, chatListState } from './chat-fixture.js'
import { ChatHub } from './chat.js'
import { InputHub, observedSessionKey, type InputBackend, type InputWire, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './input.js'
import { questionDigest } from './keys.js'

const TARGET = '00000000-0000-4000-8000-00000000000b'
const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const QUESTION = { question: 'Q-1 어느 쪽?', header: 'Pick', multiSelect: false, options: [{ label: 'o0', description: null }, { label: 'o1', description: null }] }
const QUESTION_SCREEN = ['', RULE, ' ☐ Pick', 'Q-1 어느 쪽?', '❯ 1. o0', '  2. o1', '  3. Type something.', RULE, '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\r\n')

const row = (value: unknown): string => `${JSON.stringify(value)}\n`
const human = (text: string, sessionId: string): string => row({ type: 'user', sessionId, origin: { kind: 'human' }, uuid: `u-${text}`, parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })
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
    return { text: this.screenText, input: this.input, anyInput: null, seq: 1 }
  }

  async prompt(_pane: TerminalIdentity, input: { text: string; inputRevision: number }): Promise<SendResult> {
    if (input.inputRevision !== this.input.revision) return 'refused'
    this.input = { ...this.input, revision: this.input.revision + 1 }
    this.prompts.push(input.text)
    fs.appendFileSync(this.live.file, human(input.text, this.live.sessionId))
    return 'sent'
  }

  async send(_pane: TerminalIdentity, input: { text: string; inputRevision: number | null }): Promise<KeyResult> {
    this.input = { ...this.input, revision: this.input.revision + 1 }
    this.keys.push(input.text)
    fs.appendFileSync(this.live.file, answered(this.live.sessionId))
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

function setup() {
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
  })
  cleanups.push(() => chat.stop())
  const logs: string[] = []
  const looked: string[] = []
  const hub = new InputHub({
    read: list,
    backend: () => backend,
    resolveFile: (channel) => resolveTranscriptUnique(channel.session),
    questionItems: (file) => {
      looked.push(file)
      return chat.readerFor(file)?.items() ?? null
    },
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
    expect(await t.settled('msg-l766-0001')).toMatchObject({ state: 'delivered' })
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
})
