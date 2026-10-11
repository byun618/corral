// LIFE-582 r3 격리 실물 — 격리 herdr 세션(이 시험이 띄운 것)에 이 시험이 만든 pane 에서만. 제품 허브(`InputHub`) + 실제 guard 백엔드(`HerdrInputBackend`).
//   npx tsx scripts/l582/native-r3.ts <sock> claude <cwd>   → R3-A1 맥 선체크 재현 · 빈 상태 대조 + 회귀(하나 · 여럿 · 여러 문항 · 직접 입력)
//   npx tsx scripts/l582/native-r3.ts <sock> codex <cwd>    → R3-A3 3문항 정상 경로(판독자 = 같은 기록을 읽는 ChatBuilder)
//   npx tsx scripts/l582/native-r3.ts <sock> grok <cwd>     → Grok 선택 답 1 + R3-A6 중단 경합(화면 읽은 직후 맥 타자 → Ctrl+C 0회) · 양성 대조(r4: stopped + 세션 생존만)
//   npx tsx scripts/l582/native-r3.ts <sock> capture <cwd> claude|grok <out dir>   → (r4 R4-A2) 긴 선택지 질문 하나를 띄우고 pane 을 150·100·80·60·40열로 바꿔 가며
//        화면을 <out dir>/<kind>-<열>.txt 로, 기록의 문항을 <kind>-question.json 으로 저장(fixture). 끝에 150열로 되돌려 허브로 답한다(질문 정리)
//   npx tsx scripts/l582/native-r3.ts <sock> width <cwd> claude|grok <열>...      → (r4 R4-A2) 열마다: pane 너비를 바꾸고 긴 선택지 질문 → 허브 답 → delivered + 기록 답 값
//   npx tsx scripts/l582/native-r3.ts <sock> width-mid <cwd> claude|grok <열>...  → (r5) 같은 흐름, 그 폭에서 다 보이는 중간 길이 선택지 질문
//   npx tsx scripts/l582/native-r3.ts <sock> truncated <cwd> grok <열>             → (r5 R5-A1) 긴 선택지(뒤 행이 `…` 로 잘림) → 키 0회 failed/question_truncated, 150열로 되돌려 답(대조·정리)
//   npx tsx scripts/l582/native-r3.ts <sock> values <cwd>                          → (r5 R5-A2) Claude 쉼표·따옴표 든 라벨 · 직접 입력 — delivered + 기록 답 값(실측 형식)
//   npx tsx scripts/l582/native-r3.ts <sock> other <cwd>                           → (r5 R5-A3) Grok 직접 입력 `hello` · `say "hello"` · `hello,` — delivered + 기록 답 값
// 출력은 JSON 줄. 시나리오마다 `ok`(기대와 같은가). 하나라도 다르면 exit 1. 본문은 남기지 않는다(G5 — 답 값은 시험이 정한 짧은 라벨뿐).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend, type TerminalIdentity } from '../../src/main/adapter/index.js'
import { EndpointClient } from '../../src/main/adapter/internal/vendor/endpoint-client.js'
import { ChatBuilder, type ChatItem } from '../../src/main/chat-parse.js'
import { chatFileOf } from '../../src/main/mobile/chat.js'
import { chatListState } from '../../src/main/mobile/chat-fixture.js'
import { InputHub, recordedAnswers, type InputBackend, type InputWire } from '../../src/main/mobile/input.js'
import { HerdrInputBackend } from '../../src/main/mobile/input-backend.js'
import { activeQuestion, draftState, questionDigest, screenPlain } from '../../src/main/mobile/keys.js'
import type { MobileAgentKind } from '../../src/main/mobile/list.js'
import { resolveTranscriptUnique } from '../../src/main/transcript.js'
import { sessionRecordPaths } from '../../src/runtime/terminal/agent.js'

const [sock, command, cwdArg] = process.argv.slice(2)
const cwd = cwdArg ?? ''
if (sock === undefined || !/\/herdr-dev\/sessions\/(l582-race[345]|l577g-l582g-z\d+)\//.test(sock) || !/^\/private\/tmp\/(l582-race[345]|l582g-z\d+)\//.test(cwd)) {
  console.error('usage: <isolated l582-race3|4 socket> claude|codex|grok|capture|width </private/tmp/l582-race3|4/...>')
  process.exit(2)
}
fs.mkdirSync(cwd, { recursive: true })
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
let failures = 0
const out = (step: string, data: Record<string, unknown>, ok: boolean | null = null): void => {
  if (ok === false) failures += 1
  console.log(JSON.stringify({ step, ...(ok === null ? {} : { ok }), ...data }))
}

function herdr(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock!)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout ${method}`))
    }, 45_000)
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l582r3', method, params }) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message: unknown = JSON.parse(buffer.slice(0, index))
      if (!isRecord(message)) return reject(new Error('bad reply'))
      if (isRecord(message.error)) return reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      resolve(isRecord(message.result) ? message.result : {})
    })
  })
}

const terminal = new TerminalBackend(sock)
const live = new HerdrInputBackend(sock)

async function launch(kind: MobileAgentKind): Promise<TerminalIdentity> {
  const created = await herdr('workspace.create', { cwd, focus: false })
  const root = isRecord(created.root_pane) ? created.root_pane : {}
  const paneId = String(root.pane_id)
  await delay(1600)
  const args = kind === 'claude' ? ['--model', 'haiku', '--effort', 'low'] : kind === 'codex' ? ['-c', 'check_for_update_on_startup=false', '-c', 'model_reasoning_effort="low"'] : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      await herdr('agent.start', { name: `l582r3w-${kind}`, kind, pane_id: paneId, args, timeout_ms: 30_000 })
      break
    } catch (error) {
      // 셸 rc 가 아직 도는 중이면 agent_pane_busy — 한 번 더(실패 회차는 출력에 남긴다).
      out('agent-start-retry', { attempt, error: String(error) })
      if (attempt >= 2) throw error
      await delay(2000)
    }
  }
  const epoch = await terminal.epoch(ctx())
  const pane = (await terminal.list(epoch, ctx())).find((entry) => entry.paneId === paneId)
  if (pane === undefined) throw new Error('pane missing')
  let trusted = false
  for (let index = 0; index < 120; index += 1) {
    const info = await terminal.agentInfo(pane, ctx())
    const screen = await terminal.screenAnsi(pane, ctx())
    const plain = screenPlain(screen)
    if (!trusted && kind === 'claude' && plain.includes('Yes, I trust this folder')) {
      // 커서가 「Yes」 행이 아니면 한 칸 내린 뒤 Enter(r2 q07·q08 과 같은 순서).
      if (!/❯\s*\d+\.\s*Yes, I trust this folder/.test(plain)) {
        await terminal.send(pane, '\x1b[B', ctx())
        await delay(350)
      }
      await terminal.send(pane, '\r', ctx())
      trusted = true
    } else if (!trusted && kind === 'codex' && /Trust this folder\?|trust the contents of this directory|Do you trust/i.test(plain)) {
      await terminal.send(pane, '\r', ctx())
      trusted = true
    } else if (info.interactiveReady && ['idle', 'done'].includes(info.status) && draftState({ kind, screen }) === 'empty') {
      out('launched', { kind, pane: paneId, trusted, processes: (await terminal.process(pane, ctx())).foreground.map((entry) => entry.name) })
      return pane
    }
    await delay(400)
  }
  throw new Error('agent not ready')
}

async function sessionOf(pane: TerminalIdentity): Promise<string> {
  for (let index = 0; index < 40; index += 1) {
    const info = await terminal.agentInfo(pane, ctx())
    const value = info.session?.value
    if (typeof value === 'string' && value.length > 0) return value
    await delay(500)
  }
  throw new Error('no session id')
}

function recordFile(kind: MobileAgentKind, sid: string): string | null {
  if (kind === 'claude') return sessionRecordPaths('claude', { cwd, sessionId: sid, t0Ms: 0, nowMs: 0 })[0] ?? null
  const found = resolveTranscriptUnique({ kind: 'id', agent: kind, source: 'herdr', id: sid })
  // 제품과 같은 파일 — Grok 은 찾은 `chat_history.jsonl` 의 형제 `updates.jsonl`(`chatFileOf`, service.ts).
  return found.kind === 'found' ? chatFileOf({ agent: kind, transcript: found.file }) : null
}

function readItems(input: { kind: MobileAgentKind; file: string; sid: string }): ChatItem[] {
  const builder = new ChatBuilder({ agent: input.kind, sessionId: input.kind === 'claude' ? input.sid : null })
  let offset = 0
  for (const line of fs.readFileSync(input.file, 'utf8').split('\n')) {
    builder.feed({ offset, line })
    offset += Buffer.byteLength(line) + 1
  }
  return builder.items
}

/** 허브 하나 — 채널 `c1`(claude)·`c2`(codex)·`c3`(grok) 의 세션 id 를 이 pane 의 실제 세션으로, 백엔드 위치는 이 pane 으로. */
function hubFor(input: { kind: MobileAgentKind; pane: TerminalIdentity; sid: string; file: string | null; backend?: Partial<InputBackend> }) {
  const state = chatListState()
  const channel = input.kind === 'claude' ? 'c1' : input.kind === 'codex' ? 'c2' : 'c3'
  for (const pane of state.repos[0]!.worktrees[0]!.workspace!.tabs.flatMap((tab) => tab.panes)) {
    if (pane.paneId === channel && pane.agentSession !== null && pane.agentSession.kind === 'id') pane.agentSession = { ...pane.agentSession, id: input.sid }
  }
  const backend: InputBackend = {
    locate: async () => input.pane,
    observe: (pane) => live.observe(pane),
    unmanagedPrompt: () => live.unmanagedPrompt(),
    manifestVerified: (kind) => live.manifestVerified(kind),
    screen: (pane) => live.screen(pane),
    prompt: (pane, value) => live.prompt(pane, value),
    send: (pane, value) => live.send(pane, value),
    ...input.backend,
  }
  const wires: InputWire[] = []
  const file = input.file
  const hub = new InputHub({
    read: () => ({ state, prefs: null }),
    backend: () => backend,
    resolveFile: () => (file === null ? { kind: 'none' } : { kind: 'found', file }),
    questionItems: () => (file === null ? null : readItems({ kind: input.kind, file, sid: input.sid })),
    log: () => {},
    timing: { stopConfirmMs: 4000, recordPollMs: 100, answerConfirmMs: 15_000 },
  })
  hub.attach({ device: 'd1', sink: (text) => wires.push(JSON.parse(text)) })
  const settled = async (id: string): Promise<InputWire | null> => {
    for (let index = 0; index < 400; index += 1) {
      const last = wires.filter((wire) => wire.id === id).at(-1)
      if (last !== undefined && !['queued', 'sending'].includes(last.state)) return last
      await delay(100)
    }
    return null
  }
  return { hub, channel, settled }
}

async function waitIdle(pane: TerminalIdentity): Promise<number> {
  for (let index = 0; index < 240; index += 1) {
    const info = await terminal.agentInfo(pane, ctx())
    if (info.interactiveReady && ['idle', 'done'].includes(info.status)) return info.stateChangeSeq
    await delay(500)
  }
  throw new Error('not idle')
}

async function waitQuestion(input: { kind: MobileAgentKind; pane: TerminalIdentity; collapsedOk?: boolean }): Promise<string> {
  for (let index = 0; index < 160; index += 1) {
    const text = (await terminal.screenRead(input.pane, ctx())).text
    const active = activeQuestion({ kind: input.kind, screen: text })
    if (active.kind === 'question' || (input.collapsedOk === true && active.kind === 'collapsed')) return text
    await delay(500)
  }
  throw new Error('question not shown')
}

const pendingOf = (items: ChatItem[]): Extract<ChatItem, { kind: 'question' }> | null => {
  let last: Extract<ChatItem, { kind: 'question' }> | null = null
  for (const item of items) if (item.kind === 'question' && item.state === 'pending') last = item
  return last
}
const questionOf = (items: ChatItem[], call: string | null): Extract<ChatItem, { kind: 'question' }> | null => {
  for (const item of items) if (item.kind === 'question' && item.call === call) return item
  return null
}

// --- Claude --------------------------------------------------------------------------------------------

type ClaudeCase = { name: string; prompt: string; precheck: string[]; answers: { choices: number[]; other: string | null }[]; expect: string[] }

const CLAUDE_CASES: ClaudeCase[] = [
  {
    name: 'R3-A1-precheck',
    prompt: 'Call AskUserQuestion once: one question "Pick letters", multiSelect true, options Alpha, Beta, Gamma with short descriptions. No other tools. After I answer say OK.',
    precheck: ['1'],
    answers: [{ choices: [0, 1], other: null }],
    expect: ['Alpha', 'Beta'],
  },
  {
    name: 'R3-A1-empty-control',
    prompt: 'Call AskUserQuestion once: one question "Pick letters", multiSelect true, options Alpha, Beta, Gamma with short descriptions. No other tools. After I answer say OK.',
    precheck: [],
    answers: [{ choices: [0, 1], other: null }],
    expect: ['Alpha', 'Beta'],
  },
  {
    name: 'reg-single',
    prompt: 'Call AskUserQuestion once: one question "Pick a color", single select, options Red, Green, Blue with short descriptions. No other tools. After I answer say OK.',
    precheck: [],
    answers: [{ choices: [1], other: null }],
    expect: ['Green'],
  },
  {
    name: 'reg-multi',
    prompt: 'Call AskUserQuestion once: one question "Pick fruits", multiSelect true, options Apple, Banana, Cherry with short descriptions. No other tools. After I answer say OK.',
    precheck: [],
    answers: [{ choices: [0, 2], other: null }],
    expect: ['Apple', 'Cherry'],
  },
  {
    name: 'reg-multi-question',
    prompt: 'Call AskUserQuestion once with TWO questions: "Pick pet" (single select: Cat, Dog) and "Pick city" (single select: Seoul, Busan), short descriptions. No other tools. After I answer say OK.',
    precheck: [],
    answers: [{ choices: [1], other: null }, { choices: [0], other: null }],
    expect: ['Dog', 'Seoul'],
  },
  {
    name: 'reg-direct-input',
    prompt: 'Call AskUserQuestion once: one question "Pick a drink", single select, options Tea, Coffee with short descriptions. No other tools. After I answer say OK.',
    precheck: [],
    answers: [{ choices: [], other: 'milk' }],
    expect: ['milk'],
  },
]

async function runClaude(): Promise<void> {
  const pane = await launch('claude')
  try {
    let seq = await waitIdle(pane)
    let sid: string | null = null
    for (const item of CLAUDE_CASES) {
      await terminal.promptAgent(pane, item.prompt, seq, ctx())
      const initial = await waitQuestion({ kind: 'claude', pane })
      sid ??= await sessionOf(pane)
      const file = recordFile('claude', sid)
      if (file === null || !fs.existsSync(file)) throw new Error('claude record missing')
      // 판독자가 그 질문을 읽을 때까지.
      let pending: Extract<ChatItem, { kind: 'question' }> | null = null
      for (let index = 0; index < 40 && pending === null; index += 1) {
        pending = pendingOf(readItems({ kind: 'claude', file, sid }))
        if (pending === null) await delay(250)
      }
      if (pending === null) throw new Error('pending question not in record')
      // 맥에서 먼저 고름 — 사람 키와 같은 PTY 입력 경로.
      for (const key of item.precheck) {
        await terminal.send(pane, key, ctx())
        await delay(500)
      }
      const before = await terminal.screenRead(pane, ctx())
      const beforeActive = activeQuestion({ kind: 'claude', screen: before.text })
      const { hub, channel, settled } = hubFor({ kind: 'claude', pane, sid, file })
      const id = `r3-${item.name}`
      hub.answer({ device: 'd1', id, channel, question: pending.id, call: pending.call, digest: questionDigest(pending.questions), answers: item.answers })
      const state = await settled(id)
      hub.stop()
      await delay(800)
      const after = questionOf(readItems({ kind: 'claude', file, sid }), pending.call)
      const recorded = after?.answer ?? ''
      const has = item.expect.map((label) => recorded.includes(label))
      const extra = ['Alpha', 'Beta', 'Gamma', 'Red', 'Green', 'Blue', 'Apple', 'Banana', 'Cherry', 'Cat', 'Dog', 'Seoul', 'Busan', 'Tea', 'Coffee', 'milk'].filter((label) => !item.expect.includes(label) && recorded.includes(label))
      const ok = state?.state === 'delivered' && has.every(Boolean) && extra.length === 0
      out(item.name, {
        state,
        precheck: item.precheck,
        beforeChecks: beforeActive.kind === 'question' ? beforeActive.rows.map((row) => row.checked) : null,
        initialKind: activeQuestion({ kind: 'claude', screen: initial }).kind,
        recordExpectHits: has,
        recordExtra: extra,
        questionState: after?.state ?? null,
      }, ok)
      seq = await waitIdle(pane)
    }
    if (sid !== null) out('record', { file: recordFile('claude', sid)?.replace(/^\/Users\/[^/]+/, '~') ?? null })
  } finally {
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

// --- Codex ---------------------------------------------------------------------------------------------

async function runCodex(): Promise<void> {
  const pane = await launch('codex')
  try {
    const seq = await waitIdle(pane)
    await terminal.promptAgent(pane, 'Use request_user_input_async now to ask THREE questions in a SINGLE call: Pick color (Red, Blue); Pick drink (Tea, Coffee); Pick size (Small, Large). Each option one word with a short description. No other tools. Wait for all answers, then reply OK.', seq, ctx())
    const shown = await waitQuestion({ kind: 'codex', pane, collapsedOk: true })
    out('codex-question-shown', { active: activeQuestion({ kind: 'codex', screen: shown }) })
    const sid = await sessionOf(pane)
    let file: string | null = null
    let pending: Extract<ChatItem, { kind: 'question' }> | null = null
    for (let index = 0; index < 60 && pending === null; index += 1) {
      file = recordFile('codex', sid)
      pending = file === null ? null : pendingOf(readItems({ kind: 'codex', file, sid }))
      if (pending === null) await delay(500)
    }
    if (file === null || pending === null) throw new Error('codex pending question missing')
    out('codex-pending', { questions: pending.questions.length, titles: pending.questions.map((q) => q.question.length) })
    const screens: unknown[] = []
    const { hub, channel, settled } = hubFor({
      kind: 'codex', pane, sid, file,
      backend: {
        screen: async (target) => {
          const shot = await live.screen(target)
          const active = activeQuestion({ kind: 'codex', screen: shot.text })
          screens.push(active.kind === 'question' ? { kind: active.kind, position: active.position, total: active.total, title: active.title.length } : active)
          return shot
        },
      },
    })
    const id = 'r3-A3-codex-3q'
    hub.answer({ device: 'd1', id, channel, question: pending.id, call: pending.call, digest: questionDigest(pending.questions), answers: [{ choices: [0], other: null }, { choices: [1], other: null }, { choices: [0], other: null }] })
    const state = await settled(id)
    hub.stop()
    const after = questionOf(readItems({ kind: 'codex', file, sid }), pending.call)
    const ok = state?.state === 'delivered' && after?.state === 'answered'
    out('R3-A3-codex-3q', { state, screens, questionState: after?.state ?? null, answer: after?.answer ?? null }, ok)
    out('record', { file: file.replace(/^\/Users\/[^/]+/, '~') })
    await waitIdle(pane).catch(() => 0)
  } finally {
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

// --- Grok ----------------------------------------------------------------------------------------------

async function runGrok(): Promise<void> {
  const pane = await launch('grok')
  try {
    // Grok 선택 답 1(r4 회귀 확인) — 하나 고름 질문에 폰 답 → delivered + 기록 답 값.
    {
      const seq = await waitIdle(pane)
      await terminal.promptAgent(pane, 'Call ask_user_question once: one question "Pick a color", single select, options Red, Green, Blue with short descriptions. No other tools. After I answer say OK.', seq, ctx())
      await waitQuestion({ kind: 'grok', pane })
      const sidNow = await sessionOf(pane)
      const file = recordFile('grok', sidNow)
      let pending: Extract<ChatItem, { kind: 'question' }> | null = null
      for (let index = 0; index < 40 && pending === null; index += 1) {
        pending = file === null ? null : pendingOf(readItems({ kind: 'grok', file, sid: sidNow }))
        if (pending === null) await delay(250)
      }
      if (file === null || pending === null) throw new Error('grok pending question missing')
      const { hub, channel, settled } = hubFor({ kind: 'grok', pane, sid: sidNow, file })
      hub.answer({ device: 'd1', id: 'r4-grok-select', channel, question: pending.id, call: pending.call, digest: questionDigest(pending.questions), answers: [{ choices: [1], other: null }] })
      const state = await settled('r4-grok-select')
      hub.stop()
      out('r4-grok-select', { state }, state?.state === 'delivered')
      out('record', { file: file.replace(/^\/Users\/[^/]+/, '~') })
    }
    const sid = await sessionOf(pane).catch(() => 'unknown')
    for (const race of [true, false]) {
      const seq = await waitIdle(pane)
      await terminal.promptAgent(pane, 'Run the shell command sleep 20, wait for it, then reply OK. No other work.', seq, ctx())
      let working = false
      for (let index = 0; index < 80; index += 1) {
        const info = await terminal.agentInfo(pane, ctx())
        if (info.status === 'working' && draftState({ kind: 'grok', screen: await terminal.screenAnsi(pane, ctx()) }) === 'empty') {
          working = true
          break
        }
        await delay(250)
      }
      if (!working) throw new Error('grok not working')
      await delay(1500)
      // 허브가 부른 키 넣기와 guard 결과(sent = PTY 에 씀 · refused = 아무것도 안 씀). 「부름」 은 「씀」 이 아니다(n03 판정 오류 뒤 고침).
      const keys: { code: number; inputRevision: number | null; result: string }[] = []
      let interleaved: Record<string, unknown> | null = null
      const { hub, channel, settled } = hubFor({
        kind: 'grok', pane, sid, file: null,
        backend: {
          screen: async (target) => {
            const shot = await live.screen(target)
            if (race && interleaved === null) {
              // 화면을 잡은 직후 맥 타자(사람 키와 같은 PTY 입력 경로).
              await terminal.send(target, 'desktopdraft', ctx())
              await delay(400)
              const seen = await live.screen(target)
              interleaved = { before: shot.input?.revision ?? null, after: seen.input?.revision ?? null, seqBefore: shot.seq, seqAfter: seen.seq }
            }
            return shot
          },
          send: async (target, value) => {
            const result = await live.send(target, value)
            keys.push({ code: value.text.charCodeAt(0), inputRevision: value.inputRevision, result: result.kind })
            return result
          },
        },
      })
      const id = race ? 'r3-A6-grok-race' : 'r3-A6-grok-control'
      hub.stopTurn({ device: 'd1', id, channel })
      const state = await settled(id)
      hub.stop()
      const after = await live.screen(pane)
      const remains = after.text.includes('desktopdraft')
      const written = keys.filter((key) => key.result !== 'refused').length
      // 경합 없는 양성은 `stopped` + 세션(grok 프로세스) 생존만 통과 — `unconfirmed`/`still_running` 은 실패(R4-A4).
      const alive = (await terminal.process(pane, ctx())).foreground.some((entry) => String(entry.name).startsWith('grok'))
      const ok = race ? state?.state === 'failed' && written === 0 && remains : state?.state === 'stopped' && written === 1 && keys[0]!.inputRevision !== null && alive
      out(id, { state, keys, written, interleaved, alive, desktopTextRemains: remains, draftAfter: draftState({ kind: 'grok', screen: after.text }) }, ok)
      if (race) {
        // 이 시험이 넣은 초안을 지우고(Ctrl-U) 턴이 끝나길 기다린다.
        await terminal.send(pane, '\u0015', ctx())
        await delay(500)
      }
      await waitIdle(pane).catch(() => 0)
    }
  } finally {
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

// --- 좁은 pane (r4 R4-A2) ----------------------------------------------------------------------------

const LONG_QUESTION = (tool: string): string =>
  `Call ${tool} once now. One single-select question titled "Choose deployment". Use exactly these option labels: "Deploy the service to the staging environment after running all integration checks" and "Keep the current release running until the maintenance window tomorrow morning". Short descriptions. No other tools. Wait for my answer, then say OK.`
// (r5) 좁은 폭에서도 행이 잘리지 않는 중간 길이 — Grok 80열에서 안 잘림, Claude 60열에서 선택지 글이 꺾임.
const MID_QUESTION = (tool: string): string =>
  `Call ${tool} once now. One single-select question titled "Choose deployment". Use exactly these option labels: "Deploy to staging after all integration checks pass" and "Keep current release". Descriptions exactly: "Then deploy." and "Wait.". No other tools. Wait for my answer, then say OK.`

/** 격리 herdr 의 화면 크기를 정하는 클라이언트(이 시험만 붙는다) — pane 크기는 이 클라이언트 크기를 따른다. */
async function sizer(pane: TerminalIdentity): Promise<EndpointClient> {
  const client = new EndpointClient(sock!.replace('herdr.sock', 'herdr-client.sock'))
  client.on('error', (error) => out('endpoint-error', { error: String(error) }))
  await client.connect(150, 45)
  await client.callEndpoint('pane.focus', { pane_id: pane.paneId })
  await delay(800)
  return client
}

async function askLong(input: { kind: MobileAgentKind; pane: TerminalIdentity; mid?: boolean }): Promise<{ sid: string; file: string; pending: Extract<ChatItem, { kind: 'question' }> }> {
  const seq = await waitIdle(input.pane)
  await terminal.promptAgent(input.pane, (input.mid === true ? MID_QUESTION : LONG_QUESTION)(input.kind === 'claude' ? 'AskUserQuestion' : 'ask_user_question'), seq, ctx())
  await waitQuestion({ kind: input.kind, pane: input.pane }).catch(() => '')
  const sid = await sessionOf(input.pane)
  let file: string | null = null
  let pending: Extract<ChatItem, { kind: 'question' }> | null = null
  for (let index = 0; index < 80 && pending === null; index += 1) {
    file = recordFile(input.kind, sid)
    pending = file !== null && fs.existsSync(file) ? pendingOf(readItems({ kind: input.kind, file, sid })) : null
    if (pending === null) await delay(300)
  }
  if (file === null || pending === null) {
    const shot = await terminal.screenRead(input.pane, ctx())
    out('long-missing', { file: file?.replace(/^\/Users\/[^/]+/, '~') ?? null, exists: file !== null && fs.existsSync(file), active: activeQuestion({ kind: input.kind, screen: shot.text }).kind, items: file !== null && fs.existsSync(file) ? readItems({ kind: input.kind, file, sid }).map((item) => item.kind) : null })
    throw new Error('long question not in record')
  }
  return { sid, file, pending }
}

async function answerLong(input: { kind: MobileAgentKind; pane: TerminalIdentity; sid: string; file: string; pending: Extract<ChatItem, { kind: 'question' }>; id: string }): Promise<boolean> {
  const { hub, channel, settled } = hubFor({ kind: input.kind, pane: input.pane, sid: input.sid, file: input.file })
  hub.answer({ device: 'd1', id: input.id, channel, question: input.pending.id, call: input.pending.call, digest: questionDigest(input.pending.questions), answers: [{ choices: [0], other: null }] })
  const state = await settled(input.id)
  hub.stop()
  await delay(800)
  const after = questionOf(readItems({ kind: input.kind, file: input.file, sid: input.sid }), input.pending.call)
  // 기록의 그 문항 답 값(판독자 `answer` 칸은 Grok 메시지 모양을 읽지 않는다 — c04 판정식 오류 뒤 고침).
  const values = recordedAnswers({ kind: input.kind, text: fs.readFileSync(input.file, 'utf8'), call: input.pending.call ?? '', questions: input.pending.questions.map((q) => q.question) })
  const recorded = values.kind === 'ok' ? (values.values[0] ?? '') : ''
  const [chosen, other] = input.pending.questions[0]!.options.map((option) => option.label)
  const ok = state?.state === 'delivered' && chosen !== undefined && other !== undefined && recorded.includes(chosen) && !recorded.includes(other)
  out(input.id, { state, recordHasChosen: chosen !== undefined && recorded.includes(chosen), recordHasOther: other !== undefined && recorded.includes(other), questionState: after?.state ?? null }, ok)
  return ok
}

async function runCapture(kind: MobileAgentKind, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  const pane = await launch(kind)
  let client: EndpointClient | null = null
  try {
    client = await sizer(pane)
    const asked = await askLong({ kind, pane })
    fs.writeFileSync(path.join(dir, `${kind}-question.json`), `${JSON.stringify(asked.pending.questions, null, 1)}\n`)
    const sizes: { cols: number; rows: number }[] = [{ cols: 150, rows: 45 }, { cols: 100, rows: 35 }, { cols: 80, rows: 35 }, { cols: 60, rows: 35 }, { cols: 40, rows: 35 }]
    for (const { cols, rows } of sizes) {
      client.resize(cols, rows)
      await delay(1200)
      const shot = await terminal.screenRead(pane, ctx())
      fs.writeFileSync(path.join(dir, `${kind}-${cols}.txt`), shot.text)
      out('capture', { kind, cols, rows, active: activeQuestion({ kind, screen: shot.text }).kind })
    }
    client.resize(150, 45)
    await delay(1200)
    await answerLong({ kind, pane, ...asked, id: `r4-capture-${kind}-150` })
    out('record', { file: asked.file.replace(/^\/Users\/[^/]+/, '~') })
  } finally {
    client?.close()
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

async function runWidth(input: { kind: MobileAgentKind; widths: number[]; mid: boolean }): Promise<void> {
  const { kind, widths, mid } = input
  const pane = await launch(kind)
  let client: EndpointClient | null = null
  try {
    client = await sizer(pane)
    let file: string | null = null
    for (const cols of widths) {
      client.resize(cols, cols >= 150 ? 45 : 35)
      await delay(1200)
      const asked = await askLong({ kind, pane, mid })
      file = asked.file
      const shot = await terminal.screenRead(pane, ctx())
      out('width-screen', { kind, cols, mid, active: activeQuestion({ kind, screen: shot.text }).kind })
      await answerLong({ kind, pane, ...asked, id: `${mid ? 'r5-mid' : 'r4-width'}-${kind}-${cols}` })
    }
    if (file !== null) out('record', { file: file.replace(/^\/Users\/[^/]+/, '~') })
  } finally {
    client?.close()
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

/**
 * (r4 R4-A3) Codex 접힌 질문 + 맥 입력창 초안(짧은 것 · 여러 줄로 감기는 긴 것)을 150·80열에서 떠 <out dir>/codex-collapsed-*.txt 로 저장 — 접힌 표시 아래 허용 줄의 실측 재료.
 * 끝에 초안을 지우고(Ctrl-U) 허브로 답한다(질문 정리).
 */
async function runCodexCapture(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  const pane = await launch('codex')
  let client: EndpointClient | null = null
  try {
    client = await sizer(pane)
    const seq = await waitIdle(pane)
    await terminal.promptAgent(pane, 'Use request_user_input_async now to ask ONE question: Pick color (Red, Blue), each option one word with a short description. No other tools. Wait for the answer, then reply OK.', seq, ctx())
    await waitQuestion({ kind: 'codex', pane, collapsedOk: true })
    const drafts: { name: string; text: string }[] = [
      { name: 'empty', text: '' },
      { name: 'short', text: 'r4 short draft' },
      { name: 'long', text: 'r4 long draft that keeps going so the composer has to wrap onto more than one physical line in a narrow pane for the collapsed question check' },
    ]
    for (const draft of drafts) {
      if (draft.text.length > 0) {
        await terminal.send(pane, '\u0015', ctx())
        await delay(300)
        await terminal.send(pane, draft.text, ctx())
        await delay(800)
      }
      for (const cols of [150, 80]) {
        client.resize(cols, cols >= 150 ? 45 : 35)
        await delay(1200)
        const shot = await terminal.screenRead(pane, ctx())
        fs.writeFileSync(path.join(dir, `codex-collapsed-${draft.name}-${cols}.txt`), shot.text)
        out('capture', { kind: 'codex', draft: draft.name, cols, active: activeQuestion({ kind: 'codex', screen: shot.text }) })
      }
    }
    await terminal.send(pane, '\u0015', ctx())
    await delay(500)
    client.resize(150, 45)
    await delay(1200)
    const sid = await sessionOf(pane)
    const file = recordFile('codex', sid)
    const pending = file === null ? null : pendingOf(readItems({ kind: 'codex', file, sid }))
    if (file === null || pending === null) throw new Error('codex pending missing')
    const { hub, channel, settled } = hubFor({ kind: 'codex', pane, sid, file })
    hub.answer({ device: 'd1', id: 'r4-codex-capture', channel, question: pending.id, call: pending.call, digest: questionDigest(pending.questions), answers: [{ choices: [0], other: null }] })
    const state = await settled('r4-codex-capture')
    hub.stop()
    out('r4-codex-capture', { state }, state?.state === 'delivered')
    out('record', { file: file.replace(/^\/Users\/[^/]+/, '~') })
  } finally {
    client?.close()
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

/** (r5 R5-A1) 긴 선택지를 좁은 폭에서 — 뒤 행이 `…` 로 잘려 키 0회 failed/question_truncated. 150열로 되돌려 같은 질문에 답한다(대조 · 질문 정리). */
async function runTruncated(input: { kind: MobileAgentKind; cols: number }): Promise<void> {
  const { kind, cols } = input
  const pane = await launch(kind)
  let client: EndpointClient | null = null
  try {
    client = await sizer(pane)
    client.resize(cols, 35)
    await delay(1200)
    const asked = await askLong({ kind, pane })
    const shot = await terminal.screenRead(pane, ctx())
    const sent: string[] = []
    const { hub, channel, settled } = hubFor({
      kind, pane, sid: asked.sid, file: asked.file,
      backend: {
        send: async (target, value) => {
          sent.push(value.text)
          return live.send(target, value)
        },
      },
    })
    const id = `r5-truncated-${kind}-${cols}`
    hub.answer({ device: 'd1', id, channel, question: asked.pending.id, call: asked.pending.call, digest: questionDigest(asked.pending.questions), answers: [{ choices: [0], other: null }] })
    const state = await settled(id)
    hub.stop()
    await delay(800)
    const still = questionOf(readItems({ kind, file: asked.file, sid: asked.sid }), asked.pending.call)
    out(id, { state, active: activeQuestion({ kind, screen: shot.text }).kind, keys: sent.length, questionState: still?.state ?? null }, state?.state === 'failed' && state.reason === 'question_truncated' && sent.length === 0 && still?.state === 'pending')
    client.resize(150, 45)
    await delay(1200)
    await answerLong({ kind, pane, ...asked, id: `r5-truncated-${kind}-control-150` })
    out('record', { file: asked.file.replace(/^\/Users\/[^/]+/, '~') })
  } finally {
    client?.close()
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

// --- 답 값 형식 (r5 R5-A2 Claude · R5-A3 Grok) --------------------------------------------------------------

type ValueCase = { name: string; prompt: string; labels: string[]; multi: boolean; answers: { choices: number[]; other: string | null } }

const COLOR_PROMPT = (multi: boolean, labels: string[]): string =>
  `Call AskUserQuestion once now. One question titled "Pick colors", ${multi ? 'multiSelect true' : 'single select'}. The option labels are exactly the strings of this JSON array, in order, with no added characters: ${JSON.stringify(labels)}. Short descriptions. No other tools. Wait for my answer, then say OK.`
const COLORS = ['Red', 'Blue', 'Red, Blue', 'Say "hi"']
const CLAUDE_VALUES: ValueCase[] = [
  { name: 'r5-claude-comma', prompt: COLOR_PROMPT(true, COLORS), labels: COLORS, multi: true, answers: { choices: [2], other: null } },
  { name: 'r5-claude-comma-plus', prompt: COLOR_PROMPT(true, COLORS), labels: COLORS, multi: true, answers: { choices: [0, 2], other: null } },
  { name: 'r5-claude-quote', prompt: COLOR_PROMPT(true, COLORS), labels: COLORS, multi: true, answers: { choices: [3], other: null } },
  { name: 'r5-claude-pair', prompt: COLOR_PROMPT(true, COLORS), labels: COLORS, multi: true, answers: { choices: [0, 1], other: null } },
  { name: 'r5-claude-multi-other', prompt: COLOR_PROMPT(true, COLORS), labels: COLORS, multi: true, answers: { choices: [0], other: 'ok, "fine"' } },
  { name: 'r5-claude-single-comma', prompt: COLOR_PROMPT(false, ['Red, Blue', 'Plain']), labels: ['Red, Blue', 'Plain'], multi: false, answers: { choices: [0], other: null } },
]
const GROK_OTHERS = ['hello', 'say "hello"', 'hello,']

async function answerCase(input: { kind: MobileAgentKind; pane: TerminalIdentity; item: ValueCase }): Promise<void> {
  const { kind, pane, item } = input
  const seq = await waitIdle(pane)
  await terminal.promptAgent(pane, item.prompt, seq, ctx())
  await waitQuestion({ kind, pane })
  const sid = await sessionOf(pane)
  let file: string | null = null
  let pending: Extract<ChatItem, { kind: 'question' }> | null = null
  for (let index = 0; index < 80 && pending === null; index += 1) {
    file = recordFile(kind, sid)
    pending = file !== null && fs.existsSync(file) ? pendingOf(readItems({ kind, file, sid })) : null
    if (pending === null) await delay(300)
  }
  if (file === null || pending === null) throw new Error(`${item.name}: pending question missing`)
  const labels = pending.questions[0]!.options.map((option) => option.label)
  const exact = JSON.stringify(labels) === JSON.stringify(item.labels) && (pending.questions[0]!.multiSelect === true) === item.multi
  const { hub, channel, settled } = hubFor({ kind, pane, sid, file })
  hub.answer({ device: 'd1', id: item.name, channel, question: pending.id, call: pending.call, digest: questionDigest(pending.questions), answers: [item.answers] })
  const state = await settled(item.name)
  hub.stop()
  await delay(800)
  const after = questionOf(readItems({ kind, file, sid }), pending.call)
  const values = recordedAnswers({ kind, text: fs.readFileSync(file, 'utf8'), call: pending.call ?? '', questions: pending.questions.map((q) => q.question) })
  // 기록 값은 시험이 정한 라벨·짧은 글뿐(G5).
  out(item.name, { state, labelsExact: exact, labels, choices: item.answers.choices, other: item.answers.other, recorded: values.kind === 'ok' ? values.values : null, questionState: after?.state ?? null }, exact && state?.state === 'delivered' && after?.state === 'answered')
  out('record', { file: file.replace(/^\/Users\/[^/]+/, '~') })
}

async function runValues(): Promise<void> {
  const pane = await launch('claude')
  try {
    for (const item of CLAUDE_VALUES) await answerCase({ kind: 'claude', pane, item })
  } finally {
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

async function runOther(): Promise<void> {
  const pane = await launch('grok')
  try {
    for (const [index, other] of GROK_OTHERS.entries()) {
      const item: ValueCase = {
        name: `r5-grok-other-${index}`,
        prompt: 'Call ask_user_question once: one question "Pick a word", single select, options Yes, No with short descriptions. No other tools. After I answer say OK.',
        labels: ['Yes', 'No'],
        multi: false,
        answers: { choices: [], other },
      }
      await answerCase({ kind: 'grok', pane, item })
    }
  } finally {
    await terminal.close(pane, ctx()).catch(() => {})
  }
}

const kindArg = (value: string | undefined): MobileAgentKind => {
  if (value === 'claude' || value === 'grok') return value
  throw new Error('capture/width kind: claude|grok')
}

try {
  if (command === 'capture' && process.argv[5] === 'codex') await runCodexCapture(process.argv[6] ?? '')
  else if (command === 'capture') await runCapture(kindArg(process.argv[5]), process.argv[6] ?? '')
  else if (command === 'width') await runWidth({ kind: kindArg(process.argv[5]), widths: process.argv.slice(6).map(Number), mid: false })
  else if (command === 'width-mid') await runWidth({ kind: kindArg(process.argv[5]), widths: process.argv.slice(6).map(Number), mid: true })
  else if (command === 'truncated') await runTruncated({ kind: kindArg(process.argv[5]), cols: Number(process.argv[6]) })
  else if (command === 'values') await runValues()
  else if (command === 'other') await runOther()
  else if (command === 'claude') await runClaude()
  else if (command === 'codex') await runCodex()
  else if (command === 'grok') await runGrok()
  else throw new Error(`unknown command ${command}`)
} catch (error) {
  out('error', { error: String(error) }, false)
}
process.exit(failures === 0 ? 0 : 1)
