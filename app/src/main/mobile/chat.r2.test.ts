// 대화 허브 리뷰 r2 지적 시험 (LIFE-581 R2-A1~A5) — 지적마다 그 결함을 잡는 시험. 수정 전 코드(db07e600d)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/r2).
// 폰 쪽은 앱 `ChatStore` 와 같은 규칙으로 흉내 낸다 — id 로 합치고, 받은 프레임의 가장 큰 `cursor` 를 들고, 이어 받기에 첫 id 를 `from` 으로.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_SESSIONS, chatListState } from './chat-fixture.js'
import { ChatHub, type ChatResume, type WireItem } from './chat.js'
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

const codexReply = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
const codexTool = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'late', arguments: JSON.stringify({ cmd: 'sleep 10' }) } }
const codexToolResult = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'late', output: 'Process exited with code 1\nOutput:\nSYNTHETIC' } }

function paneOf(state: ListState, paneId: string) {
  const pane = state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)).find((row) => row.paneId === paneId)
  if (pane === undefined) throw new Error(`pane ${paneId} 없음`)
  return pane
}

/** Codex 채널 c2 하나 — 세션 id → 파일 표를 고칠 수 있다. */
function setup(input: { rows: unknown[]; log?: (tag: string, fields?: Record<string, unknown>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l581r2-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'codex.jsonl')
  fs.writeFileSync(file, lines(input.rows))
  const bySession = new Map<string, string>([[CHAT_SESSIONS.codex.id, file]])
  const state = chatListState()
  const hub = new ChatHub({
    read: () => ({ state, prefs: null }),
    resolveFile: ({ session }) => (session.kind === 'id' ? (bySession.get(session.id) ?? null) : null),
    log: input.log ?? (() => {}),
    pollMs: 20,
    graceMs: 5000,
    refreshMs: 10,
    retryMs: 30,
  })
  cleanups.push(() => hub.stop())
  return { dir, file, state, hub, bySession }
}

/** 폰 흉내 — 받은 프레임을 id 로 합치고 가장 큰 cursor 를 든다. `limit` 이 있으면 그 수만큼만 받고 나머지는 끊긴 것으로 친다. */
function phone(hub: ChatHub) {
  const held = new Map<number, WireItem>()
  let gen: string | null = null
  let cursor: number | null = null
  let hasOlder = false
  let limit = Number.POSITIVE_INFINITY
  let frames: Frame[] = []
  let subscription: ReturnType<ChatHub['subscribe']> | null = null
  const accept = (frame: Frame): void => {
    if (frame.type === 'chat.page' && frame.mode === 'reset') held.clear()
    if (frame.type === 'chat.page' && frame.mode !== 'older') {
      gen = String(frame.gen)
      hasOlder = frame.hasOlder === true
    }
    if (frame.type === 'chat.page' && frame.mode === 'older') hasOlder = frame.hasOlder === true
    for (const item of itemsOf(frame)) held.set(item.id, item)
    if (typeof frame.cursor === 'number') cursor = Math.max(cursor ?? 0, frame.cursor)
  }
  const ids = (): number[] => [...held.keys()].sort((a, b) => a - b)
  return {
    frames: () => frames,
    ids,
    hasOlder: () => hasOlder,
    connect(input: { limit?: number } = {}): void {
      limit = input.limit ?? Number.POSITIVE_INFINITY
      frames = []
      const first = ids()[0]
      const resume: ChatResume = gen !== null && cursor !== null && first !== undefined ? { gen, from: first, cursor } : null
      // r0·r1 이 같은 상황에서 무엇을 하는지가 음성 대조가 되게, r0 의 `after` 도 함께 싣는다.
      const request = resume === null ? null : { ...resume, after: ids()[ids().length - 1] ?? 0 }
      subscription = hub.subscribe({
        channelId: 'c2',
        resume: request,
        sink: (text) => {
          const frame: Frame = JSON.parse(text)
          frames.push(frame)
          if (frames.length <= limit) accept(frame)
        },
      })
    },
    disconnect(): void {
      subscription?.close()
      subscription = null
    },
    older(): void {
      const first = ids()[0]
      if (first !== undefined && gen !== null) subscription?.older({ gen, before: first })
    },
  }
}

describe('R2-A1 나눠 보낸 묶음의 앞 프레임만 받고 끊겨도 나머지가 다시 온다', () => {
  const big = (i: number) => codexReply(`${i}:${'한'.repeat(15_000)}`)

  it('이어 받기(resume) 가 여러 프레임 — 첫 프레임만 받고 끊긴 뒤 다시 이어 받으면 빠짐 없음', async () => {
    const { file, hub } = setup({ rows: [codexReply('seed')] })
    const p = phone(hub)
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    p.disconnect()
    fs.appendFileSync(file, lines(Array.from({ length: 30 }, (_, i) => big(i))))
    await sleep(80) // 구독 0 — 판독자는 멈춰 있다(R1-A3). 다시 열면 따라잡는다.
    p.connect({ limit: 1 })
    await waitFor(() => p.frames().find((frame) => frame.mode === 'resume'))
    await sleep(60)
    expect(p.frames().length).toBeGreaterThan(1) // 정말 나뉘었다(양성 대조)
    p.disconnect()
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    await sleep(60)
    const all = hub.readerFor(file)?.items().map((item) => item.id) ?? []
    expect(all).toHaveLength(31)
    expect(p.ids()).toEqual(all)
  })

  it('일반 push 가 여러 프레임 — 첫 프레임만 받고 끊긴 뒤 이어 받으면 빠짐 없음', async () => {
    const { file, hub } = setup({ rows: [codexReply('seed')] })
    const p = phone(hub)
    p.connect({ limit: 1 + 1 }) // 첫 페이지 1 + push 첫 프레임 1 만 받는다
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    // 한 번에 써서 꼬리 확인 한 번이 묶음 하나로 읽게 한다.
    fs.appendFileSync(file, lines(Array.from({ length: 30 }, (_, i) => big(i))))
    await waitFor(() => (p.frames().filter((frame) => frame.type === 'chat.items').length > 1 ? true : undefined))
    p.disconnect()
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    await sleep(60)
    const all = hub.readerFor(file)?.items().map((item) => item.id) ?? []
    expect(all).toHaveLength(31)
    expect(p.ids()).toEqual(all)
  })
})

describe('R2-A2 폰이 아직 불러오지 않은 과거 말풍선의 갱신이 과거 요청 경계를 당기지 않는다', () => {
  it('오래된 비동기 결과(맨 앞 도구의 늦은 결과) → 과거를 파일 처음까지 다 불러온다', async () => {
    const { file, hub } = setup({ rows: [codexTool, ...Array.from({ length: 100 }, (_, i) => codexReply(`reply ${i}`))] })
    const p = phone(hub)
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    expect(p.ids()).toHaveLength(40)
    fs.appendFileSync(file, lines([codexToolResult]))
    await sleep(120) // 늦은 결과가 판독되고(push 가 오든 말든) 지나간다
    for (let i = 0; i < 5 && p.hasOlder(); i += 1) {
      const before = p.frames().length
      p.older()
      await waitFor(() => (p.frames().length > before ? true : undefined))
    }
    const reader = hub.readerFor(file)
    expect(p.hasOlder()).toBe(false)
    expect(p.ids()).toEqual(reader?.items().map((item) => item.id))
    // 과거 페이지로 받은 도구 묶음은 늦은 결과가 반영된 최신 상태다.
    const tools = p.ids().map((id) => itemsOfHeld(p, id)).find((item) => item?.kind === 'tools')
    expect(tools).toMatchObject({ kind: 'tools', tools: [{ status: 'error' }] })
  })
})

/** 폰이 든 말풍선 하나 — 마지막으로 받은 값(프레임 순서대로 찾는다). */
function itemsOfHeld(p: ReturnType<typeof phone>, id: number): WireItem | undefined {
  let found: WireItem | undefined
  for (const frame of p.frames()) for (const item of itemsOf(frame)) if (item.id === id) found = item
  return found
}

describe('R2-A3 첫 색인·따라잡기 중에 마지막 구독이 떠나면 다음 조각 경계에서 멈춘다', () => {
  const mib = (count: number) => Array.from({ length: count }, (_, i) => codexReply(`${i}:${'x'.repeat(1024 * 1024)}`))

  it('큰 기록을 열자마자 닫으면 색인을 끝까지 읽지 않는다 · 부분 색인은 공개하지 않는다 · 다시 열면 전부', async () => {
    const { file, hub } = setup({ rows: mib(30) })
    const size = fs.statSync(file).size
    const first = phone(hub)
    first.connect()
    first.disconnect()
    await sleep(400)
    const reader = hub.readerFor(file)
    expect(reader?.state.kind).not.toBe('ready')
    expect(reader?.cost.bytes ?? size).toBeLessThan(size / 2)
    // 다시 열면 처음부터 다 읽고 첫 페이지(양성 대조).
    const again = phone(hub)
    again.connect()
    await waitFor(() => again.frames().find((frame) => frame.type === 'chat.page'), 10_000)
    expect(hub.readerFor(file)?.items()).toHaveLength(30)
  })

  it('멈춘 동안 크게 늘어난 기록 — 다시 열어 따라잡는 도중 닫으면 거기서 멈춘다', async () => {
    const { file, hub } = setup({ rows: [codexReply('seed')] })
    const p = phone(hub)
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    p.disconnect()
    fs.appendFileSync(file, lines(mib(30)))
    const reader = hub.readerFor(file)
    const before = reader?.cost.bytes ?? 0
    p.connect()
    p.disconnect()
    await sleep(400)
    expect((reader?.cost.bytes ?? 0) - before).toBeLessThan(15 * 1024 * 1024)
  })
})

describe('R2-A4 일시 부재는 구독을 끝내지 않는다 — 회복되면 사용자 조작 없이 이어진다', () => {
  it('새 세션 참조가 기록 파일보다 먼저 왔다(no_file) → 파일이 생기면 새 기록을 처음부터', async () => {
    const { dir, state, hub, bySession } = setup({ rows: [codexReply('옛 답')] })
    const p = phone(hub)
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    const next = path.join(dir, 'codex-next.jsonl')
    bySession.set('replacement', next)
    paneOf(state, 'c2').agentSession = { kind: 'id', agent: 'codex', source: 'herdr', id: 'replacement' }
    hub.refresh()
    const gone = await waitFor(() => p.frames().find((frame) => frame.type === 'chat.unavailable'))
    expect(gone).toMatchObject({ reason: 'no_file', retrying: true })
    fs.writeFileSync(next, lines([codexReply('새 답')]))
    const after = p.frames().indexOf(gone)
    const reset = await waitFor(() => p.frames().slice(after + 1).find((frame) => frame.type === 'chat.page'), 2000)
    expect(reset).toMatchObject({ mode: 'reset' })
    expect(itemsOf(reset)[0]).toMatchObject({ kind: 'reply', body: { text: '새 답' } })
    // 그 뒤 새 기록의 push 도 온다.
    fs.appendFileSync(next, lines([codexReply('새 답 둘')]))
    const push = await waitFor(() => p.frames().find((frame) => frame.type === 'chat.items'))
    expect(itemsOf(push)[0]).toMatchObject({ kind: 'reply', body: { text: '새 답 둘' } })
  })

  it('목록 연결이 잠깐 connecting → live 로 돌아오면 같은 구독이 이어 받는다(push 계속)', async () => {
    const { file, state, hub } = setup({ rows: [codexReply('답')] })
    const p = phone(hub)
    p.connect()
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'))
    const live = state.link
    state.link = { ...live, phase: 'connecting' }
    hub.refresh()
    state.link = live
    hub.refresh()
    fs.appendFileSync(file, lines([codexReply('회복 뒤 답')]))
    const push = await waitFor(() => p.frames().find((frame) => frame.type === 'chat.items'), 2000)
    expect(itemsOf(push)[0]).toMatchObject({ kind: 'reply', body: { text: '회복 뒤 답' } })
    expect(p.frames().some((frame) => frame.type === 'chat.unavailable' && frame.retrying !== true)).toBe(false)
  })

  it('처음 열 때 파일이 아직 없어도 구독을 든다 → 생기면 첫 페이지 · 진짜 채널 삭제는 그대로 끝(양성 대조)', async () => {
    const { file, state, hub } = setup({ rows: [codexReply('답')] })
    fs.renameSync(file, `${file}.away`)
    const p = phone(hub)
    p.connect()
    expect(p.frames()[0]).toMatchObject({ type: 'chat.unavailable', reason: 'no_file' })
    fs.renameSync(`${file}.away`, file)
    await waitFor(() => p.frames().find((frame) => frame.type === 'chat.page'), 2000)
    // 채널이 목록에서 사라지면(pane 닫힘) 끝 — 다시 찾지 않는다.
    for (const worktree of state.repos.flatMap((repo) => repo.worktrees)) for (const tab of worktree.workspace?.tabs ?? []) tab.panes = tab.panes.filter((pane) => pane.paneId !== 'c2')
    hub.refresh()
    const gone = await waitFor(() => p.frames().find((frame) => frame.type === 'chat.unavailable' && frame.reason === 'not_listed'))
    expect(gone.retrying).not.toBe(true)
    expect(hub.subscriberCount()).toBe(0)
  })
})

describe('R2-A5 첫 페이지 계측은 구독 입구 → 보낼 프레임 준비 완료', () => {
  it('세션 찾기·가림·변환·직렬화 시간이 firstPageMs 에 들어간다 — 입구→sink 와 거의 같다', async () => {
    const logs: Record<string, unknown>[] = []
    const { hub } = setup({ rows: Array.from({ length: 40 }, () => codexReply('%2525252525252525'.repeat(2100))), log: (tag, fields) => logs.push({ tag, ...fields }) })
    // 판독자를 먼저 데워 둔다 — 색인 시간이 아니라 페이지 준비 시간을 본다.
    const warm = phone(hub)
    warm.connect()
    await waitFor(() => warm.frames().find((frame) => frame.type === 'chat.page'))
    logs.length = 0
    let sinkAt = 0
    const started = performance.now()
    hub.subscribe({ channelId: 'c2', resume: null, sink: () => (sinkAt = sinkAt || performance.now()) })
    const reported = Number(logs.find((entry) => entry.tag === 'mobile.chat_page')?.firstPageMs)
    const actual = sinkAt - started
    expect(actual).toBeGreaterThan(5) // 가림 비용이 실제로 있다(양성 대조)
    expect(actual - reported).toBeLessThan(Math.max(2, actual * 0.2))
  })
})
