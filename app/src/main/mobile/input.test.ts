// 폰 쓰기 허브 (LIFE-582 Z2ⓐⓑⓖ · Z3 · Z5 · Z6 · Z9ⓔ) — 가짜 백엔드 + 실제 기록 대조(`countSubmissions`).
// 가짜 백엔드의 넣기는 Claude 기록에 사람 발화 한 줄을 붙인다 — 「들어감」 은 그 줄을 커서 뒤에서 정확히 1건 찾았을 때만.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import type { ChatItem } from '../chat-parse.js'
import { CHAT_SESSIONS, chatListState } from './chat-fixture.js'
import { cleanAnswers, INPUT_IDS_MAX, INPUT_QUEUE_MAX, InputHub, questionOnScreen, type FileResolution, type InputBackend, type InputWire, type PaneObservation, type SendResult } from './input.js'
import { KEY } from './keys.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const DRAFT = ['', RULE, '❯ 쓰던 글', RULE].join('\r\n')
/** 질문 화면 — `question()` 이 만드는 문항 글(Q-<id>)·선택지(o0, o1 …)가 보인다. */
const questionScreen = (id: number, options = 2): string => ['', `Q-${id} 어느 쪽?`, ...Array.from({ length: options }, (_, index) => `${index + 1}. o${index}`), ''].join('\r\n')

type Delivery = 'record' | 'twice' | 'none'

class FakeBackend implements InputBackend {
  status = 'idle'
  seq = 1
  quiet = true
  screenText = EMPTY
  delivery: Delivery = 'record'
  promptResult: SendResult = 'sent'
  sendResult: SendResult = 'sent'
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

  async screen(): Promise<string> {
    return this.screenText
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

  async send(_pane: TerminalIdentity, text: string, seq: number): Promise<SendResult> {
    if (this.sendResult !== 'sent') return this.sendResult
    this.sends.push({ text, seq })
    this.onSend?.(text)
    return 'sent'
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

/** Claude 의 답 줄 — 그 도구 호출의 tool_result(`chat-parse` 가 `result` 원자로 읽는다). */
function answerLine(call: string, isError = false): string {
  uuid += 1
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'ok', is_error: isError }] }, uuid: `u-${uuid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
}

function setup(input: { listed?: boolean; noFileYet?: boolean; resolution?: () => FileResolution; deviceValid?: (device: string) => boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l582i-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'claude.jsonl')
  if (input.noFileYet !== true) fs.writeFileSync(file, `${userLine('이전 지시')}\n`)
  const backend = new FakeBackend(file)
  const items: { list: ChatItem[] } = { list: [] }
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  const hub = new InputHub({
    read: () => (input.listed === false ? null : { state: chatListState(), prefs: null }),
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
  const answerOn = (input: { id: number; call?: string; when?: (text: string) => boolean; lines?: number; resolve?: boolean }) => {
    backend.onSend = (text) => {
      if (input.when !== undefined && !input.when(text)) return
      for (let index = 0; index < (input.lines ?? 1); index += 1) fs.appendFileSync(file, `${answerLine(input.call ?? `toolu-${input.id}`)}\n`)
      if (input.resolve !== false) items.list = [question({ id: input.id, state: 'answered', call: input.call })]
    }
  }
  return { hub, backend, file, items, wires, last, settled, logs, answerOn }
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
    t.answerOn({ id: 10 })
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0001', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [1], other: null }] })
    expect((await t.settled('ans-aaaa-0001')).state).toBe('delivered')
    expect(t.backend.sends).toEqual([{ text: '2', seq: 7 }])
  })
  it('뒤에 새 질문이 열렸거나 답한 질문이면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' }), question({ id: 20, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0002', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0002')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    t.items.list = [question({ id: 10, state: 'answered' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0003', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0003')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('질문 대기가 아니면(blocked 아님) 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0004', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0004')).toMatchObject({ state: 'failed', reason: 'question_closed' })
  })
  it('첫 키에서 guard 가 거절하면 실패(question_changed) — 넣은 것 없음', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.sendResult = 'refused'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0005', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0005')).toMatchObject({ state: 'failed', reason: 'question_changed' })
  })
  it('직접 입력의 줄바꿈·제어 문자는 키가 되지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, when: (text) => text === KEY.enter })
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0006', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [], other: 'a\nb\x1bc' }] })
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
    t.hub.answer({ device: 'd1', id: 'r1a1-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [], other: '직접' }] })
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
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0001', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0001')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('같은 말풍선 id 에 다른 질문(다른 도구 호출) → 넣지 않는다(question_closed)', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending', call: 'toolu-new' })]
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0002', channel: 'c1', question: 10, call: 'toolu-old', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0002')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('도구 호출 id 가 없는 답은 대조할 수 없어 잠근다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0003', channel: 'c1', question: 10, call: null, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0003')).toMatchObject({ state: 'failed', reason: 'question_changed' })
  })
  it('화면을 읽는 사이 seq 가 바뀌면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.screenText = questionScreen(10)
    const screen = t.backend.screen.bind(t.backend)
    t.backend.screen = async () => { t.backend.seq += 1; return screen() }
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0004')).toMatchObject({ state: 'failed', reason: 'question_changed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('판독자가 answered 여도 기록에 그 질문의 답 줄이 없으면 들어감이 아니다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => { t.items.list = [question({ id: 10, state: 'answered' })] }
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0005', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0005')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
  })
  it('답 줄이 있어도 판독자에서 아직 대기면 들어감이 아니다 · 답 줄 2건은 확인 못 함', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.screenText = questionScreen(10)
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.answerOn({ id: 10, resolve: false })
    t.hub.answer({ device: 'd1', id: 'r1a2-0000-0006', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await t.settled('r1a2-0000-0006')).toMatchObject({ state: 'unconfirmed', reason: 'record_missing' })
    const u = setup()
    u.backend.status = 'blocked'
    u.backend.screenText = questionScreen(10)
    u.items.list = [question({ id: 10, state: 'pending' })]
    u.answerOn({ id: 10, lines: 2 })
    u.hub.answer({ device: 'd1', id: 'r1a2-0000-0007', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [0], other: null }] })
    expect(await u.settled('r1a2-0000-0007')).toMatchObject({ state: 'unconfirmed', reason: 'record_ambiguous' })
  })
  it('questionOnScreen — 문항 글과 선택지가 모두 보여야 한다', () => {
    const item = question({ id: 3, state: 'pending' })
    if (item.kind !== 'question') throw new Error('fixture')
    expect(questionOnScreen({ question: item, screen: questionScreen(3) })).toBe(true)
    expect(questionOnScreen({ question: item, screen: questionScreen(4) })).toBe(false)
    expect(questionOnScreen({ question: item, screen: ['Q-3 어느 쪽?', '1. o0'].join('\n') })).toBe(false)
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
    t.hub.answer({ device: 'd1', id: 'r1a4-0000-0004', channel: 'c1', question: 10, call: 'toolu-10', answers: [{ choices: [], other: '본문' }] })
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
