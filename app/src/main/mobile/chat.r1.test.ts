// 대화 허브 리뷰 r1 지적 시험 (LIFE-581 R1-A1~A5) — 지적마다 그 결함을 잡는 시험. 수정 전 코드(591eb404f)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/r1).
// 이어 받기 요청에는 r0 의 `after` 도 같이 싣는다 — r0 코드가 같은 상황에서 실제로 무엇을 보내는지가 음성 대조가 되게.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../../shared/types.js'
import { CHAT_SESSIONS, CLAUDE_SESSION, chatListState } from './chat-fixture.js'
import { ChatHub, MAX_FRAME_BYTES, type ChatResume, type WireItem } from './chat.js'
import type { ListState } from './list.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

type Frame = Record<string, unknown> & { type: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const lines = (rows: unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('')
const itemsOf = (frame: Frame | undefined): WireItem[] => (frame !== undefined && Array.isArray(frame.items) ? frame.items : [])

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

const claudeUser = (text: string, uuid: string, parent: string | null, session = CLAUDE_SESSION) => ({ type: 'user', sessionId: session, uuid, parentUuid: parent, message: { role: 'user', content: text } })
const claudeReply = (text: string, uuid: string, parent: string | null, session = CLAUDE_SESSION) => ({ type: 'assistant', sessionId: session, uuid, parentUuid: parent, message: { id: `m-${uuid}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } })
const codexReply = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
const codexMeta = { type: 'session_meta', payload: { id: 'synthetic' } }

function paneOf(state: ListState, paneId: string) {
  const pane = state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)).find((row) => row.paneId === paneId)
  if (pane === undefined) throw new Error(`pane ${paneId} 없음`)
  return pane
}

/** 고칠 수 있는 목록 상태 + 세션 id → 파일 표 — 같은 pane 의 세션 교체를 흉내 낸다. */
function setup(input: { claude?: unknown[]; codex?: unknown[]; graceMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l581r1-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files = { claude: path.join(dir, 'claude.jsonl'), codex: path.join(dir, 'codex.jsonl') }
  fs.writeFileSync(files.claude, lines(input.claude ?? [claudeUser('첫 지시', 'u1', null), claudeReply('첫 답', 'a1', 'u1')]))
  fs.writeFileSync(files.codex, lines(input.codex ?? [codexMeta, codexReply('코덱스 답')]))
  const bySession = new Map<string, string>([
    [CLAUDE_SESSION, files.claude],
    [CHAT_SESSIONS.codex.id, files.codex],
  ])
  const state = chatListState()
  const hub = new ChatHub({
    read: () => ({ state, prefs: null }),
    resolveFile: ({ session }) => (session.kind === 'id' ? (bySession.get(session.id) ?? null) : null),
    log: () => {},
    pollMs: 20,
    graceMs: input.graceMs ?? 2000,
    refreshMs: 10,
  })
  cleanups.push(() => hub.stop())
  return { dir, files, state, hub, bySession }
}

function open(hub: ChatHub, channelId: string, resume: ChatResume = null) {
  const frames: Frame[] = []
  const subscription = hub.subscribe({ channelId, resume, sink: (text) => frames.push(JSON.parse(text)) })
  return { frames, subscription }
}

/** 이어 받기 요청 — 새 모양(`from`·`cursor`)과 r0 모양(`after` = 마지막 id)을 함께 싣는다. */
function resumeOf(input: { page: Frame; held: WireItem[] }): ChatResume {
  const resume = { gen: String(input.page.gen), from: input.held[0]?.id ?? 0, cursor: Number(input.page.cursor ?? 0), after: input.held[input.held.length - 1]?.id ?? 0 }
  return resume
}

/** 앱(`mobile/src/core/chat.ts` `mergeItems`)과 같은 합치기 — id 가 같으면 새 값. */
function merge(have: WireItem[], incoming: WireItem[]): WireItem[] {
  const byId = new Map<number, WireItem>()
  for (const item of [...have, ...incoming]) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

describe('R1-A1 같은 채널의 provider 세션이 바뀌면 새 기록으로 옮긴다', () => {
  it('pane 의 agentSession 이 바뀌면(/clear·새 세션) 새 파일을 처음부터(reset, 새 세대) 보내고 그 뒤 새 파일의 push 를 받는다', async () => {
    const { dir, state, hub, bySession } = setup()
    const { frames } = open(hub, 'c1')
    const first = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    const next = path.join(dir, 'claude-new.jsonl')
    fs.writeFileSync(next, lines([claudeUser('새 세션 지시', 'n1', null, 'replacement')]))
    bySession.set('replacement', next)
    const session: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr', id: 'replacement' }
    paneOf(state, 'c1').agentSession = session
    // main 상태 변화 신호(service.listChanged → hub.changed). r0 에는 없다.
    Reflect.get(hub, 'changed')?.call(hub)
    const reset = await waitFor(() => frames.slice(1).find((frame) => frame.type === 'chat.page'), 1500)
    expect(reset).toMatchObject({ mode: 'reset' })
    expect(reset.gen).not.toBe(first.gen)
    expect(itemsOf(reset).map((item) => (item.kind === 'prompt' ? item.body.text : item.kind))).toEqual(['새 세션 지시'])
    fs.appendFileSync(next, lines([claudeReply('새 세션 답', 'n2', 'n1', 'replacement')]))
    const pushed = await waitFor(() => frames.find((frame) => frame.type === 'chat.items' && frame.gen === reset.gen))
    expect(itemsOf(pushed).map((item) => item.kind)).toEqual(['reply'])
  })

  it('채널이 목록에서 사라지면 chat.unavailable(not_listed) 한 건 — 그 뒤 옛 파일의 변화는 오지 않는다', async () => {
    const { files, state, hub } = setup()
    const { frames } = open(hub, 'c1')
    await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    const worktree = state.repos[0]?.worktrees[0]
    const tab = worktree?.workspace?.tabs[0]
    if (tab === undefined) throw new Error('tab 없음')
    tab.panes = tab.panes.filter((pane) => pane.paneId !== 'c1')
    Reflect.get(hub, 'changed')?.call(hub)
    const gone = await waitFor(() => frames.find((frame) => frame.type === 'chat.unavailable'), 1500)
    expect(gone).toMatchObject({ channel: 'c1', reason: 'not_listed' })
    const count = frames.length
    fs.appendFileSync(files.claude, lines([claudeUser('사라진 뒤', 'u9', 'a1')]))
    await sleep(150)
    expect(frames.length).toBe(count)
  })
})

describe('R1-A2 이어 받기는 마지막 id 보다 앞 말풍선의 변경도 준다', () => {
  it('Codex 비동기 질문 → 답 → 끊김 → 질문에 답함 → 이어 받기: 폰의 질문도 answered', async () => {
    const question = { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'q', arguments: JSON.stringify({ questions: [{ title: '고를까?', options: ['A', 'B'] }] }) } }
    const { files, hub } = setup({ codex: [codexMeta, question, codexReply('그동안 일합니다')] })
    const first = open(hub, 'c2')
    const page = await waitFor(() => first.frames.find((frame) => frame.type === 'chat.page'))
    const held = itemsOf(page)
    expect(held.find((item) => item.kind === 'question')).toMatchObject({ state: 'pending' })
    first.subscription.close()
    const reply = `<send_user_message_question_reply>${JSON.stringify([{ answer: 'A', question: '고를까?', questionItemId: 'q' }])}</send_user_message_question_reply>`
    fs.appendFileSync(files.codex, lines([{ type: 'event_msg', payload: { type: 'user_message', message: reply } }]))
    await sleep(60)
    const again = open(hub, 'c2', resumeOf({ page, held }))
    const resumed = await waitFor(() => again.frames.find((frame) => frame.type === 'chat.page'))
    const merged = resumed.mode === 'reset' ? itemsOf(resumed) : merge(held, itemsOf(resumed))
    expect(merged.find((item) => item.kind === 'question')).toMatchObject({ state: 'answered', answer: 'A' })
    expect(resumed.mode).toBe('resume')
  })

  it('앞선 도구 묶음의 늦은 결과도 이어 받기에 들어온다', async () => {
    const call = { type: 'assistant', sessionId: CLAUDE_SESSION, uuid: 't1', parentUuid: 'u1', message: { id: 'm-t1', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 9' } }] } }
    const { files, hub } = setup({ claude: [claudeUser('지시', 'u1', null), call, claudeReply('기다리는 동안 답', 'a1', 't1')] })
    const first = open(hub, 'c1')
    const page = await waitFor(() => first.frames.find((frame) => frame.type === 'chat.page'))
    const held = itemsOf(page)
    first.subscription.close()
    fs.appendFileSync(files.claude, lines([{ type: 'user', sessionId: CLAUDE_SESSION, uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'x', is_error: true }] } }]))
    await sleep(60)
    const again = open(hub, 'c1', resumeOf({ page, held }))
    const resumed = await waitFor(() => again.frames.find((frame) => frame.type === 'chat.page'))
    const merged = resumed.mode === 'reset' ? itemsOf(resumed) : merge(held, itemsOf(resumed))
    const tools = merged.find((item) => item.kind === 'tools')
    expect(tools?.kind === 'tools' ? tools.tools.map((tool) => tool.status) : null).toEqual(['error'])
  })
})

describe('R1-A3 열린 대화가 0 이면 그 자리에서 읽기를 멈춘다', () => {
  it('마지막 구독이 떠난 직후(유예 안) 줄이 늘어도 stat·읽기 0 — 다시 열면 따라잡는다', async () => {
    const { files, hub } = setup({ graceMs: 5000 })
    const first = open(hub, 'c1')
    await waitFor(() => first.frames.find((frame) => frame.type === 'chat.page'))
    const reader = hub.readerFor(files.claude)
    if (reader === null) throw new Error('판독자 없음')
    first.subscription.close()
    const before = { ...reader.cost }
    fs.appendFileSync(files.claude, lines([claudeUser('닫힌 뒤 지시', 'u2', 'a1')]))
    await sleep(150)
    expect({ polls: reader.cost.polls - before.polls, bytes: reader.cost.bytes - before.bytes }).toEqual({ polls: 0, bytes: 0 })
    expect(hub.subscriberCount()).toBe(0)
    // 양성 대조 — 다시 열면 멈춘 동안 쓰인 줄까지 받는다.
    const again = open(hub, 'c1')
    const page = await waitFor(() => again.frames.find((frame) => frame.type === 'chat.page'))
    const prompts = itemsOf(page).flatMap((item) => (item.kind === 'prompt' ? [item.body.text] : []))
    expect(prompts).toContain('닫힌 뒤 지시')
  })
})

describe('R1-A4 파일이 줄거나 덮어쓰이면 새 세대로 처음부터', () => {
  const first = codexReply('AAAA')
  const tail = codexReply('TAIL')
  it('같은 크기 덮어쓰기(첫 줄 그대로) — 살아 있는 판독자가 잡아 reset · 새 세대 · 새 글', async () => {
    const { files, hub } = setup({ codex: [codexMeta, first, tail] })
    const { frames } = open(hub, 'c2')
    const page = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    await sleep(40)
    fs.writeFileSync(files.codex, lines([codexMeta, codexReply('BBBB'), tail]))
    const reset = await waitFor(() => frames.slice(1).find((frame) => frame.type === 'chat.page'), 1500)
    expect(reset.gen).not.toBe(page.gen)
    expect(itemsOf(reset).map((item) => (item.kind === 'reply' ? item.body.text : item.kind))).toEqual(['BBBB', 'TAIL'])
  })

  it('첫 줄이 같은 채 줄어듦 — reset 의 세대가 바뀐다', async () => {
    const { files, hub } = setup({ codex: [codexMeta, first, tail] })
    const { frames } = open(hub, 'c2')
    const page = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    fs.writeFileSync(files.codex, lines([codexMeta, codexReply('CCCC')]))
    const reset = await waitFor(() => frames.slice(1).find((frame) => frame.type === 'chat.page'), 1500)
    expect(reset).toMatchObject({ mode: 'reset' })
    expect(reset.gen).not.toBe(page.gen)
  })

  it('판독자를 버린 뒤 줄어든 파일 — 옛 세대 이어 받기는 reset 이고 폰에 옛 첫 답이 남지 않는다', async () => {
    const padding = { type: 'token_usage_record', payload: { padding: 'x'.repeat(300) } }
    const { files, hub } = setup({ codex: [codexMeta, first, tail, padding], graceMs: 1 })
    const one = open(hub, 'c2')
    const page = await waitFor(() => one.frames.find((frame) => frame.type === 'chat.page'))
    const held = itemsOf(page)
    one.subscription.close()
    await waitFor(() => (hub.readerCount() === 0 ? true : undefined))
    fs.writeFileSync(files.codex, lines([codexMeta, codexReply('BBBB'), tail]))
    const two = open(hub, 'c2', resumeOf({ page, held }))
    const second = await waitFor(() => two.frames.find((frame) => frame.type === 'chat.page'))
    expect(second).toMatchObject({ mode: 'reset' })
    const merged = second.mode === 'reset' ? itemsOf(second) : merge(held, itemsOf(second))
    expect(merged.map((item) => (item.kind === 'reply' ? item.body.text : item.kind))).toEqual(['BBBB', 'TAIL'])
  })
})

describe('R1-A5 말풍선 하나·프레임 하나의 바이트 상한 + 잘림 표시', () => {
  // 제품 상수 `ITEM_BYTES_MAX`(64 KiB)를 시험 안에 고정한다 — 상수가 없는 수정 전 코드에서도 바이트 수로 실패하게(음성 대조).
  const ITEM_BYTES_MAX = 64 * 1024
  it('문항 10 × 선택지 20 × 긴 글 질문 — 프레임 ≤ MAX_FRAME_BYTES · 말풍선 ≤ ITEM_BYTES_MAX · clipped', async () => {
    const long = '한'.repeat(2100)
    const question = { question: long, header: long, options: Array.from({ length: 20 }, () => ({ label: long, description: long })), multiSelect: false }
    const ask = { type: 'assistant', sessionId: CLAUDE_SESSION, uuid: 'q1', parentUuid: null, message: { id: 'm-q', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: Array.from({ length: 10 }, () => question) } }] } }
    const { hub } = setup({ claude: [ask] })
    const { frames } = open(hub, 'c1')
    const page = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const item = itemsOf(page)[0]
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(ITEM_BYTES_MAX)
    expect(item).toMatchObject({ kind: 'question', clipped: true })
  })

  it('이스케이프가 큰 글(제어 문자) 답 — 말풍선 ≤ ITEM_BYTES_MAX · body.clipped 에 원래 길이', async () => {
    const text = '\u0001'.repeat(15000)
    const { hub } = setup({ claude: [claudeReply(text, 'a1', null)] })
    const { frames } = open(hub, 'c1')
    const page = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    const item = itemsOf(page)[0]
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(ITEM_BYTES_MAX)
    expect(item?.kind === 'reply' ? item.body.clipped : null).toBe(15000)
  })

  it('이름이 모두 다른 도구 수천 개 — 말풍선 ≤ ITEM_BYTES_MAX · count 는 전체', async () => {
    const blocks = Array.from({ length: 3000 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: `mcp__server__tool_${i}_${'n'.repeat(40)}`, input: { command: 'x'.repeat(200) } }))
    const call = { type: 'assistant', sessionId: CLAUDE_SESSION, uuid: 't', parentUuid: null, message: { id: 'm-t', role: 'assistant', model: 'x', content: blocks } }
    const { hub } = setup({ claude: [call] })
    const { frames } = open(hub, 'c1')
    const page = await waitFor(() => frames.find((frame) => frame.type === 'chat.page'))
    const item = itemsOf(page)[0]
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(ITEM_BYTES_MAX)
    expect(item).toMatchObject({ kind: 'tools', count: 3000 })
  })
})
