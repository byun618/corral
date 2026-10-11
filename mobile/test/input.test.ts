// 폰 쓰기 (LIFE-582 Z8ⓒ) — Composer 상태표 8행 · 중단 버튼 4상태 · 질문 잠금 · 보낸 지시 상태(C12 + 확인 못 함) · 저장소(id 멱등·조회·30초 안 확정).
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatQuestion } from '../src/core/chat'
import type { SessionEvent } from '../src/core/connection'
import {
  MAX_INPUT_BYTES,
  SENDING_GIVEUP_MS,
  SENDING_QUERY_MS,
  composerMode,
  connKind,
  newInputId,
  otherAllowed,
  parseInputState,
  placeSent,
  questionLock,
  questionLockText,
  questionLocked,
  sendGate,
  sentLine,
  stepReady,
  stopLine,
  stopView,
  toggleChoice,
  utf8Bytes,
  withOther,
  type SentEntry,
} from '../src/core/input'
import { InputStore } from '../src/core/input-store'
import type { Channel } from '../src/core/list'
import { FakeClock } from './fakes'

function channel(patch: Partial<Channel> = {}): Channel {
  const dot = patch.dot ?? 'idle'
  return { id: 'w1:p1', key: 's:w1:p1', status: 'live', kind: 'claude', title: 't', dot, dotUnseen: dot, depth: 0, origin: null, spawnedBy: null, parent: null, preview: { kind: 'none' }, waiting: null, model: null, timeAt: null, activityAt: 1, outcome: null, ...patch }
}

const q = (patch: Partial<ChatQuestion> = {}): ChatQuestion => ({ question: '어느 쪽?', header: null, options: [{ label: 'A', description: null }, { label: 'B', description: null }], multiSelect: false, preview: false, ...patch })
const card = (questions: ChatQuestion[], patch: Partial<Extract<ChatItem, { kind: 'question' }>> = {}): Extract<ChatItem, { kind: 'question' }> => ({ id: 9, kind: 'question', at: null, call: 'toolu-9', digest: null, questions, state: 'pending', answer: null, clipped: false, ...patch })
const mode = (input: Partial<Parameters<typeof composerMode>[0]>) => composerMode({ channel: channel(), conn: 'connected', unknown: false, question: null, step: 0, noSession: false, ...input })

describe('Composer 상태표 8행 (design-handoff §2)', () => {
  it('한가 · 작업 중(큐) · 질문 직접 입력 · 질문 선택지만 · 권한 대기 · 재연결 · 끊김 · 닫힘', () => {
    expect(mode({})).toEqual({ kind: 'open', target: 'send', placeholder: '지시 보내기', note: null })
    expect(mode({ channel: channel({ dot: 'working' }) })).toMatchObject({ kind: 'open', target: 'send', placeholder: '지시 보내기 — 이 턴이 끝나면 들어갑니다' })
    expect(mode({ question: card([q()]) })).toMatchObject({ kind: 'open', target: 'answer', placeholder: '선택지 밖 답을 직접 쓰기' })
    expect(mode({ question: card([q({ preview: true })]) })).toMatchObject({ kind: 'locked', placeholder: '선택지로 답해 주세요' })
    expect(mode({ channel: channel({ dot: 'waiting', waiting: 'approval' }) })).toMatchObject({ kind: 'locked', placeholder: '맥에서 승인할 때까지 보낼 수 없음' })
    expect(mode({ conn: 'reconnecting' })).toEqual({ kind: 'locked', placeholder: '지시 보내기', note: '연결되면 보낼 수 있습니다', keep: true })
    expect(mode({ conn: 'offline' })).toMatchObject({ kind: 'locked', placeholder: '연결이 끊겨 보낼 수 없음', keep: true })
    expect(mode({ conn: 'mismatch' })).toMatchObject({ kind: 'locked', placeholder: '연결이 끊겨 보낼 수 없음' })
    expect(mode({ channel: channel({ status: 'closed' }) })).toEqual({ kind: 'closed' })
  })
  it('세션 참조가 없으면 잠근다(Codex 첫 지시 전) · 목록 실패도 잠근다', () => {
    expect(mode({ noSession: true })).toMatchObject({ kind: 'locked' })
    expect(mode({ unknown: true })).toMatchObject({ kind: 'locked' })
  })
  it('연결 상태 → 다섯 갈래', () => {
    expect(connKind({ kind: 'reconnecting', since: 0, lastConnectedAt: null, attempt: 1, reason: 'network', offline: false })).toBe('reconnecting')
    expect(connKind({ kind: 'reconnecting', since: 0, lastConnectedAt: null, attempt: 1, reason: 'network', offline: true })).toBe('offline')
    expect(connKind({ kind: 'connected', since: 0, lastAliveAt: 0 })).toBe('connected')
    expect(connKind({ kind: 'unpaired', reason: null })).toBe('offline')
  })
  it('보내기 — 글이 있고 65536 바이트 안일 때만, 넘으면 넘친 바이트', () => {
    const open = mode({})
    expect(sendGate({ mode: open, body: '   ' }).enabled).toBe(false)
    expect(sendGate({ mode: open, body: '가'.repeat(21845) })).toEqual({ enabled: true, over: 0 })
    expect(sendGate({ mode: open, body: '가'.repeat(21846) })).toEqual({ enabled: false, over: 2 })
    expect(sendGate({ mode: mode({ conn: 'reconnecting' }), body: 'x' }).enabled).toBe(false)
  })
  it('UTF-8 바이트 — 한글 3 · 이모지 4', () => {
    expect(utf8Bytes('a가🙂')).toBe(1 + 3 + 4)
    expect(utf8Bytes('x'.repeat(MAX_INPUT_BYTES))).toBe(MAX_INPUT_BYTES)
  })
})

describe('중단 버튼 4상태 (StopButton · P5)', () => {
  const view = (patch: Partial<Channel>, conn: Parameters<typeof stopView>[0]['conn'] = 'connected') => stopView({ channel: channel(patch), conn, unknown: false })
  it('작업 중 · 지켜보는 중 · 질문 대기 · 권한 대기에 보인다', () => {
    expect(view({ dot: 'working' })).toBe('enabled')
    expect(view({ dot: 'monitoring' })).toBe('enabled')
    expect(view({ dot: 'waiting', waiting: 'question' })).toBe('enabled')
    expect(view({ dot: 'waiting', waiting: 'approval' })).toBe('enabled')
  })
  it('한가 · 완료 · 실패 · 중단됨 · 닫힘 · Grok 질문 대기 · 로그인 대기는 숨긴다', () => {
    const quiet: Channel['dot'][] = ['idle', 'done', 'failed', 'interrupted']
    for (const dot of quiet) expect(view({ dot })).toBe('hidden')
    expect(view({ status: 'closed', dot: 'working' })).toBe('hidden')
    expect(view({ kind: 'grok', dot: 'waiting', waiting: 'question' })).toBe('hidden')
    expect(view({ kind: 'grok', dot: 'waiting', waiting: 'approval' })).toBe('enabled')
    expect(view({ dot: 'blocked', waiting: 'login' })).toBe('hidden')
  })
  it('연결이 없으면 흐린 비활성', () => {
    expect(view({ dot: 'working' }, 'reconnecting')).toBe('disabled')
    expect(stopView({ channel: channel({ dot: 'working' }), conn: 'connected', unknown: true })).toBe('disabled')
  })
})

describe('질문 (C3 · C4 · C5 · P4)', () => {
  it('서버와 같은 잠금 — 선택지 9개 이상 · Claude 아닌 multiSelect · 덜어 낸 질문', () => {
    const nine = q({ options: Array.from({ length: 8 }, (_, index) => ({ label: `o${index}`, description: null })) })
    expect(questionLocked({ kind: 'claude', item: card([nine]) })).toBe(false)
    expect(questionLocked({ kind: 'claude', item: card([q({ options: [...nine.options, { label: 'x', description: null }] })]) })).toBe(true)
    expect(questionLocked({ kind: 'grok', item: card([q({ multiSelect: true })]) })).toBe(true)
    expect(questionLocked({ kind: 'claude', item: card([q({ multiSelect: true })]) })).toBe(false)
    expect(questionLocked({ kind: 'claude', item: card([q()], { clipped: true }) })).toBe(true)
  })
  it('직접 입력 — Claude preview 만 막힌다', () => {
    expect(otherAllowed({ kind: 'claude', question: q({ preview: true }) })).toBe(false)
    expect(otherAllowed({ kind: 'codex', question: q() })).toBe(true)
  })
  it('하나 고르기는 바꿔 끼우고 여럿은 토글 · 직접 입력은 하나 고르기의 선택을 지운다', () => {
    expect(toggleChoice({ question: q(), answer: { choices: [0], other: 'x' }, choice: 1 })).toEqual({ choices: [1], other: null })
    const multi = q({ multiSelect: true })
    expect(toggleChoice({ question: multi, answer: { choices: [1], other: null }, choice: 0 })).toEqual({ choices: [0, 1], other: null })
    expect(toggleChoice({ question: multi, answer: { choices: [0, 1], other: null }, choice: 0 })).toEqual({ choices: [1], other: null })
    expect(withOther({ question: q(), answer: { choices: [0], other: null }, text: 'y' })).toEqual({ choices: [], other: 'y' })
    expect(withOther({ question: multi, answer: { choices: [0], other: null }, text: 'y' })).toEqual({ choices: [0], other: 'y' })
    expect(stepReady({ question: q(), answer: { choices: [], other: null } })).toBe(false)
    expect(stepReady({ question: multi, answer: { choices: [0, 1], other: null } })).toBe(true)
  })
})

const entry = (patch: Partial<SentEntry>): SentEntry => ({ id: 'm1', channel: 'w1:p1', op: 'send', text: '안녕', state: 'sending', wait: null, reason: null, acked: false, sentAt: 0, at: 0, tailId: 5, provisional: false, ...patch })
const hhmm = () => '10:12'

describe('보낸 지시 상태 (C12 + 확인 못 함 · P6)', () => {
  it('보내는 중 · 대기 중 + 취소 · 들어감 ✓ · 실패 + 다시 보내기 · 확인하지 못했습니다', () => {
    expect(sentLine({ entry: entry({}), hhmm })).toEqual({ tone: 'muted', text: '보내는 중…', action: null, faded: true })
    expect(sentLine({ entry: entry({ state: 'queued', acked: true }), hhmm })).toEqual({ tone: 'question', text: '대기 중 · 이 턴이 끝나면 들어갑니다', action: 'cancel', faded: false })
    expect(sentLine({ entry: entry({ state: 'delivered', acked: true }), hhmm })).toEqual({ tone: 'dim', text: '들어감 ✓ 10:12', action: null, faded: false })
    expect(sentLine({ entry: entry({ state: 'failed', reason: 'mac_draft' }), hhmm })).toMatchObject({ tone: 'error', text: '보내지 못했습니다 · 맥 입력창에 쓰던 글이 있어 보내지 않았습니다', action: 'retry' })
    expect(sentLine({ entry: entry({ state: 'unconfirmed', reason: 'record_missing' }), hhmm })?.text).toContain('들어갔는지 확인하지 못했습니다')
    expect(sentLine({ entry: entry({ state: 'cancelled' }), hhmm })).toBeNull()
  })
  it('들어간 지시는 보낸 뒤 생긴 같은 글의 「내 지시」 에 붙는다 — 보내기 전 같은 글에는 붙지 않는다', () => {
    const items: ChatItem[] = [
      { id: 3, kind: 'prompt', at: null, body: { text: '안녕', clipped: null } },
      { id: 7, kind: 'prompt', at: null, body: { text: ' 안녕 ', clipped: null } },
    ]
    const placed = placeSent({ items, sent: [entry({ state: 'delivered' }), entry({ id: 'm2', state: 'queued' })] })
    expect([...placed.attached.keys()]).toEqual([7])
    expect(placed.trailing.map((item) => item.id)).toEqual(['m2'])
    expect(placeSent({ items: items.slice(0, 1), sent: [entry({ state: 'delivered' })] }).trailing).toHaveLength(1)
  })
  it('중단 결과 문구(C10 후보 A)', () => {
    expect(stopLine(entry({ op: 'stop', state: 'stopped' }))?.text).toBe('턴을 멈췄습니다 · 백그라운드는 계속 돕니다')
    expect(stopLine(entry({ op: 'stop', state: 'failed', reason: 'not_running' }))?.text).toBe('이미 멈춰 있습니다')
  })
  it('서버 `input.state` 읽기 · id 규칙', () => {
    expect(parseInputState({ type: 'input.state', id: 'm1', channel: 'c', op: 'send', state: 'queued', wait: 'turn', reason: null, at: 5 })).toEqual({ id: 'm1', channel: 'c', op: 'send', state: 'queued', wait: 'turn', reason: null, at: 5, text: null })
    expect(parseInputState({ id: 'm1', state: 'bogus' })).toBeNull()
    expect(newInputId({ now: 1_700_000_000_000, random: () => 0.5 })).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })
})

class FakeConnection {
  sent: Record<string, unknown>[] = []
  online = true
  private listener: ((event: SessionEvent) => void) | null = null
  onSession(listener: (event: SessionEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }
  send(message: Record<string, unknown>): boolean {
    if (!this.online) return false
    this.sent.push(message)
    return true
  }
  emit(event: SessionEvent): void {
    this.listener?.(event)
  }
  state(id: string, state: string, patch: Record<string, unknown> = {}): void {
    const message = parseInputState({ id, state, channel: 'w1:p1', op: 'send', wait: null, reason: null, at: 1, ...patch })
    if (message !== null) this.emit({ kind: 'input', attempt: 1, message })
  }
}

function setup() {
  const clock = new FakeClock()
  const connection = new FakeConnection()
  let seed = 0
  const store = new InputStore({ connection, now: () => clock.now(), random: () => ((seed += 0.137) % 1), timer: clock })
  return { clock, connection, store }
}

describe('입력 저장소 (P2 · P6)', () => {
  it('연결이 없으면 보내지 않는다 — 항목도 만들지 않는다(자동 전송 없음)', () => {
    const t = setup()
    t.connection.online = false
    expect(t.store.send({ channel: 'w1:p1', text: 'x', tailId: null })).toBeNull()
    expect(t.store.getSnapshot().entries).toHaveLength(0)
  })
  it('서버 상태로 갱신 · 끝난 뒤 늦은 답은 무시', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    t.connection.state(id, 'queued', { wait: 'turn' })
    expect(t.store.getSnapshot().entries[0]).toMatchObject({ state: 'queued', acked: true, wait: 'turn' })
    t.connection.state(id, 'delivered')
    t.connection.state(id, 'queued')
    expect(t.store.getSnapshot().entries[0]?.state).toBe('delivered')
  })
  it('다시 보내기 = 새 id, 같은 글 · 이전 항목은 지운다', () => {
    const t = setup()
    const first = t.store.send({ channel: 'w1:p1', text: '같은 글', tailId: 1 }) ?? ''
    t.connection.state(first, 'failed', { reason: 'mac_draft' })
    const second = t.store.retry(first)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(t.connection.sent.at(-1)).toMatchObject({ type: 'input.send', id: second, text: '같은 글' })
    expect(t.store.getSnapshot().entries.map((item) => item.id)).toEqual([second])
  })
  it('취소는 서버가 받은 대기 중만', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    expect(t.store.cancel(id)).toBe(false)
    t.connection.state(id, 'queued')
    expect(t.store.cancel(id)).toBe(true)
    expect(t.connection.sent.at(-1)).toEqual({ type: 'input.cancel', id })
  })
  it('재연결(live) 뒤 끝나지 않은 id 를 조회 — 다시 보내지 않는다 · 서버가 모르면 확인하지 못했습니다(들어갔을 수 있다 — R1-A8 SURFACE 정정)', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    t.connection.emit({ kind: 'live', attempt: 2, reason: 'connect' })
    expect(t.connection.sent.slice(-2)).toEqual([{ type: 'input.status', ids: [id] }, { type: 'input.pending' }])
    expect(t.connection.sent.filter((message) => message.type === 'input.send')).toHaveLength(1)
    t.connection.state(id, 'unknown', { channel: null, op: null })
    expect(t.store.getSnapshot().entries[0]).toMatchObject({ state: 'unconfirmed', reason: 'unknown', provisional: false })
  })
  it('보내는 중이 30초 넘게 남지 않는다 — 20초에 조회, 30초에 확인하지 못했습니다', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    t.clock.advance(SENDING_QUERY_MS)
    expect(t.connection.sent.at(-1)).toEqual({ type: 'input.status', ids: [id] })
    t.clock.advance(SENDING_GIVEUP_MS - SENDING_QUERY_MS)
    expect(t.store.getSnapshot().entries[0]).toMatchObject({ state: 'unconfirmed', reason: 'no_reply' })
  })
  it('서버가 받았으면(대기 중) 긴 턴도 기다린다 — 시간으로 끝내지 않는다', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    t.connection.state(id, 'queued')
    t.clock.advance(10 * 60_000)
    expect(t.store.getSnapshot().entries[0]?.state).toBe('queued')
  })
  it('질문 답·중단 메시지 모양 — 키는 보내지 않는다', () => {
    const t = setup()
    t.store.answer({ channel: 'w1:p1', question: 9, call: 'toolu-9', digest: 'ab'.repeat(16), answers: [{ choices: [1], other: null }] })
    t.store.stop({ channel: 'w1:p1' })
    expect(t.connection.sent.map((message) => message.type)).toEqual(['question.answer', 'turn.stop'])
    expect(t.connection.sent[0]).toMatchObject({ question: 9, call: 'toolu-9', digest: 'ab'.repeat(16), answers: [{ choices: [1], other: null }] })
    expect(JSON.stringify(t.connection.sent)).not.toMatch(/\\u001b|keys/)
  })
})

// --- 수정 r1 ---------------------------------------------------------------------------------------

describe('R1-A7 앱 혼자 정한 확인 못 함은 끝이 아니다', () => {
  it('30초 확인 못 함 뒤 재연결 조회 · 늦은 delivered 로 수렴한다 — 다시 보내기는 그동안 없다', () => {
    const t = setup()
    const id = t.store.send({ channel: 'w1:p1', text: 'x', tailId: null }) ?? ''
    t.clock.advance(SENDING_GIVEUP_MS)
    expect(t.store.getSnapshot().entries[0]).toMatchObject({ state: 'unconfirmed', reason: 'no_reply', provisional: true })
    expect(t.store.retry(id)).toBeNull()
    t.connection.sent.length = 0
    t.connection.emit({ kind: 'live', attempt: 2, reason: 'connect' })
    expect(t.connection.sent).toContainEqual({ type: 'input.status', ids: [id] })
    t.connection.state(id, 'delivered')
    expect(t.store.getSnapshot().entries[0]).toMatchObject({ state: 'delivered', provisional: false })
    // 서버가 확정한 끝은 늦은 queued 가 되돌리지 않는다.
    t.connection.state(id, 'queued')
    expect(t.store.getSnapshot().entries[0]?.state).toBe('delivered')
  })
  it('확인 못 함 줄 — 앱 혼자 정한 것에는 다시 보내기가 없다', () => {
    expect(sentLine({ entry: entry({ state: 'unconfirmed', reason: 'no_reply', provisional: true }), hhmm })?.action).toBeNull()
    expect(sentLine({ entry: entry({ state: 'unconfirmed', reason: 'record_missing' }), hhmm })?.action).toBe('retry')
  })
})

describe('R1-A8 앱 재시작 뒤 서버 큐 복구', () => {
  it('새 저장소가 live 에서 input.pending 을 묻고, 모르는 대기 지시를 본문과 함께 들인다 — 취소할 수 있다', () => {
    const t = setup()
    t.connection.emit({ kind: 'live', attempt: 1, reason: 'connect' })
    expect(t.connection.sent).toEqual([{ type: 'input.pending' }])
    t.connection.state('mold-0000-0001', 'queued', { wait: 'turn', text: '앱이 잊은 지시' })
    expect(t.store.getSnapshot().entries).toEqual([expect.objectContaining({ id: 'mold-0000-0001', channel: 'w1:p1', op: 'send', state: 'queued', text: '앱이 잊은 지시', acked: true })])
    expect(t.store.cancel('mold-0000-0001')).toBe(true)
    // 끝난 것·채널 모름은 들이지 않는다.
    t.connection.state('mold-0000-0002', 'delivered')
    t.connection.state('mold-0000-0003', 'queued', { channel: null })
    expect(t.store.getSnapshot().entries).toHaveLength(1)
  })
})

describe('C2 백그라운드 대기 문구', () => {
  it('지켜보는 중이면 입력창·대기 줄이 「백그라운드 작업까지 끝나면」', () => {
    expect(mode({ channel: channel({ dot: 'monitoring' }) })).toMatchObject({ kind: 'open', placeholder: '지시 보내기 — 백그라운드 작업까지 끝나면 들어갑니다' })
    expect(mode({ channel: channel({ dot: 'working' }) })).toMatchObject({ placeholder: '지시 보내기 — 이 턴이 끝나면 들어갑니다' })
    expect(sentLine({ entry: entry({ state: 'queued', acked: true }), hhmm, monitoring: true })?.text).toBe('대기 중 · 백그라운드 작업까지 끝나면 들어갑니다')
  })
})

describe('LIFE-582 최종 관문 — 답 카드 잠금은 채널이 질문을 기다릴 때만 연다 (Z4ⓓ 턴 끝난 Codex 비동기 질문)', () => {
  const asking: Partial<Channel> = { dot: 'waiting', waiting: 'question' }
  it('질문 대기 → open · 모양 잠금 → shape', () => {
    expect(questionLock({ channel: channel({ ...asking, kind: 'codex' }), item: card([q()]) })).toBe('open')
    expect(questionLock({ channel: channel({ ...asking, kind: 'codex' }), item: card([q({ multiSelect: true })]) })).toBe('shape')
    expect(questionLock({ channel: channel({ ...asking, kind: 'claude' }), item: card([q({ multiSelect: true })]) })).toBe('open')
  })
  it('턴이 끝남(한가 · 완료 · 중단) → ended · 작업 중 · 다른 대기 → not_waiting — 둘 다 모양 잠금보다 앞선다', () => {
    const cases: [Partial<Channel>, string][] = [
      [{ dot: 'done' }, 'ended'], [{ dot: 'idle' }, 'ended'], [{ dot: 'interrupted' }, 'ended'],
      [{ dot: 'working' }, 'not_waiting'], [{ dot: 'monitoring' }, 'not_waiting'], [{ dot: 'waiting', waiting: 'approval' }, 'not_waiting'], [{ dot: 'blocked', waiting: 'login' }, 'not_waiting'],
    ]
    for (const [patch, want] of cases) {
      expect(questionLock({ channel: channel({ ...patch, kind: 'codex' }), item: card([q()]) })).toBe(want)
      expect(questionLock({ channel: channel({ ...patch, kind: 'codex' }), item: card([q({ multiSelect: true })]) })).toBe(want)
    }
  })
  it('잠금 안내 — Codex 턴 끝남은 provider 이름, 그 밖은 중립', () => {
    expect(questionLockText({ lock: 'ended', kind: 'codex' })).toBe('Codex 가 턴을 마쳤습니다 — 아래 입력창에 답을 지시로 보내 주세요')
    expect(questionLockText({ lock: 'ended', kind: 'claude' })).toBe('턴이 끝난 질문입니다 — 아래 입력창에 답을 지시로 보내 주세요')
    expect(questionLockText({ lock: 'not_waiting', kind: 'codex' })).toBe('지금은 폰에서 답할 수 없는 질문입니다 — 맥에서 확인해 주세요')
    expect(questionLockText({ lock: 'shape', kind: 'codex' })).toBe('맥에서 답해 주세요 — 이 질문은 폰에서 고를 수 없습니다')
  })
})
