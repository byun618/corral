// 폰 쓰기 허브 (LIFE-582 Z2ⓐⓑⓖ · Z3 · Z5 · Z6 · Z9ⓔ) — 가짜 백엔드 + 실제 기록 대조(`countSubmissions`).
// 가짜 백엔드의 넣기는 Claude 기록에 사람 발화 한 줄을 붙인다 — 「들어감」 은 그 줄을 커서 뒤에서 정확히 1건 찾았을 때만.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from '../adapter/index.js'
import type { ChatItem } from '../chat-parse.js'
import { CHAT_SESSIONS, chatListState } from './chat-fixture.js'
import { INPUT_QUEUE_MAX, InputHub, type InputBackend, type InputWire, type PaneObservation, type SendResult } from './input.js'
import { KEY } from './keys.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const DRAFT = ['', RULE, '❯ 쓰던 글', RULE].join('\r\n')

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
  readonly prompts: string[] = []
  readonly sends: { text: string; seq: number }[] = []
  onSend: ((text: string) => void) | null = null
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  async locate(paneId: string): Promise<TerminalIdentity | null> {
    if (this.paneMissing) return null
    return { epoch: 'e', ptyId: 't', paneId, tabId: 'tab', workspaceId: 'ws', path: '/w', repo: '/w', title: 'x' }
  }

  async observe(): Promise<PaneObservation> {
    return { status: this.status, seq: this.seq, quiet: this.quiet, unmanaged: this.unmanaged }
  }

  async manifestVerified(): Promise<boolean> {
    return true
  }

  async screen(): Promise<string> {
    return this.screenText
  }

  async prompt(_pane: TerminalIdentity, text: string): Promise<SendResult> {
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

function question(input: { id: number; state: 'pending' | 'answered' | 'closed'; options?: number }): ChatItem {
  const options = Array.from({ length: input.options ?? 2 }, (_, index) => ({ label: `o${index}`, description: null }))
  return { id: input.id, kind: 'question', questions: [{ question: 'q', header: null, options, multiSelect: false }], state: input.state, answer: null, at: null }
}

function setup(input: { listed?: boolean; noFileYet?: boolean } = {}) {
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
    resolveFile: () => (fs.existsSync(file) || input.noFileYet !== true ? file : null),
    expectedFile: () => (input.noFileYet === true ? file : null),
    questionItems: () => items.list,
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    timing: { pollMs: 5, gateMs: 5, confirmMs: 400, recordPollMs: 10, stepGapMs: 1, answerConfirmMs: 300, stopConfirmMs: 200 },
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
  return { hub, backend, file, items, wires, last, settled, logs }
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
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = () => { t.items.list = [question({ id: 10, state: 'answered' })] }
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0001', channel: 'c1', question: 10, answers: [{ choices: [1], other: null }] })
    expect((await t.settled('ans-aaaa-0001')).state).toBe('delivered')
    expect(t.backend.sends).toEqual([{ text: '2', seq: 7 }])
  })
  it('뒤에 새 질문이 열렸거나 답한 질문이면 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' }), question({ id: 20, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0002', channel: 'c1', question: 10, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0002')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    t.items.list = [question({ id: 10, state: 'answered' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0003', channel: 'c1', question: 10, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0003')).toMatchObject({ state: 'failed', reason: 'question_closed' })
    expect(t.backend.sends).toHaveLength(0)
  })
  it('질문 대기가 아니면(blocked 아님) 넣지 않는다', async () => {
    const t = setup()
    t.backend.status = 'working'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0004', channel: 'c1', question: 10, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0004')).toMatchObject({ state: 'failed', reason: 'question_closed' })
  })
  it('첫 키에서 guard 가 거절하면 실패(question_changed) — 넣은 것 없음', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.backend.sendResult = 'refused'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0005', channel: 'c1', question: 10, answers: [{ choices: [0], other: null }] })
    expect(await t.settled('ans-aaaa-0005')).toMatchObject({ state: 'failed', reason: 'question_changed' })
  })
  it('직접 입력의 줄바꿈·제어 문자는 키가 되지 않는다', async () => {
    const t = setup()
    t.backend.status = 'blocked'
    t.items.list = [question({ id: 10, state: 'pending' })]
    t.backend.onSend = (text) => { if (text === KEY.enter) t.items.list = [question({ id: 10, state: 'answered' })] }
    t.hub.answer({ device: 'd1', id: 'ans-aaaa-0006', channel: 'c1', question: 10, answers: [{ choices: [], other: 'a\nb\x1bc' }] })
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
