// 폰 쓰기 허브 (LIFE-582 Z2ⓐⓑⓖ · Z3 · Z5 · Z6 · Z9ⓔ) — 가짜 백엔드 + 실제 기록 대조(`countSubmissions`).
// 가짜 백엔드의 넣기는 Claude 기록에 사람 발화 한 줄을 붙인다 — 「들어감」 은 그 줄을 커서 뒤에서 정확히 1건 찾았을 때만.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import { ChatBuilder, type ChatItem } from '../chat-parse.js'
import { CHAT_SESSIONS, chatListState } from './chat-fixture.js'
import { answerMatches, answerRecords, cleanAnswers, observedSessionKey, recordedAnswers, INPUT_IDS_MAX, INPUT_QUEUE_MAX, InputHub, type FileResolution, type InputBackend, type InputWire, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './input.js'
import { activeQuestion, KEY, matchQuestion, questionDigest } from './keys.js'
import type { MobileAgentKind } from './list.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const DRAFT = ['', RULE, '❯ 쓰던 글', RULE].join('\r\n')
/** Claude 질문 화면(Z1 실측 모양) — 맨 아래 상자에 `question()` 이 만드는 문항 글(Q-<id>)·선택지(o0, o1 …). `above` 는 상자 위 과거 글. */
const questionScreen = (id: number, options = 2, above: string[] = []): string =>
  ['', ...above, RULE, ' ☐ Pick', `Q-${id} 어느 쪽?`, ...Array.from({ length: options }, (_, index) => `${index === 0 ? '❯ ' : '  '}${index + 1}. o${index}`), `  ${options + 1}. Type something.`, RULE, `  ${options + 2}. Chat about this`, 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\r\n')
/** 폰이 본 그 질문의 내용 지문(`question()` 과 같은 모양). */
const digestFor = (id: number, options = 2): string => {
  const item = question({ id, state: 'pending', options })
  if (item.kind !== 'question') throw new Error('fixture')
  return questionDigest(item.questions)
}

type Delivery = 'record' | 'twice' | 'none'

class FakeBackend implements InputBackend {
  status = 'idle'
  seq = 1
  quiet = true
  screenText = EMPTY
  delivery: Delivery = 'record'
  promptResult: SendResult = 'sent'
  sendResult: SendResult = 'sent'
  /** 화면을 읽을 때 같은 턴의 입력 — 없으면 `input`. */
  screenInput: ScreenRead['input'] | undefined = undefined
  paneMissing = false
  unmanaged = false
  /** LIFE-597: guard 가 `unmanaged_agent` 를 아는가(handshake `unmanaged_prompt`). */
  unmanagedCapable = true
  /** 넣을 때마다 받은 `unmanagedAgent`(관리 pane 이면 null). */
  readonly unmanagedAgents: (string | null)[] = []
  epoch = 'e'
  ptyId = 't'
  input: PaneObservation['input'] = { revision: 1, idleMs: 10_000 }
  /** LIFE-598: herdr 가 말하는 그 pane 의 세션 — 기본은 목록과 같다(setup 이 목록에서 읽게 잇는다). 시험이 목록과 엇갈리게 바꾼다. */
  observedSession: (paneId: string) => string | null = () => null
  /** 넣기 직전에 부른다(끔·해지가 넣기 중에 겹치는 시험). */
  onPrompt: (() => void) | null = null
  readonly fences: { seq: number; inputRevision: number; minIdleMs: number }[] = []
  readonly prompts: string[] = []
  readonly sends: { text: string; seq: number }[] = []
  /** 울타리 친 키의 revision(시험이 「다른 입력」 을 끼우려면 `input.revision` 을 올린다). */
  readonly keyFences: (number | null)[] = []
  onSend: ((text: string) => void) | null = null
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  async locate(paneId: string): Promise<TerminalIdentity | null> {
    if (this.paneMissing) return null
    return { epoch: this.epoch, ptyId: this.ptyId, paneId, tabId: 'tab', workspaceId: 'ws', path: '/w', repo: '/w', title: 'x' }
  }

  async observe(pane: TerminalIdentity): Promise<PaneObservation> {
    return { status: this.status, seq: this.seq, quiet: this.quiet, unmanaged: this.unmanaged, input: this.input, session: this.observedSession(pane.paneId) }
  }

  unmanagedPrompt(): boolean {
    return this.unmanagedCapable
  }

  async manifestVerified(): Promise<boolean> {
    return true
  }

  async screen(): Promise<ScreenRead> {
    return { text: this.screenText, input: this.screenInput === undefined ? this.input : this.screenInput, seq: this.seq }
  }

  async prompt(_pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number; unmanagedAgent: string | null }): Promise<SendResult> {
    const { text, unmanagedAgent, ...fence } = input
    this.fences.push(fence)
    this.unmanagedAgents.push(unmanagedAgent)
    this.onPrompt?.()
    if (this.promptResult !== 'sent') return this.promptResult
    // guard 처럼 — 울타리 revision 이 지금 값과 다르면 쓰지 않는다(`input_changed`). 들어가면 같은 턴에서 revision 을 1 올린다(`queue_user_input_submission`).
    if (this.input !== null && fence.inputRevision !== this.input.revision) return 'refused'
    if (this.input !== null) this.input = { ...this.input, revision: this.input.revision + 1 }
    this.prompts.push(text)
    const times = this.delivery === 'none' ? 0 : this.delivery === 'twice' ? 2 : 1
    for (let index = 0; index < times; index += 1) fs.appendFileSync(this.file, `${userLine(text)}\n`)
    return 'sent'
  }

  /** guard 처럼 — seq 는 기록만, 입력 revision 울타리는 비교하고 쓴 뒤 revision 을 올려 돌려준다. */
  async send(_pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number | null }): Promise<KeyResult> {
    if (this.sendResult !== 'sent') return { kind: this.sendResult }
    if (input.inputRevision !== null && this.input !== null && input.inputRevision !== this.input.revision) return { kind: 'refused' }
    this.keyFences.push(input.inputRevision)
    this.sends.push({ text: input.text, seq: input.seq })
    if (this.input !== null) this.input = { ...this.input, revision: this.input.revision + 1 }
    // guard 가 돌려주는 것은 **이 쓰기 직후** revision 이다 — 그 뒤 다른 입력(onSend 가 흉내)은 다음 키의 울타리에 걸린다.
    const revision = input.inputRevision === null || this.input === null ? null : this.input.revision
    this.onSend?.(input.text)
    return { kind: 'sent', revision }
  }
}

let uuid = 0
function userLine(text: string): string {
  uuid += 1
  return JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: text }, uuid: `u-${uuid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
}

function question(input: { id: number; state: 'pending' | 'answered' | 'closed'; options?: number; call?: string | null }): ChatItem {
  const options = Array.from({ length: input.options ?? 2 }, (_, index) => ({ label: `o${index}`, description: null }))
  const call = input.call === undefined ? `toolu-${input.id}` : input.call
  return { id: input.id, kind: 'question', call, questions: [{ question: `Q-${input.id} 어느 쪽?`, header: null, options, multiSelect: false }], state: input.state, answer: null, at: null }
}

/**
 * Claude 의 답 줄 — 그 도구 호출의 tool_result(`chat-parse` 가 `result` 원자로 읽는다). `answers` = 실물의 `toolUseResult.answers`(`{문항: 답}` —
 * 답 값 대조 R3-A1 의 재료). 없으면 답 값을 못 읽는 줄.
 */
function answerLine(call: string, isError = false, answers: Record<string, string> | null = null): string {
  uuid += 1
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'ok', is_error: isError }] }, ...(answers === null ? {} : { toolUseResult: { answers } }), uuid: `u-${uuid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
}

function setup(input: { listed?: boolean; noFileYet?: boolean; resolution?: () => FileResolution; deviceValid?: (device: string) => boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l582i-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'claude.jsonl')
  if (input.noFileYet !== true) fs.writeFileSync(file, `${userLine('이전 지시')}\n`)
  const backend = new FakeBackend(file)
  const items: { list: ChatItem[] } = { list: [] }
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  // 목록 상태 — 시험이 세션 교체(R2-A4)를 흉내 내려고 고칠 수 있다.
  const state = chatListState()
  // herdr 관측 세션 = 지금 목록의 그 pane 세션(실물에서 둘이 같은 봉투 — LIFE-598 k1 실측). 시험이 엇갈림을 따로 만든다.
  backend.observedSession = (paneId) => {
    const session = paneSession(state, paneId)
    return session === null ? null : observedSessionKey({ source: session.source, kind: session.kind, value: session.kind === 'id' ? session.id : session.path })
  }
  const hub = new InputHub({
    read: () => (input.listed === false ? null : { state, prefs: null }),
    backend: () => backend,
    // 새 세션은 첫 지시 전 파일이 없다 — 찾기는 null, 「생길 경로」 만 안다.
    resolveFile: input.resolution ?? (() => (fs.existsSync(file) || input.noFileYet !== true ? { kind: 'found', file } : { kind: 'none' })),
    expectedFile: () => (input.noFileYet === true ? file : null),
    questionItems: () => items.list,
    deviceValid: input.deviceValid,
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    timing: { pollMs: 5, gateMs: 5, quietMs: 500, confirmMs: 400, recordPollMs: 10, stepGapMs: 1, answerConfirmMs: 300, stopConfirmMs: 200 },
  })
  cleanups.push(() => hub.stop())
  const wires: InputWire[] = []
  hub.attach({ device: 'd1', sink: (text) => wires.push(JSON.parse(text)) })
  const last = (id: string): InputWire | undefined => wires.filter((wire) => wire.id === id).at(-1)
  const settled = async (id: string, timeoutMs = 2_000): Promise<InputWire> => {
    const started = Date.now()
    for (;;) {
      const wire = last(id)
      if (wire !== undefined && !['queued', 'sending'].includes(wire.state)) return wire
      if (Date.now() - started > timeoutMs) throw new Error(`settle timeout ${id}: ${JSON.stringify(wire)}`)
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  /** 답 키가 끝나면 기록에 그 질문의 답 줄을 붙이고 판독자를 해소한다 — 실제 provider 와 같은 두 증거. */
  const answerOn = (input: { id: number; call?: string; when?: (text: string) => boolean; lines?: number; resolve?: boolean; value?: string }) => {
    backend.onSend = (text) => {
      if (input.when !== undefined && !input.when(text)) return
      const answers = input.value === undefined ? null : { [`Q-${input.id} 어느 쪽?`]: input.value }
      for (let index = 0; index < (input.lines ?? 1); index += 1) fs.appendFileSync(file, `${answerLine(input.call ?? `toolu-${input.id}`, false, answers)}\n`)
      if (input.resolve !== false) items.list = [question({ id: input.id, state: 'answered', call: input.call })]
    }
  }
  return { hub, backend, file, items, wires, last, settled, logs, answerOn, state }
}

describe('지시 보내기 — 메시지 id 당 많아야 한 번 (Z2ⓐ)', () => {
  it('같은 id 세 번 = 넣기 1회 · 들어감', async () => {
    const t = setup()
    for (let index = 0; index < 3; index += 1) t.hub.send({ device: 'd1', id: 'msg-aaaa-0001', channel: 'c1', text: '안녕' })
    expect((await t.settled('msg-aaaa-0001')).state).toBe('delivered')
    t.hub.send({ device: 'd1', id: 'msg-aaaa-0001', channel: 'c1', text: '안녕' })
    expect(t.backend.prompts).toEqual(['안녕'])
    expect(t.last('msg-aaaa-0001')?.state).toBe('delivered')
  })
  it('같은 글 새 id = 두 번 넣는다(전체 기록 같은 글 거절을 쓰지 않는다)', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-bbbb-0001', channel: 'c1', text: '같은 글' })
    expect((await t.settled('msg-bbbb-0001')).state).toBe('delivered')
    t.hub.send({ device: 'd1', id: 'msg-bbbb-0002', channel: 'c1', text: '같은 글' })
    expect((await t.settled('msg-bbbb-0002')).state).toBe('delivered')
    expect(t.backend.prompts).toHaveLength(2)
  })
  it('기기가 다르면 같은 id 도 따로다', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-cccc-0001', channel: 'c1', text: 'x' })
    await t.settled('msg-cccc-0001')
    t.hub.send({ device: 'd2', id: 'msg-cccc-0001', channel: 'c1', text: 'x' })
    await new Promise((done) => setTimeout(done, 200))
    expect(t.backend.prompts).toHaveLength(2)
  })
})

describe('들어감 = 커서 뒤 정확히 1건 (Z2ⓑ)', () => {
  it('기록 파일이 아직 없는 새 세션 — 생길 경로로 커서를 잡고 들어감', async () => {
    const t = setup({ noFileYet: true })
    t.hub.send({ device: 'd1', id: 'msg-dddd-0000', channel: 'c1', text: '첫 지시' })
    expect((await t.settled('msg-dddd-0000')).state).toBe('delivered')
  })
  it('기록에 0건 → 확인 못 함(record_missing), 다시 넣지 않는다', async () => {
    const t = setup()
    t.backend.delivery = 'none'
    t.hub.send({ device: 'd1', id: 'msg-dddd-0001', channel: 'c1', text: '안 보임' })
    expect(await t.settled('msg-dddd-0001')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
    expect(t.backend.prompts).toHaveLength(1)
  })
  it('기록에 2건 → 확인 못 함(record_ambiguous)', async () => {
    const t = setup()
    t.backend.delivery = 'twice'
    t.hub.send({ device: 'd1', id: 'msg-dddd-0002', channel: 'c1', text: '두 번' })
    expect(await t.settled('msg-dddd-0002')).toMatchObject({ state: 'unconfirmed', reason: 'record_ambiguous' })
  })
  it('커서 앞의 같은 글은 세지 않는다', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-dddd-0003', channel: 'c1', text: '이전 지시' })
    expect((await t.settled('msg-dddd-0003')).state).toBe('delivered')
  })
  it('넣기 결과를 모르면(unknown) 확인으로 간다 — 다시 넣지 않는다', async () => {
    const t = setup()
    t.backend.promptResult = 'unknown'
    t.hub.send({ device: 'd1', id: 'msg-dddd-0004', channel: 'c1', text: 'u' })
    expect((await t.settled('msg-dddd-0004')).state).toBe('unconfirmed')
  })
})

describe('채널 큐 (Z3)', () => {
  it('작업 중이면 기다리고(wait=turn) 끝나면 순서대로 한 건씩', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'msg-eeee-0001', channel: 'c1', text: '하나' })
    t.hub.send({ device: 'd1', id: 'msg-eeee-0002', channel: 'c1', text: '둘' })
    await new Promise((done) => setTimeout(done, 60))
    expect(t.last('msg-eeee-0001')).toMatchObject({ state: 'queued', wait: 'turn' })
    expect(t.backend.prompts).toHaveLength(0)
    t.backend.quiet = true
    expect((await t.settled('msg-eeee-0001')).state).toBe('delivered')
    expect((await t.settled('msg-eeee-0002')).state).toBe('delivered')
    expect(t.backend.prompts).toEqual(['하나', '둘'])
  })
  it('큐 취소는 넣기 전만 — 취소한 것은 넣지 않는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'msg-ffff-0001', channel: 'c1', text: '취소할 것' })
    t.hub.cancel({ device: 'd1', id: 'msg-ffff-0001' })
    t.backend.quiet = true
    t.hub.send({ device: 'd1', id: 'msg-ffff-0002', channel: 'c1', text: '남는 것' })
    expect((await t.settled('msg-ffff-0002')).state).toBe('delivered')
    expect(t.last('msg-ffff-0001')?.state).toBe('cancelled')
    expect(t.backend.prompts).toEqual(['남는 것'])
    t.hub.cancel({ device: 'd1', id: 'msg-ffff-0002' })
    expect(t.last('msg-ffff-0002')?.state).toBe('delivered')
  })
  it(`큐 상한 ${INPUT_QUEUE_MAX} 을 넘으면 queue_full`, () => {
    const t = setup()
    t.backend.quiet = false
    for (let index = 0; index <= INPUT_QUEUE_MAX; index += 1) t.hub.send({ device: 'd1', id: `msg-gggg-000${index}`, channel: 'c1', text: `q${index}` })
    expect(t.last(`msg-gggg-000${INPUT_QUEUE_MAX}`)).toMatchObject({ state: 'failed', reason: 'queue_full' })
    expect(t.hub.queued('c1')).toBe(INPUT_QUEUE_MAX)
  })
  it('모바일 끔 → 큐는 실패, 다시 켜도 넣지 않는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'msg-hhhh-0001', channel: 'c1', text: '끔' })
    t.hub.stop()
    expect(t.last('msg-hhhh-0001')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
    t.hub.start()
    t.backend.quiet = true
    await new Promise((done) => setTimeout(done, 80))
    expect(t.backend.prompts).toHaveLength(0)
  })
  // LIFE-597: 582 D1(관리 밖 = 기다리지 않고 failed/unmanaged)을 대체한다 — 새 guard 면 관리 밖 갈래로 넣고, 옛 guard 면 쓰기 0 + guard_outdated.
  it('관리 밖 pane(셸에서 직접 띄운 세션)은 채널 종류를 명시해 넣는다(LIFE-597)', async () => {
    const t = setup()
    t.backend.unmanaged = true
    t.hub.send({ device: 'd1', id: 'msg-iiii-0002', channel: 'c1', text: '관리 밖' })
    expect(await t.settled('msg-iiii-0002')).toMatchObject({ state: 'delivered' })
    expect(t.backend.prompts).toEqual(['관리 밖'])
    expect(t.backend.unmanagedAgents).toEqual(['claude'])
  })
  it('관리 pane 은 관리 밖 옵션 없이 넣는다(LIFE-597 — CLI 와 같은 술어)', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-iiii-0003', channel: 'c1', text: '관리' })
    expect(await t.settled('msg-iiii-0003')).toMatchObject({ state: 'delivered' })
    expect(t.backend.unmanagedAgents).toEqual([null])
  })
  it('관리 밖 pane 인데 guard 가 그 갈래를 모르면 쓰지 않고 실패(guard_outdated, LIFE-597 U5)', async () => {
    const t = setup()
    t.backend.unmanaged = true
    t.backend.unmanagedCapable = false
    t.hub.send({ device: 'd1', id: 'msg-iiii-0004', channel: 'c1', text: '옛 guard' })
    expect(await t.settled('msg-iiii-0004')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.backend.fences).toHaveLength(0)
  })
  it('관리 밖 pane 이 settle 전이면(quiet 아님) 넣지 않고 기다린다(LIFE-597 U2ⓒ)', async () => {
    const t = setup()
    t.backend.unmanaged = true
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'msg-iiii-0005', channel: 'c1', text: '막 띄움' })
    await new Promise((done) => setTimeout(done, 80))
    expect(t.last('msg-iiii-0005')).toMatchObject({ state: 'queued' })
    expect(t.backend.prompts).toHaveLength(0)
    t.backend.quiet = true
    expect(await t.settled('msg-iiii-0005')).toMatchObject({ state: 'delivered' })
    expect(t.backend.unmanagedAgents).toEqual(['claude'])
  })
  it('pane 이 닫히면 실패(closed) — 나중에 넣지 않는다', async () => {
    const t = setup()
    t.backend.paneMissing = true
    t.hub.send({ device: 'd1', id: 'msg-iiii-0001', channel: 'c1', text: '닫힘' })
    expect(await t.settled('msg-iiii-0001')).toMatchObject({ state: 'failed', reason: 'closed' })
  })
  it('guard 가 거절하면(seq 바뀜) 큐에 되돌려 다시 기다린다', async () => {
    const t = setup()
    t.backend.promptResult = 'refused'
    t.hub.send({ device: 'd1', id: 'msg-jjjj-0001', channel: 'c1', text: '거절' })
    await new Promise((done) => setTimeout(done, 60))
    expect(t.last('msg-jjjj-0001')?.state).toBe('queued')
    t.backend.promptResult = 'sent'
    expect((await t.settled('msg-jjjj-0001')).state).toBe('delivered')
    expect(t.backend.prompts).toHaveLength(1)
  })
})

describe('채널 거절 (P1·P8)', () => {
  it('셸 pane · 세션 없음 · 목록 밖 · 빈 글은 넣지 않는다', () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-kkkk-0001', channel: 's1', text: 'x' })
    t.hub.send({ device: 'd1', id: 'msg-kkkk-0002', channel: 'c4', text: 'x' })
    t.hub.send({ device: 'd1', id: 'msg-kkkk-0003', channel: 'nope', text: 'x' })
    t.hub.send({ device: 'd1', id: 'msg-kkkk-0004', channel: 'c1', text: '\x1b\x03 ' })
    expect(t.last('msg-kkkk-0001')).toMatchObject({ state: 'failed', reason: 'not_listed' })
    expect(t.last('msg-kkkk-0002')).toMatchObject({ state: 'failed', reason: 'no_session' })
    expect(t.last('msg-kkkk-0003')).toMatchObject({ state: 'failed', reason: 'not_listed' })
    expect(t.last('msg-kkkk-0004')).toMatchObject({ state: 'failed', reason: 'empty' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('본문 제어 문자는 지우고 넣는다 — 로그에 본문이 없다 (Z9ⓔ)', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'msg-kkkk-0005', channel: 'c1', text: 'a\x1b[Bb\x03c' })
    expect((await t.settled('msg-kkkk-0005')).state).toBe('delivered')
    expect(t.backend.prompts).toEqual(['a[Bbc'])
    expect(JSON.stringify(t.logs)).not.toContain('a[Bbc')
  })
  it('모르는 id 조회 → unknown', () => {
    const t = setup()
    t.hub.status({ device: 'd1', ids: ['msg-none-0001'] })
    expect(t.last('msg-none-0001')?.state).toBe('unknown')
  })
})

describe('맥 초안 (Z6 · P9)', () => {
  it('입력창에 글이 있으면 넣지 않고 실패(mac_draft)', async () => {
    const t = setup()
    t.backend.screenText = DRAFT
    t.hub.send({ device: 'd1', id: 'msg-llll-0001', channel: 'c1', text: '합쳐지면 안 됨' })
    expect(await t.settled('msg-llll-0001')).toMatchObject({ state: 'failed', reason: 'mac_draft' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('입력 줄을 못 찾으면 넣지 않는다(draft_unknown)', async () => {
    const t = setup()
    t.backend.screenText = 'no prompt box'
    t.hub.send({ device: 'd1', id: 'msg-llll-0002', channel: 'c1', text: 'x' })
    expect(await t.settled('msg-llll-0002')).toMatchObject({ state: 'failed', reason: 'draft_unknown' })
  })
})

describe('질문 답 (Z5)', () => {
  it('열린 마지막 질문 + blocked 일 때만 서버가 만든 키를 seq 비교로 넣는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.seq = 7
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, value: 'o1' })
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0001', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect((await t.settled('ans-aaaa-0001')).state).toBe('delivered')
    expect(t.backend.sends).toEqual([{ text: '2', seq: 7 }])
  })
  it('뒤에 새 질문이 열렸거나 답한 질문이면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' }), question({ id: 20, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0002', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0002')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    t.items.list = [question({ id: 10, state: 'answered' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0003', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0003')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('질문 대기가 아니면(blocked 아님) 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0004')).toMatchObject({ state: 'failed', reason: 'question_closed' })
  })
  it('첫 키에서 guard 가 거절하면 실패(question_changed) — 넣은 것 없음', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.sendResult = 'refused'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0005', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0005')).toMatchObject({ state: 'failed', reason: 'question_changed' })
  })
  it('직접 입력의 줄바꿈·제어 문자는 키가 되지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, when: (text) => text === KEY.enter, value: 'a bc' })
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0006', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: 'a\nb\x1bc' }] })
    expect((await t.settled('ans-aaaa-0006')).state).toBe('delivered')
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3', 'a bc', KEY.enter])
  })
})

describe('중단 (Z6 · P5)', () => {
  it('작업 중이면 Esc 1회 · 상태가 떠나면 멈춤', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.seq = 3
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0001', channel: 'c1' })
    expect((await t.settled('stp-aaaa-0001')).state).toBe('stopped')
    expect(t.backend.sends).toEqual([{ text: KEY.esc, seq: 3 }])
  })
  it('한가하면 아무 키도 넣지 않는다(not_running)', async () => {
    const t = setup()
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0002', channel: 'c1' })
    expect(await t.settled('stp-aaaa-0002')).toMatchObject({ state: 'failed', reason: 'not_running' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('멈추지 않으면 재시도 없이 확인 못 함(still_running)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0003', channel: 'c1' })
    expect(await t.settled('stp-aaaa-0003')).toMatchObject({ state: 'unconfirmed', reason: 'still_running' })
    expect(t.backend.sends).toHaveLength(1)
  })
  it('관측 뒤 상태가 바뀌면(guard 거절) 실패(state_changed)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.sendResult = 'refused'
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0004', channel: 'c1' })
    expect(await t.settled('stp-aaaa-0004')).toMatchObject({ state: 'failed', reason: 'state_changed' })
  })
  it('Grok 은 Ctrl+C, 맥 초안이 있으면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.screenText = ['╭──╮', '│ ❯ 초안   │', '╰──╯'].join('\r\n')
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0005', channel: 'c3' })
    expect(await t.settled('stp-aaaa-0005')).toMatchObject({ state: 'failed', reason: 'mac_draft' })
    t.backend.screenText = ['╭──╮', '│ ❯       │', '╰──╯'].join('\r\n')
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'stp-aaaa-0006', channel: 'c3' })
    expect((await t.settled('stp-aaaa-0006')).state).toBe('stopped')
    expect(t.backend.sends.map((send) => send.text)).toEqual([KEY.ctrlC])
  })
})

// --- 수정 r1 (Codex r1 지적) ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('R1-A1 해지 — 그 기기의 큐는 PTY 에 쓰이지 않는다', () => {
  it('작업 중 큐에 둔 지시 → 해지 → 준비돼도 넣지 않는다(failed/revoked)', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a1-0000-0001', channel: 'c1', text: '해지 전 지시' })
    await wait(30)
    t.hub.revoke('d1')
    t.backend.quiet = true
    await wait(80)
    expect(t.backend.prompts).toHaveLength(0)
    // 해지된 기기에는 결과도 보내지 않는다 — 마지막으로 받은 것은 해지 전 상태.
    expect(t.last('r1a1-0000-0001')?.state).toBe('queued')
  })
  it('해지가 hub 에 닿기 전이라도 효과 직전에 페어링을 본다(deviceValid)', async () => {
    let paired = true
    const t = setup({ deviceValid: () => paired })
    t.backend.onPrompt = () => {}
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a1-0000-0002', channel: 'c1', text: 'x' })
    await wait(30)
    paired = false
    t.backend.quiet = true
    expect(await t.settled('r1a1-0000-0002')).toMatchObject({ state: 'failed', reason: 'revoked' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('연결이 끊긴 것(폰 화면 끔)은 해지가 아니다 — 큐가 남아 나중에 들어간다', async () => {
    const t = setup()
    t.backend.quiet = false
    const detach = t.hub.attach({ device: 'd1', sink: () => {} })
    t.hub.send({ device: 'd1', id: 'r1a1-0000-0003', channel: 'c1', text: '화면 끔' })
    detach()
    await wait(30)
    t.backend.quiet = true
    await wait(120)
    expect(t.backend.prompts).toEqual(['화면 끔'])
  })
  it('답의 키 사이에 해지되면 남은 키를 넣지 않는다(unconfirmed/revoked)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => t.hub.revoke('d1')
    t.hub.answer({ device: 'd1', id: 'r1a1-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: '직접' }] })
    await wait(80)
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
  })
})

describe('R1-A2 질문 동일성 — 도구 호출 id · 화면 · 한 관측', () => {
  it('판독자에는 이전 질문이 남았는데 화면은 다른 대기(권한 등) → 넣지 않는다(question_changed)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.seq = 200
    t.backend.screenText = ['', 'Do you want to run this command?', '1. Yes', '2. No', ''].join('\r\n')
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0001', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0001')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('같은 말풍선 id 에 다른 질문(다른 도구 호출) → 넣지 않는다(question_closed)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending', call: 'toolu-new' })]
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0002', channel: 'c1', question: 10, call: 'toolu-old', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0002')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('도구 호출 id 가 없는 답은 대조할 수 없어 잠근다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0003', channel: 'c1', question: 10, call: null, digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0003')).toMatchObject({ state: 'failed', reason: 'question_changed' })
  })
  it('화면을 읽는 사이 seq 가 바뀌면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.screenText = questionScreen(10)
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => { t.backend.seq += 1; return screen() }
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0004')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('판독자가 answered 여도 기록에 그 질문의 답 줄이 없으면 들어감이 아니다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => { t.items.list = [question({ id: 10, state: 'answered' })] }
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0005', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0005')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
  })
  it('답 줄이 있어도 판독자에서 아직 대기면 들어감이 아니다 · 답 줄 2건은 확인 못 함', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, resolve: false })
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0006', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0006')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
    const u = setup()
    u.backend.status = 'blocked'
    u.backend.screenText = questionScreen(10)
    u.items.list = [question({ id: 10, state: 'pending' })]
    u.answerOn({ id: 10, lines: 2 })
    u.hub.answer({ device: 'd1', id: 'r1a2-0000-0007', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await u.settled('r1a2-0000-0007')).toMatchObject({ state: 'unconfirmed', reason: 'record_ambiguous' })
  })
})

describe('R1-A3 맥 타자 — 관측한 입력 revision 으로만 넣는다', () => {
  it('넣기는 두 번째 관측의 입력 revision 과 조용한 시간 하한을 guard 에 싣는다', async () => {
    const t = setup()
    t.backend.input = { revision: 42, idleMs: 9_000 }
    t.hub.send({ device: 'd1', id: 'r1a3-0000-0001', channel: 'c1', text: 'x' })
    expect((await t.settled('r1a3-0000-0001')).state).toBe('delivered')
    // 울타리 = 접수 때의 revision(LIFE-598 r2), 하한 = quietMs(r2 에서 2 s 하한을 되돌림).
    expect(t.backend.fences).toEqual([{ seq: 1, inputRevision: 42, minIdleMs: 500 }])
  })
  it('입력 revision 이 없는 guard 면 넣지 않는다(guard_outdated)', async () => {
    const t = setup()
    t.backend.input = null
    t.hub.send({ device: 'd1', id: 'r1a3-0000-0002', channel: 'c1', text: 'x' })
    expect(await t.settled('r1a3-0000-0002')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('guard 가 거절했는데 입력 revision 이 그대로면(상태 전이) 큐로 돌아가고, 다음 관문에서 초안을 보면 넣지 않는다', async () => {
    const t = setup()
    t.backend.promptResult = 'refused'
    t.backend.onPrompt = () => { t.backend.screenText = DRAFT }
    t.hub.send({ device: 'd1', id: 'r1a3-0000-0003', channel: 'c1', text: '합쳐지면 안 됨' })
    expect(await t.settled('r1a3-0000-0003')).toMatchObject({ state: 'failed', reason: 'mac_draft' })
    expect(t.backend.prompts).toHaveLength(0)
  })
})

describe('R1-A4 모바일 끔 — 거절이 늦게 와도 되살리지 않는다', () => {
  it('넣는 중 끔 + guard 거절 → failed(mobile_off), 다시 켜도 넣지 않는다', async () => {
    const t = setup()
    t.backend.promptResult = 'refused'
    t.backend.onPrompt = () => t.hub.stop()
    t.hub.send({ device: 'd1', id: 'r1a4-0000-0001', channel: 'c1', text: '끈 뒤 부활 금지' })
    expect(await t.settled('r1a4-0000-0001')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
    t.hub.start()
    t.backend.promptResult = 'sent'
    t.backend.onPrompt = null
    t.hub.send({ device: 'd1', id: 'r1a4-0000-0002', channel: 'c1', text: '새 지시' })
    expect((await t.settled('r1a4-0000-0002')).state).toBe('delivered')
    expect(t.backend.prompts).toEqual(['새 지시'])
  })
  it('관문 대기 중 끄고 바로 켜도 이전 세대의 지시는 넣지 않는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a4-0000-0003', channel: 'c1', text: '이전 세대' })
    await wait(20)
    t.hub.stop()
    t.hub.start()
    t.backend.quiet = true
    await wait(80)
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.last('r1a4-0000-0003')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
  })
  it('직접 입력 답의 첫 키 뒤 끄면 남은 키(본문·Enter)를 넣지 않고 unconfirmed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => t.hub.stop()
    t.hub.answer({ device: 'd1', id: 'r1a4-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: '본문' }] })
    expect(await t.settled('r1a4-0000-0004')).toMatchObject({ state: 'unconfirmed', reason: 'mobile_off' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
  })
})

describe('R1-A5 접수 때 묶은 대상', () => {
  it('큐에 있는 동안 PTY 세대가 바뀌면 새 세대로 따라가지 않는다(target_changed)', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a5-0000-0001', channel: 'c1', text: '이전 PTY' })
    await wait(30)
    t.backend.ptyId = 't-replacement'
    t.backend.quiet = true
    expect(await t.settled('r1a5-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('backend epoch 가 바뀌어도(herdr 재시작) 실패', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a5-0000-0002', channel: 'c1', text: '이전 epoch' })
    await wait(30)
    t.backend.epoch = 'e2'
    t.backend.quiet = true
    expect(await t.settled('r1a5-0000-0002')).toMatchObject({ state: 'failed', reason: 'target_changed' })
  })
})

describe('R1-A6 기억에서 밀린 id', () => {
  it(`${INPUT_IDS_MAX} 개 뒤에 같은 id 가 다시 와도 다시 넣지 않는다(unknown/expired)`, async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'r1a6-keep-0000', channel: 'c1', text: '한 번만' })
    expect((await t.settled('r1a6-keep-0000')).state).toBe('delivered')
    for (let index = 0; index < INPUT_IDS_MAX; index += 1) t.hub.send({ device: 'd1', id: `r1a6-fill-${String(index).padStart(4, '0')}`, channel: 'c1', text: ' ' })
    t.hub.send({ device: 'd1', id: 'r1a6-keep-0000', channel: 'c1', text: '한 번만' })
    await wait(80)
    expect(t.backend.prompts).toEqual(['한 번만'])
    expect(t.last('r1a6-keep-0000')).toMatchObject({ state: 'unknown', reason: 'expired' })
    t.hub.status({ device: 'd1', ids: ['r1a6-keep-0000'] })
    expect(t.last('r1a6-keep-0000')).toMatchObject({ state: 'unknown', reason: 'expired' })
  })
})

describe('R1-A8 복구 조회', () => {
  it('pending — 이 기기의 끝나지 않은 요청을 본문과 함께 보낸다(다른 기기·끝난 것은 없다)', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'r1a8-0000-0001', channel: 'c1', text: '대기 중' })
    t.hub.send({ device: 'd1', id: 'r1a8-0000-0002', channel: 'c4', text: '실패' })
    t.hub.send({ device: 'd2', id: 'r1a8-0000-0003', channel: 'c1', text: '남의 것' })
    await wait(20)
    t.wires.length = 0
    t.hub.pending({ device: 'd1' })
    expect(t.wires).toEqual([expect.objectContaining({ id: 'r1a8-0000-0001', channel: 'c1', op: 'send', state: 'queued', text: '대기 중' })])
  })
})

describe('R1-A11 직접 입력 상한 = 65536 바이트(P7)', () => {
  it('2001 자는 받고, 합계 65536 바이트를 넘으면 bad_answer', () => {
    expect(cleanAnswers([{ choices: [], other: 'a'.repeat(2001) }])).not.toBeNull()
    expect(cleanAnswers([{ choices: [], other: 'a'.repeat(65_536) }])).not.toBeNull()
    expect(cleanAnswers([{ choices: [], other: 'a'.repeat(40_000) }, { choices: [], other: 'b'.repeat(30_000) }])).toBeNull()
    expect(cleanAnswers([{ choices: [], other: '가'.repeat(21_846) }])).toBeNull()
  })
})

describe('R1-A13 쓰기용 기록 해소', () => {
  it('같은 세션 id 의 파일이 둘 이상이면 넣지 않는다(record_ambiguous)', async () => {
    const t = setup({ resolution: () => ({ kind: 'ambiguous' }) })
    t.hub.send({ device: 'd1', id: 'r1ad-0000-0001', channel: 'c1', text: 'x' })
    expect(await t.settled('r1ad-0000-0001')).toMatchObject({ state: 'failed', reason: 'record_ambiguous' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('읽기 오류(0건을 믿을 수 없음)는 생길 경로로 넘어가지 않고 기다린다', async () => {
    const t = setup({ noFileYet: true, resolution: () => ({ kind: 'error' }) })
    t.hub.send({ device: 'd1', id: 'r1ad-0000-0002', channel: 'c1', text: 'x' })
    await wait(80)
    expect(t.last('r1ad-0000-0002')?.state).toBe('queued')
    expect(t.backend.prompts).toHaveLength(0)
  })
})

describe('C1 꼬리 커서', () => {
  it('제출 뒤 기록이 다시 쓰이면(앞부분 바뀜) 들어감으로 올리지 않는다(record_rewritten)', async () => {
    const t = setup()
    t.backend.delivery = 'none'
    t.backend.onPrompt = () => fs.writeFileSync(t.file, `${userLine('다시 쓴 기록')}\n${userLine('x')}\n`)
    t.hub.send({ device: 'd1', id: 'c1c1-0000-0001', channel: 'c1', text: 'x' })
    expect(await t.settled('c1c1-0000-0001')).toMatchObject({ state: 'unconfirmed', reason: 'record_rewritten' })
  })
})

/** 그 채널(`c1` 등)의 pane — 세션 교체를 흉내 낸다. */
/** fixture c1 의 접수 세션을 herdr 관측 키로(LIFE-598 시험이 관측을 고정할 때). */
const OLD_SESSION = observedSessionKey({ source: CHAT_SESSIONS.claude.source, kind: 'id', value: CHAT_SESSIONS.claude.id })
/** 그 pane 의 목록 세션 — 없는 pane 이면 null(가짜 herdr 관측용). */
function paneSession(state: ReturnType<typeof chatListState>, id: string) {
  for (const repo of state.repos) for (const worktree of repo.worktrees) for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.paneId === id) return pane.agentSession
  return null
}
function paneOf(state: ReturnType<typeof chatListState>, id: string) {
  for (const repo of state.repos) for (const worktree of repo.worktrees) for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.paneId === id) return pane
  throw new Error(`no pane ${id}`)
}
/** Claude 권한 질문 상자(Z1 perm-screens 모양). */
const PERMISSION = ['', '╌'.repeat(40), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend'].join('\r\n')
/** 문항 둘짜리 질문(같은 모양 선택지 2개씩). */
function twoQuestions(id: number, state: 'pending' | 'answered' = 'pending'): ChatItem {
  const options = [{ label: 'o0', description: null }, { label: 'o1', description: null }]
  return { id, kind: 'question', call: `toolu-${id}`, questions: [{ question: `Q-${id} 첫째?`, header: null, options, multiSelect: false }, { question: `Q-${id} 둘째?`, header: null, options, multiSelect: false }], state, answer: null, at: null }
}
/** 문항 둘 상자 — `title` 이 둘째면 머리 줄 첫 탭이 답함(☒ — Z1 a-q4-q2 실측). */
const boxOf = (title: string): string => ['', RULE, title.endsWith('둘째?') ? '←  ☒ A  ☐ B  ✔ Submit  →' : '←  ☐ A  ☐ B  ✔ Submit  →', title, '❯ 1. o0', '  2. o1', '  3. Type something.', RULE, '  4. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\r\n')
const REVIEW = ['', RULE, '←  ☒ A  ☒ B  ✔ Submit  →', 'Review your answers', ' ● x', 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'].join('\r\n')

describe('R2-A1 질문 동일성 — 활성 질문 영역 · 내용 지문 · 키 사이 입력 울타리', () => {
  it('화면 위 과거 글에 그 질문이 있어도 맨 아래 상자가 권한 질문이면 키 0회(question_changed)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    // 과거 글(그 질문 글·선택지가 그대로 보인다) 아래 지금 상자는 권한 질문.
    t.backend.screenText = ['❯ Q-10 어느 쪽?', '1. o0', '2. o1', PERMISSION].join('\r\n')
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0001', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r2a1-0000-0001')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('같은 말풍선 id·도구 호출 id 인데 내용이 바뀌었으면(폰이 본 지문과 다름) 키 0회 — 화면이 새 내용을 보여도', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    const replaced = question({ id: 10, state: 'pending', options: 3 })
    t.items.list = [replaced]
    t.backend.screenText = questionScreen(10, 3)
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0002', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10, 2), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r2a1-0000-0002')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('지문이 없는 답(이전 앱)은 대조할 수 없어 키 0회', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0003', channel: 'c1', question: 10, call: 'toolu-10', digest: null, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r2a1-0000-0003')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('직접 입력 키 사이에 다른 입력이 끼면(blocked seq 그대로) 그 키부터 넣지 않는다 — 1회 뒤 unconfirmed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    // 첫 키 뒤 다른 클라이언트의 키 — 입력 revision 만 움직이고 seq 는 그대로.
    t.backend.onSend = () => { if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1 } }
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: '폰의 답' }] })
    expect(await t.settled('r2a1-0000-0004')).toMatchObject({ state: 'unconfirmed', reason: 'question_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
    // 첫 키는 화면의 revision 으로, 그 뒤는 guard 가 돌려준 revision 으로 울타리 쳤다.
    expect(t.backend.keyFences).toEqual([1])
  })
  it('문항 사이 화면이 다른 대기로 바뀌면 다음 문항 키를 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [twoQuestions(30)]
    t.backend.screenText = boxOf('Q-30 첫째?')
    t.backend.onSend = () => { t.backend.screenText = PERMISSION }
    const item = twoQuestions(30)
    if (item.kind !== 'question') throw new Error('fixture')
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0005', channel: 'c1', question: 30, call: 'toolu-30', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })
    expect(await t.settled('r2a1-0000-0005')).toMatchObject({ state: 'unconfirmed', reason: 'question_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['1'])
  })
  it('양성 대조 — 문항 둘: 화면이 첫째 → 둘째 → 검토로 옮겨 가면 키 1 · 2 · 1 을 각 화면 확인 뒤 넣고 들어감', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [twoQuestions(31)]
    t.backend.screenText = boxOf('Q-31 첫째?')
    const screens = [boxOf('Q-31 둘째?'), REVIEW]
    t.backend.onSend = () => {
      const next = screens.shift()
      if (next !== undefined) t.backend.screenText = next
      else {
        fs.appendFileSync(t.file, `${answerLine('toolu-31', false, { 'Q-31 첫째?': 'o0', 'Q-31 둘째?': 'o1' })}\n`)
        t.items.list = [twoQuestions(31, 'answered')]
      }
    }
    const item = twoQuestions(31)
    if (item.kind !== 'question') throw new Error('fixture')
    t.hub.answer({ device: 'd1', id: 'r2a1-0000-0006', channel: 'c1', question: 31, call: 'toolu-31', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })
    expect((await t.settled('r2a1-0000-0006')).state).toBe('delivered')
    expect(t.backend.sends.map((send) => send.text)).toEqual(['1', '2', '1'])
    expect(t.backend.keyFences).toEqual([1, 2, 3])
  })
})

/** Codex 답 봉투 한 줄 — `questionItemId` = `["request_user_input_async","<call>",<문항>]`(실물 모양). `id` 를 주지 않으면 귀속을 못 읽는 봉투. */
function codexReply(entries: { call?: string; index?: number; answer: string; question?: string }[]): string {
  const body = entries.map((entry) => ({ answer: entry.answer, question: entry.question ?? 'q', ...(entry.call === undefined ? {} : { questionItemId: JSON.stringify(['request_user_input_async', entry.call, entry.index ?? 0]) }) }))
  return JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `<send_user_message_question_reply>\n${JSON.stringify(body)}\n</send_user_message_question_reply>` } })
}
const CODEX_COLLAPSED = ['• Queued follow-up inputs', '  ? 1 question · 3s', '    ⇧← to answer', '', '› Ask Codex to do anything'].join('\r\n')
const codexOpen = (id: number): string => ['• Queued follow-up inputs', '', `  Q-${id} 어느 쪽?`, '', '  › 1. o0', '    2. o1', '    3. Other', '', '  enter submit   ⌃] skip   ⇧→ main prompt'].join('\r\n')

describe('R2-A2 Codex 답 귀속 — 그 호출의 문항 답만 센다', () => {
  it('answerRecords — 다른 질문의 봉투는 세지 않고, 귀속 못 읽은 봉투는 unattributed, 문항 전부가 답해져야 1건', () => {
    const other = codexReply([{ call: 'call-other', answer: 'B' }])
    expect(answerRecords({ kind: 'codex', text: other, call: 'call-mine', questions: 1 })).toEqual({ count: 0, declined: false, unattributed: false })
    expect(answerRecords({ kind: 'codex', text: codexReply([{ answer: 'B' }]), call: 'call-mine', questions: 1 })).toMatchObject({ unattributed: true })
    expect(answerRecords({ kind: 'codex', text: codexReply([{ call: 'call-mine', answer: 'A' }]), call: 'call-mine', questions: 1 })).toMatchObject({ count: 1 })
    // 두 문항 — 봉투가 문항마다 따로 와도 둘 다 와야 1건. 하나만이면 0건, 같은 문항 두 번이면 1건이 아니다.
    const first = codexReply([{ call: 'call-mine', index: 0, answer: 'A' }])
    const second = codexReply([{ call: 'call-mine', index: 1, answer: 'B' }])
    expect(answerRecords({ kind: 'codex', text: first, call: 'call-mine', questions: 2 }).count).toBe(0)
    expect(answerRecords({ kind: 'codex', text: `${first}\n${second}`, call: 'call-mine', questions: 2 }).count).toBe(1)
    expect(answerRecords({ kind: 'codex', text: `${first}\n${first}`, call: 'call-mine', questions: 1 }).count).toBe(2)
  })
  it('허브 — 커서 뒤에 다른 질문의 답 봉투만 생기고 판독자가 풀려도 들어감이 아니다(unconfirmed)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = CODEX_COLLAPSED
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = (text) => {
      if (text === KEY.shiftLeft) t.backend.screenText = codexOpen(10)
      else {
        fs.appendFileSync(t.file, `${codexReply([{ call: 'some-other-call', answer: 'o1' }])}\n`)
        t.items.list = [question({ id: 10, state: 'answered' })]
      }
    }
    t.hub.answer({ device: 'd1', id: 'r2a2-0000-0001', channel: 'c2', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('r2a2-0000-0001')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
    expect(t.backend.sends.map((send) => send.text)).toEqual([KEY.shiftLeft, '2'])
  })
  it('허브 양성 대조 — 그 호출의 봉투면 들어감 · 펼친 뒤 화면을 다시 대조한다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = CODEX_COLLAPSED
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = (text) => {
      if (text === KEY.shiftLeft) t.backend.screenText = codexOpen(10)
      else {
        fs.appendFileSync(t.file, `${codexReply([{ call: 'toolu-10', answer: 'o1', question: 'Q-10 어느 쪽?' }])}\n`)
        t.items.list = [question({ id: 10, state: 'answered' })]
      }
    }
    t.hub.answer({ device: 'd1', id: 'r2a2-0000-0002', channel: 'c2', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect((await t.settled('r2a2-0000-0002')).state).toBe('delivered')
  })
  it('허브 — ⇧← 로 펼친 상자가 다른 질문이면 답 키를 넣지 않는다(펼치기 키만)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = CODEX_COLLAPSED
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = (text) => { if (text === KEY.shiftLeft) t.backend.screenText = codexOpen(99) }
    t.hub.answer({ device: 'd1', id: 'r2a2-0000-0003', channel: 'c2', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('r2a2-0000-0003')).toMatchObject({ state: 'unconfirmed', reason: 'question_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual([KEY.shiftLeft])
  })
})

describe('R2-A3 화면을 잡을 때의 입력 — 같은 guard 턴의 revision·조용한 시간', () => {
  it('화면을 잡을 때 입력이 조용하지 않았으면(echo 가 아직 화면에 없을 수 있다) 그 화면으로 넣지 않는다 — 조용해지면 그 화면의 revision 으로', async () => {
    const t = setup()
    // 접수 직전에 맥 입력이 있었다(revision 2, 0 ms) — 접수 때 묶은 revision 도 2. 화면을 잡은 턴에 입력이 아직 조용하지 않다.
    t.backend.input = { revision: 2, idleMs: 0 }
    t.hub.send({ device: 'd1', id: 'r2a3-0000-0001', channel: 'c1', text: '폰 지시' })
    await wait(120)
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.last('r2a3-0000-0001')).toMatchObject({ state: 'queued', wait: 'gate' })
    // 조용해짐(revision 그대로) — 화면 턴과 효과 직전 재관측이 접수 때의 revision 2 를 본다.
    t.backend.input = { revision: 2, idleMs: 2_500 }
    expect((await t.settled('r2a3-0000-0001')).state).toBe('delivered')
    expect(t.backend.fences.at(-1)).toMatchObject({ inputRevision: 2, minIdleMs: 500 })
  })
  it('화면 턴의 seq 가 관측과 다르면 그 화면으로 넣지 않는다', async () => {
    const t = setup()
    const screen = t.backend.screen.bind(t.backend)
    let moved = false
    t.backend.screen = async () => {
      const shot = await screen()
      if (moved) return shot
      moved = true
      return { ...shot, seq: shot.seq === null ? null : shot.seq + 1 }
    }
    t.hub.send({ device: 'd1', id: 'r2a3-0000-0002', channel: 'c1', text: '다음 관문' })
    expect((await t.settled('r2a3-0000-0002')).state).toBe('delivered')
    expect(t.backend.fences).toHaveLength(1)
  })
  it('화면 턴이 입력을 알려 주지 않는 guard 면 넣지 않는다(guard_outdated)', async () => {
    const t = setup()
    t.backend.screenInput = null
    t.hub.send({ device: 'd1', id: 'r2a3-0000-0003', channel: 'c1', text: 'x' })
    expect(await t.settled('r2a3-0000-0003')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(t.backend.fences).toHaveLength(0)
  })
})

describe('R2-A4 접수 세션 — 관문 await 중 같은 PTY 의 세션이 바뀌면 넣지 않는다', () => {
  it('첫 관측 동안 세션 교체(PTY·epoch·seq 그대로) → target_changed, 넣기 0회', async () => {
    const t = setup()
    // herdr 관측은 옛 세션에 고정 — 목록 비교(R2-A4)만으로 잡히는지 본다(LIFE-598 r1 C·R1-C2).
    t.backend.observedSession = () => OLD_SESSION
    const observe = t.backend.observe.bind(t.backend)
    let swapped = false
    t.backend.observe = async (pane) => {
      const seen = await observe(pane)
      if (!swapped) {
        swapped = true
        const pane = paneOf(t.state, 'c1')
        if (pane.agentSession !== null && pane.agentSession.kind === 'id') pane.agentSession = { ...pane.agentSession, id: 'replacement-session' }
      }
      return seen
    }
    t.hub.send({ device: 'd1', id: 'r2a4-0000-0001', channel: 'c1', text: '이전 세션' })
    expect(await t.settled('r2a4-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('답 — 키 사이에 세션이 바뀌면 남은 키를 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => {
      const pane = paneOf(t.state, 'c1')
      if (pane.agentSession !== null && pane.agentSession.kind === 'id') pane.agentSession = { ...pane.agentSession, id: 'replacement-session' }
    }
    t.hub.answer({ device: 'd1', id: 'r2a4-0000-0002', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: '본문' }] })
    expect(await t.settled('r2a4-0000-0002')).toMatchObject({ state: 'unconfirmed', reason: 'target_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
  })
})

describe('LIFE-598 r1 — 마지막 관측 뒤 세션만 바뀌는 창 (r2: 조용함 하한은 quietMs 로 되돌림)', () => {
  const newSession = observedSessionKey({ source: 'herdr:claude', kind: 'id', value: 'cleared-session' })
  it('screen 도중 세션만 바뀜(seq·revision 그대로) → 효과 직전 재관측이 잡아 prompt 0회 target_changed', async () => {
    const t = setup()
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => {
      const shot = await screen()
      t.backend.observedSession = () => newSession
      return shot
    }
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0001', channel: 'c1', text: '옛 세션 지시' })
    expect(await t.settled('l598r1-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('manifestVerified 도중 세션만 바뀜 → prompt 0회 target_changed', async () => {
    const t = setup()
    t.backend.manifestVerified = async () => {
      t.backend.observedSession = () => newSession
      return true
    }
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0002', channel: 'c1', text: '옛 세션 지시' })
    expect(await t.settled('l598r1-0000-0002')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('screen 도중 세션이 null 로 → 쓰지 않고 target_changed', async () => {
    const t = setup()
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => {
      const shot = await screen()
      t.backend.observedSession = () => null
      return shot
    }
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0003', channel: 'c1', text: '옛 세션 지시' })
    expect(await t.settled('l598r1-0000-0003')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('호출 횟수로 가른다 — 접수·첫·두 번째 관측은 옛 세션, 네 번째(효과 직전)만 새 세션 → target_changed', async () => {
    const t = setup()
    let calls = 0
    t.backend.observedSession = () => ((calls += 1) <= 3 ? OLD_SESSION : newSession)
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0004', channel: 'c1', text: '옛 세션 지시' })
    expect(await t.settled('l598r1-0000-0004')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    // 접수(bind — R0)·first·second·last.
    expect(calls).toBe(4)
    expect(t.logs.filter((log) => log.tag === 'mobile.input_target_changed').map((log) => log.fields.check)).toEqual(['herdr_session'])
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('효과 시점 입력이 quietMs 미만이면 넣지 않고 기다린다 — 넘으면 넣는다(r2: 2 s 하한 없음)', async () => {
    const t = setup()
    t.backend.input = { revision: 5, idleMs: 300 }
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0005', channel: 'c1', text: '조용해지면' })
    await wait(80)
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.last('l598r1-0000-0005')).toMatchObject({ state: 'queued', wait: 'gate' })
    // 1.2 s — r1 의 2 s 하한이면 기다렸을 값. 이제는 넣는다.
    t.backend.input = { revision: 5, idleMs: 1_200 }
    expect((await t.settled('l598r1-0000-0005')).state).toBe('delivered')
    expect(t.backend.fences.at(-1)).toMatchObject({ inputRevision: 5, minIdleMs: 500 })
  })
  it('화면 뒤 재관측에서 revision 이 바뀌었으면(접수 뒤 입력) 넣지 않고 끝낸다 — 다음 화면을 기다리지 않는다(r2)', async () => {
    const t = setup()
    const screen = t.backend.screen.bind(t.backend)
    let bumped = false
    t.backend.screen = async () => {
      const shot = await screen()
      if (!bumped && t.backend.input !== null) {
        bumped = true
        t.backend.input = { revision: t.backend.input.revision + 1, idleMs: 10_000 }
      }
      return shot
    }
    t.hub.send({ device: 'd1', id: 'l598r1-0000-0006', channel: 'c1', text: '다음 화면으로' })
    expect(await t.settled('l598r1-0000-0006')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
    expect(t.logs.filter((log) => log.tag === 'mobile.input_target_changed').map((log) => log.fields.check)).toEqual(['input'])
  })
  it('질문 답 — 화면 읽기 도중 세션만 바뀜 → 키 0회 target_changed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(12)
    t.items.list = [question({ id: 12, state: 'pending' })]
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => {
      const shot = await screen()
      t.backend.observedSession = () => newSession
      return shot
    }
    t.hub.answer({ device: 'd1', id: 'l598r1-0000-0007', channel: 'c1', question: 12, call: 'toolu-12', digest: digestFor(12), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('l598r1-0000-0007')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('질문 답 — 첫 화면이 quietMs 미만으로 조용하면 키를 넣지 않고 다시 읽는다(r2: 2 s 하한 없음 — G·R2-G1 해소)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(13)
    t.items.list = [question({ id: 13, state: 'pending' })]
    t.answerOn({ id: 13, value: 'o1' })
    const screen = t.backend.screen.bind(t.backend)
    const idles: number[] = []
    t.backend.screen = async () => {
      const shot = await screen()
      // 첫 읽기는 0.3 s 조용, 그 뒤는 0.6 s — 첫 읽기 뒤에는 키가 없어야 한다.
      const idleMs = idles.length === 0 ? 300 : 600
      idles.push(t.backend.sends.length)
      return { ...shot, input: shot.input === null ? null : { ...shot.input, idleMs } }
    }
    t.hub.answer({ device: 'd1', id: 'l598r1-0000-0008', channel: 'c1', question: 13, call: 'toolu-13', digest: digestFor(13), answers: [{ choices: [1], other: null }] })
    expect((await t.settled('l598r1-0000-0008')).state).toBe('delivered')
    expect(idles.slice(0, 2)).toEqual([0, 0])
  })
})

describe('LIFE-598 r2 — 접수 뒤 맥 입력이 있으면 넣지 않는다(접수 때 입력 revision 울타리)', () => {
  const newSession = observedSessionKey({ source: 'herdr:claude', kind: 'id', value: 'cleared-session' })
  /** 맥 키 한 번 — 입력 revision 만 움직인다(세션은 herdr·목록 모두 옛 값 그대로 = herdr 가 `/clear` 를 아직 모르는 때). */
  const typed = (t: ReturnType<typeof setup>): void => {
    if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1 }
  }
  const checks = (t: ReturnType<typeof setup>): unknown[] => t.logs.filter((log) => log.tag === 'mobile.input_target_changed').map((log) => log.fields.check)
  const states = (t: ReturnType<typeof setup>, id: string): string[] => t.wires.filter((wire) => wire.id === id).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}`)

  it('ⓓ 대기 중 맥 입력(세션은 herdr·목록 모두 옛 값) → prompt 0회 · failed/target_changed', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0001', channel: 'c1', text: '옛 세션 지시' })
    await wait(30)
    expect(t.last('l598r2-0000-0001')?.state).toBe('queued')
    typed(t)
    t.backend.quiet = true
    expect(await t.settled('l598r2-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
    expect(t.backend.prompts).toHaveLength(0)
    expect(checks(t)).toEqual(['input'])
  })
  it('ⓓ 양성 대조 — 접수 뒤 입력이 없으면 접수 때 revision 으로 넣는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.backend.input = { revision: 7, idleMs: 10_000 }
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0002', channel: 'c1', text: '그대로' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r2-0000-0002')).state).toBe('delivered')
    expect(t.backend.fences).toEqual([{ seq: 1, inputRevision: 7, minIdleMs: 500 }])
  })
  it('ⓔ 같은 pane 연속 두 지시 — 앞 지시의 허브 쓰기(revision +1) 뒤에도 뒤 지시를 넣는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0003', channel: 'c1', text: '앞 지시' })
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0004', channel: 'c1', text: '뒤 지시' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r2-0000-0003')).state).toBe('delivered')
    expect((await t.settled('l598r2-0000-0004')).state).toBe('delivered')
    expect(t.backend.prompts).toEqual(['앞 지시', '뒤 지시'])
    // 둘 다 접수 때 revision 1 — 뒤 지시의 울타리는 앞 지시 쓰기 뒤(2)로 옮겨졌다.
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([1, 2])
  })
  it('ⓕ 앞 지시 쓰기와 뒤 지시 사이 맥 입력 → 뒤 지시 failed/target_changed(앞 지시는 들어감)', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      const result = await prompt(pane, input)
      if ((calls += 1) === 1) typed(t)
      return result
    }
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0005', channel: 'c1', text: '앞 지시' })
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0006', channel: 'c1', text: '뒤 지시' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r2-0000-0005')).state).toBe('delivered')
    expect(await t.settled('l598r2-0000-0006')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual(['앞 지시'])
  })
  it('ⓑ guard 거절이 입력 변화면(재관측 revision ≠ 울타리) 큐로 돌리지 않고 failed/target_changed', async () => {
    const t = setup()
    // 효과 직전 재관측 뒤·guard 턴 전에 맥 키 — 가짜 guard 가 울타리로 거절한다.
    t.backend.onPrompt = () => {
      t.backend.onPrompt = null
      typed(t)
    }
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0007', channel: 'c1', text: '거절됨' })
    expect(await t.settled('l598r2-0000-0007')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
    expect(checks(t)).toEqual(['input_refused'])
    expect(states(t, 'l598r2-0000-0007')).not.toContain('queued:turn')
  })
  it('ⓑ guard 거절이 상태 전이면(revision 그대로) 큐로 — 다음 관문에서 넣는다', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => ((calls += 1) === 1 ? 'refused' : prompt(pane, input))
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0008', channel: 'c1', text: '다음 관문' })
    expect((await t.settled('l598r2-0000-0008')).state).toBe('delivered')
    expect(calls).toBe(2)
    expect(states(t, 'l598r2-0000-0008')).toContain('queued:turn')
  })
  it('ⓒ 답 키(허브 자기 쓰기) 뒤 대기 지시는 넣는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.quiet = false
    t.backend.screenText = questionScreen(14)
    t.items.list = [question({ id: 14, state: 'pending' })]
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0009', channel: 'c1', text: '답 뒤 지시' })
    await wait(30)
    t.answerOn({ id: 14, value: 'o1' })
    t.hub.answer({ device: 'd1', id: 'l598r2-0000-0010', channel: 'c1', question: 14, call: 'toolu-14', digest: digestFor(14), answers: [{ choices: [1], other: null }] })
    expect((await t.settled('l598r2-0000-0010')).state).toBe('delivered')
    t.backend.onSend = null
    t.backend.status = 'idle'
    t.backend.screenText = EMPTY
    t.backend.quiet = true
    expect((await t.settled('l598r2-0000-0009')).state).toBe('delivered')
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([2])
  })
  it('ⓒ 중단 키(허브 자기 쓰기) 뒤 대기 지시는 넣는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0011', channel: 'c1', text: '중단 뒤 지시' })
    await wait(30)
    t.backend.onSend = () => {
      t.backend.status = 'idle'
      t.backend.quiet = true
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r2-0000-0012', channel: 'c1' })
    expect((await t.settled('l598r2-0000-0012')).state).toBe('stopped')
    expect((await t.settled('l598r2-0000-0011')).state).toBe('delivered')
    // 중단 키는 울타리 없이(r3) — 사슬은 관측 revision 1 → 2 를 쓰기 전에 걸었다.
    expect(t.backend.keyFences).toEqual([null])
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([2])
  })
  it('ⓓ 답 — 접수 뒤(첫 화면 전) 맥 입력 → 키 0회 · failed/question_changed(로그는 입력 울타리)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(15)
    t.items.list = [question({ id: 15, state: 'pending' })]
    const screen = t.backend.screen.bind(t.backend)
    let first = true
    t.backend.screen = async () => {
      if (first) typed(t)
      first = false
      return screen()
    }
    t.hub.answer({ device: 'd1', id: 'l598r2-0000-0013', channel: 'c1', question: 15, call: 'toolu-15', digest: digestFor(15), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('l598r2-0000-0013')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
    expect(checks(t)).toEqual(['input'])
  })
  // --- 리뷰 r2 생존 변이(C·R2-C2·G·R2-G2)를 죽이는 시험 ---
  it('C·R2-C2(a) 화면 뒤 재관측의 seq 가 두 번째 관측과 다르면 그 관측으로 넣지 않는다 — 턴을 기다린 뒤 넣는다', async () => {
    const t = setup()
    const observe = t.backend.observe.bind(t.backend)
    let calls = 0
    // 접수(1)·first(2)·second(3)·last(4) — 효과 직전 재관측 한 번만 seq 가 다르다.
    t.backend.observe = async (pane) => {
      const seen = await observe(pane)
      return (calls += 1) === 4 ? { ...seen, seq: seen.seq + 1 } : seen
    }
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0014', channel: 'c1', text: '다음 턴' })
    expect((await t.settled('l598r2-0000-0014')).state).toBe('delivered')
    expect(states(t, 'l598r2-0000-0014')).toContain('queued:turn')
    expect(t.backend.fences).toEqual([expect.objectContaining({ seq: 1 })])
  })
  it('C·R2-C2(b) 화면 뒤 재관측에 입력 revision 이 없으면(guard) 넣지 않는다 — guard_outdated', async () => {
    const t = setup()
    const observe = t.backend.observe.bind(t.backend)
    let calls = 0
    t.backend.observe = async (pane) => {
      const seen = await observe(pane)
      return (calls += 1) === 4 ? { ...seen, input: null } : seen
    }
    t.hub.send({ device: 'd1', id: 'l598r2-0000-0015', channel: 'c1', text: 'x' })
    expect(await t.settled('l598r2-0000-0015')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('C·R2-C2(c) 답 둘째 키 전 herdr 관측만 새 세션(목록 옛 값) → 둘째 키 0 · unconfirmed/target_changed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(16)
    t.items.list = [question({ id: 16, state: 'pending' })]
    t.backend.onSend = () => { t.backend.observedSession = () => newSession }
    t.hub.answer({ device: 'd1', id: 'l598r2-0000-0016', channel: 'c1', question: 16, call: 'toolu-16', digest: digestFor(16), answers: [{ choices: [], other: '폰의 답' }] })
    expect(await t.settled('l598r2-0000-0016')).toMatchObject({ state: 'unconfirmed', reason: 'target_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
    expect(checks(t)).toEqual(['herdr_session'])
  })
  it('C·R2-C2(d) 답 키 사이 seq 전이(revision 그대로) → 다음 키 0 · unconfirmed/question_changed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(17)
    t.items.list = [question({ id: 17, state: 'pending' })]
    t.backend.onSend = () => { t.backend.seq += 1 }
    t.hub.answer({ device: 'd1', id: 'l598r2-0000-0017', channel: 'c1', question: 17, call: 'toolu-17', digest: digestFor(17), answers: [{ choices: [], other: '폰의 답' }] })
    expect(await t.settled('l598r2-0000-0017')).toMatchObject({ state: 'unconfirmed', reason: 'question_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
  })
  it('G·R2-G2 둘째 묶음 화면의 revision 이 앞 키 revision 과 다르면(화면 턴만 입력을 봄) 둘째 묶음 키 0', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [twoQuestions(32)]
    t.backend.screenText = boxOf('Q-32 첫째?')
    t.backend.onSend = () => { t.backend.screenText = boxOf('Q-32 둘째?') }
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => {
      const shot = await screen()
      return t.backend.sends.length === 0 || shot.input === null ? shot : { ...shot, input: { ...shot.input, revision: shot.input.revision + 5 } }
    }
    const item = twoQuestions(32)
    if (item.kind !== 'question') throw new Error('fixture')
    t.hub.answer({ device: 'd1', id: 'l598r2-0000-0018', channel: 'c1', question: 32, call: 'toolu-32', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })
    expect(await t.settled('l598r2-0000-0018')).toMatchObject({ state: 'unconfirmed', reason: 'question_changed' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['1'])
  })
})

describe('LIFE-598 r3 — 자기 쓰기 사슬은 쓰기 전에 · 순환 차단 · PTY 세대 · 중단 무울타리', () => {
  const lag = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const checks = (t: ReturnType<typeof setup>): unknown[] => t.logs.filter((log) => log.tag === 'mobile.input_target_changed').map((log) => log.fields.check)
  it('P1(리뷰 R3-C2) 중단 키가 guard 에서 쓰인 뒤 응답이 늦어도 대기 지시는 거짓 target_changed 가 아니다 — 넣는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0001', channel: 'c1', text: '중단 뒤 지시' })
    await wait(30)
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async (pane, input) => {
      const result = await send(pane, input) // revision +1 은 이미 일어남
      t.backend.status = 'idle'
      t.backend.quiet = true
      await lag(40) // 응답이 허브에 닿기까지 — 그 사이 펌프가 새 revision 을 본다
      return result
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r3-0000-0002', channel: 'c1' })
    expect((await t.settled('l598r3-0000-0002')).state).toBe('stopped')
    expect((await t.settled('l598r3-0000-0001')).state).toBe('delivered')
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([2])
    expect(checks(t)).toEqual([])
  })
  it('P2(리뷰 R3-C2) 답 키 — 같은 경합에서도 대기 지시를 넣는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.quiet = false
    t.backend.screenText = questionScreen(61)
    t.items.list = [question({ id: 61, state: 'pending' })]
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0003', channel: 'c1', text: '답 뒤 지시' })
    await wait(30)
    t.answerOn({ id: 61, value: 'o1' })
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async (pane, input) => {
      const result = await send(pane, input)
      await lag(40)
      return result
    }
    t.hub.answer({ device: 'd1', id: 'l598r3-0000-0004', channel: 'c1', question: 61, call: 'toolu-61', digest: digestFor(61), answers: [{ choices: [1], other: null }] })
    expect((await t.settled('l598r3-0000-0004')).state).toBe('delivered')
    t.backend.send = send
    t.backend.onSend = null
    t.backend.status = 'idle'
    t.backend.screenText = EMPTY
    t.backend.quiet = true
    expect((await t.settled('l598r3-0000-0003')).state).toBe('delivered')
    expect(checks(t)).toEqual([])
  })
  it('중단 키 관측과 키 사이 맥 입력(울타리 없는 키) → 중단은 들어가고 뒤 대기 지시는 target_changed(쓰지 않는 쪽)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0005', channel: 'c1', text: '맥 입력 뒤 지시' })
    await wait(30)
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async (pane, input) => {
      // 관측 뒤·키 앞의 맥 키 — 울타리 없는 중단 키는 그대로 들어간다.
      if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1 }
      return send(pane, input)
    }
    t.backend.onSend = () => {
      t.backend.status = 'idle'
      t.backend.quiet = true
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r3-0000-0006', channel: 'c1' })
    expect((await t.settled('l598r3-0000-0006')).state).toBe('stopped')
    expect(await t.settled('l598r3-0000-0005')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('R3-C3 쓴 뒤 revision 이 직전보다 크지 않으면(guard 가 +0 을 돌려줌) 사슬을 걸지 않는다 — 걸리지 않고 뒤 지시는 끝난다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.quiet = false
    t.backend.screenText = questionScreen(62)
    t.items.list = [question({ id: 62, state: 'pending' })]
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0007', channel: 'c1', text: '+0 뒤 지시' })
    await wait(30)
    t.answerOn({ id: 62, value: 'o1' })
    const send = t.backend.send.bind(t.backend)
    // guard 가 쓴 뒤 revision 을 쓰기 전 값 그대로 돌려준다(실제로는 +1) — 그 값을 고리로 걸면 자기 고리다.
    t.backend.send = async (pane, input) => {
      const result = await send(pane, input)
      return result.kind === 'sent' && result.revision !== null ? { kind: 'sent', revision: result.revision - 1 } : result
    }
    t.hub.answer({ device: 'd1', id: 'l598r3-0000-0008', channel: 'c1', question: 62, call: 'toolu-62', digest: digestFor(62), answers: [{ choices: [1], other: null }] })
    await t.settled('l598r3-0000-0008')
    t.backend.send = send
    t.backend.onSend = null
    t.backend.status = 'idle'
    t.backend.screenText = EMPTY
    t.backend.quiet = true
    expect(await t.settled('l598r3-0000-0007')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('R3-C5 같은 revision 숫자의 새 PTY 세대 항목은 옛 세대의 사슬을 타지 않는다', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0009', channel: 'c1', text: '옛 세대' })
    expect((await t.settled('l598r3-0000-0009')).state).toBe('delivered')
    // 옛 PTY 의 사슬 1 → 2. 새 PTY 는 revision 을 1 부터 다시 센다.
    t.backend.ptyId = 't-respawned'
    t.backend.input = { revision: 1, idleMs: 10_000 }
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0010', channel: 'c1', text: '새 세대' })
    expect((await t.settled('l598r3-0000-0010')).state).toBe('delivered')
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([1, 1])
  })
  it('R3-C5 지시 `unknown`(썼을 수 있음)은 사슬을 잇지 않는다 — 뒤 대기 지시는 target_changed', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      const result = await prompt(pane, input)
      return (calls += 1) === 1 ? 'unknown' : result
    }
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0011', channel: 'c1', text: '시간 초과' })
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0012', channel: 'c1', text: '뒤 지시' })
    await wait(30)
    t.backend.quiet = true
    await t.settled('l598r3-0000-0011')
    expect(await t.settled('l598r3-0000-0012')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual(['시간 초과'])
  })
  it('R3-C5(x7) guard 거절과 겹친 허브 자기 쓰기(중단 키)가 끝났으면 거절 뒤 판별은 지금 사슬로 — 큐로 돌아가 넣는다', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      if ((calls += 1) === 1) {
        // 넣기 요청이 guard 에 닿기 전에 폰 중단 키가 먼저 쓰였다(revision +1) — 이 넣기는 울타리로 거절된다.
        t.backend.status = 'working'
        t.backend.onSend = () => { t.backend.status = 'idle' }
        t.hub.stopTurn({ device: 'd1', id: 'l598r3-0000-0014', channel: 'c1' })
        await lag(20)
      }
      return prompt(pane, input)
    }
    t.hub.send({ device: 'd1', id: 'l598r3-0000-0013', channel: 'c1', text: '거절 뒤 다시' })
    expect((await t.settled('l598r3-0000-0013')).state).toBe('delivered')
    expect((await t.settled('l598r3-0000-0014')).state).toBe('stopped')
    expect(t.backend.prompts).toEqual(['거절 뒤 다시'])
    expect(checks(t)).toEqual([])
  })
})

describe('LIFE-598 r4 — 진행 중 넣지 않음 · reject 정리 · 응답 없는 +1 은 재관측으로 · 답은 확정 고리까지', () => {
  const lag = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const macKey = (t: ReturnType<typeof setup>): void => {
    if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1, idleMs: 0 }
  }
  it('P7(C·R4-C1·G·R4-G1) 중단 키가 guard 에 닿기 전 맥 키(예측 끝값과 같은 revision) + 에이전트 한가 → 진행 중이라 대기 지시를 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0001', channel: 'c1', text: '맥 키 뒤 지시' })
    await wait(30)
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async (pane, input) => {
      macKey(t)
      t.backend.status = 'idle'
      t.backend.quiet = true
      t.backend.input = t.backend.input === null ? null : { ...t.backend.input, idleMs: 10_000 }
      await lag(120) // in-flight — 펌프가 관문을 도는 동안
      return send(pane, input)
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r4-0000-0002', channel: 'c1' })
    await t.settled('l598r4-0000-0002')
    expect(await t.settled('l598r4-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual([])
  })
  it('P1(R4-C2) 지시 prompt 가 reject 하면 진행 표시를 남기지 않는다 — 같은 pane 다음 지시가 들어간다', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      if ((calls += 1) === 1) throw new Error('boom')
      return prompt(pane, input)
    }
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0003', channel: 'c1', text: '던짐' })
    expect(await t.settled('l598r4-0000-0003')).toMatchObject({ state: 'unconfirmed', reason: 'backend' })
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0004', channel: 'c1', text: '다음' })
    expect((await t.settled('l598r4-0000-0004')).state).toBe('delivered')
  })
  it('P2(R4-C2) 답 키 send 가 reject 해도 같은 pane 다음 지시가 queued 로 남지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.quiet = false
    t.backend.screenText = questionScreen(71)
    t.items.list = [question({ id: 71, state: 'pending' })]
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async () => { throw new Error('boom') }
    t.hub.answer({ device: 'd1', id: 'l598r4-0000-0005', channel: 'c1', question: 71, call: 'toolu-71', digest: digestFor(71), answers: [{ choices: [1], other: null }] })
    await t.settled('l598r4-0000-0005')
    t.backend.send = send
    t.backend.status = 'idle'
    t.backend.quiet = true
    t.backend.screenText = EMPTY
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0006', channel: 'c1', text: '다음' })
    expect((await t.settled('l598r4-0000-0006')).state).toBe('delivered')
  })
  it('중단 키 send 가 reject 해도 같은 pane 대기 지시는 끝난다(진행 표시 없음 — 고리 거둠 → target_changed)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0007', channel: 'c1', text: '중단 reject 뒤' })
    await wait(30)
    t.backend.send = async () => {
      // 썼는지 모른다 — 실제로 썼다고 치자(revision +1).
      macKey(t)
      t.backend.status = 'idle'
      t.backend.quiet = true
      throw new Error('boom')
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r4-0000-0008', channel: 'c1' })
    await t.settled('l598r4-0000-0008')
    expect(await t.settled('l598r4-0000-0007')).toMatchObject({ state: 'failed', reason: 'target_changed' })
  })
  it('P3(R4-C3) guard 가 지시에서 revision 을 안 올리면(+0) 고리를 확정하지 않는다 — 뒤 지시는 영구 behind 없이 들어간다', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    t.backend.prompt = async (pane, input) => {
      const before = t.backend.input
      const result = await prompt(pane, input)
      if (before !== null) t.backend.input = before
      return result
    }
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0009', channel: 'c1', text: '앞' })
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0010', channel: 'c1', text: '뒤' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r4-0000-0009')).state).toBe('delivered')
    expect((await t.settled('l598r4-0000-0010')).state).toBe('delivered')
    expect(t.backend.fences.map((fence) => fence.inputRevision)).toEqual([1, 1])
  })
  it('R4-C3 중단 키 +0(guard 계약 깨짐) 뒤 맥 +1 → 맥 입력을 자기 쓰기로 삼키지 않는다 — 뒤 지시 target_changed', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0011', channel: 'c1', text: '삼키면 안 됨' })
    await wait(30)
    const send = t.backend.send.bind(t.backend)
    t.backend.send = async (pane, input) => {
      const before = t.backend.input
      const result = await send(pane, input)
      if (before !== null) t.backend.input = before // +0
      t.backend.status = 'idle'
      setTimeout(() => {
        macKey(t)
        if (t.backend.input !== null) t.backend.input = { ...t.backend.input, idleMs: 10_000 }
        t.backend.quiet = true
      }, 40)
      return result
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r4-0000-0012', channel: 'c1' })
    await t.settled('l598r4-0000-0012')
    expect(await t.settled('l598r4-0000-0011')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual([])
  })
  it('P4 앞 지시가 쓰인 뒤 응답 지연 중 맥 키 → 뒤 지시 target_changed', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      const result = await prompt(pane, input)
      if ((calls += 1) === 1) {
        macKey(t)
        await lag(60)
      }
      return result
    }
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0013', channel: 'c1', text: '앞' })
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0014', channel: 'c1', text: '뒤' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r4-0000-0013')).state).toBe('delivered')
    expect(await t.settled('l598r4-0000-0014')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual(['앞'])
  })
  it('P5 앞 지시 in-flight 중 맥 키가 먼저(앞 지시 거절) → 뒤 지시 target_changed, 뒤 prompt 0회', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      if ((calls += 1) === 1) {
        macKey(t)
        await lag(60)
      }
      return prompt(pane, input)
    }
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0015', channel: 'c1', text: '앞' })
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0016', channel: 'c1', text: '뒤' })
    await wait(30)
    t.backend.quiet = true
    await t.settled('l598r4-0000-0015')
    expect(await t.settled('l598r4-0000-0016')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual([])
  })
  it('R4-C4 답은 같은 pane 지시 쓰기가 끝날 때까지 기다려 확정 고리까지만 울타리로 — 지시 거절 뒤 맥 키면 답 키 0', async () => {
    const t = setup()
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      if ((calls += 1) === 1) {
        // 넣기 in-flight 중 에이전트가 질문으로 막히고 폰 답이 온다(허브 상태 기계상 가능한 조합).
        t.backend.status = 'blocked'
        t.backend.quiet = false
        t.backend.screenText = questionScreen(72)
        t.items.list = [question({ id: 72, state: 'pending' })]
        t.answerOn({ id: 72, value: 'o1' })
        // 답의 첫 화면 읽기 순간에 맥 키 — R0(맥 키 전) 뒤이고, 그 revision 은 아직 미확정인 넣기 고리의 끝(R0+1)과 같다.
        const screen = t.backend.screen.bind(t.backend)
        let first = true
        t.backend.screen = async () => {
          if (first) {
            first = false
            macKey(t)
            if (t.backend.input !== null) t.backend.input = { ...t.backend.input, idleMs: 10_000 }
          }
          return screen()
        }
        t.hub.answer({ device: 'd1', id: 'l598r4-0000-0018', channel: 'c1', question: 72, call: 'toolu-72', digest: digestFor(72), answers: [{ choices: [1], other: null }] })
        await lag(100)
        return 'refused'
      }
      return prompt(pane, input)
    }
    t.hub.send({ device: 'd1', id: 'l598r4-0000-0017', channel: 'c1', text: '앞' })
    expect(await t.settled('l598r4-0000-0018')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
})

describe('LIFE-598 r5 낮음 — 재관측 실패·답 대기·중단 확인 기한·빈 사슬 정리', () => {
  const lag = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  /** 지시가 들어간 직후의 다음 관측 한 번(= 사슬 확정용 재관측)만 바꾼다. */
  const afterPrompt = (t: ReturnType<typeof setup>, seen: (pane: TerminalIdentity, observe: (pane: TerminalIdentity) => Promise<PaneObservation>) => Promise<PaneObservation>): void => {
    const prompt = t.backend.prompt.bind(t.backend)
    const observe = t.backend.observe.bind(t.backend)
    let armed = false
    let calls = 0
    t.backend.prompt = async (pane, input) => {
      const result = await prompt(pane, input)
      if ((calls += 1) === 1) armed = true
      return result
    }
    t.backend.observe = async (pane) => {
      if (!armed) return observe(pane)
      armed = false
      return seen(pane, observe)
    }
  }
  it('C·R5-C1 지시가 들어간 뒤 재관측이 reject → 이 지시는 delivered, 고리는 거둬 뒤 지시 target_changed(k8)', async () => {
    const t = setup()
    afterPrompt(t, async () => { throw new Error('observe boom') })
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0001', channel: 'c1', text: '앞' })
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0002', channel: 'c1', text: '뒤' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r5-0000-0001')).state).toBe('delivered')
    expect(await t.settled('l598r5-0000-0002')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual(['앞'])
  })
  it('C·R5-C1 재관측에 입력 revision 이 없으면(null) 확정하지 않는다 — 뒤 지시 target_changed(k9)', async () => {
    const t = setup()
    afterPrompt(t, async (pane, observe) => ({ ...(await observe(pane)), input: null }))
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0003', channel: 'c1', text: '앞' })
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0004', channel: 'c1', text: '뒤' })
    await wait(30)
    t.backend.quiet = true
    expect((await t.settled('l598r5-0000-0003')).state).toBe('delivered')
    expect(await t.settled('l598r5-0000-0004')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toEqual(['앞'])
  })
  /** 지시 넣기가 `hold` ms 걸리는 동안 질문이 열리고 폰 답이 온다 — 넣기는 결국 들어간다(revision +1). */
  const slowPromptWithAnswer = (t: ReturnType<typeof setup>, input: { hold: number; id: number; answerId: string; during?: () => void }): void => {
    const prompt = t.backend.prompt.bind(t.backend)
    let calls = 0
    t.backend.prompt = async (pane, args) => {
      if ((calls += 1) === 1) {
        t.backend.status = 'blocked'
        t.backend.quiet = false
        t.backend.screenText = questionScreen(input.id)
        t.items.list = [question({ id: input.id, state: 'pending' })]
        t.answerOn({ id: input.id, value: 'o1' })
        t.hub.answer({ device: 'd1', id: input.answerId, channel: 'c1', question: input.id, call: `toolu-${input.id}`, digest: digestFor(input.id), answers: [{ choices: [1], other: null }] })
        await lag(30) // 답이 R0(넣기 전 값)를 잡고 진행 중 쓰기를 기다린다
        input.during?.()
        await lag(input.hold)
      }
      return prompt(pane, args)
    }
  }
  it('C·R5-C2 지시가 느리게 들어가는 동안 온 답은 기다린 뒤 확정 고리(R0+1)를 울타리로 — 답도 delivered(k11)', async () => {
    const t = setup()
    slowPromptWithAnswer(t, { hold: 80, id: 81, answerId: 'l598r5-0000-0006' })
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0005', channel: 'c1', text: '앞' })
    expect((await t.settled('l598r5-0000-0006')).state).toBe('delivered')
    expect(t.backend.keyFences).toEqual([2])
  })
  it('C·R5-C2 지시 넣기가 answerConfirmMs(300) 보다 오래 걸리면 답은 키 0회 failed/busy(k3)', async () => {
    const t = setup()
    slowPromptWithAnswer(t, { hold: 700, id: 82, answerId: 'l598r5-0000-0008' })
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0007', channel: 'c1', text: '앞' })
    expect(await t.settled('l598r5-0000-0008')).toMatchObject({ state: 'failed', reason: 'busy' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('C·R5-C2 답이 기다리는 동안 모바일을 끄면 바로 끝난다(halted — 기한·쓰기 끝을 기다리지 않음, k10)', async () => {
    const t = setup()
    let offAt = 0
    slowPromptWithAnswer(t, { hold: 600, id: 83, answerId: 'l598r5-0000-0010', during: () => { offAt = Date.now(); t.hub.stop() } })
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0009', channel: 'c1', text: '앞' })
    expect(await t.settled('l598r5-0000-0010')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
    expect(Date.now() - offAt).toBeLessThan(200)
    // 대기 루프도 그 자리에서 멈춰야 한다 — 기한(300 ms)·쓰기 끝(600 ms) 뒤에 결과를 다른 이유(`busy` 등)로 덮어쓰거나 키를 넣지 않는다.
    await wait(800)
    expect(t.last('l598r5-0000-0010')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
    expect(t.wires.filter((wire) => wire.id === 'l598r5-0000-0010' && wire.state === 'failed')).toHaveLength(1)
    expect(t.backend.sends).toHaveLength(0)
  })
  it('C·R5-C3 중단 확인 기한은 사슬 재관측 뒤부터 — 관측이 느려도(150 ms) 기한(200 ms) 안에 멈춤을 본다', async () => {
    const t = setup()
    t.backend.status = 'working'
    const observe = t.backend.observe.bind(t.backend)
    let keyAt = 0
    t.backend.onSend = () => {
      keyAt = Date.now()
      // 키 뒤 320 ms 에 멈춘다.
      setTimeout(() => { t.backend.status = 'idle' }, 320)
    }
    t.backend.observe = async (pane) => {
      if (keyAt > 0) await lag(150)
      return observe(pane)
    }
    t.hub.stopTurn({ device: 'd1', id: 'l598r5-0000-0011', channel: 'c1' })
    expect((await t.settled('l598r5-0000-0011', 3_000)).state).toBe('stopped')
  })
  it('C·R5-C5 고리가 하나도 남지 않은 pane 의 사슬 Map 은 버린다(거절·unknown 뒤 빈 Map 없음)', async () => {
    const t = setup()
    t.backend.promptResult = 'unknown'
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0012', channel: 'c1', text: '시간 초과' })
    await t.settled('l598r5-0000-0012')
    expect(t.hub.selfWritePanes()).toBe(0)
    // 들어간 쓰기의 확정 고리는 남는다(뒤 지시의 울타리).
    t.backend.promptResult = 'sent'
    t.hub.send({ device: 'd1', id: 'l598r5-0000-0013', channel: 'c1', text: '들어감' })
    expect((await t.settled('l598r5-0000-0013')).state).toBe('delivered')
    expect(t.hub.selfWritePanes()).toBe(1)
  })
})

describe('LIFE-598 효과 직전 세션 — 목록이 늦어도 herdr 관측이 바뀌었으면 넣지 않는다', () => {
  const newSession = observedSessionKey({ source: 'herdr:claude', kind: 'id', value: 'cleared-session' })
  it('ⓐ 목록은 옛 세션, herdr 관측은 새 세션(/clear) → failed/target_changed, prompt 0회', async () => {
    const t = setup()
    t.backend.observedSession = () => newSession
    t.hub.send({ device: 'd1', id: 'l598-0000-0001', channel: 'c1', text: '옛 세션 지시' })
    expect(await t.settled('l598-0000-0001')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓐ\' 대기 중(작업 중)에 herdr 세션만 바뀌면 관문을 넘는 순간 target_changed — 새 세션에 넣지 않는다', async () => {
    const t = setup()
    t.backend.quiet = false
    t.hub.send({ device: 'd1', id: 'l598-0000-0002', channel: 'c1', text: '대기 지시' })
    await new Promise((done) => setTimeout(done, 30))
    expect(t.last('l598-0000-0002')?.state).toBe('queued')
    t.backend.observedSession = () => newSession
    t.backend.quiet = true
    expect(await t.settled('l598-0000-0002')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓑ herdr 관측에 세션이 없으면(null) 쓰지 않고 끝낸다 — queued 로 남지 않는다', async () => {
    const t = setup()
    t.backend.observedSession = () => null
    t.hub.send({ device: 'd1', id: 'l598-0000-0003', channel: 'c1', text: '증명 못 함' })
    expect(await t.settled('l598-0000-0003')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('ⓒ 세션이 같으면(목록 = herdr) 지금처럼 넣는다', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'l598-0000-0004', channel: 'c1', text: '같은 세션' })
    expect(await t.settled('l598-0000-0004')).toMatchObject({ state: 'delivered' })
    expect(t.backend.prompts).toEqual(['같은 세션'])
  })
  it('질문 답 — 목록은 옛 세션, herdr 관측은 새 세션 → 키 0회 target_changed', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(11)
    t.items.list = [question({ id: 11, state: 'pending' })]
    t.backend.observedSession = () => newSession
    t.hub.answer({ device: 'd1', id: 'l598-0000-0005', channel: 'c1', question: 11, call: 'toolu-11', digest: digestFor(11), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('l598-0000-0005')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
})

describe('R2-A7 기록 회전 — 다른 파일(inode)의 과거 같은 글을 새 제출로 세지 않는다', () => {
  it('넣는 동안 경로가 같은 글이 이미 있던 다른 파일로 바뀌면 unconfirmed(record_rewritten)', async () => {
    const t = setup()
    const text = '같은 초의 이전 제출'
    const replacement = `${t.file}.replacement`
    // 요청 전에 이미 있던 기록 — 접두 + 같은 글.
    fs.writeFileSync(replacement, `${fs.readFileSync(t.file, 'utf8')}${userLine(text)}\n`)
    t.backend.onPrompt = () => {
      fs.renameSync(t.file, `${t.file}.old`)
      fs.renameSync(replacement, t.file)
    }
    t.backend.delivery = 'none'
    t.hub.send({ device: 'd1', id: 'r2a7-0000-0001', channel: 'c1', text })
    expect(await t.settled('r2a7-0000-0001')).toMatchObject({ state: 'unconfirmed', reason: 'record_rewritten' })
  })
  it('대조 — 같은 파일에 덧붙으면 들어감', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'r2a7-0000-0002', channel: 'c1', text: '정상 덧붙임' })
    expect((await t.settled('r2a7-0000-0002')).state).toBe('delivered')
  })
})

describe('R2-A9 답·중단은 취소를 받지 않는다 — 취소를 답한 뒤 키를 넣지 않는다', () => {
  it('답 접수 직후 같은 id 취소 → cancelled 를 내보내지 않고, 상태가 끝에서 sending 으로 되돌아가지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, value: 'o0' })
    t.hub.answer({ device: 'd1', id: 'r2a9-0000-0001', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    t.hub.cancel({ device: 'd1', id: 'r2a9-0000-0001' })
    expect((await t.settled('r2a9-0000-0001')).state).toBe('delivered')
    const states = t.wires.filter((wire) => wire.id === 'r2a9-0000-0001').map((wire) => wire.state)
    expect(states).not.toContain('cancelled')
    // 끝난 상태 뒤에 sending·queued 가 다시 오지 않는다.
    const final = states.findIndex((state) => !['queued', 'sending'].includes(state))
    expect(states.slice(final).every((state) => state === 'delivered')).toBe(true)
  })
})

describe('C5 활성 세대 — 끄고 바로 켜도(stopped=false) 이전 세대 요청은 효과를 내지 않는다', () => {
  it('guard 거절 사이에 끄고 켜면 되살려 다시 넣지 않는다(mobile_off, 넣기 시도 1회)', async () => {
    const t = setup()
    let attempts = 0
    t.backend.promptResult = 'refused'
    t.backend.onPrompt = () => {
      attempts += 1
      t.hub.stop()
      t.hub.start()
    }
    t.hub.send({ device: 'd1', id: 'c5-0000-0001', channel: 'c1', text: '이전 세대' })
    expect(await t.settled('c5-0000-0001')).toMatchObject({ state: 'failed', reason: 'mobile_off' })
    await wait(60)
    expect(attempts).toBe(1)
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('답 키 사이에 끄고 켜면 남은 키를 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => {
      t.hub.stop()
      t.hub.start()
    }
    t.hub.answer({ device: 'd1', id: 'c5-0000-0002', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [], other: '본문' }] })
    expect(await t.settled('c5-0000-0002')).toMatchObject({ state: 'unconfirmed', reason: 'mobile_off' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['3'])
  })
})

// --- 수정 r3 (Codex r3 지적) ---------------------------------------------------------------------------

const Z1 = path.resolve(__dirname, '../../../../specs/LIFE-582-mobile-input/raw/claude/z1')
const z1 = (name: string): string => fs.readFileSync(path.join(Z1, name), 'utf8')
const z1Permission = (pane: string): string => {
  const text = z1('perm-screens.txt')
  const start = text.indexOf(`== w1:${pane} `)
  const next = text.indexOf('== w1:', start + 1)
  return text.slice(text.indexOf('\n', start) + 1, next < 0 ? undefined : next)
}

/** Claude multiSelect 상자 — `checked` = 체크된 칸(0부터), 직접 입력 행은 `other`(없으면 자리표시). 머리 탭은 체크가 있으면 ☒(Z1 a-q2-after13). */
const multiBox = (input: { id: number; options: number; checked: number[]; other?: string; cursor?: number }): string => {
  const cursor = input.cursor ?? 1
  const row = (n: number, label: string, on: boolean) => `${n === cursor ? '❯ ' : '  '}${n}. [${on ? '✔' : ' '}] ${label}`
  return ['', RULE, `←  ${input.checked.length > 0 || input.other !== undefined ? '☒' : '☐'} Pick  ✔ Submit  →`, `Q-${input.id} 어느 쪽?`,
    ...Array.from({ length: input.options }, (_, index) => row(index + 1, `o${index}`, input.checked.includes(index))),
    row(input.options + 1, input.other ?? 'Type something', input.other !== undefined), '     Submit', RULE, `  ${input.options + 2}. Chat about this`, 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\r\n')
}
const multiQuestion = (id: number, options: number, state: 'pending' | 'answered' = 'pending'): ChatItem => ({
  id, kind: 'question', call: `toolu-${id}`, state, answer: null, at: null,
  questions: [{ question: `Q-${id} 어느 쪽?`, header: null, options: Array.from({ length: options }, (_, index) => ({ label: `o${index}`, description: null })), multiSelect: true }],
})
const questionsOf = (item: ChatItem): Extract<ChatItem, { kind: 'question' }>['questions'] => {
  if (item.kind !== 'question') throw new Error('fixture')
  return item.questions
}
const REVIEW_R3 = ['', RULE, '←  ☒ Pick  ✔ Submit  →', '', 'Review your answers', '', ' ● Q?', '   → o0', '', 'Ready to submit your answers?', '', '❯ 1. Submit answers', '  2. Cancel'].join('\r\n')

/**
 * Claude multiSelect 를 흉내 내는 가짜 화면 — 숫자 키는 칸을 뒤집고(커서는 그대로), ↓·Enter 로 Submit 행에 가면 검토 화면, 검토의 `1` 이면
 * **그때 체크된 칸**을 기록의 답 값으로 남긴다(실물 `toolUseResult.answers` 모양). 맥이 먼저 체크한 칸이 있으면 그 상태에서 시작한다.
 */
function claudeMulti(t: ReturnType<typeof setup>, input: { id: number; options: number; checked: number[] }): { checked: Set<number> } {
  const state = { checked: new Set(input.checked) }
  let downs = 0
  t.backend.status = 'blocked'
  t.items.list = [multiQuestion(input.id, input.options)]
  t.backend.screenText = multiBox({ id: input.id, options: input.options, checked: [...state.checked] })
  t.backend.onSend = (text) => {
    if (t.backend.screenText === REVIEW_R3) {
      if (text !== '1') return
      const labels = [...state.checked].sort((a, b) => a - b).map((index) => `o${index}`)
      fs.appendFileSync(t.file, `${answerLine(`toolu-${input.id}`, false, { [`Q-${input.id} 어느 쪽?`]: labels.join(', ') })}\n`)
      t.items.list = [multiQuestion(input.id, input.options, 'answered')]
      t.backend.screenText = EMPTY
      return
    }
    if (/^[1-9]$/.test(text)) {
      const index = Number(text) - 1
      if (state.checked.has(index)) state.checked.delete(index)
      else state.checked.add(index)
      t.backend.screenText = multiBox({ id: input.id, options: input.options, checked: [...state.checked] })
    } else if (text === KEY.down) downs += 1
    else if (text === KEY.enter && downs === input.options + 1) t.backend.screenText = REVIEW_R3
  }
  return state
}

describe('R3-A1 맥이 이미 고른 상태 — 정확히 셀 수 있으면 그 키, 아니면 키 0회 · 답 값 대조', () => {
  it('재현 — 맥이 1번을 체크해 둔 multiSelect 에 폰 [0,1] → 2번만 뒤집고 기록 답 = o0, o1 · 들어감', async () => {
    const t = setup()
    const screen = claudeMulti(t, { id: 40, options: 3, checked: [0] })
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0001', channel: 'c1', question: 40, call: 'toolu-40', digest: questionDigest(questionsOf(multiQuestion(40, 3))), answers: [{ choices: [0, 1], other: null }] })
    expect(await t.settled('r3a1-0000-0001')).toMatchObject({ state: 'delivered' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['2', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter, '1'])
    expect([...screen.checked].sort()).toEqual([0, 1])
  })
  it('양성 대조 — 갓 열린 빈 multiSelect 에 폰 [0,1] → 1·2 뒤집기 · 들어감', async () => {
    const t = setup()
    claudeMulti(t, { id: 41, options: 3, checked: [] })
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0002', channel: 'c1', question: 41, call: 'toolu-41', digest: questionDigest(questionsOf(multiQuestion(41, 3))), answers: [{ choices: [0, 1], other: null }] })
    expect(await t.settled('r3a1-0000-0002')).toMatchObject({ state: 'delivered' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['1', '2', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter, '1'])
  })
  it('기록의 답 값이 폰 답과 다르면 1건이어도 들어감이 아니다(answer_mismatch)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, value: 'o0' })
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0003', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('r3a1-0000-0003')).toMatchObject({ state: 'unconfirmed', reason: 'answer_mismatch' })
  })
  it('답 값을 못 읽으면 들어감이 아니다(answer_unreadable)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10 })
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [1], other: null }] })
    expect(await t.settled('r3a1-0000-0004')).toMatchObject({ state: 'unconfirmed', reason: 'answer_unreadable' })
  })
  it('맥에서 고르는 중(직접 입력 글 · 커서 이동)이면 키 0회 실패 question_in_progress', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [multiQuestion(42, 3)]
    t.backend.screenText = multiBox({ id: 42, options: 3, checked: [], other: '메모' })
    const digest = questionDigest(questionsOf(multiQuestion(42, 3)))
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0005', channel: 'c1', question: 42, call: 'toolu-42', digest, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r3a1-0000-0005')).toMatchObject({ state: 'failed', reason: 'question_in_progress' })
    t.backend.screenText = multiBox({ id: 42, options: 3, checked: [], cursor: 2 })
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0006', channel: 'c1', question: 42, call: 'toolu-42', digest, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r3a1-0000-0006')).toMatchObject({ state: 'failed', reason: 'question_in_progress' })
    // 하나 고름 — 커서가 2행이면 숫자가 어디로 갈지 셀 수 없다.
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.screenText = questionScreen(10).replace('❯ 1. o0', '  1. o0').replace('  2. o1', '❯ 2. o1')
    t.hub.answer({ device: 'd1', id: 'r3a1-0000-0007', channel: 'c1', question: 10, call: 'toolu-10', digest: digestFor(10), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r3a1-0000-0007')).toMatchObject({ state: 'failed', reason: 'question_in_progress' })
    expect(t.backend.sends).toHaveLength(0)
  })
})

describe('R3-A2 활성 영역 아래 경계 — 끝난 질문 상자 + 지금 권한 질문(Z1 실측 합성, 세 provider)', () => {
  const cases: { kind: MobileAgentKind; channel: string; file: string; pane: string }[] = [
    { kind: 'claude', channel: 'c1', file: 'a-q1-screen.txt', pane: 'p7' },
    { kind: 'codex', channel: 'c2', file: 'ca-q1-open.txt', pane: 'p8' },
    { kind: 'grok', channel: 'c3', file: 'ga-q1-screen.txt', pane: 'p9' },
  ]
  for (const { kind, channel, file, pane } of cases) {
    it(`${kind} — 키 0회 · 실패`, async () => {
      const t = setup()
      const old = z1(file)
      const active = activeQuestion({ kind, screen: old })
      if (active.kind !== 'question') throw new Error('fixture')
      // 실물 설명(Z1: Claude `Pick X`, Grok 라벨 반복)을 넣는다 — 설명이 틀려 `other` 로 떨어지면 아래 경계 없이도 이 시험이 통과한다.
      const descriptions = active.options.map((label) => (kind === 'claude' ? `Pick ${label}` : kind === 'grok' ? label : null))
      // 양성 대조 — 같은 상자 홀로는 그 질문이다(아래 경계만이 막는다).
      expect(matchQuestion({ kind, active, question: { question: active.title, options: active.options, multiSelect: false, preview: false, descriptions }, index: 0, total: 1 }).kind).toBe('same')
      t.backend.status = 'blocked'
      t.backend.screenText = `${old}\n${z1Permission(pane)}`
      const item: ChatItem = { id: 10, kind: 'question', call: 'call-old', questions: [{ question: active.title, header: null, options: active.options.map((label, index) => ({ label, description: descriptions[index] ?? null })), multiSelect: false }], state: 'pending', answer: null, at: null }
      t.items.list = [item]
      t.hub.answer({ device: 'd1', id: `r3a2-${kind}`, channel, question: 10, call: 'call-old', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }] })
      expect(await t.settled(`r3a2-${kind}`)).toMatchObject({ state: 'failed', reason: 'question_changed' })
      expect(t.backend.sends).toHaveLength(0)
    })
  }
})

/** Codex 질문 도구 호출 줄 · 답 봉투 줄(실물 모양) — 판독자(`ChatBuilder`)가 이 파일을 읽어 대기 질문을 만든다. */
const codexAsk = (call: string, titles: string[]): string =>
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: titles.map((title, index) => ({ id: `q${index}`, title, options: ['Tea', 'Coffee'] })) }), call_id: call } })
const codexAnswerLine = (input: { call: string; index: number; question: string; answer: string }): string =>
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: `<send_user_message_question_reply>\n${JSON.stringify([{ answer: input.answer, question: input.question, questionItemId: JSON.stringify(['request_user_input_async', input.call, input.index]) }])}\n</send_user_message_question_reply>` } })
const readItems = (file: string): ChatItem[] => {
  const builder = new ChatBuilder({ agent: 'codex', sessionId: null })
  let offset = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    builder.feed({ offset, line })
    offset += Buffer.byteLength(line) + 1
  }
  return builder.items
}
const codexBox = (input: { counter: string | null; title: string }): string =>
  ['• Queued follow-up inputs', '', ...(input.counter === null ? [] : [`  ${input.counter}`]), `  ${input.title}`, '', '  › 1. Tea', '    2. Coffee', '    3. Other', '', '  enter submit   ⌃] skip   ⇧→ main prompt'].join('\r\n')

describe('R3-A3 Codex 여러 문항 — 남은 위치 · 문항별 해소 (판독자 = ChatBuilder)', () => {
  it('판독자 — 봉투가 문항마다 오면 마지막 문항까지 대기 · 다 차면 답함', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l582r3-'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = path.join(root, 'codex.jsonl')
    const titles = ['Pick color', 'Pick drink', 'Pick size']
    fs.writeFileSync(file, `${codexAsk('call-3q', titles)}\n`)
    const state = () => readItems(file).find((item) => item.kind === 'question')
    expect(state()).toMatchObject({ state: 'pending' })
    fs.appendFileSync(file, `${codexAnswerLine({ call: 'call-3q', index: 0, question: titles[0]!, answer: 'Tea' })}\n`)
    expect(state()).toMatchObject({ state: 'pending' })
    fs.appendFileSync(file, `${codexAnswerLine({ call: 'call-3q', index: 1, question: titles[1]!, answer: 'Tea' })}\n`)
    expect(state()).toMatchObject({ state: 'pending' })
    // 다른 호출의 봉투는 이 질문을 풀지 않는다.
    fs.appendFileSync(file, `${codexAnswerLine({ call: 'call-other', index: 2, question: titles[2]!, answer: 'Tea' })}\n`)
    expect(state()).toMatchObject({ state: 'pending' })
    fs.appendFileSync(file, `${codexAnswerLine({ call: 'call-3q', index: 2, question: titles[2]!, answer: 'Coffee' })}\n`)
    expect(state()).toMatchObject({ state: 'answered', answer: 'Tea · Tea · Coffee' })
  })
  it('허브 — 3문항(1 of 3 → 1 of 2 → 표시 없음) 정상 경로가 들어감', async () => {
    const t = setup()
    const titles = ['Pick color', 'Pick drink', 'Pick size']
    fs.writeFileSync(t.file, `${codexAsk('call-3q', titles)}\n`)
    t.items.list = readItems(t.file)
    const item = t.items.list.find((entry) => entry.kind === 'question')
    if (item === undefined || item.kind !== 'question') throw new Error('fixture')
    t.backend.status = 'blocked'
    t.backend.screenText = [...'• Queued follow-up inputs\n  ? 3 questions · 3s\n    ⇧← to answer\n\n› Ask Codex to do anything'.split('\n')].join('\r\n')
    const screens = [codexBox({ counter: '1 of 2', title: titles[1]! }), codexBox({ counter: null, title: titles[2]! }), EMPTY]
    let answered = 0
    t.backend.onSend = (text) => {
      if (text === KEY.shiftLeft) {
        t.backend.screenText = codexBox({ counter: '1 of 3', title: titles[0]! })
        return
      }
      fs.appendFileSync(t.file, `${codexAnswerLine({ call: 'call-3q', index: answered, question: titles[answered]!, answer: text === '1' ? 'Tea' : 'Coffee' })}\n`)
      answered += 1
      t.items.list = readItems(t.file)
      t.backend.screenText = screens.shift()!
    }
    t.hub.answer({ device: 'd1', id: 'r3a3-0000-0001', channel: 'c2', question: item.id, call: 'call-3q', digest: questionDigest(item.questions), answers: [{ choices: [0], other: null }, { choices: [1], other: null }, { choices: [0], other: null }] })
    expect(await t.settled('r3a3-0000-0001')).toMatchObject({ state: 'delivered' })
    expect(t.backend.sends.map((send) => send.text)).toEqual([KEY.shiftLeft, '1', '2', '1'])
  })
})

describe('R3-A4·A5 들어감 근거 — 이 세션 · 이 접수 뒤의 줄만', () => {
  it('같은 파일을 제자리에서 다시 써 옛 줄(접수 전 시각)이 커서 뒤에 와도 들어감이 아니다', async () => {
    const t = setup()
    const old = userLine('같은 초의 옛 지시')
    const prefix = fs.readFileSync(t.file)
    await wait(5)
    t.backend.delivery = 'none'
    t.backend.onPrompt = () => fs.writeFileSync(t.file, Buffer.concat([prefix, Buffer.from(`${old}\n`)]))
    t.hub.send({ device: 'd1', id: 'r3a4-0000-0001', channel: 'c1', text: '같은 초의 옛 지시' })
    expect(await t.settled('r3a4-0000-0001')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
  })
  it('파일이 없던 세션(0건 → 생길 경로) — 나중에 생긴 파일이 다른 세션 줄이거나 옛 줄이면 들어감이 아니다', async () => {
    const foreign = setup({ noFileYet: true })
    foreign.backend.delivery = 'none'
    foreign.backend.onPrompt = () => {
      const line = JSON.parse(userLine('폰 지시'))
      fs.writeFileSync(foreign.file, `${JSON.stringify({ ...line, sessionId: 'different-session' })}\n`)
    }
    foreign.hub.send({ device: 'd1', id: 'r3a4-0000-0002', channel: 'c1', text: '폰 지시' })
    expect(await foreign.settled('r3a4-0000-0002')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
    const restored = setup({ noFileYet: true })
    const archived = userLine('폰 지시')
    await wait(5)
    restored.backend.delivery = 'none'
    restored.backend.onPrompt = () => fs.writeFileSync(restored.file, `${archived}\n`)
    restored.hub.send({ device: 'd1', id: 'r3a4-0000-0003', channel: 'c1', text: '폰 지시' })
    expect(await restored.settled('r3a4-0000-0003')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
  })
  it('양성 대조 — 보통 붙이기 · 새 세션의 첫 지시는 들어감', async () => {
    const t = setup()
    t.hub.send({ device: 'd1', id: 'r3a4-0000-0004', channel: 'c1', text: '보통 지시' })
    expect(await t.settled('r3a4-0000-0004')).toMatchObject({ state: 'delivered' })
    const fresh = setup({ noFileYet: true })
    fresh.hub.send({ device: 'd1', id: 'r3a4-0000-0005', channel: 'c1', text: '첫 지시' })
    expect(await fresh.settled('r3a4-0000-0005')).toMatchObject({ state: 'delivered' })
  })
})

describe('R3-A6 Grok 중단 — 빈 입력 줄을 본 guard 턴의 revision 으로 울타리', () => {
  const GROK_EMPTY = ['╭──╮', '│ ❯       │', '╰──╯'].join('\r\n')
  it('화면을 읽은 뒤 맥 입력이 끼면 Ctrl+C 0회 · 실패', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.screenText = GROK_EMPTY
    const read = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => {
      const shot = await read()
      // 화면을 잡은 직후 맥 타자 — guard 의 입력 revision 이 오른다.
      if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1 }
      return shot
    }
    t.hub.stopTurn({ device: 'd1', id: 'r3a6-0000-0001', channel: 'c3' })
    expect(await t.settled('r3a6-0000-0001')).toMatchObject({ state: 'failed', reason: 'state_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('양성 대조 — 사이 입력이 없으면 그 revision 으로 Ctrl+C 1회 · 멈춤', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.screenText = GROK_EMPTY
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'r3a6-0000-0002', channel: 'c3' })
    expect((await t.settled('r3a6-0000-0002')).state).toBe('stopped')
    expect(t.backend.sends.map((send) => send.text)).toEqual([KEY.ctrlC])
    expect(t.backend.keyFences).toEqual([1])
  })
  it('다른 provider 의 중단은 그대로(울타리 없이 seq 비교만 — LIFE-598 r3 에서 r2 이전으로 되돌림)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'r3a6-0000-0003', channel: 'c1' })
    expect((await t.settled('r3a6-0000-0003')).state).toBe('stopped')
    expect(t.backend.keyFences).toEqual([null])
  })
  it('revision 없는 guard 면 다른 provider 의 중단은 예전처럼 울타리 없이', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.input = null
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'r3a6-0000-0004', channel: 'c1' })
    expect((await t.settled('r3a6-0000-0004')).state).toBe('stopped')
    expect(t.backend.keyFences).toEqual([null])
  })
})

// --- 수정 r4 (Codex r4 지적) ---------------------------------------------------------------------------

describe('R4-A1 답 값은 문항마다 — 문항↔답 대응을 보존한다', () => {
  const yesNo = (question: string) => ({ question, header: null, options: [{ label: 'Yes', description: null }, { label: 'No', description: null }], multiSelect: false })
  const pair = [yesNo('Allow feature A?'), yesNo('Allow feature B?')]
  const claudeResult = (answers: Record<string, string>): string =>
    JSON.stringify({ type: 'user', sessionId: CHAT_SESSIONS.claude.id, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-pair', content: 'answers' }] }, toolUseResult: { answers } })
  const grokResult = (message: string): string =>
    JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-g', status: 'completed', rawOutput: { UserAnswered: { message } } } } })
  const values = (input: Parameters<typeof recordedAnswers>[0]): string[] => {
    const result = recordedAnswers(input)
    if (result.kind !== 'ok') throw new Error('unreadable')
    return result.values
  }

  it('리뷰 answer-values 재현 — 두 문항 답이 서로 바뀌어 기록되면 다르다 · 바른 대응은 같다', () => {
    const answers = [{ choices: [0], other: null }, { choices: [1], other: null }]
    const right = values({ kind: 'claude', text: claudeResult({ 'Allow feature A?': 'Yes', 'Allow feature B?': 'No' }), call: 'call-pair', questions: pair.map((q) => q.question) })
    const swapped = values({ kind: 'claude', text: claudeResult({ 'Allow feature A?': 'No', 'Allow feature B?': 'Yes' }), call: 'call-pair', questions: pair.map((q) => q.question) })
    expect(answerMatches({ kind: 'claude', recorded: right, questions: pair, answers })).toBe(true)
    expect(answerMatches({ kind: 'claude', recorded: swapped, questions: pair, answers })).toBe(false)
  })
  it('반복 라벨 · 겹치는 라벨(다른 라벨의 부분 문자열) · multiSelect 집합 순서', () => {
    const wine = [{ question: 'Pick drinks', header: null, options: [{ label: 'Red', description: null }, { label: 'Red wine', description: null }, { label: 'Tea', description: null }], multiSelect: true }]
    const check = (recorded: string, choices: number[]) => answerMatches({ kind: 'claude', recorded: [recorded], questions: wine, answers: [{ choices, other: null }] })
    expect(check('Red, Red wine', [0, 1])).toBe(true)
    expect(check('Red wine, Red', [0, 1])).toBe(true)
    expect(check('Red wine', [0, 1])).toBe(false)
    expect(check('Red wine', [0])).toBe(false)
    expect(check('Red, Red', [0])).toBe(false)
    expect(check('Red, Tea', [0])).toBe(false)
    const single = [{ question: 'Pick', header: null, options: [{ label: 'Red', description: null }, { label: 'Red wine', description: null }], multiSelect: false }]
    expect(answerMatches({ kind: 'claude', recorded: ['Red wine'], questions: single, answers: [{ choices: [0], other: null }] })).toBe(false)
    expect(answerMatches({ kind: 'claude', recorded: ['Red'], questions: single, answers: [{ choices: [0], other: null }] })).toBe(true)
    // 두 라벨이 이어 붙으면 셋째 라벨이 되는 경우 — `, ` 경계를 안 보면 「Red wine」 하나를 [Red, wine] 으로 읽는다.
    const glued = [{ question: 'Pick drinks', header: null, options: [{ label: 'Red', description: null }, { label: 'wine', description: null }, { label: 'Red wine', description: null }], multiSelect: true }]
    expect(answerMatches({ kind: 'claude', recorded: ['Red wine'], questions: glued, answers: [{ choices: [0, 1], other: null }] })).toBe(false)
    expect(answerMatches({ kind: 'claude', recorded: ['Red, wine'], questions: glued, answers: [{ choices: [0, 1], other: null }] })).toBe(true)
  })
  it('Codex — 그 호출의 문항 번호로 대응, 바뀐 번호는 다르다 · 같은 번호 둘은 대응 불명', () => {
    const reply = (index: number, answer: string) => codexReply([{ call: 'call-c', index, answer, question: pair[index]!.question }])
    const answers = [{ choices: [0], other: null }, { choices: [1], other: null }]
    const right = values({ kind: 'codex', text: `${reply(0, 'Yes')}\n${reply(1, 'No')}`, call: 'call-c', questions: pair.map((q) => q.question) })
    const swapped = values({ kind: 'codex', text: `${reply(0, 'No')}\n${reply(1, 'Yes')}`, call: 'call-c', questions: pair.map((q) => q.question) })
    expect(answerMatches({ kind: 'codex', recorded: right, questions: pair, answers })).toBe(true)
    expect(answerMatches({ kind: 'codex', recorded: swapped, questions: pair, answers })).toBe(false)
    expect(recordedAnswers({ kind: 'codex', text: `${reply(0, 'Yes')}\n${reply(0, 'No')}`, call: 'call-c', questions: pair.map((q) => q.question) })).toEqual({ kind: 'unreadable' })
  })
  it('Grok — 문항 경계(`"문항"=`)로 자른다 · 경계를 못 읽으면 answer_unreadable 재료', () => {
    const answers = [{ choices: [0], other: null }, { choices: [1], other: null }]
    const tail = " You can now continue with the user's answers in mind."
    const right = values({ kind: 'grok', text: grokResult(`User has answered your questions: "Allow feature A?"="Yes", "Allow feature B?"="No".${tail}`), call: 'call-g', questions: pair.map((q) => q.question) })
    const swapped = values({ kind: 'grok', text: grokResult(`User has answered your questions: "Allow feature A?"="No", "Allow feature B?"="Yes".${tail}`), call: 'call-g', questions: pair.map((q) => q.question) })
    expect(right).toEqual(['"Yes"', '"No"'])
    expect(answerMatches({ kind: 'grok', recorded: right, questions: pair, answers })).toBe(true)
    expect(answerMatches({ kind: 'grok', recorded: swapped, questions: pair, answers })).toBe(false)
    // 직접 입력(실측 모양 `"Other" user notes: 글`).
    const other = values({ kind: 'grok', text: grokResult(`User has answered your questions: "Allow feature A?"="Other" user notes: 망고 mango.${tail}`), call: 'call-g', questions: [pair[0]!.question] })
    expect(answerMatches({ kind: 'grok', recorded: other, questions: [pair[0]!], answers: [{ choices: [], other: '망고 mango' }] })).toBe(true)
    // 문항 글이 안 보이거나 두 번이면 경계를 모른다.
    expect(recordedAnswers({ kind: 'grok', text: grokResult(`User has answered your questions: "Yes", "No".${tail}`), call: 'call-g', questions: pair.map((q) => q.question) })).toEqual({ kind: 'unreadable' })
    expect(recordedAnswers({ kind: 'grok', text: grokResult(`User has answered your questions: "Allow feature A?"="Allow feature A?"="Yes".${tail}`), call: 'call-g', questions: [pair[0]!.question] })).toEqual({ kind: 'unreadable' })
  })
  it('허브 — 리뷰 hub-swapped-pair 재현: 키 1 · 2 · 검토 1 뒤 기록이 서로 바뀐 답이면 unconfirmed/answer_mismatch', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    const item: Extract<ChatItem, { kind: 'question' }> = { id: 12, kind: 'question', call: 'toolu-12', questions: [yesNo('Q-12 첫째?'), yesNo('Q-12 둘째?')], state: 'pending', answer: null, at: null }
    t.items.list = [item]
    const box = (title: string): string => ['', RULE, title.endsWith('둘째?') ? '←  ☒ A  ☐ B  ✔ Submit  →' : '←  ☐ A  ☐ B  ✔ Submit  →', title, '❯ 1. Yes', '  2. No', '  3. Type something.', RULE, '  4. Chat about this', 'Enter to select · Esc to cancel'].join('\r\n')
    t.backend.screenText = box('Q-12 첫째?')
    t.backend.onSend = () => {
      const sent = t.backend.sends.length
      if (sent === 1) t.backend.screenText = box('Q-12 둘째?')
      else if (sent === 2) t.backend.screenText = REVIEW
      else {
        fs.appendFileSync(t.file, `${answerLine('toolu-12', false, { 'Q-12 첫째?': 'No', 'Q-12 둘째?': 'Yes' })}\n`)
        t.items.list = [{ ...item, state: 'answered' }]
      }
    }
    t.hub.answer({ device: 'd1', id: 'r4a1-0000-0001', channel: 'c1', question: 12, call: 'toolu-12', digest: questionDigest(questionsOf(item)), answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })
    expect(await t.settled('r4a1-0000-0001')).toMatchObject({ state: 'unconfirmed', reason: 'answer_mismatch' })
    expect(t.backend.sends.map((send) => send.text)).toEqual(['1', '2', '1'])
  })
})

describe('R4-A2 좁은 맥 pane — 실물 화면(r4/width)에서 허브 답', () => {
  const W = path.resolve(__dirname, '../../../../specs/LIFE-582-mobile-input/raw/claude/r4/width')
  const recordedItem = (kind: 'claude' | 'grok', call: string): Extract<ChatItem, { kind: 'question' }> => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(W, `${kind}-question.json`), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('fixture')
    const questions = parsed.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('question' in entry) || !('options' in entry) || typeof entry.question !== 'string' || !Array.isArray(entry.options)) throw new Error('fixture')
      const options = entry.options.map((option: unknown) => {
        if (typeof option !== 'object' || option === null || !('label' in option) || typeof option.label !== 'string') throw new Error('fixture')
        return { label: option.label, description: 'description' in option && typeof option.description === 'string' ? option.description : null }
      })
      return { question: entry.question, header: null, options, multiSelect: false }
    })
    return { id: 50, kind: 'question', call, questions, state: 'pending', answer: null, at: null }
  }
  it('Claude 80·60열 실물 화면 — 줄 바뀐 선택지를 복원해 키 1회 · 들어감', async () => {
    for (const cols of [80, 60]) {
      const t = setup()
      const item = recordedItem('claude', `toolu-w${cols}`)
      const questions = questionsOf(item)
      t.backend.status = 'blocked'
      t.items.list = [item]
      t.backend.screenText = fs.readFileSync(path.join(W, `claude-${cols}.txt`), 'utf8')
      t.backend.onSend = () => {
        fs.appendFileSync(t.file, `${answerLine(`toolu-w${cols}`, false, { [questions[0]!.question]: questions[0]!.options[0]!.label })}\n`)
        t.items.list = [{ ...item, state: 'answered' }]
      }
      t.hub.answer({ device: 'd1', id: `r4a2-claude-${cols}`, channel: 'c1', question: 50, call: `toolu-w${cols}`, digest: questionDigest(questions), answers: [{ choices: [0], other: null }] })
      expect([cols, await t.settled(`r4a2-claude-${cols}`)]).toMatchObject([cols, { state: 'delivered' }])
      expect(t.backend.sends.map((send) => send.text)).toEqual(['1'])
    }
  })
  it('R5-A1 리뷰 prefix-wrong-question — Grok 80열 실물 화면 + 숨은 뒷부분만 다른 기록 → 키 0회 failed/question_truncated(원래 기록도 같음)', async () => {
    for (const alter of [true, false]) {
      const t = setup()
      const base = recordedItem('grok', 'call-g80')
      const item = alter ? { ...base, questions: base.questions.map((q) => ({ ...q, options: q.options.map((option, at) => (at === 1 ? { ...option, label: option.label.replace('tomorrow morning', 'next month') } : option)) })) } : base
      t.backend.status = 'blocked'
      t.items.list = [item]
      t.backend.screenText = fs.readFileSync(path.join(W, 'grok-80.txt'), 'utf8')
      t.hub.answer({ device: 'd1', id: `r5a1-${alter}`, channel: 'c3', question: 50, call: 'call-g80', digest: questionDigest(questionsOf(item)), answers: [{ choices: [1], other: null }] })
      expect([alter, await t.settled(`r5a1-${alter}`)]).toMatchObject([alter, { state: 'failed', reason: 'question_truncated' }])
      expect(t.backend.sends).toHaveLength(0)
    }
  })
  it('Grok 40열 실물 화면 — 행이 스크롤로 안 보여 복원 불가 → 키 0회 failed/question_truncated', async () => {
    const t = setup()
    const item = recordedItem('grok', 'call-g40')
    t.backend.status = 'blocked'
    t.items.list = [item]
    t.backend.screenText = fs.readFileSync(path.join(W, 'grok-40.txt'), 'utf8')
    t.hub.answer({ device: 'd1', id: 'r4a2-grok-40', channel: 'c3', question: 50, call: 'call-g40', digest: questionDigest(questionsOf(item)), answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r4a2-grok-40')).toMatchObject({ state: 'failed', reason: 'question_truncated' })
    expect(t.backend.sends).toHaveLength(0)
  })
})

describe('R5-A2·A3 답 값 형식 — 실측 기록(r5/native m01 Claude · m02 Grok)', () => {
  const colors = { question: 'Pick colors', header: null, options: ['Red', 'Blue', 'Red, Blue', 'Say "hi"'].map((label) => ({ label, description: null })), multiSelect: true }
  const claudeValue = (value: string): string =>
    JSON.stringify({ type: 'user', sessionId: CHAT_SESSIONS.claude.id, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-c', content: 'answers' }] }, toolUseResult: { answers: { 'Pick colors': value } } })
  const claudeMatches = (input: { value: string; choices: number[]; other?: string; question?: typeof colors }): boolean => {
    const question = input.question ?? colors
    const read = recordedAnswers({ kind: 'claude', text: claudeValue(input.value), call: 'call-c', questions: [question.question] })
    return read.kind === 'ok' && answerMatches({ kind: 'claude', recorded: read.values, questions: [question], answers: [{ choices: input.choices, other: input.other ?? null }] })
  }
  it('R5-A2 Claude multiSelect — 쉼표·따옴표 든 글은 `"…"`(안의 `"` 는 `\\"`)로 감싼 실측 형식대로 나눈다', () => {
    // 양성(m01 실측 모양): 쉼표 라벨 하나 · 쉼표 라벨 + 다른 라벨 · 따옴표 라벨 · 직접 입력(쉼표·따옴표) · 평범한 둘.
    expect(claudeMatches({ value: '"Red, Blue"', choices: [2] })).toBe(true)
    expect(claudeMatches({ value: 'Red, "Red, Blue"', choices: [0, 2] })).toBe(true)
    expect(claudeMatches({ value: '"Red, Blue", Red', choices: [0, 2] })).toBe(true)
    expect(claudeMatches({ value: '"Say \\"hi\\""', choices: [3] })).toBe(true)
    expect(claudeMatches({ value: 'Red, "ok, \\"fine\\""', choices: [0], other: 'ok, "fine"' })).toBe(true)
    expect(claudeMatches({ value: 'Red, Blue', choices: [0, 1] })).toBe(true)
    // 음성: 다른 집합 — 따옴표를 일괄 제거하면 같아지는 값끼리.
    expect(claudeMatches({ value: '"Red, Blue"', choices: [0, 1] })).toBe(false)
    expect(claudeMatches({ value: 'Red, Blue', choices: [2] })).toBe(false)
    expect(claudeMatches({ value: 'Red, "Red, Blue"', choices: [2] })).toBe(false)
    expect(claudeMatches({ value: '"Say \\"hi\\""', choices: [], other: 'Say hi' })).toBe(false)
    // 형식이 어긋난 값(닫히지 않은 따옴표 · 감싸지 않은 따옴표)은 같다고 하지 않는다.
    expect(claudeMatches({ value: '"Red, Blue', choices: [2] })).toBe(false)
    expect(claudeMatches({ value: 'Say "hi"', choices: [3] })).toBe(false)
    // 하나 고름은 감싸지 않는다(m01 r5-claude-single-comma).
    const single = { ...colors, multiSelect: false }
    expect(claudeMatches({ value: 'Red, Blue', choices: [2], question: single })).toBe(true)
    expect(claudeMatches({ value: '"Red, Blue"', choices: [2], question: single })).toBe(false)
  })
  const word = { question: 'Pick a word', header: null, options: [{ label: 'Yes', description: null }, { label: 'No', description: null }], multiSelect: false }
  const tail = " You can now continue with the user's answers in mind."
  const grokValues = (message: string, questions: string[]): string[] | null => {
    const line = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-g', status: 'completed', rawOutput: { UserAnswered: { message } } } } })
    const read = recordedAnswers({ kind: 'grok', text: line, call: 'call-g', questions })
    return read.kind === 'ok' ? read.values : null
  }
  it('R5-A3 Grok 직접 입력 — 고정 접두 뒤 글 그대로 · 마지막 문항의 끝 쉼표는 답 글', () => {
    const other = (recorded: string, phone: string): boolean => {
      const values = grokValues(`User has answered your questions: "Pick a word"="Other" user notes: ${recorded}.${tail}`, ['Pick a word'])
      return values !== null && answerMatches({ kind: 'grok', recorded: values, questions: [word], answers: [{ choices: [], other: phone }] })
    }
    // 양성(m02 실측 모양).
    expect(other('hello', 'hello')).toBe(true)
    expect(other('say "hello"', 'say "hello"')).toBe(true)
    expect(other('hello,', 'hello,')).toBe(true)
    // 음성 — 리뷰 trailing-comma-false-positive · 반대 방향.
    expect(other('hello,', 'hello')).toBe(false)
    expect(other('hello', 'hello,')).toBe(false)
    expect(other('say "hello"', 'say hello')).toBe(false)
    // 두 문항 — 문항 사이 구분자만 뗀다(앞 문항 직접 입력의 끝 쉼표는 남는다).
    const pair = grokValues(`User has answered your questions: "Q1"="Other" user notes: a,, "Q2"="No".${tail}`, ['Q1', 'Q2'])
    expect(pair).toEqual(['"Other" user notes: a,', '"No"'])
    // 고른 답에 직접 입력 접두가 오면(또는 그 반대) 다르다.
    expect(answerMatches({ kind: 'grok', recorded: ['"Other" user notes: Yes'], questions: [word], answers: [{ choices: [0], other: null }] })).toBe(false)
    expect(answerMatches({ kind: 'grok', recorded: ['"Yes"'], questions: [word], answers: [{ choices: [], other: 'Yes' }] })).toBe(false)
  })
})
