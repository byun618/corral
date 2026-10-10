// 대화 구독 허브 (LIFE-581 Y2·Y4ⓐ·Y5ⓒ·Y7·Y9ⓓⓔ) — 실제 파일(임시 폴더의 합성 기록)로 페이지·push·과거·이어 받기·세대 교체·가림을 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../../shared/types.js'
import { ChatBuilder } from '../chat-parse.js'
import { CHAT_HOME, CHAT_SESSIONS, CLAUDE_SESSION, SECRET_RESULT, SECRET_THOUGHT, chatListState, claudeLines, codexNewLines, grokUpdateLines } from './chat-fixture.js'
import { CHAT_PAGE_SIZE, ChatHub, ITEM_TEXT_MAX, wireItem, type ChatResume, type WireItem } from './chat.js'
import type { ListInput } from './list.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

type Frame = Record<string, unknown> & { type: string }

function setup(input: { files?: Partial<Record<keyof typeof CHAT_SESSIONS, string[]>>; list?: () => ListInput | null; graceMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l581c-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files: Record<string, string> = {}
  const lines = { claude: claudeLines(), codex: codexNewLines(), grok: grokUpdateLines(), retained: claudeLines().map((line) => line.replaceAll(CLAUDE_SESSION, 'cfx-closed')), ...input.files }
  for (const [key, body] of Object.entries(lines)) {
    const file = path.join(dir, `${key}.jsonl`)
    fs.writeFileSync(file, body.map((line) => `${line}\n`).join(''))
    files[key] = file
  }
  const bySession = new Map<string, string>()
  for (const [key, session] of Object.entries(CHAT_SESSIONS)) {
    const file = files[key]
    if (file !== undefined && session.kind === 'id') bySession.set(session.id, file)
  }
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  const resolved: AgentSessionRef[] = []
  const hub = new ChatHub({
    read: input.list ?? (() => ({ state: chatListState(), prefs: null })),
    resolveFile: ({ session }) => {
      resolved.push(session)
      return session.kind === 'id' ? (bySession.get(session.id) ?? null) : null
    },
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    pollMs: 20,
    graceMs: input.graceMs ?? 50,
  })
  cleanups.push(() => hub.stop())
  return { dir, files, hub, logs, resolved }
}

function open(hub: ChatHub, channelId: string, resume: ChatResume = null) {
  const frames: Frame[] = []
  const subscription = hub.subscribe({ channelId, resume, sink: (text) => frames.push(JSON.parse(text)) })
  return { frames, subscription }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const pageOf = (frames: Frame[], mode?: string): Frame | undefined => frames.find((frame) => frame.type === 'chat.page' && (mode === undefined || frame.mode === mode))
const itemsOf = (frame: Frame): WireItem[] => (Array.isArray(frame.items) ? frame.items : [])
const append = (file: string, lines: string[]): void => fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(''))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function claudePrompt(text: string, uuid: string, parent: string): string {
  return JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: new Date().toISOString(), sessionId: CLAUDE_SESSION })
}
function claudeReply(text: string, uuid: string, parent: string): string {
  return JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'assistant', message: { id: `m-${uuid}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] }, uuid, timestamp: new Date().toISOString(), sessionId: CLAUDE_SESSION })
}

/** 한 번에 변환한 결과(정답) — 페이지·이어 받기를 이어 붙인 것과 견준다. */
function fullWire(file: string, sessionId: string | null, agent: 'claude' | 'codex' | 'grok' = 'claude'): WireItem[] {
  const builder = new ChatBuilder({ agent, sessionId })
  const buffer = fs.readFileSync(file)
  let start = 0
  for (;;) {
    const newline = buffer.indexOf(0x0a, start)
    if (newline < 0) break
    builder.feed({ offset: start, line: buffer.toString('utf8', start, newline) })
    start = newline + 1
  }
  const place = { worktree: '/Users/fxuser/repos/demo', home: CHAT_HOME }
  return builder.items.map((item) => wireItem({ item, place }))
}

describe('구독 → 최근 페이지 → push (Y2ⓐ)', () => {
  it('세 provider 모두 첫 페이지를 받는다 — 세대·말풍선, 생각·결과 본문 없음, 홈 경로 가림', async () => {
    const { hub } = setup()
    for (const channel of ['c1', 'c2', 'c3']) {
      const { frames } = open(hub, channel)
      const page = await waitFor(() => pageOf(frames, 'reset'))
      expect(page).toMatchObject({ channel, hasOlder: false })
      expect(typeof page.gen).toBe('string')
      expect(itemsOf(page).length).toBeGreaterThan(5)
      const text = JSON.stringify(page)
      expect(text).not.toContain(SECRET_THOUGHT)
      expect(text).not.toContain(SECRET_RESULT)
      expect(text).not.toContain(CHAT_HOME)
    }
    const claude = open(hub, 'c1')
    const page = await waitFor(() => pageOf(claude.frames, 'reset'))
    const text = JSON.stringify(page)
    expect(text).toContain('src/a.ts 를 고쳐 줘') // worktree 안 → 상대
    expect(text).toContain('ls ~/secret') // worktree 밖 홈 아래 → ~
  })

  it('새 줄 → chat.items push(그 말풍선만) · 반쯤 쓰인 줄은 개행이 올 때까지 보류 (Y2ⓓ)', async () => {
    const { hub, files } = setup()
    const { frames } = open(hub, 'c1')
    await waitFor(() => pageOf(frames, 'reset'))
    append(files.claude ?? '', [claudePrompt('라이브 지시', 'L1', 'a11')])
    const pushed = await waitFor(() => frames.find((frame) => frame.type === 'chat.items'))
    expect(itemsOf(pushed).map((item) => item.kind)).toEqual(['prompt'])
    expect(pushed).toMatchObject({ channel: 'c1' })
    expect(typeof pushed.readAt).toBe('number')
    expect(typeof pushed.writtenAt).toBe('number')
    const half = claudeReply('반쯤', 'L2', 'L1')
    fs.appendFileSync(files.claude ?? '', half.slice(0, 40))
    await sleep(200)
    expect(frames.filter((frame) => frame.type === 'chat.items')).toHaveLength(1)
    fs.appendFileSync(files.claude ?? '', `${half.slice(40)}\n`)
    await waitFor(() => (frames.filter((frame) => frame.type === 'chat.items').length === 2 ? true : undefined))
    expect(itemsOf(frames.filter((frame) => frame.type === 'chat.items')[1] ?? { type: 'x' }).map((item) => item.kind)).toEqual(['reply'])
  })
})

describe('판독 비용 (Y2ⓒ · Y10ⓑ)', () => {
  it('열린 대화 0 이면 판독자 0 · 파일 찾기 0 — 마지막 구독이 떠나면 유예 뒤 판독자도 사라진다', async () => {
    const { hub, resolved, files } = setup()
    await sleep(60)
    expect(hub.readerCount()).toBe(0)
    expect(resolved).toEqual([])
    const { frames, subscription } = open(hub, 'c1')
    await waitFor(() => pageOf(frames))
    const reader = hub.readerFor(files.claude ?? '')
    expect(reader).not.toBeNull()
    subscription.close()
    await waitFor(() => (hub.readerCount() === 0 ? true : undefined))
    const polls = reader?.cost.polls ?? 0
    await sleep(100)
    expect(reader?.cost.polls).toBe(polls)
  })

  it('같은 대화를 두 연결이 열어도 판독자 하나 · 색인 한 번 · push 는 둘 다', async () => {
    const { hub, files } = setup()
    const a = open(hub, 'c1')
    const b = open(hub, 'c1')
    await waitFor(() => pageOf(a.frames))
    await waitFor(() => pageOf(b.frames))
    expect(hub.readerCount()).toBe(1)
    const reader = hub.readerFor(files.claude ?? '')
    expect(reader?.cost.indexes).toBe(1)
    append(files.claude ?? '', [claudePrompt('둘 다 받는 지시', 'S1', 'a11')])
    await waitFor(() => a.frames.find((frame) => frame.type === 'chat.items'))
    await waitFor(() => b.frames.find((frame) => frame.type === 'chat.items'))
  })
})

describe('거절 (Y2ⓑ) — 목록에 있는 AI 채널만, 양성 대조', () => {
  it('모르는 채널 · 셸 pane · 세션 참조 없음 · 파일 없음 · 상태 못 읽음은 chat.unavailable 한 건', async () => {
    const { hub, files } = setup()
    const reasons: Record<string, unknown> = {}
    for (const channel of ['nope', 's1', 'c4', 'retained:r-old', '../../etc/passwd']) reasons[channel] = open(hub, channel).frames[0]?.reason
    expect(reasons).toEqual({ nope: 'not_listed', s1: 'not_listed', c4: 'no_session', 'retained:r-old': 'no_session', '../../etc/passwd': 'not_listed' })
    fs.rmSync(files.codex ?? '')
    expect(open(hub, 'c2').frames[0]).toMatchObject({ type: 'chat.unavailable', reason: 'no_file' })
    const empty = setup({ list: () => null })
    expect(open(empty.hub, 'c1').frames[0]).toMatchObject({ type: 'chat.unavailable', reason: 'not_ready' })
    // 양성 대조 — 같은 허브의 AI 채널은 열린다.
    expect(await waitFor(() => pageOf(open(hub, 'c1').frames))).toMatchObject({ type: 'chat.page' })
    expect(hub.readerCount()).toBe(1)
  })
})

describe('닫힌 세션 (Y7 · X7)', () => {
  it('보존 행 retained:<pane> 은 붙든 세션 참조의 지난 기록을 연다', async () => {
    const { hub, resolved } = setup()
    const page = await waitFor(() => pageOf(open(hub, 'retained:r-claude').frames))
    expect(itemsOf(page).some((item) => item.kind === 'reply')).toBe(true)
    expect(resolved.at(-1)).toEqual(CHAT_SESSIONS.retained)
  })
})

describe('과거 페이지 (Y4ⓐ) — 이어 붙인 결과 = 한 번에 변환한 결과', () => {
  it('파일 처음까지 — 페이지 경계에서 빠짐·중복 0', async () => {
    const lines: string[] = []
    let parent = 'root'
    for (let i = 0; i < 130; i += 1) {
      lines.push(claudePrompt(`지시 ${i}`, `p${i}`, parent))
      lines.push(JSON.stringify({ parentUuid: `p${i}`, type: 'assistant', message: { id: `m${i}`, model: 'x', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/tmp/f${i}` } }] }, uuid: `t${i}u`, sessionId: CLAUDE_SESSION }))
      lines.push(JSON.stringify({ parentUuid: `t${i}u`, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' }] }, uuid: `r${i}`, sessionId: CLAUDE_SESSION }))
      lines.push(claudeReply(`답 ${i}`, `a${i}`, `r${i}`))
      parent = `a${i}`
    }
    const { hub, files } = setup({ files: { claude: lines } })
    const { frames, subscription } = open(hub, 'c1')
    const first = await waitFor(() => pageOf(frames, 'reset'))
    expect(itemsOf(first)).toHaveLength(CHAT_PAGE_SIZE)
    expect(first.hasOlder).toBe(true)
    const collected = [...itemsOf(first)]
    let guard = 0
    for (;;) {
      const before = collected[0]?.id ?? 0
      const count = frames.length
      subscription.older({ gen: String(first.gen), before })
      const page = await waitFor(() => (frames.length > count ? frames[frames.length - 1] : undefined))
      expect(page).toMatchObject({ type: 'chat.page', mode: 'older' })
      collected.unshift(...itemsOf(page))
      if (page.hasOlder !== true) break
      guard += 1
      expect(guard).toBeLessThan(50)
    }
    const expected = fullWire(files.claude ?? '', CLAUDE_SESSION)
    expect(collected).toEqual(expected)
    expect(new Set(collected.map((item) => item.id)).size).toBe(collected.length)
    // 세대가 다른 과거 요청은 무시한다.
    const count = frames.length
    subscription.older({ gen: 'stale', before: collected[10]?.id ?? 0 })
    await sleep(50)
    expect(frames.length).toBe(count)
  })
})

describe('재연결 이어 받기 (Y5ⓐ 재료 · Y5ⓒ)', () => {
  // r1(R1-A2·A4): 이어 받기 열쇠가 「마지막 id」 에서 「첫 id + 변경 순번」 으로 바뀌었고, 판독자를 버린 뒤(유예 끝)에는 세대가 새로 뽑혀 reset 이다.
  // 그래서 r0 의 「유예 끝 뒤 resume」 시험을 「유예 안 resume」 + 「유예 끝 뒤 reset」 둘로 나눴다.
  it('끊긴 동안 쓰인 줄 ≥ 3 — 유예 안에 같은 세대 + 첫 id + 변경 순번으로 다시 구독하면 그 뒤 전부(resume), 이어 붙인 결과 = 한 번에 변환', async () => {
    const { hub, files } = setup({ graceMs: 5000 })
    const first = open(hub, 'c1')
    const page = await waitFor(() => pageOf(first.frames, 'reset'))
    const held = itemsOf(page)
    first.subscription.close()
    append(files.claude ?? '', [claudePrompt('끊긴 동안 1', 'D1', 'a11'), claudeReply('끊긴 동안 2', 'D2', 'D1'), claudePrompt('끊긴 동안 3', 'D3', 'D2')])
    const again = open(hub, 'c1', { gen: String(page.gen), from: held[0]?.id ?? 0, cursor: Number(page.cursor) })
    const resumed = await waitFor(() => pageOf(again.frames))
    expect(resumed).toMatchObject({ mode: 'resume', gen: page.gen })
    const merged = new Map<number, WireItem>()
    for (const item of [...held, ...itemsOf(resumed)]) merged.set(item.id, item)
    const expected = fullWire(files.claude ?? '', CLAUDE_SESSION)
    expect([...merged.values()].sort((a, b) => a.id - b.id)).toEqual(expected.slice(Math.max(0, expected.length - merged.size)))
    expect(itemsOf(resumed).filter((item) => item.kind === 'prompt').map((item) => (item.kind === 'prompt' ? item.body.text : ''))).toEqual(['끊긴 동안 1', '끊긴 동안 3'])
    expect(Number(resumed.cursor)).toBeGreaterThan(Number(page.cursor))
  })

  it('판독자를 버린 뒤(유예 끝) 다시 열면 같은 파일이어도 새 세대 — 옛 세대 이어 받기는 reset', async () => {
    const { hub } = setup({ graceMs: 1 })
    const first = open(hub, 'c1')
    const page = await waitFor(() => pageOf(first.frames, 'reset'))
    first.subscription.close()
    await waitFor(() => (hub.readerCount() === 0 ? true : undefined))
    const again = open(hub, 'c1', { gen: String(page.gen), from: itemsOf(page)[0]?.id ?? 0, cursor: Number(page.cursor) })
    const second = await waitFor(() => pageOf(again.frames))
    expect(second).toMatchObject({ mode: 'reset' })
    expect(second.gen).not.toBe(page.gen)
  })

  it('세대가 다르거나 받은 적 없는 순번이면 처음부터(reset)', async () => {
    const { hub } = setup()
    expect(await waitFor(() => pageOf(open(hub, 'c1', { gen: 'other', from: 0, cursor: 0 }).frames))).toMatchObject({ mode: 'reset' })
    const page = await waitFor(() => pageOf(open(hub, 'c1').frames))
    expect(await waitFor(() => pageOf(open(hub, 'c1', { gen: String(page.gen), from: 0, cursor: Number(page.cursor) + 5 }).frames))).toMatchObject({ mode: 'reset' })
  })

  it('파일이 줄거나 교체되면 새 세대로 처음부터 · rewind 가 들어와도 새 세대', async () => {
    const { hub, files } = setup()
    const { frames } = open(hub, 'c1')
    const page = await waitFor(() => pageOf(frames, 'reset'))
    // rewind — 마지막 사람 발화(u6)와 같은 부모(a9)를 둔 새 발화.
    append(files.claude ?? '', [claudePrompt('또 되감기', 'u7', 'a9')])
    const rewound = await waitFor(() => frames.filter((frame) => frame.type === 'chat.page' && frame.mode === 'reset')[1])
    expect(rewound.gen).not.toBe(page.gen)
    expect(itemsOf(rewound).some((item) => item.kind === 'prompt' && item.body.text === '되감은 뒤 지시')).toBe(false)
    // 줄어듦
    fs.writeFileSync(files.claude ?? '', `${claudePrompt('새 파일', 'n1', 'x')}\n`)
    const shrunk = await waitFor(() => frames.filter((frame) => frame.type === 'chat.page' && frame.mode === 'reset')[2])
    expect(shrunk.gen).not.toBe(rewound.gen)
    expect(itemsOf(shrunk).map((item) => item.kind)).toEqual(['prompt'])
    // 교체(새 inode)
    const replacement = `${files.claude}.new`
    fs.writeFileSync(replacement, `${claudePrompt('교체된 파일', 'n2', 'x')}\n${claudeReply('교체 답', 'n3', 'n2')}\n`)
    fs.renameSync(replacement, files.claude ?? '')
    const replaced = await waitFor(() => frames.filter((frame) => frame.type === 'chat.page' && frame.mode === 'reset')[3])
    expect(replaced.gen).not.toBe(shrunk.gen)
    expect(itemsOf(replaced).map((item) => item.kind)).toEqual(['prompt', 'reply'])
  })
})

describe('크기 상한·가림 (Y9ⓓⓔ)', () => {
  it('넘는 글은 잘림 표시(clipped = 원래 길이)와 함께 자른다 · 퍼센트 인코딩 홈도 가린다', async () => {
    const long = 'x'.repeat(ITEM_TEXT_MAX + 4000)
    const lines = [claudePrompt(`홈 %2FUsers%2Ffxuser%2Fpriv 와 ${CHAT_HOME}/a`, 'p1', 'r'), claudeReply(long, 'a1', 'p1')]
    const { hub } = setup({ files: { claude: lines } })
    const page = await waitFor(() => pageOf(open(hub, 'c1').frames))
    const [prompt, reply] = itemsOf(page)
    expect(reply?.kind === 'reply' ? reply.body : null).toEqual({ text: 'x'.repeat(ITEM_TEXT_MAX), clipped: ITEM_TEXT_MAX + 4000 })
    expect(prompt?.kind === 'prompt' ? prompt.body.text : '').toBe('홈 ~/priv 와 ~/a')
    expect(JSON.stringify(page)).not.toMatch(/fxuser/)
  })
})
