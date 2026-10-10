// 폰 쓰기 허브 (LIFE-582 Z2ⓐⓑⓖ · Z3 · Z5 · Z6 · Z9ⓔ) — 가짜 백엔드 + 실제 기록 대조(`countSubmissions`).
// 가짜 백엔드의 넣기는 Claude 기록에 사람 발화 한 줄을 붙인다 — 「들어감」 은 그 줄을 커서 뒤에서 정확히 1건 찾았을 때만.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import { ChatBuilder, type ChatItem } from '../chat-parse.js'
import { CHAT_SESSIONS, chatListState } from './chat-fixture.js'
import { answerRecords, cleanAnswers, INPUT_IDS_MAX, INPUT_QUEUE_MAX, InputHub, type FileResolution, type InputBackend, type InputWire, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './input.js'
import { activeQuestion, KEY, questionDigest } from './keys.js'
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
  epoch = 'e'
  ptyId = 't'
  input: PaneObservation['input'] = { revision: 1, idleMs: 10_000 }
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

  async observe(): Promise<PaneObservation> {
    return { status: this.status, seq: this.seq, quiet: this.quiet, unmanaged: this.unmanaged, input: this.input }
  }

  async manifestVerified(): Promise<boolean> {
    return true
  }

  async screen(): Promise<ScreenRead> {
    return { text: this.screenText, input: this.screenInput === undefined ? this.input : this.screenInput, seq: this.seq }
  }

  async prompt(_pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number }): Promise<SendResult> {
    const { text, ...fence } = input
    this.fences.push(fence)
    this.onPrompt?.()
    if (this.promptResult !== 'sent') return this.promptResult
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
  it('관리 밖 pane(셸에서 직접 띄운 세션)은 기다리지 않고 실패(unmanaged)', async () => {
    const t = setup()
    t.backend.unmanaged = true
    t.hub.send({ device: 'd1', id: 'msg-iiii-0002', channel: 'c1', text: '관리 밖' })
    expect(await t.settled('msg-iiii-0002')).toMatchObject({ state: 'failed', reason: 'unmanaged' })
    expect(t.backend.prompts).toHaveLength(0)
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
    expect(t.backend.fences).toEqual([{ seq: 1, inputRevision: 42, minIdleMs: 500 }])
  })
  it('입력 revision 이 없는 guard 면 넣지 않는다(guard_outdated)', async () => {
    const t = setup()
    t.backend.input = null
    t.hub.send({ device: 'd1', id: 'r1a3-0000-0002', channel: 'c1', text: 'x' })
    expect(await t.settled('r1a3-0000-0002')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(t.backend.fences).toHaveLength(0)
  })
  it('guard 가 입력 변화로 거절하면 큐로 돌아가고, 다음 관문에서 초안을 보면 넣지 않는다', async () => {
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
    // 관측은 조용(revision 1)하지만 화면을 잡은 턴에는 막 입력이 있었다(revision 2, 0 ms).
    t.backend.screenInput = { revision: 2, idleMs: 0 }
    t.hub.send({ device: 'd1', id: 'r2a3-0000-0001', channel: 'c1', text: '폰 지시' })
    await wait(120)
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.last('r2a3-0000-0001')).toMatchObject({ state: 'queued', wait: 'gate' })
    t.backend.screenInput = { revision: 2, idleMs: 900 }
    expect((await t.settled('r2a3-0000-0001')).state).toBe('delivered')
    // 넣기의 울타리는 관측(1)이 아니라 화면 턴의 revision(2)이다.
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
    const observe = t.backend.observe.bind(t.backend)
    let swapped = false
    t.backend.observe = async () => {
      const seen = await observe()
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
      t.backend.status = 'blocked'
      t.backend.screenText = `${old}\n${z1Permission(pane)}`
      const item: ChatItem = { id: 10, kind: 'question', call: 'call-old', questions: [{ question: active.title, header: null, options: active.options.map((label) => ({ label, description: null })), multiSelect: false }], state: 'pending', answer: null, at: null }
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
  it('다른 provider 의 중단은 그대로(울타리 없이 seq 비교만)', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.backend.onSend = () => { t.backend.status = 'idle' }
    t.hub.stopTurn({ device: 'd1', id: 'r3a6-0000-0003', channel: 'c1' })
    expect((await t.settled('r3a6-0000-0003')).state).toBe('stopped')
    expect(t.backend.keyFences).toEqual([null])
  })
})
