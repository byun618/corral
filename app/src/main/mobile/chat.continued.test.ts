// 열린 대화의 세션 이어 가기 (LIFE-766 C3·C4·C5·C9) — 실제 파일·실제 주기(기본 상수)로 잰다. `changed()` 는 부르지 않는다: 전환은 상태 변화 없이 일어난다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../../shared/types.js'
import { CHAT_SESSIONS, CLAUDE_SESSION, chatListState } from './chat-fixture.js'
import { ChatHub, type WireItem } from './chat.js'
import { buildMobileList, channelKey, type ListState } from './list.js'

const TARGET = '00000000-0000-4000-8000-00000000000b'
const NEXT = '00000000-0000-4000-8000-00000000000c'
const row = (value: unknown): string => `${JSON.stringify(value)}\n`
/** 파일마다 앞 줄에 잇는다 — 같은 부모의 사람 발화는 rewind 로 읽힌다. */
const parents = new Map<string, string>()
const linked = (sessionId: string, uuid: string, record: Record<string, unknown>): string => {
  const parentUuid = parents.get(sessionId) ?? null
  parents.set(sessionId, uuid)
  return row({ ...record, sessionId, uuid, parentUuid })
}
const human = (text: string, sessionId: string): string => linked(sessionId, `u-${text}`, { type: 'user', message: { role: 'user', content: text } })
const reply = (text: string, sessionId: string): string => linked(sessionId, `a-${text}`, { type: 'assistant', message: { id: `m-${text}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } })
const fork = (to: string): string => row({ type: 'continued-in', sessionId: CLAUDE_SESSION, continuedInSessionId: to })

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  parents.clear()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

type Frame = Record<string, unknown> & { type: string }
const itemsOf = (frame: Frame): WireItem[] => (Array.isArray(frame['items']) ? frame['items'] : [])
const texts = (frame: Frame): string[] => itemsOf(frame).flatMap((item) => (item.kind === 'prompt' || item.kind === 'reply' ? [item.body.text] : []))

function paneOf(state: ListState, paneId: string) {
  const pane = state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)).find((one) => one.paneId === paneId)
  if (pane === undefined) throw new Error(`pane ${paneId} 없음`)
  return pane
}

function setup(input: { graceMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l766c-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fileOf = (id: string): string => path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(fileOf(CLAUDE_SESSION), human('옛 지시', CLAUDE_SESSION) + reply('옛 답', CLAUDE_SESSION))
  const state = chatListState()
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  let resolves = 0
  const hub = new ChatHub({
    read: () => ({ state, prefs: null }),
    resolveFile: ({ session }) => {
      resolves += 1
      if (session.kind !== 'id') return null
      return fs.existsSync(fileOf(session.id)) ? fileOf(session.id) : null
    },
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    graceMs: input.graceMs ?? 100,
    refreshMs: 10,
  })
  cleanups.push(() => hub.stop())
  const frames: Frame[] = []
  const open = () => hub.subscribe({ channelId: 'c1', resume: null, sink: (text) => frames.push(JSON.parse(text)) })
  const continued = (): number => logs.filter((entry) => entry.tag === 'mobile.chat_continued').length
  const resets = (): Frame[] => frames.filter((frame) => frame.type === 'chat.page' && frame['mode'] === 'reset')
  return { dir, fileOf, state, hub, logs, frames, open, continued, resets, resolves: () => resolves }
}

describe('C4 열린 대화가 옮겨 간다', () => {
  it('changed() 0회로 reset 첫 페이지가 3초 안에 오고, 사람 말풍선이 보이고, 새 줄이 push 되고, 옛 판독자는 버려진다', async () => {
    const t = setup()
    t.open()
    await waitFor(() => t.resets()[0])
    fs.writeFileSync(t.fileOf(TARGET), human('옛 지시', TARGET) + reply('옛 답', TARGET) + human('새 지시', TARGET))
    const started = Date.now()
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    const page = await waitFor(() => t.resets()[1])
    expect(Date.now() - started).toBeLessThanOrEqual(3000)
    expect(texts(page)).toEqual(['옛 지시', '옛 답', '새 지시'])
    expect(t.continued()).toBe(1)
    fs.appendFileSync(t.fileOf(TARGET), reply('새 답', TARGET))
    const pushed = await waitFor(() => t.frames.find((frame) => frame.type === 'chat.items' && frame['gen'] === page['gen']))
    expect(texts(pushed)).toEqual(['새 답'])
    await waitFor(() => (t.hub.readerCount() === 1 ? true : undefined))
    expect(t.hub.readerFor(t.fileOf(CLAUDE_SESSION))).toBeNull()
    expect(t.hub.readerFor(t.fileOf(TARGET))?.sessionId).toBe(TARGET)
    expect(t.resets()).toHaveLength(2)
  })

  it('대상이 0.9초 늦게 생기는 순서 — 기다리는 동안 옛 대화를 그대로 두고, 생기면 3초 안에 옮겨 간다', async () => {
    const t = setup()
    t.open()
    await waitFor(() => t.resets()[0])
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    await sleep(900)
    expect(t.resets()).toHaveLength(1)
    expect(t.frames.filter((frame) => frame.type === 'chat.unavailable')).toHaveLength(0)
    expect(t.continued()).toBe(0)
    const created = Date.now()
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    const page = await waitFor(() => t.resets()[1])
    expect(Date.now() - created).toBeLessThanOrEqual(3000)
    expect(texts(page)).toEqual(['새 지시'])
    expect(t.continued()).toBe(1)
  })

  it('이미 끝난 전환 위에 새로 열어도 새 파일·새 id 로 바로 연다(이동 아님)', async () => {
    const t = setup()
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    t.open()
    expect(texts(await waitFor(() => t.resets()[0]))).toEqual(['새 지시'])
    expect(t.continued()).toBe(0)
  })

  it('옛 세션이 되살아나면 원본으로 돌아온다 · 연쇄도 따라간다', async () => {
    const t = setup()
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    t.open()
    await waitFor(() => t.resets()[0])
    fs.writeFileSync(t.fileOf(NEXT), human('다음 지시', NEXT))
    fs.appendFileSync(t.fileOf(TARGET), row({ type: 'continued-in', sessionId: TARGET, continuedInSessionId: NEXT }))
    expect(texts(await waitFor(() => t.resets()[1]))).toEqual(['다음 지시'])
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), human('되살림', CLAUDE_SESSION))
    expect(texts(await waitFor(() => t.resets()[2]))).toEqual(['옛 지시', '옛 답', '되살림'])
    expect(t.continued()).toBe(2)
  })

  it('확인 주기는 참조를 다시 찾지 않는다(폴더 훑기 0) · 구독이 떠나면 멈춘다', async () => {
    const t = setup()
    const subscription = t.open()
    await waitFor(() => t.resets()[0])
    const before = t.resolves()
    await sleep(1600)
    expect(t.resolves()).toBe(before)
    subscription.close()
    await sleep(600)
    expect(Reflect.get(t.hub, 'followTimer')).toBeNull()
  })

  it('Codex 대화는 판별하지 않는다 — 확인 주기가 돌지 않는다', async () => {
    const t = setup()
    const codex = path.join(t.dir, `${CHAT_SESSIONS.codex.id}.jsonl`)
    fs.writeFileSync(codex, row({ type: 'session_meta', payload: { id: 'synthetic' } }))
    const frames: Frame[] = []
    const channel = paneOf(t.state, 'c2').agentSession?.agent === 'codex' ? 'c2' : 'c3'
    t.hub.subscribe({ channelId: channel, resume: null, sink: (text) => frames.push(JSON.parse(text)) })
    await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    expect(Reflect.get(t.hub, 'followTimer')).toBeNull()
  })
})

describe('C5 참조가 뒤늦게 바뀌어도', () => {
  const moved: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr', id: TARGET }

  it('이동 뒤 참조가 새 id 로 바뀌면 파일이 같으므로 추가 reset 0 · 말풍선 수 변화 0', async () => {
    const t = setup()
    t.open()
    await waitFor(() => t.resets()[0])
    fs.writeFileSync(t.fileOf(TARGET), human('옛 지시', TARGET) + reply('옛 답', TARGET) + human('새 지시', TARGET))
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    const page = await waitFor(() => t.resets()[1])
    const count = t.hub.readerFor(t.fileOf(TARGET))?.items().length
    paneOf(t.state, 'c1').agentSession = moved
    // 채널 키가 참조를 따라 바뀌지 않도록 c1 은 pane id 기반 채널 id 다 — 같은 구독이 그대로 산다.
    t.hub.changed()
    await sleep(800)
    expect(t.resets()).toHaveLength(2)
    expect(t.logs.filter((entry) => entry.tag === 'mobile.chat_session_switch')).toHaveLength(0)
    expect(t.hub.readerFor(t.fileOf(TARGET))?.items().length).toBe(count)
    expect(t.hub.readerFor(t.fileOf(TARGET))?.gen).toBe(page['gen'])
    fs.appendFileSync(t.fileOf(TARGET), reply('새 답', TARGET))
    expect(texts(await waitFor(() => t.frames.find((frame) => frame.type === 'chat.items' && frame['gen'] === page['gen'])))).toEqual(['새 답'])
  })

  it('반대 순서 — 참조가 먼저 옮겨 가면 평소의 세션 교체 한 번이고 이어 가기 이동은 없다', async () => {
    const t = setup()
    t.open()
    await waitFor(() => t.resets()[0])
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    paneOf(t.state, 'c1').agentSession = moved
    t.hub.changed()
    await waitFor(() => t.resets()[1])
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    await sleep(800)
    expect(t.resets()).toHaveLength(2)
    expect(t.continued()).toBe(0)
    expect(t.logs.filter((entry) => entry.tag === 'mobile.chat_session_switch')).toHaveLength(1)
  })

  it('상태 변화가 이동보다 먼저 와도 reset 은 이동당 1회다 — 이동은 같은 로그로 센다', async () => {
    const t = setup()
    t.open()
    await waitFor(() => t.resets()[0])
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    t.hub.refresh()
    t.hub.refresh()
    await waitFor(() => t.resets()[1])
    await sleep(800)
    expect(t.resets()).toHaveLength(2)
    expect(t.continued()).toBe(1)
  })
})

describe('C9 그대로인 것', () => {
  it('이동해도 pane.agentSession·channelKey·목록 행 값이 그대로다', async () => {
    const t = setup()
    const ref = paneOf(t.state, 'c1').agentSession
    if (ref === null) throw new Error('참조 없음')
    const copy = structuredClone(ref)
    const list = (): string => JSON.stringify(buildMobileList({ state: t.state, prefs: null }))
    const key = channelKey({ paneId: 'c1', session: ref })
    t.open()
    await waitFor(() => t.resets()[0])
    const before = list()
    fs.writeFileSync(t.fileOf(TARGET), human('새 지시', TARGET))
    fs.appendFileSync(t.fileOf(CLAUDE_SESSION), fork(TARGET))
    await waitFor(() => t.resets()[1])
    expect(paneOf(t.state, 'c1').agentSession).toEqual(copy)
    expect(channelKey({ paneId: 'c1', session: paneOf(t.state, 'c1').agentSession })).toBe(key)
    expect(list()).toBe(before)
  })
})
