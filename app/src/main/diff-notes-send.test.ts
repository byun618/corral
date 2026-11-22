// diff 메모 보내기 main 쪽 (LIFE-832 L4ⓖ·L5·L6·L8·L10ⓐⓑ) — 데스크톱 전용 InputHub 인스턴스 + 가짜 백엔드 + 실제 기록 대조(`countSubmissions`).
// 가짜 백엔드의 넣기는 Claude 기록에 사람 발화 한 줄을 붙인다 — 「들어감」 은 그 줄을 커서 뒤에서 정확히 1건 찾았을 때만(폰 경로 시험과 같은 장치).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalIdentity } from './adapter/index.js'
import { DiffNotesSender } from './diff-notes-send.js'
import { InputHub, observedSessionKey, type InputBackend, type InputWire, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './mobile/input.js'
import { CHAT_SESSIONS } from './mobile/chat-fixture.js'
import { fixturePane, fixtureWorktree, liveLink } from './mobile/list-fixture.js'
import type { ListState } from './mobile/list.js'
import { formatNotesBody, type DiffNotesState } from '../shared/diff-notes.js'
import { MAX_INPUT_BYTES } from '../shared/input-body.js'
import type { AgentSessionRef, RepoRow } from '../shared/types.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')
const DRAFT = ['', RULE, '❯ 쓰던 글', RULE].join('\r\n')
const MAIN = '/Users/fx/repos/demo'
const LINKED = '/Users/fx/repos/demo/.claude/worktrees/feat'

let uuid = 0
function userLine(text: string): string {
  uuid += 1
  return JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: text }, uuid: `u-${uuid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
}

class FakeBackend implements InputBackend {
  status = 'idle'
  seq = 1
  quiet = true
  screenText = EMPTY
  paneMissing = false
  input: PaneObservation['input'] = { revision: 1, idleMs: 10_000 }
  observedSession: (paneId: string) => string | null = () => null
  readonly prompts: { paneId: string; text: string }[] = []
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  async locate(paneId: string): Promise<TerminalIdentity | null> {
    if (this.paneMissing) return null
    return { epoch: 'e', ptyId: 't', paneId, tabId: 'tab', workspaceId: 'ws', path: LINKED, repo: MAIN, title: 'x' }
  }

  async observe(pane: TerminalIdentity): Promise<PaneObservation> {
    return { status: this.status, seq: this.seq, quiet: this.quiet, unmanaged: false, input: this.input, anyInput: null, session: this.observedSession(pane.paneId) }
  }

  unmanagedPrompt(): boolean {
    return true
  }

  async manifestVerified(): Promise<boolean> {
    return true
  }

  async screen(): Promise<ScreenRead> {
    return { text: this.screenText, input: this.input, anyInput: null, seq: this.seq }
  }

  async prompt(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number }): Promise<SendResult> {
    // guard 처럼 — 울타리 revision 이 지금 값과 다르면 쓰지 않는다. 들어가면 같은 턴에서 revision 을 1 올린다.
    if (this.input !== null && input.inputRevision !== this.input.revision) return 'refused'
    if (this.input !== null) this.input = { ...this.input, revision: this.input.revision + 1 }
    this.prompts.push({ paneId: pane.paneId, text: input.text })
    fs.appendFileSync(this.file, `${userLine(input.text)}\n`)
    return 'sent'
  }

  async send(): Promise<KeyResult> {
    return { kind: 'refused' }
  }
}

/** main checkout(main workspace 에 claude `m1`) + linked worktree(claude `c1` · codex `c2` · grok `c3` · 세션 없는 claude `c4` · 셸 `s1`). */
function listState(): ListState {
  const session = (ref: AgentSessionRef) => ({ agentSession: ref, cwd: LINKED })
  const linked = [fixturePane('c1', 'claude', session(CHAT_SESSIONS.claude)), fixturePane('c2', 'codex', session(CHAT_SESSIONS.codex)), fixturePane('c3', 'grok', session(CHAT_SESSIONS.grok)), fixturePane('c4', 'claude', { agentSession: null, cwd: LINKED }), fixturePane('s1', null, { cwd: LINKED })]
  const main = [fixturePane('m1', 'claude', { agentSession: { kind: 'id', agent: 'claude', source: 'herdr', id: 'main-session' }, cwd: MAIN })]
  const repo: RepoRow = {
    root: MAIN,
    name: 'demo',
    error: null,
    worktrees: [fixtureWorktree({ path: MAIN, branch: 'main', repoName: 'demo', isLinked: false, panes: main }), fixtureWorktree({ path: LINKED, branch: 'feat', repoName: 'demo', parentPath: MAIN, panes: linked })],
  }
  return { repos: [repo], retainedAgents: [], orchestrationLineage: { state: 'ready', entries: [] }, integrations: [], home: '/Users/fx', link: liveLink() }
}

const TIMING = { pollMs: 5, gateMs: 5, quietMs: 500, confirmMs: 400, recordPollMs: 10, stepGapMs: 1, answerConfirmMs: 300, stopConfirmMs: 200 }

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l832s-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'claude.jsonl')
  fs.writeFileSync(file, `${userLine('이전 지시')}\n`)
  const backend = new FakeBackend(file)
  const state = listState()
  backend.observedSession = (paneId) => {
    const pane = state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes).find((row) => row.paneId === paneId)
    const ref = pane?.agentSession ?? null
    return ref === null ? null : observedSessionKey({ source: ref.source, kind: ref.kind, value: ref.kind === 'id' ? ref.id : ref.path })
  }
  const pushes: DiffNotesState[] = []
  const logs: string[] = []
  const sender = new DiffNotesSender({
    read: () => ({ state, prefs: null }),
    backend: () => backend,
    push: (pushed) => pushes.push(pushed),
    log: (tag) => logs.push(tag),
    hub: { resolveFile: () => ({ kind: 'found', file }), timing: TIMING },
  })
  const last = (id: string): DiffNotesState | undefined => pushes.filter((pushed) => pushed.requestId === id).at(-1)
  const settled = async (id: string, timeoutMs = 2_000): Promise<DiffNotesState> => {
    const started = Date.now()
    for (;;) {
      const pushed = last(id)
      if (pushed !== undefined && !['queued', 'sending'].includes(pushed.state)) return pushed
      if (Date.now() - started > timeoutMs) throw new Error(`settle timeout ${id}: ${JSON.stringify(pushed)}`)
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  const records = (text: string): number =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"content"') && line.includes(JSON.stringify(text).slice(1, -1))).length
  return { sender, backend, state, file, pushes, logs, last, settled, records }
}

const BODY = formatNotesBody({
  notes: [
    { rel: 'src/b.ts', line: 3, lineText: 'const b = 2', body: '둘째 파일\n두 줄' },
    { rel: 'src/a.ts', line: 10, lineText: 'const a = 1', body: '첫째 "따옴표" \\ 백슬래시' },
    { rel: 'src/a.ts', line: 2, lineText: 'import x', body: '이모지 🙂 · 탭\t끝' },
  ],
  against: ['base main(abc1234)'],
})

describe('diff 메모 보내기 — 들어감 (L5·L3)', () => {
  it('두 파일 메모 3개 본문(여러 줄) → 대상 pane 기록에 정확히 1건 · delivered · 넣은 글 = 보낸 글', async () => {
    const t = setup()
    expect(t.sender.send({ requestId: 'r-0001', worktree: LINKED, paneId: 'c1', text: BODY })).toEqual({ ok: true })
    expect(await t.settled('r-0001')).toMatchObject({ state: 'delivered', reason: null })
    expect(t.backend.prompts).toEqual([{ paneId: 'c1', text: BODY }])
    expect(BODY.split('\n').length).toBeGreaterThan(5)
    expect(t.records(BODY)).toBe(1)
    // 허브 로그는 데스크톱 이름으로 갈린다 — 폰 로그(`mobile.*`)와 섞이지 않는다.
    expect(t.logs).toContain('diff_notes.input_delivered')
    expect(t.logs.some((tag) => tag.startsWith('mobile.'))).toBe(false)
  })
  it('같은 요청 id 연타 3회 → 넣기 1회(L8)', async () => {
    const t = setup()
    for (let index = 0; index < 3; index += 1) t.sender.send({ requestId: 'r-mash', worktree: LINKED, paneId: 'c1', text: BODY })
    expect(await t.settled('r-mash')).toMatchObject({ state: 'delivered' })
    t.sender.send({ requestId: 'r-mash', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    expect(t.backend.prompts).toHaveLength(1)
  })
})

describe('접수 거절 — 쓰기 0 (L4ⓖ·L9·L10ⓐ)', () => {
  const cases: [string, unknown, string][] = [
    ['입력이 객체가 아님', 'x', 'bad_input'],
    ['요청 id 모양 틀림', { requestId: 'a b', worktree: LINKED, paneId: 'c1', text: 'x' }, 'bad_input'],
    ['본문이 문자열 아님', { requestId: 'r1', worktree: LINKED, paneId: 'c1', text: 3 }, 'bad_input'],
    ['상한 초과', { requestId: 'r1', worktree: LINKED, paneId: 'c1', text: 'a'.repeat(MAX_INPUT_BYTES + 1) }, 'too_large'],
    ['정리 안 된 본문(ESC)', { requestId: 'r1', worktree: LINKED, paneId: 'c1', text: 'a\x1b[201~b' }, 'not_clean'],
    ['빈 본문', { requestId: 'r1', worktree: LINKED, paneId: 'c1', text: '  \n ' }, 'empty'],
    ['없는 worktree', { requestId: 'r1', worktree: '/nope', paneId: 'c1', text: 'x' }, 'not_worktree'],
    ['main workspace 의 에이전트 pane', { requestId: 'r1', worktree: LINKED, paneId: 'm1', text: 'x' }, 'not_target'],
    ['셸 pane', { requestId: 'r1', worktree: LINKED, paneId: 's1', text: 'x' }, 'not_target'],
    ['없는 pane', { requestId: 'r1', worktree: LINKED, paneId: 'zz', text: 'x' }, 'not_target'],
    ['세션 참조 없는 에이전트 pane', { requestId: 'r1', worktree: LINKED, paneId: 'c4', text: 'x' }, 'no_session'],
  ]
  it.each(cases)('%s → %s', async (_name, input, reason) => {
    const t = setup()
    expect(t.sender.send(input)).toEqual({ ok: false, reason })
    await new Promise((done) => setTimeout(done, 20))
    expect(t.backend.prompts).toHaveLength(0)
    expect(t.pushes).toHaveLength(0)
  })
  it('상한 딱 맞는 본문(65536 바이트)은 받는다', () => {
    const t = setup()
    expect(t.sender.send({ requestId: 'r-max', worktree: LINKED, paneId: 'c1', text: 'a'.repeat(MAX_INPUT_BYTES) })).toEqual({ ok: true })
  })
})

describe('끼어들지 않기 (L6) — 폰 허브와 같은 보장', () => {
  it('ⓐ 작업 중이면 대기(turn) → 턴이 끝난 뒤 들어간다, 작업 중 넣기 0', async () => {
    const t = setup()
    t.backend.quiet = false
    t.backend.status = 'working'
    t.sender.send({ requestId: 'r-wait', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 40))
    expect(t.last('r-wait')).toMatchObject({ state: 'queued', wait: 'turn' })
    expect(t.backend.prompts).toHaveLength(0)
    t.backend.quiet = true
    t.backend.status = 'idle'
    expect(await t.settled('r-wait')).toMatchObject({ state: 'delivered' })
    expect(t.backend.prompts).toHaveLength(1)
  })
  it('ⓑ 대기 중 취소 → cancelled, 넣기 0', async () => {
    const t = setup()
    t.backend.quiet = false
    t.sender.send({ requestId: 'r-cancel', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    t.sender.cancel({ requestId: 'r-cancel' })
    expect(await t.settled('r-cancel')).toMatchObject({ state: 'cancelled' })
    t.backend.quiet = true
    await new Promise((done) => setTimeout(done, 40))
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓒ 접수 뒤 그 pane 에 키 입력 → failed/mac_input, 넣기 0', async () => {
    const t = setup()
    t.backend.quiet = false
    t.sender.send({ requestId: 'r-key', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    if (t.backend.input !== null) t.backend.input = { ...t.backend.input, revision: t.backend.input.revision + 1 }
    t.backend.quiet = true
    expect(await t.settled('r-key')).toMatchObject({ state: 'failed', reason: 'mac_input' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓓ 입력창에 초안 → failed/mac_draft, 넣기 0', async () => {
    const t = setup()
    t.backend.screenText = DRAFT
    t.sender.send({ requestId: 'r-draft', worktree: LINKED, paneId: 'c1', text: BODY })
    expect(await t.settled('r-draft')).toMatchObject({ state: 'failed', reason: 'mac_draft' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓔ Claude agent view 화면 → failed/agent_view, 넣기 0', async () => {
    const t = setup()
    t.backend.screenText = fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-view', 'view-default.ansi'), 'utf8')
    t.sender.send({ requestId: 'r-view', worktree: LINKED, paneId: 'c1', text: BODY })
    expect(await t.settled('r-view')).toMatchObject({ state: 'failed', reason: 'agent_view' })
    expect(t.backend.prompts).toHaveLength(0)
  })
  it('ⓕ 접수 뒤 pane 이 닫힘 → failed/closed · 세션 바뀜 → failed/target_changed', async () => {
    const closed = setup()
    closed.backend.quiet = false
    closed.sender.send({ requestId: 'r-closed', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    closed.backend.paneMissing = true
    expect(await closed.settled('r-closed')).toMatchObject({ state: 'failed', reason: 'closed' })
    const moved = setup()
    moved.backend.quiet = false
    moved.sender.send({ requestId: 'r-moved', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    moved.backend.observedSession = () => 'other-session'
    moved.backend.quiet = true
    expect(await moved.settled('r-moved')).toMatchObject({ state: 'failed', reason: 'target_changed' })
    expect([...closed.backend.prompts, ...moved.backend.prompts]).toHaveLength(0)
  })
  it('ⓖ 같은 pane 에 폰 지시와 거의 동시 — 자기 쓰기 사슬이 인스턴스별이라 뒤 것은 쓰지 않고 실패(mac_input)', async () => {
    const t = setup()
    const phoneWires: InputWire[] = []
    const phone = new InputHub({ read: () => ({ state: t.state, prefs: null }), backend: () => t.backend, resolveFile: () => ({ kind: 'found', file: t.file }), questionItems: () => null, log: () => {}, timing: TIMING })
    cleanups.push(() => phone.stop())
    phone.attach({ device: 'phone', sink: (text) => phoneWires.push(JSON.parse(text)) })
    t.backend.quiet = false
    t.sender.send({ requestId: 'r-race', worktree: LINKED, paneId: 'c1', text: BODY })
    phone.send({ device: 'phone', id: 'p-race', channel: 'c1', text: '폰 지시' })
    await new Promise((done) => setTimeout(done, 30))
    t.backend.quiet = true
    const desktop = await t.settled('r-race')
    const started = Date.now()
    while (!phoneWires.some((wire) => wire.id === 'p-race' && !['queued', 'sending'].includes(wire.state)) && Date.now() - started < 2_000) await new Promise((done) => setTimeout(done, 5))
    const phoneState = phoneWires.filter((wire) => wire.id === 'p-race').at(-1)
    const states = [desktop.state, phoneState?.state].sort()
    expect(states).toEqual(['delivered', 'failed'])
    expect([desktop.reason, phoneState?.reason]).toContain('mac_input')
    expect(t.backend.prompts).toHaveLength(1)
  })
})

describe('모바일 수명과 분리 (L10ⓑ)', () => {
  it('폰 허브를 끄거나(stop) 기기를 해지해도 데스크톱 인스턴스의 대기 요청은 남아 들어간다', async () => {
    const t = setup()
    const phone = new InputHub({ read: () => ({ state: t.state, prefs: null }), backend: () => t.backend, resolveFile: () => ({ kind: 'found', file: t.file }), questionItems: () => null, deviceValid: () => false, log: () => {}, timing: TIMING })
    t.backend.quiet = false
    t.sender.send({ requestId: 'r-off', worktree: LINKED, paneId: 'c1', text: BODY })
    await new Promise((done) => setTimeout(done, 30))
    phone.stop()
    phone.revoke('desktop')
    t.backend.quiet = true
    expect(await t.settled('r-off')).toMatchObject({ state: 'delivered' })
  })
})
