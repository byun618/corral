// LIFE-598 — l597/final.ts 의 사본(경로 접두사 /tmp/l598-* · herdr 세션 l577g-l598-z*). 바뀐 것: `setup --plan c0`(cs·cm 두 pane 만) ·
// `u3c` 가 herdr `agent_session` 바뀐 시각·허브가 넣기 시작한 시각(sending 수신)·옛/새 세션 기록별 표지 수를 남기고 `--expect repro|fixed` 로 판정을 고른다.
// 원래 설명: LIFE-597 최종 관문 — 격리 회차 묶음. 격리 개발 Electron(`l598/g-up.sh` 가 /tmp/l598-z* 에 띄운 것)과
// 그 이름 herdr 세션에서 **이 시험이 만든 pane 만** 친다. 폰 자리 = 이 스크립트의 WS 클라이언트(`l598/q-setup.mjs mobile` 이 남긴 0600 토큰).
//   npx tsx scripts/l598/final.ts setup  --root /tmp/l598-z1                 → 격리 레포 · pane(셸에서 provider 직접 타자 = 관리 밖 · herdr agent.start = 관리) → <ROOT>/panes.json
//   npx tsx scripts/l598/final.ts <u1a|u1b|u1d|u2b|u2c|u2d|u3a|u3b|u3c|u3d|u4a|u5|u5r> --root <ROOT> --out <dir>   → 회차마다 ndjson 한 줄 · `ok`
// 기록 대조는 제품 코드를 쓰지 않는다 — provider 기록 줄을 직접 읽어 사람이 친 줄을 센다. 원자료에는 상태·이유·시각·바이트 수·표지·개수만(G5).
// 종료 0 = 그 항목 회차 전부 `ok` · 1 = 하나라도 아님 · 2 = 사용법.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { TerminalBackend, type TerminalIdentity } from '../../src/main/adapter/index.js'
import { cleanBody, draftState, screenPlain } from '../../src/main/mobile/keys.js'
import type { MobileAgentKind } from '../../src/main/mobile/list.js'
import { openLog } from '../../src/main/log.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? ''
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}
const ROOT = flag('root') ?? ''
const OUT = flag('out')
if (!/^\/tmp\/l598-z[^/]*$/.test(ROOT)) {
  console.error('--root 는 /tmp/l598-z*')
  process.exit(2)
}
const SESSION = `l577g-${path.basename(ROOT)}`
const SOCK = path.join(os.homedir(), '.config/herdr-dev/sessions', SESSION, 'herdr.sock')
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const CLI = path.join(APP, 'cli/corral.mjs')
const RPC = path.join(ROOT, 'ud/runtime/rpc.sock')
const PANES = path.join(ROOT, 'panes.json')
// 어댑터 진단 줄(req.*)은 stdout 대신 ROOT 아래 파일로(원자료를 회차 줄만으로).
openLog(path.join(ROOT, 'driver-log'))
const terminal = new TerminalBackend(SOCK)
const ctx = (ms = 10_000) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + ms })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const real = (p: string): string => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

let failures = 0
let outFile: string | null = null
function out(step: string, data: Record<string, unknown>, ok: boolean | null = null): void {
  if (ok === false) failures += 1
  const line = JSON.stringify({ step, at: new Date().toISOString(), ok, ...data })
  console.log(line)
  if (outFile !== null) fs.appendFileSync(outFile, `${line}\n`)
}

// --- herdr(격리 이름 세션만) ------------------------------------------------------------------------------

function herdr(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  if (!SOCK.includes('/herdr-dev/sessions/l577g-l598-z')) throw new Error('거부: 격리 세션이 아니다')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`herdr 시간 초과 ${method}`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'l597f', method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message: unknown = JSON.parse(buffer.slice(0, index))
      if (!isRecord(message)) return reject(new Error('herdr 응답 모양'))
      if (isRecord(message.error)) return reject(new Error(`${method}: ${String(message.error.code)} ${String(message.error.message)}`))
      resolve(isRecord(message.result) ? message.result : {})
    })
  })
}

async function paneList(): Promise<{ paneId: string; cwd: string }[]> {
  const result = await herdr('pane.list', {})
  const panes = Array.isArray(result.panes) ? result.panes : []
  return panes.flatMap((pane: unknown) => (isRecord(pane) && typeof pane.pane_id === 'string' && typeof pane.cwd === 'string' ? [{ paneId: pane.pane_id, cwd: pane.cwd }] : []))
}

/** 이 시험이 만든 pane 인가 — ROOT 아래 레포의 pane 만(그 밖이면 던진다). */
async function own(paneId: string): Promise<TerminalIdentity> {
  const pane = (await paneList()).find((entry) => entry.paneId === paneId)
  if (pane === undefined || !real(pane.cwd).startsWith(`${real(ROOT)}/`)) throw new Error(`거부: 이 시험이 만든 pane 이 아니다 (${paneId})`)
  const epoch = await terminal.epoch(ctx())
  const identity = (await terminal.list(epoch, ctx())).find((entry) => entry.paneId === paneId)
  if (identity === undefined) throw new Error(`pane 없음 ${paneId}`)
  return identity
}

// --- 격리 앱 제어(q-setup · 계측 소켓) ------------------------------------------------------------------------

function qsetup(args: string[]): Record<string, unknown> {
  const text = execFileSync(process.execPath, [path.join(APP, 'scripts/l598/q-setup.mjs'), ...args, '--root', ROOT], { cwd: APP, encoding: 'utf8' })
  const parsed: unknown = JSON.parse(text.trim().split('\n').at(-1) ?? '{}')
  return isRecord(parsed) ? parsed : {}
}

function ctlCall(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(ROOT, 'ctl/ctl.sock'))
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('ctl 시간 초과'))
    }, 20_000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.end()
      const parsed: unknown = JSON.parse(buffer.slice(0, index))
      resolve(isRecord(parsed) ? parsed : {})
    })
  })
}

async function serverPort(): Promise<number> {
  const result = await ctlCall({ cmd: 'mobile-status' })
  const mobile = isRecord(result.mobile) ? result.mobile : {}
  const port = num(mobile.serverPort)
  if (port === null) throw new Error('모바일 서버 포트 없음')
  return port
}

// --- 폰 자리 ---------------------------------------------------------------------------------------------

type Wire = { id: string; state: string; reason: string | null; wait: string | null; op: string | null; at: number; recvAt: number }
const FINAL = new Set(['delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped', 'unknown'])
type QuestionInfo = { id: number; call: string | null; digest: string | null; state: string; count: number }

class Phone {
  readonly states = new Map<string, Wire[]>()
  readonly questions = new Map<string, Map<number, QuestionInfo>>()
  readonly errors: string[] = []
  closed: { code: number; at: number } | null = null
  private constructor(private readonly ws: WebSocket) {}

  static async open(tokenFile = path.join(ROOT, 'sec/token')): Promise<Phone> {
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    const ws = new WebSocket(`ws://127.0.0.1:${await serverPort()}/ws`)
    const phone = new Phone(ws)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello 시간 초과')), 10_000)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token, client: { name: 'l598-final', version: '1' } })))
      ws.on('error', reject)
      ws.on('close', (code) => {
        phone.closed = { code, at: Date.now() }
      })
      ws.on('message', (data) => {
        const message: unknown = JSON.parse(data.toString())
        if (!isRecord(message)) return
        if (message.type === 'hello') {
          clearTimeout(timer)
          resolve()
        }
        phone.take(message)
      })
    })
    return phone
  }

  private take(message: Record<string, unknown>): void {
    if (message.type === 'error') this.errors.push(String(message.code))
    if (message.type === 'input.state') {
      const id = str(message.id) ?? ''
      const list = this.states.get(id) ?? []
      list.push({ id, state: str(message.state) ?? '', reason: str(message.reason), wait: str(message.wait), op: str(message.op), at: num(message.at) ?? 0, recvAt: Date.now() })
      this.states.set(id, list)
    }
    if ((message.type === 'chat.page' || message.type === 'chat.items') && Array.isArray(message.items)) {
      const channel = str(message.channel) ?? ''
      const map = this.questions.get(channel) ?? new Map<number, QuestionInfo>()
      for (const item of message.items) {
        if (!isRecord(item) || item.kind !== 'question') continue
        const id = num(item.id)
        if (id === null) continue
        map.set(id, { id, call: str(item.call), digest: str(item.digest), state: str(item.state) ?? '', count: Array.isArray(item.questions) ? item.questions.length : 0 })
      }
      this.questions.set(channel, map)
    }
  }

  send(body: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(body))
  }

  subscribe(channel: string): void {
    this.send({ type: 'chat.subscribe', channel })
  }

  async waitFor(id: string, done: (wire: Wire) => boolean, timeoutMs = 90_000): Promise<Wire | null> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const hit = (this.states.get(id) ?? []).find(done)
      if (hit !== undefined) return hit
      await delay(100)
    }
    return null
  }

  final(id: string, timeoutMs = 90_000): Promise<Wire | null> {
    return this.waitFor(id, (wire) => FINAL.has(wire.state), timeoutMs)
  }

  last(id: string): Wire | null {
    return this.states.get(id)?.at(-1) ?? null
  }

  async pendingQuestion(channel: string, after: Set<number>, timeoutMs = 90_000): Promise<QuestionInfo | null> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const open = [...(this.questions.get(channel)?.values() ?? [])].filter((item) => item.state === 'pending' && !after.has(item.id) && item.call !== null && item.digest !== null)
      if (open.length > 0) return open.at(-1) ?? null
      await delay(200)
    }
    return null
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve()
      this.ws.once('close', () => resolve())
      this.ws.close()
    })
  }

  terminate(): void {
    this.ws.terminate()
  }
}

let serial = 0
/** 실행마다 다른 표지 꼬리 — 같은 글을 다시 보내면 앞 실행의 기록까지 세어 2건이 된다(Z3ⓐ try2). */
const RUN = Date.now().toString(36)
const M = (marker: string): string => `${marker}-${RUN}`
const newId = (tag: string): string => `l598-${tag}-${Date.now().toString(36)}-${(serial += 1)}`

// --- 세션 목록 --------------------------------------------------------------------------------------------

/** managed = herdr `agent.start`(관리 결속) · shell = 셸에서 provider 를 직접 타자(관리 밖 — 이 작업의 대상). 'unmanaged' 는 582 판 이름(쓰지 않음). */
type Mode = 'managed' | 'unmanaged' | 'shell'
type PaneInfo = { name: string; kind: MobileAgentKind; mode: Mode; repo: string; paneId: string }

function panes(): PaneInfo[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(PANES, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('panes.json')
  return parsed.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return []
    const kind = entry.kind === 'claude' || entry.kind === 'codex' || entry.kind === 'grok' ? entry.kind : null
    const mode = entry.mode === 'managed' || entry.mode === 'unmanaged' || entry.mode === 'shell' ? entry.mode : null
    const name = str(entry.name)
    const repo = str(entry.repo)
    const paneId = str(entry.paneId)
    return kind !== null && mode !== null && name !== null && repo !== null && paneId !== null ? [{ name, kind, mode, repo, paneId }] : []
  })
}
const paneOf = (name: string): PaneInfo => {
  const found = panes().find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`pane ${name} 없음`)
  return found
}

// --- 데스크톱 쪽 관측·입력(이 시험이 만든 pane 만) ---------------------------------------------------------------

type Agent = { status: string; seq: number; ready: boolean; session: string | null; observedAt: string }
async function agentOf(paneId: string): Promise<Agent> {
  const pane = await own(paneId)
  const info = await terminal.agentInfo(pane, ctx())
  return { status: info.status, seq: info.stateChangeSeq, ready: info.interactiveReady, session: typeof info.session?.value === 'string' ? info.session.value : null, observedAt: new Date().toISOString() }
}
async function screen(paneId: string): Promise<string> {
  return terminal.screenAnsi(await own(paneId), ctx())
}
/** 데스크톱 사용자의 키(사람 키와 같은 PTY 입력 경로 `pane.send_text`) — 이 시험이 만든 pane 만. */
async function desktopKeys(paneId: string, text: string): Promise<void> {
  await terminal.send(await own(paneId), text, ctx())
}
async function waitStatus(paneId: string, wanted: (agent: Agent) => boolean, timeoutMs = 120_000): Promise<Agent | null> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const agent = await agentOf(paneId)
    if (wanted(agent)) return agent
    await delay(400)
  }
  return null
}
// LIFE-597: 관리 밖 pane 은 ready(interactive_ready)가 켜지지 않는다 — 한가는 상태만 본다(넣는 관문은 제품이 판단한다).
const idle = (agent: Agent): boolean => agent.status === 'idle' || agent.status === 'done'
async function waitIdle(info: PaneInfo, timeoutMs = 180_000): Promise<boolean> {
  const agent = await waitStatus(info.paneId, idle, timeoutMs)
  if (agent === null) return false
  // 화면 입력 줄이 비어 있을 때까지(데스크톱 초안 없음).
  for (let index = 0; index < 20; index += 1) {
    if (draftState({ kind: info.kind, screen: await screen(info.paneId) }) === 'empty') return true
    await delay(300)
  }
  return false
}

// --- 기록 대조(provider 기록 직접 읽기) ------------------------------------------------------------------------

type Row = { index: number; file: string; role: 'user' | 'assistant' | 'other'; text: string | null; time: number | null; raw: Record<string, unknown> }

function recordFiles(info: PaneInfo): string[] {
  const repo = real(info.repo)
  if (info.kind === 'claude') {
    const dir = path.join(os.homedir(), '.claude/projects', repo.replace(/[^A-Za-z0-9]/g, '-'))
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)) : []
  }
  if (info.kind === 'grok') {
    const dir = path.join(os.homedir(), '.grok/sessions', encodeURIComponent(repo))
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name, 'updates.jsonl')).filter((file) => fs.existsSync(file)) : []
  }
  const day = new Date()
  const dirs = [0, 1].map((back) => {
    const d = new Date(day.getTime() - back * 86_400_000)
    return path.join(os.homedir(), '.codex/sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  })
  return dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)) : [])).filter((file) => {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0] ?? ''
    try {
      const meta: unknown = JSON.parse(first)
      return isRecord(meta) && isRecord(meta.payload) && typeof meta.payload.cwd === 'string' && real(meta.payload.cwd) === repo
    } catch {
      return false
    }
  })
}

const iso = (value: unknown): number | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null)
function rowsOf(info: PaneInfo): Row[] {
  const rows: Row[] = []
  for (const file of recordFiles(info)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.trim() === '') return
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return
      }
      if (!isRecord(raw)) return
      if (info.kind === 'claude') {
        const message = isRecord(raw.message) ? raw.message : {}
        const origin = isRecord(raw.origin) ? raw.origin : {}
        const human = raw.type === 'user' && origin.kind === 'human' && typeof message.content === 'string'
        rows.push({ index, file, role: raw.type === 'assistant' ? 'assistant' : raw.type === 'user' ? 'user' : 'other', text: human ? String(message.content) : null, time: iso(raw.timestamp), raw })
      } else if (info.kind === 'codex') {
        const payload = isRecord(raw.payload) ? raw.payload : {}
        const message = raw.type === 'response_item' && payload.type === 'message'
        const parts = Array.isArray(payload.content) ? payload.content : []
        const text = message && payload.role === 'user' ? parts.map((part: unknown) => (isRecord(part) && part.type === 'input_text' ? String(part.text ?? '') : '')).join('') : null
        rows.push({ index, file, role: message && payload.role === 'assistant' ? 'assistant' : message && payload.role === 'user' ? 'user' : 'other', text, time: iso(raw.timestamp), raw })
      } else {
        const params = isRecord(raw.params) ? raw.params : {}
        const update = isRecord(params.update) ? params.update : {}
        const content = update.content
        const text = update.sessionUpdate === 'user_message_chunk' ? (typeof content === 'string' ? content : isRecord(content) ? String(content.text ?? '') : Array.isArray(content) ? content.map((part: unknown) => (isRecord(part) ? String(part.text ?? '') : '')).join('') : '') : null
        const role = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : update.sessionUpdate === 'user_message_chunk' ? 'user' : 'other'
        const time = typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : iso(raw.timestamp)
        const previous = rows.at(-1)
        // 이어진 user 조각은 한 줄(CLI §4.6 G6 과 같은 규칙).
        if (role === 'user' && previous !== undefined && previous.file === file && previous.role === 'user' && previous.text !== null && text !== null) previous.text += text
        else rows.push({ index, file, role, text, time, raw })
      }
    })
  }
  return rows
}
const norm = (text: string): string => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
/** 그 글(제품 본문 정리 뒤)과 같은 사람 줄 수 — 표지가 회차마다 고유라 전체 기록에서 센다. */
function matches(info: PaneInfo, text: string): { count: number; rows: Row[] } {
  const want = norm(cleanBody(text))
  const rows = rowsOf(info).filter((row) => row.role === 'user' && row.text !== null && norm(row.text) === want)
  return { count: rows.length, rows }
}
/** 표지가 들어 있는 사람 줄 수(합쳐진 글 · 바뀐 글까지 잡는 넓은 그물). */
function markerRows(info: PaneInfo, marker: string): number {
  return rowsOf(info).filter((row) => row.role === 'user' && row.text !== null && row.text.includes(marker)).length
}

/** LIFE-598 r2: 허브가 `target_changed` 로 끝낸 갈래(앱 로그 `mobile.input_target_changed` 의 `check`) — `since` 이후 줄만. 무엇이 막았는지 원자료로 가른다(C·R2-C3). */
function hubChecks(since: number): { at: number; op: string | null; check: string | null }[] {
  let text = ''
  try {
    text = fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8')
  } catch {
    return []
  }
  const found: { at: number; op: string | null; check: string | null }[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('mobile.input_target_changed')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || parsed.tag !== 'mobile.input_target_changed') continue
      const at = num(parsed.at)
      if (at !== null && at >= since) found.push({ at, op: str(parsed.op), check: str(parsed.check) })
    } catch {
      continue
    }
  }
  return found
}

// --- 지시 1회 ---------------------------------------------------------------------------------------------

type SendResult = { id: string; marker: string; final: Wire | null; ms: number | null; states: string[]; record: number; textExact: boolean | null }
async function sendOnce(input: { phone: Phone; info: PaneInfo; text: string; marker: string; waitMs?: number; settleMs?: number }): Promise<SendResult> {
  const { phone, info, text, marker } = input
  const id = newId(marker)
  const t0 = Date.now()
  phone.send({ type: 'input.send', id, channel: info.paneId, text })
  const final = await phone.final(id, input.waitMs ?? 90_000)
  await delay(input.settleMs ?? 1500)
  const found = matches(info, text)
  const row = found.rows[0]
  return {
    id, marker, final,
    ms: final === null ? null : final.recvAt - t0,
    states: (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`),
    record: found.count,
    textExact: row === undefined || row.text === null ? null : row.text === cleanBody(text),
  }
}
const sendView = (result: SendResult) => ({ id: result.id, marker: result.marker, final: result.final?.state ?? null, reason: result.final?.reason ?? null, ms: result.ms, states: result.states, record: result.record, textExact: result.textExact })

// --- setup ------------------------------------------------------------------------------------------------

const LAUNCH: Record<MobileAgentKind, { args: string[]; cli: string[] }> = {
  claude: { args: ['--model', 'claude-haiku-5-5', '--effort', 'low'], cli: ['--model', 'claude-haiku-5-5', '--effort', 'low'] },
  codex: { args: ['-c', 'check_for_update_on_startup=false', '-c', 'model_reasoning_effort="low"'], cli: ['--effort', 'low'] },
  grok: { args: [], cli: [] },
}

async function clearStartup(info: PaneInfo): Promise<boolean> {
  let trusted = false
  for (let index = 0; index < 150; index += 1) {
    const ansi = await screen(info.paneId)
    const plain = screenPlain(ansi)
    if (!trusted && info.kind === 'claude' && plain.includes('Yes, I trust this folder')) {
      if (!/❯\s*\d+\.\s*Yes, I trust this folder/.test(plain)) {
        await desktopKeys(info.paneId, '\x1b[B')
        await delay(350)
      }
      await desktopKeys(info.paneId, '\r')
      trusted = true
    } else if (!trusted && info.kind === 'codex' && /Trust this folder\?|trust the contents of this directory|Do you trust/i.test(plain)) {
      await desktopKeys(info.paneId, '\r')
      trusted = true
    } else {
      // 관리 밖(셸)도 herdr 가 상태를 감지한다 — 한가 + 빈 입력 줄.
      const agent = await agentOf(info.paneId).catch(() => null)
      if (agent !== null && idle(agent) && draftState({ kind: info.kind, screen: ansi }) === 'empty') return true
    }
    await delay(400)
  }
  return false
}

// --- 597: 셸 기동 · 원시 guard · 상태 표본 ---------------------------------------------------------------------

const LAUNCH_LINE: Record<MobileAgentKind, string> = {
  claude: `claude ${LAUNCH.claude.args.join(' ')}`,
  codex: `codex ${LAUNCH.codex.args.map((arg) => (arg.includes('"') ? `'${arg}'` : arg)).join(' ')}`,
  grok: 'grok',
}

/** 셸 pane 에 provider 를 데스크톱 사용자처럼 타자해 띄운다(관리 밖). */
async function typeLaunch(paneId: string, kind: MobileAgentKind, extra = ''): Promise<void> {
  await desktopKeys(paneId, `${LAUNCH_LINE[kind]}${extra === '' ? '' : ` ${extra}`}\r`)
}

/** guard 봉투를 직접(제품 어댑터를 거치지 않고) 한 번 — 오류 칸(`unready`·`observed_input`)을 그대로 받으려고. 이 시험이 만든 pane 만. */
async function rawGuard(paneId: string, extra: Record<string, unknown>, operation: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pane = await own(paneId)
  if (!SOCK.includes('/herdr-dev/sessions/l577g-l598-z')) throw new Error('거부: 격리 세션이 아니다')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('rawGuard 시간 초과')) }, 15_000)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'l597raw', method: 'corral.terminal', params: { epoch: pane.epoch, deadline_ms: Date.now() + 10_000, pane_id: pane.paneId, terminal_id: pane.ptyId, operation, ...extra } })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message: unknown = JSON.parse(buffer.slice(0, index))
      resolve(isRecord(message) ? message : {})
    })
  })
}
/** 원시 agent.get — status·seq·관리 여부·`corral_state_quiet_ms`·입력 revision. 에이전트가 없으면 error 코드. */
async function rawAgent(paneId: string): Promise<{ at: number; after: number; status: string | null; seq: number | null; quietMs: number | null; ready: boolean | null; launchPending: boolean | null; agent: string | null; revision: number | null; error: string | null }> {
  const at = Date.now()
  const reply = await rawGuard(paneId, {}, { method: 'agent.get', params: { target: paneId } })
  const agent = isRecord(reply.result) && isRecord(reply.result.agent) ? reply.result.agent : null
  const error = isRecord(reply.error) ? str(reply.error.code) : null
  // after = 응답을 받은 시각 — guard 가 quietMs 를 잰 시각은 [at, after] 안이다. 변화 시각의 보수적(늦은) 추정은 after − quietMs.
  return { at, after: Date.now(), status: agent === null ? null : str(agent.agent_status), seq: agent === null ? null : num(agent.state_change_seq), quietMs: agent === null ? null : num(agent.corral_state_quiet_ms), ready: agent === null ? null : agent.interactive_ready === true, launchPending: agent === null ? null : agent.launch_pending === true, agent: agent === null ? null : str(agent.agent), revision: agent === null ? null : num(agent.corral_input_revision), error }
}
/** 원시 agent.prompt(폰 경로와 같은 칸 — 관리 밖이면 unmanaged_agent). 거절이면 code·unready 를 돌려준다. */
async function rawPrompt(paneId: string, input: { text: string; seq: number; revision: number; unmanagedAgent: string | null; minIdleMs?: number }): Promise<{ code: string | null; unready: unknown; message: string | null; accepted: boolean }> {
  const reply = await rawGuard(paneId, { expected_state_change_seq: input.seq, expected_input_revision: input.revision, min_input_idle_ms: input.minIdleMs ?? 0, ...(input.unmanagedAgent === null ? {} : { unmanaged_agent: input.unmanagedAgent }) },
    { method: 'agent.prompt', params: { target: paneId, text: input.text } })
  const error = isRecord(reply.error) ? reply.error : null
  return { code: error === null ? null : str(error.code), unready: error === null ? null : (error.unready ?? null), message: error === null ? null : str(error.message), accepted: error === null }
}

/** 지시 하나가 넣어진 시각(폰 상태 `sending`)과 그 직전 마지막 상태 변화 시각(표본의 at − corral_state_quiet_ms)을 재는 표본기. */
class Sampler {
  readonly samples: Awaited<ReturnType<typeof rawAgent>>[] = []
  private running = true
  private readonly done: Promise<void>
  constructor(private readonly paneId: string, everyMs = 150) {
    this.done = (async () => {
      while (this.running) {
        this.samples.push(await rawAgent(this.paneId).catch(() => ({ at: Date.now(), after: Date.now(), status: null, seq: null, quietMs: null, ready: null, launchPending: null, agent: null, revision: null, error: 'sample_failed' })))
        await delay(everyMs)
      }
    })()
  }
  async stop(): Promise<void> {
    this.running = false
    await this.done
  }
  /**
   * `at` 시각 이전의 마지막 상태 변화 — 그 시각 전에 응답이 온 표본들의 (after − quietMs) 중 최댓값(마지막 표본과 같은 seq).
   * after − quietMs 는 실제 변화 시각보다 늦거나 같다(보수적) — 그래서 「넣은 시각 − 이 값」 은 실제 경과보다 작거나 같다.
   */
  lastChangeBefore(at: number): { lastChangeAt: number | null; seq: number | null; samplesBefore: number } {
    const before = this.samples.filter((sample) => sample.after <= at && sample.quietMs !== null && sample.seq !== null)
    const last = before.at(-1)
    if (last === undefined) return { lastChangeAt: null, seq: null, samplesBefore: 0 }
    const same = before.filter((sample) => sample.seq === last.seq)
    return { lastChangeAt: Math.max(...same.map((sample) => sample.after - (sample.quietMs ?? 0))), seq: last.seq, samplesBefore: before.length }
  }
  /** 표본에서 처음 한가(idle|done)가 보인 시각. */
  firstIdleAfter(at: number): number | null {
    return this.samples.find((sample) => sample.at >= at && (sample.status === 'idle' || sample.status === 'done'))?.at ?? null
  }
}
/**
 * 넣기 시작 시각 — 폰이 `sending` 을 **받은** 시각. 서버 상태의 `at` 은 `sending` 때 갱신되지 않아(접수·끝 시각만) 쓰지 않는다(f06 측정 오류).
 * 허브는 `sending` 을 보낸 **뒤** guard 를 부르므로, 받은 시각은 guard 판정 시각과 수 ms 안이다.
 */
const sendingAt = (phone: Phone, id: string): number | null => (phone.states.get(id) ?? []).find((wire) => wire.state === 'sending')?.recvAt ?? null

async function waitShell(paneId: string, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const agent = await rawAgent(paneId)
    if (agent.error !== null || agent.agent === null) return true
    await delay(400)
  }
  return false
}
/** 한가한 Claude 를 데스크톱 사용자처럼 끈다(`/exit`). */
async function exitClaude(info: PaneInfo): Promise<boolean> {
  await desktopKeys(info.paneId, '/exit')
  await delay(500)
  await desktopKeys(info.paneId, '\r')
  return waitShell(info.paneId)
}
async function exitProvider(info: PaneInfo, kind: MobileAgentKind): Promise<boolean> {
  if (kind === 'claude') return exitClaude({ ...info, kind })
  // Codex·Grok: Ctrl+C 두 번(입력 줄이 비어 있을 때 종료).
  await desktopKeys(info.paneId, '\x03')
  await delay(400)
  await desktopKeys(info.paneId, '\x03')
  return waitShell(info.paneId)
}

// --- setup ------------------------------------------------------------------------------------------------

async function setup(): Promise<void> {
  const u5 = flag('plan') === 'u5'
  const c0 = flag('plan') === 'c0'
  const plan: { name: string; kind: MobileAgentKind; mode: Mode }[] = u5
    ? [{ name: 'os', kind: 'claude', mode: 'shell' }, { name: 'om', kind: 'claude', mode: 'managed' }]
    : c0
    ? [{ name: 'cs', kind: 'claude', mode: 'shell' }, { name: 'cm', kind: 'claude', mode: 'managed' }]
    : [
        { name: 'cs', kind: 'claude', mode: 'shell' },
        { name: 'xs', kind: 'codex', mode: 'shell' },
        { name: 'gs', kind: 'grok', mode: 'shell' },
        { name: 'cr', kind: 'claude', mode: 'shell' },
        { name: 'fl', kind: 'claude', mode: 'shell' },
        { name: 'sw', kind: 'claude', mode: 'shell' },
        { name: 'cm', kind: 'claude', mode: 'managed' },
        { name: 'xm', kind: 'codex', mode: 'managed' },
        { name: 'gm', kind: 'grok', mode: 'managed' },
      ]
  const existing = fs.existsSync(PANES) ? panes() : []
  const result: PaneInfo[] = [...existing]
  for (const item of plan) {
    if (existing.some((entry) => entry.name === item.name)) continue
    const made = qsetup(['pane', '--name', item.name])
    const repo = str(made.repo) ?? ''
    const paneId = str(made.paneId) ?? ''
    await delay(1500)
    if (item.mode === 'managed') {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await herdr('agent.start', { name: `l598-${item.name}`, kind: item.kind, pane_id: paneId, args: LAUNCH[item.kind].args, timeout_ms: 30_000 }, 40_000)
          break
        } catch (error) {
          out('agent-start-retry', { name: item.name, attempt, error: String(error) })
          if (attempt >= 3) throw error
          await delay(2500)
        }
      }
    } else {
      await typeLaunch(paneId, item.kind)
    }
    const info: PaneInfo = { ...item, repo, paneId }
    const ready = await clearStartup(info)
    // Codex 는 첫 지시 전엔 세션 참조가 없다 — 데스크톱 사용자의 첫 지시 1회로 세션을 연다. Claude resume 용 pane 도 첫 지시로 기록을 만든다.
    if (ready && (item.kind === 'codex' || item.name === 'cr')) {
      await desktopKeys(paneId, 'Reply with the single word OK.')
      await delay(600)
      await desktopKeys(paneId, '\r')
      await delay(4000)
      await waitIdle(info)
    }
    const agent = await rawAgent(paneId)
    out('pane', { name: item.name, kind: item.kind, mode: item.mode, paneId, ready, agent }, ready)
    result.push(info)
    fs.writeFileSync(PANES, `${JSON.stringify(result, null, 1)}\n`)
  }
}

// --- U1 ---------------------------------------------------------------------------------------------------

/** ⓐ·ⓒ 셸 직접 기동 Claude·Codex·Grok 각 3회 — 한가 세션 지시 → delivered · 기록 정확히 1건 · ≤ 15 s. */
async function u1a(): Promise<void> {
  const phone = await Phone.open()
  try {
    for (let round = 0; round < 3; round += 1) {
      for (const name of ['cs', 'xs', 'gs']) {
        const info = paneOf(name)
        await waitIdle(info)
        const before = await rawAgent(info.paneId)
        const result = await sendOnce({ phone, info, text: `${M(`l598-u1a-${round}-${name}`)} reply with OK only`, marker: `u1a-${round}-${name}` })
        out(`U1a-${round}-${name}`, { pane: name, kind: info.kind, mode: info.mode, managed: before.ready, launchPending: before.launchPending, ...sendView(result) }, before.ready === false && result.final?.state === 'delivered' && result.record === 1 && result.ms !== null && result.ms <= 15_000)
      }
    }
  } finally {
    await phone.close()
  }
}

/** ⓑ Claude `--resume <id>` 를 손으로 친 세션 2회. */
async function u1b(): Promise<void> {
  const info = paneOf('cr')
  await waitIdle(info)
  const before = await agentOf(info.paneId)
  const sessionId = before.session
  if (sessionId === null) {
    out('U1b-resume', { error: 'no session id before resume' }, false)
    return
  }
  const exited = await exitClaude(info)
  await delay(1000)
  await typeLaunch(info.paneId, 'claude', `--resume ${sessionId}`)
  const ready = await clearStartup(info)
  const resumed = await agentOf(info.paneId)
  out('U1b-resumed', { exited, ready, sameSession: resumed.session === sessionId, sessionShape: sessionId.length }, exited && ready && resumed.session === sessionId)
  const phone = await Phone.open()
  try {
    for (let round = 0; round < 2; round += 1) {
      await waitIdle(info)
      const result = await sendOnce({ phone, info, text: `${M(`l598-u1b-${round}`)} reply with OK only`, marker: `u1b-${round}` })
      const after = await agentOf(info.paneId)
      out(`U1b-${round}`, { ...sendView(result), managed: after.ready, sameSession: after.session === sessionId }, result.final?.state === 'delivered' && result.record === 1 && result.ms !== null && result.ms <= 15_000 && after.session === sessionId)
    }
  } finally {
    await phone.close()
  }
}

const LONG = (tag: string): string => `Run the shell command \`sleep 12\` in the foreground and wait for it, then reply with the single word DONE. ${tag}`
async function startLong(phone: Phone, info: PaneInfo, tag: string): Promise<SendResult> {
  await waitIdle(info)
  const result = await sendOnce({ phone, info, text: LONG(tag), marker: tag, settleMs: 300 })
  await waitStatus(info.paneId, (agent) => agent.status === 'working', 30_000)
  await delay(1500)
  return result
}

/** ⓓ + U2ⓒ(턴 끝): 작업 중 지시 → queued/turn → 턴 뒤 들어감. 들어간 시각 − 턴 끝 전이 시각 ≥ 3 s. */
async function turnEndRound(phone: Phone, info: PaneInfo, label: string): Promise<void> {
  const longTag = M(`l598-${label}-long`)
  const long = await startLong(phone, info, longTag)
  const sampler = new Sampler(info.paneId)
  const marker = M(`l598-${label}`)
  const id = newId(label)
  const text = `${marker} reply OK only`
  phone.send({ type: 'input.send', id, channel: info.paneId, text })
  const queued = await phone.waitFor(id, (wire) => wire.state === 'queued' && wire.wait === 'turn', 8000)
  const final = await phone.final(id, 120_000)
  await delay(1500)
  await sampler.stop()
  const sent = sendingAt(phone, id)
  const change = sent === null ? { lastChangeAt: null, seq: null, samplesBefore: 0 } : sampler.lastChangeBefore(sent)
  const deltaMs = sent === null || change.lastChangeAt === null ? null : sent - change.lastChangeAt
  const order = (() => {
    const rows = rowsOf(info)
    const longRow = rows.findIndex((row) => row.role === 'user' && row.text !== null && row.text.includes(longTag))
    const doneRow = rows.findIndex((row, index) => index > longRow && row.role === 'assistant' && JSON.stringify(row.raw).includes('DONE'))
    const mine = rows.findIndex((row) => row.role === 'user' && row.text !== null && row.text.includes(marker))
    return { longRow, doneRow, mine, after: doneRow >= 0 && mine > doneRow }
  })()
  const count = matches(info, text).count
  out(label, { kind: info.kind, long: long.final?.state ?? null, states: (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`), queuedTurn: queued !== null, final: final?.state ?? null, record: count, order, sendingAt: sent, lastChangeAt: change.lastChangeAt, deltaMs, samples: sampler.samples.length },
    queued !== null && final?.state === 'delivered' && count === 1 && order.after && deltaMs !== null && deltaMs >= 3000)
}
async function u1d(): Promise<void> {
  const phone = await Phone.open()
  try {
    await turnEndRound(phone, paneOf('cs'), 'U1d-cs')
  } finally {
    await phone.close()
  }
}

// --- U2 ---------------------------------------------------------------------------------------------------

/** ⓒ provider 를 친 직후 접수한 지시 3회 + 턴이 막 끝난 직후 3회 — 들어간 시각 − 마지막 전이 ≥ 3 s. 첫 한가 직후 원시 guard 거절(unmanaged_settling) 원자료. */
async function u2c(): Promise<void> {
  const phone = await Phone.open()
  const info = paneOf('fl')
  try {
    for (let round = 0; round < (flag('step') === 'turn' ? 0 : 3); round += 1) {
      await waitIdle(info)
      const previous = (await agentOf(info.paneId)).session
      if (!(await exitClaude(info))) {
        out(`U2c-launch-${round}`, { error: 'exit failed' }, false)
        continue
      }
      await delay(800)
      const sampler = new Sampler(info.paneId, 100)
      const launchAt = Date.now()
      await typeLaunch(info.paneId, 'claude')
      // 첫 한가가 보이면 바로 원시 guard 로 넣어 본다(관리 밖 옵션) — settle 전이면 거절이어야 한다(쓰기 0).
      let probe: Awaited<ReturnType<typeof rawPrompt>> | null = null
      let probeQuietMs: number | null = null
      const probeUntil = Date.now() + 30_000
      while (Date.now() < probeUntil) {
        const agent = await rawAgent(info.paneId)
        if ((agent.status === 'idle' || agent.status === 'done') && agent.seq !== null && agent.revision !== null && agent.agent === 'claude') {
          probeQuietMs = agent.quietMs
          probe = await rawPrompt(info.paneId, { text: `${M(`l598-u2c-probe-${round}`)} probe`, seq: agent.seq, revision: agent.revision, unmanagedAgent: 'claude' })
          break
        }
        await delay(100)
      }
      // 접수는 새 세션이 채널에 잡힌 직후(가장 이른 접수 가능 시점) — 그 전에 접수한 지시는 접수 때 묶은 대상과 달라 not_listed·target_changed 로 끝난다(f09 launch 회차, R1-A5 설계).
      let sessionSeenAt: number | null = null
      const sessionUntil = Date.now() + 30_000
      while (Date.now() < sessionUntil) {
        const now = await agentOf(info.paneId).catch(() => null)
        if (now !== null && now.session !== null && now.session !== previous) {
          sessionSeenAt = Date.now()
          break
        }
        await delay(100)
      }
      const marker = M(`l598-u2c-launch-${round}`)
      const id = newId(`u2c-launch-${round}`)
      const text = `${marker} reply OK only`
      phone.send({ type: 'input.send', id, channel: info.paneId, text })
      const acceptedAt = Date.now()
      const final = await phone.final(id, 60_000)
      await delay(1500)
      await sampler.stop()
      const sent = sendingAt(phone, id)
      const change = sent === null ? { lastChangeAt: null, seq: null, samplesBefore: 0 } : sampler.lastChangeBefore(sent)
      const deltaMs = sent === null || change.lastChangeAt === null ? null : sent - change.lastChangeAt
      const probeRows = markerRows(info, `l598-u2c-probe-${round}`)
      const count = matches(info, text).count
      out(`U2c-launch-${round}`, { states: (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`), final: final?.state ?? null, record: count,
        launchAt, firstIdleAt: sampler.firstIdleAfter(launchAt), sessionSeenAt, acceptedAt, acceptedAfterLaunchMs: acceptedAt - launchAt, sendingAt: sent, lastChangeAt: change.lastChangeAt, deltaMs, probe: probe === null ? null : { code: probe.code, unready: probe.unready, accepted: probe.accepted, quietMsAtProbe: probeQuietMs }, probeRows, samples: sampler.samples.length },
        final?.state === 'delivered' && count === 1 && deltaMs !== null && deltaMs >= 3000 && probe !== null && probe.accepted === false && probe.unready === 'unmanaged_settling' && probeRows === 0)
    }
    for (let round = 0; round < (flag('step') === 'launch' ? 0 : 3); round += 1) await turnEndRound(phone, info, `U2c-turn-${round}`)
  } finally {
    await phone.close()
  }
}

/** ⓑ 같은 pane 에서 Claude 를 끄고 Codex 를 띄움 → claude 로 결속한 관리 밖 넣기는 거절(kind mismatch) · 셸 명령만 돌 때 → 넣지 않음. 폰 경로는 셸 명령 중 실패·쓰기 0. */
async function u2b(): Promise<void> {
  const info = paneOf('sw')
  await waitIdle(info)
  const exited = await exitClaude(info)
  await delay(800)
  await typeLaunch(info.paneId, 'codex')
  const codex: PaneInfo = { ...info, kind: 'codex' }
  const ready = await clearStartup(codex)
  await delay(3500)
  const now = await rawAgent(info.paneId)
  const marker = M('l598-u2b-kind')
  const kind = now.seq === null || now.revision === null ? null : await rawPrompt(info.paneId, { text: `${marker} probe`, seq: now.seq, revision: now.revision, unmanagedAgent: 'claude' })
  await delay(2000)
  const kindRows = markerRows(codex, marker) + markerRows(info, marker)
  out('U2b-kind', { exited, codexReady: ready, agentNow: now.agent, quietMs: now.quietMs, result: kind, rows: kindRows, screenHasMarker: screenPlain(await screen(info.paneId)).includes(marker) }, exited && kind !== null && kind.accepted === false && kind.unready === 'unmanaged_kind_mismatch' && kindRows === 0)
  // 셸 명령만 도는 pane — 에이전트 없음.
  const codexExited = await exitProvider(info, 'codex')
  await delay(800)
  await desktopKeys(info.paneId, 'sleep 40\r')
  await delay(1500)
  const shell = await rawAgent(info.paneId)
  const marker2 = M('l598-u2b-shell')
  const probe = await rawPrompt(info.paneId, { text: `${marker2} probe`, seq: shell.seq ?? 0, revision: shell.revision ?? 0, unmanagedAgent: 'claude' })
  const phone = await Phone.open()
  try {
    const marker3 = M('l598-u2b-phone')
    const result = await sendOnce({ phone, info, text: `${marker3} reply OK only`, marker: 'u2b-phone', waitMs: 30_000, settleMs: 2000 })
    const screenText = screenPlain(await screen(info.paneId))
    out('U2b-shell', { codexExited, agentNow: shell.agent, agentError: shell.error, probe, phone: sendView(result), screenHasMarker: screenText.includes(marker2) || screenText.includes(marker3) },
      codexExited && probe.accepted === false && result.final !== null && result.final.state === 'failed' && !screenText.includes(marker2) && !screenText.includes(marker3))
  } finally {
    await phone.close()
  }
  await desktopKeys(info.paneId, '\x03')
}

/** ⓓ blocked(새 레포의 Claude 신뢰 확인) 동안 접수한 지시는 넣지 않는다 — 대기 유지·기록 0, 원시 guard 거절. 신뢰 뒤 들어감(양성 대조). */
async function u2d(): Promise<void> {
  const made = qsetup(['pane', '--name', `cb${RUN}`])
  const info: PaneInfo = { name: 'cb', kind: 'claude', mode: 'shell', repo: str(made.repo) ?? '', paneId: str(made.paneId) ?? '' }
  await delay(1500)
  await typeLaunch(info.paneId, 'claude')
  // 감지 전에는 agent.get 이 agent_not_found 를 낸다 — 원시 표본으로 blocked 가 보일 때까지(f17: waitStatus 가 첫 오류에서 끝나 셸 상태에 접수했다).
  let blocked: number | null = null
  const blockedUntil = Date.now() + 30_000
  while (Date.now() < blockedUntil) {
    if ((await rawAgent(info.paneId)).status === 'blocked') {
      blocked = Date.now()
      break
    }
    await delay(200)
  }
  // 채널이 목록에 잡힐 시간(목록 갱신) — blocked 인 채로.
  await delay(3000)
  const phone = await Phone.open()
  try {
    const marker = M('l598-u2d')
    const id = newId('u2d')
    const text = `${marker} reply OK only`
    phone.send({ type: 'input.send', id, channel: info.paneId, text })
    await delay(8000)
    const whileBlocked = (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`)
    const stillBlocked = await rawAgent(info.paneId)
    const probe = stillBlocked.seq === null || stillBlocked.revision === null ? null : await rawPrompt(info.paneId, { text: `${M('l598-u2d-probe')} probe`, seq: stillBlocked.seq, revision: stillBlocked.revision, unmanagedAgent: 'claude' })
    const rowsWhileBlocked = markerRows(info, marker) + markerRows(info, 'l598-u2d-probe')
    const noSending = !whileBlocked.some((state) => state.startsWith('sending'))
    out('U2d-blocked', { blockedSeen: blocked !== null, statusAfter8s: stillBlocked.status, states: whileBlocked, probe, rowsWhileBlocked }, blocked !== null && stillBlocked.status === 'blocked' && noSending && rowsWhileBlocked === 0 && probe !== null && probe.code === 'agent_blocked')
    // 신뢰 → 한가 → 들어감(양성 대조).
    const trustAt = Date.now()
    const ready = await clearStartup(info)
    const final = await phone.final(id, 60_000)
    await delay(1500)
    const sent = sendingAt(phone, id)
    out('U2d-after-trust', { ready, final: final?.state ?? null, reason: final?.reason ?? null, record: matches(info, text).count, sendingAfterTrustMs: sent === null ? null : sent - trustAt }, final?.state === 'delivered' && matches(info, text).count === 1 && sent !== null && sent > trustAt)
  } finally {
    await phone.close()
  }
  const panesNow = panes()
  if (!panesNow.some((entry) => entry.paneId === info.paneId)) fs.writeFileSync(PANES, `${JSON.stringify([...panesNow, { ...info, name: `cb${RUN}` }], null, 1)}\n`)
}

/** ⓓ 보충 — 세션이 있는 관리 밖 Claude 의 권한 대기(blocked) 동안 접수한 지시: 넣지 않고 대기 · 원시 guard agent_blocked · 권한 답 뒤 턴이 끝나면 들어감. */
async function u2d2(): Promise<void> {
  const made = qsetup(['pane', '--name', `cp${RUN}`])
  const info: PaneInfo = { name: 'cp', kind: 'claude', mode: 'shell', repo: str(made.repo) ?? '', paneId: str(made.paneId) ?? '' }
  fs.writeFileSync(PANES, `${JSON.stringify([...panes(), { ...info, name: `cp${RUN}` }], null, 1)}\n`)
  await delay(1500)
  // 사용자 전역 설정은 bypassPermissions — 실행 플래그로만 권한 확인을 켠다(전역 설정 무변경).
  await typeLaunch(info.paneId, 'claude', '--permission-mode default')
  const ready = await clearStartup(info)
  await desktopKeys(info.paneId, `Use the Bash tool to run exactly: touch l598-perm-${RUN}.txt — then reply DONE.`)
  await delay(600)
  await desktopKeys(info.paneId, '\r')
  const blocked = await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 60_000).catch(() => null)
  const phone = await Phone.open()
  try {
    const marker = M('l598-u2d2')
    const id = newId('u2d2')
    const text = `${marker} reply OK only`
    phone.send({ type: 'input.send', id, channel: info.paneId, text })
    await delay(8000)
    const whileBlocked = (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`)
    const still = await rawAgent(info.paneId)
    const probe = still.seq === null || still.revision === null ? null : await rawPrompt(info.paneId, { text: `${M('l598-u2d2-probe')} probe`, seq: still.seq, revision: still.revision, unmanagedAgent: 'claude' })
    const rows = markerRows(info, marker) + markerRows(info, 'l598-u2d2-probe')
    const noSending = !whileBlocked.some((state) => state.startsWith('sending'))
    out('U2d2-blocked', { ready, blockedSeen: blocked !== null, statusAfter8s: still.status, managed: still.ready, states: whileBlocked, probe, rows }, blocked !== null && still.status === 'blocked' && still.ready === false && noSending && whileBlocked.some((state) => state.startsWith('queued')) && rows === 0 && probe !== null && probe.code === 'agent_blocked')
    // 권한 허용(데스크톱 사용자의 Enter — 첫 선택지 Yes) → 턴 끝 → 들어감(양성 대조).
    const answerAt = Date.now()
    await desktopKeys(info.paneId, '\r')
    const final = await phone.final(id, 90_000)
    await delay(1500)
    const sent = sendingAt(phone, id)
    out('U2d2-after-permission', { final: final?.state ?? null, reason: final?.reason ?? null, record: matches(info, text).count, sendingAfterAnswerMs: sent === null ? null : sent - answerAt, states: (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`) }, final?.state === 'delivered' && matches(info, text).count === 1 && sent !== null && sent > answerAt)
  } finally {
    await phone.close()
  }
}

// --- U3 ---------------------------------------------------------------------------------------------------

/** ⓐ 맥 입력창 초안 → failed/mac_draft · 합쳐진 글 기록 0 (관리 밖 셋). */
async function u3a(): Promise<void> {
  const phone = await Phone.open()
  try {
    for (const name of ['cs', 'xs', 'gs']) {
      const info = paneOf(name)
      await waitIdle(info)
      const draft = `l598-u3a-draft-${name}`
      await desktopKeys(info.paneId, draft)
      await delay(1200)
      const shown = draftState({ kind: info.kind, screen: await screen(info.paneId) })
      const marker = M(`l598-u3a-phone-${name}`)
      const result = await sendOnce({ phone, info, text: `${marker} reply OK only`, marker: `u3a-${name}`, waitMs: 30_000, settleMs: 3000 })
      await desktopKeys(info.paneId, '\x7f'.repeat(draft.length + 4))
      await delay(1000)
      const merged = rowsOf(info).filter((row) => row.role === 'user' && row.text !== null && (row.text.includes(marker) || row.text.includes(draft))).length
      out(`U3a-${name}`, { kind: info.kind, draftOnScreen: shown, ...sendView(result), mergedOrAnyRows: merged, draftCleared: draftState({ kind: info.kind, screen: await screen(info.paneId) }) }, result.final !== null && result.final.state === 'failed' && result.final.reason === 'mac_draft' && merged === 0)
    }
  } finally {
    await phone.close()
  }
}

/** ⓑ 넣기 직전 맥 타자(입력 revision 변화) → guard 거절(input_changed) · 쓰기 0. 제품과 같은 칸(관리 밖 옵션 + 화면 턴의 revision)으로 원시 호출. */
async function u3b(): Promise<void> {
  for (const name of ['cs', 'xs', 'gs']) {
    const info = paneOf(name)
    await waitIdle(info)
    await delay(3500)
    const pane = await own(info.paneId)
    const shot = await terminal.screenRead(pane, ctx())
    await desktopKeys(info.paneId, 'z')
    await delay(300)
    const marker = M(`l598-u3b-${name}`)
    const result = shot.input === null || shot.seq === null ? null : await rawPrompt(info.paneId, { text: `${marker} probe`, seq: shot.seq, revision: shot.input.revision, unmanagedAgent: info.kind, minIdleMs: 0 })
    await delay(1500)
    const screenText = screenPlain(await screen(info.paneId))
    await desktopKeys(info.paneId, '\x7f\x7f')
    await delay(800)
    // 양성 대조: 타자 없이 같은 방식이면 받아들인다(이 회차는 실제로 넣는다 — 기록 1건).
    await delay(3500)
    const shot2 = await terminal.screenRead(pane, ctx())
    const marker2 = M(`l598-u3b-control-${name}`)
    const control = shot2.input === null || shot2.seq === null ? null : await rawPrompt(info.paneId, { text: `${marker2} reply OK only`, seq: shot2.seq, revision: shot2.input.revision, unmanagedAgent: info.kind, minIdleMs: 0 })
    await delay(4000)
    out(`U3b-${name}`, { revisionAtScreen: shot.input?.revision ?? null, result, rows: markerRows(info, marker), screenHasMarker: screenText.includes(marker), control: control === null ? null : { accepted: control.accepted, code: control.code }, controlRows: markerRows(info, marker2) },
      result !== null && result.code === 'input_changed' && markerRows(info, marker) === 0 && !screenText.includes(marker) && control !== null && control.accepted && markerRows(info, marker2) === 1)
    await waitIdle(info)
  }
}

/**
 * ⓒ 대기 중 같은 pane 에 새 세션(Claude `/clear`)이 뜸. `--expect fixed`(기본, C1) → failed/target_changed · 옛·새 기록 모두 0
 *   + 세션이 실제로 바뀌었다(`sessionChanged`) · 넣기를 시작하지 않았다(`sendingAt` null) · 표본 실패 0 · `/clear` 뒤 세션 null 표본 ≤ 2
 *   (r1 — 세션과 무관한 「항상 거절」 거짓 양성을 통과로 세지 않는다).
 *   r2(게이트 ① 「1안」): 접수 뒤 첫 맥 키(Esc)부터 그 지시는 끝나야 한다 — 실패 수신이 Esc 뒤이고, 허브 로그의 갈래가 입력 울타리(`check: input`)여야 통과
 *   (목록·herdr 세션 대조가 막은 것은 r2 울타리의 증거가 아니다). 갈래·시각은 `blockedBy`·`checks` 로 남긴다.
 * `--expect repro`(C0, 수정 전) → 새 세션에 들어감(unconfirmed/record_missing 또는 delivered) + 새 세션 기록 표지 1건.
 * 같은 회차에 herdr `agent_session` 표본(150 ms)으로 바뀐 시각, 폰이 `sending` 을 받은 시각(허브가 넣기 시작)을 남긴다.
 */
async function u3c(): Promise<void> {
  const phone = await Phone.open()
  // --pane cm = 같은 시나리오를 관리 pane(agent.start)에서.
  const info = paneOf(flag('pane') ?? 'cs')
  const expect = flag('expect') ?? 'fixed'
  try {
    const before = await agentOf(info.paneId)
    await startLong(phone, info, M(`l598-u3c-long-${info.name}`))
    const marker = M(`l598-u3c-${info.name}`)
    const id = newId(`u3c-${info.name}`)
    const text = `${marker} reply OK only`
    // 표본 실패(error)와 herdr 가 세션 없음(null)이라 말한 것을 가른다(r1).
    const sessions: { at: number; session: string | null; error: boolean }[] = []
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const agent = await agentOf(info.paneId).catch(() => null)
        sessions.push({ at: Date.now(), session: agent?.session ?? null, error: agent === null })
        await delay(150)
      }
    })()
    const sentAt = Date.now()
    phone.send({ type: 'input.send', id, channel: info.paneId, text })
    const queued = await phone.waitFor(id, (wire) => wire.state === 'queued', 8000)
    // 접수가 묶이기(bind 관측) 전에 키가 가면 R0 가 그 키를 포함한다 — 묶일 여유를 둔다.
    await delay(1500)
    const escAt = Date.now()
    await desktopKeys(info.paneId, '\x1b')
    await waitIdle(info, 30_000)
    await desktopKeys(info.paneId, '/clear')
    await delay(500)
    const clearEnterAt = Date.now()
    await desktopKeys(info.paneId, '\r')
    const final = await phone.final(id, 90_000)
    await delay(2000)
    sampling = false
    await sampler
    const after = await agentOf(info.paneId)
    const changedAt = sessions.find((sample) => sample.at >= clearEnterAt && sample.session !== null && sample.session !== before.session)?.at ?? null
    const nullDuring = sessions.filter((sample) => sample.at >= clearEnterAt && !sample.error && sample.session === null).length
    const sampleErrors = sessions.filter((sample) => sample.error).length
    const sent = sendingAt(phone, id)
    const failedAt = (phone.states.get(id) ?? []).find((wire) => wire.state === 'failed')?.recvAt ?? null
    // 기록 파일별 표지 수 — Claude 기록 파일 이름 = 세션 id.
    const bySession: Record<string, number> = {}
    for (const row of rowsOf(info)) {
      if (row.role !== 'user' || row.text === null || !row.text.includes(marker)) continue
      const sid = path.basename(row.file, '.jsonl')
      const label = sid === before.session ? 'old' : sid === after.session ? 'new' : 'other'
      bySession[label] = (bySession[label] ?? 0) + 1
    }
    const rows = markerRows(info, marker)
    const states = (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`)
    const timing = { escAt, clearEnterAt, herdrSessionChangedAt: changedAt, sendingAt: sent, failedAt, herdrChangeMs: changedAt === null ? null : changedAt - clearEnterAt, sendingMs: sent === null ? null : sent - clearEnterAt, failedMs: failedAt === null ? null : failedAt - clearEnterAt, failedAfterEscMs: failedAt === null ? null : failedAt - escAt, sessionSamples: sessions.length, sampleErrors, nullSamplesAfterClear: nullDuring }
    const checks = hubChecks(sentAt).filter((entry) => entry.op === 'send')
    const blockedBy = checks.length === 1 ? checks[0]!.check : null
    const reproduced = (final?.state === 'unconfirmed' || final?.state === 'delivered') && (bySession.new ?? 0) === 1
    const sessionChanged = before.session !== null && after.session !== null && before.session !== after.session
    const fixed = final?.state === 'failed' && final.reason === 'target_changed' && rows === 0 && sessionChanged && sent === null && failedAt !== null && failedAt > escAt && blockedBy === 'input' && sampleErrors === 0 && nullDuring <= 2
    out(`U3c-${info.name}`, { pane: info.name, mode: info.mode, managed: after.ready, expect, queued: queued !== null, sessionChanged, final: final?.state ?? null, reason: final?.reason ?? null, blockedBy, checks, states, rows, bySession, ...timing },
      expect === 'repro' ? reproduced : fixed)
  } finally {
    await phone.close()
  }
}

/**
 * LIFE-598 r2 C3 추가: 같은 pane 연속 두 지시 — 앞 지시가 허브 쓰기(revision +1)여도 뒤 지시가 들어간다(자기 쓰기 사슬). 맥 입력 없음.
 * 한가한 pane 에 두 지시를 잇달아 보낸다(앞 지시가 들어가 턴이 도는 동안 뒤 지시는 queued/turn). 판정: 둘 다 delivered + 기록 표지 각 1건 + 갈래 로그 0.
 */
async function twin(): Promise<void> {
  const phone = await Phone.open()
  const info = paneOf(flag('pane') ?? 'cs')
  try {
    await waitIdle(info)
    const markers = [M(`l598-twin-a-${info.name}`), M(`l598-twin-b-${info.name}`)]
    const ids = markers.map((marker) => newId(marker))
    const sentAt = Date.now()
    for (let index = 0; index < 2; index += 1) phone.send({ type: 'input.send', id: ids[index]!, channel: info.paneId, text: `${markers[index]} reply OK only` })
    const finals = [await phone.final(ids[0]!, 120_000), await phone.final(ids[1]!, 120_000)]
    await waitIdle(info, 60_000)
    await delay(1500)
    const rows = markers.map((marker) => markerRows(info, marker))
    const states = ids.map((id) => (phone.states.get(id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}${wire.reason === null ? '' : `/${wire.reason}`}`))
    const checks = hubChecks(sentAt)
    out(`twin-${info.name}`, { pane: info.name, mode: info.mode, finals: finals.map((final) => final?.state ?? null), reasons: finals.map((final) => final?.reason ?? null), rows, states, checks },
      finals.every((final) => final?.state === 'delivered') && rows.every((count) => count === 1) && checks.length === 0)
  } finally {
    await phone.close()
  }
}

/**
 * LIFE-598 r1 ⓒ: 한가한 pane 에서 `/clear` 전후 `agent.get` 시계열(≤ 150 ms) — `state_change_seq`·`status`·`agent_session`·입력 revision·idle.
 * `--rounds N`(기본 2). 회차마다 한 줄: Enter 뒤 세션 반영 지연(`sessionChangeMs`), 그 표본의 입력 idle(마지막 키 뒤 경과),
 * 세션이 바뀐 표본에서 seq 가 Enter 직전과 같은가(`seqSameAtChange`), 변화가 있었던 칸들의 시계열(값이 바뀐 표본만). 세션 값은 앞 8자.
 * 판정: 세션이 6 s 안에 바뀌었고 샘플러 실패 0 이면 ok(측정 회차의 성립 — 지연 값 자체는 판정하지 않는다).
 */
async function series(): Promise<void> {
  const info = paneOf(flag('pane') ?? 'cs')
  const rounds = Number(flag('rounds') ?? '2')
  for (let round = 0; round < rounds; round += 1) {
    await waitIdle(info, 60_000)
    await delay(1500)
    const pane = await own(info.paneId)
    type Sample = { ms: number; status: string | null; seq: number | null; session: string | null; revision: number | null; idleMs: number | null; quietMs: number | null; error: string | null }
    const samples: Sample[] = []
    let t0 = Date.now()
    let running = true
    const take = async (): Promise<void> => {
      while (running) {
        const at = Date.now()
        const sample = await terminal.agentInfo(pane, ctx()).then(
          (agent): Sample => ({ ms: at - t0, status: agent.status, seq: agent.stateChangeSeq, session: agent.session?.value.slice(0, 8) ?? null, revision: agent.input?.revision ?? null, idleMs: agent.input?.idleMs ?? null, quietMs: agent.stateQuietMs ?? null, error: null }),
          (error: unknown): Sample => ({ ms: at - t0, status: null, seq: null, session: null, revision: null, idleMs: null, quietMs: null, error: String(error).slice(0, 80) }),
        )
        samples.push(sample)
        await delay(Math.max(0, 100 - (Date.now() - at)))
      }
    }
    const sampler = take()
    await delay(600)
    await desktopKeys(info.paneId, '/clear')
    await delay(500)
    t0 = Date.now()
    // 앞 표본은 Enter 기준 음수 ms 로 다시 적는다.
    for (const sample of samples) sample.ms -= 1100
    await desktopKeys(info.paneId, '\r')
    await delay(6000)
    running = false
    await sampler
    const before = [...samples].reverse().find((sample) => sample.ms < 0 && sample.error === null) ?? null
    const change = samples.find((sample) => sample.ms >= 0 && sample.error === null && sample.session !== null && before !== null && sample.session !== before.session) ?? null
    const prevOfChange = change === null ? null : [...samples].reverse().find((sample) => sample.ms < change.ms && sample.error === null) ?? null
    const compact = samples.filter((sample, index) => index === 0 || sample.error !== null || ((prev) => prev.status !== sample.status || prev.seq !== sample.seq || prev.session !== sample.session || prev.revision !== sample.revision)(samples[index - 1]!))
    const errors = samples.filter((sample) => sample.error !== null).length
    const nulls = samples.filter((sample) => sample.error === null && sample.session === null).length
    out(`series-${info.name}-${round}`, {
      pane: info.name, mode: info.mode, samples: samples.length, errors, nullSessionSamples: nulls,
      sessionChangeMs: change?.ms ?? null, sessionChangeWindowMs: change === null || prevOfChange === null ? null : [prevOfChange.ms, change.ms],
      idleAtChange: change?.idleMs ?? null, seqBefore: before?.seq ?? null, seqAtChange: change?.seq ?? null, seqSameAtChange: change === null || before === null ? null : change.seq === before.seq,
      statusBefore: before?.status ?? null, statusAtChange: change?.status ?? null, compact,
    }, change !== null && errors === 0)
  }
}

type Ask = { tag: string; prompt: string; answers: { choices: number[]; other: string | null }[]; expect: string[] }
const ASK: Ask = { tag: 'single', prompt: 'Call AskUserQuestion once: one question "Pick a color", single select, options Red, Green, Blue with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [1], other: null }], expect: ['Green'] }

/** ⓓ 관리 밖 pane 의 질문 답·중단 각 1회(무회귀). */
async function u3d(): Promise<void> {
  const phone = await Phone.open()
  const info = paneOf('cs')
  try {
    await waitIdle(info)
    phone.subscribe(info.paneId)
    await delay(800)
    const seen = new Set([...(phone.questions.get(info.paneId)?.keys() ?? [])])
    const prompt = await sendOnce({ phone, info, text: ASK.prompt, marker: 'u3d-ask', settleMs: 300 })
    const question = await phone.pendingQuestion(info.paneId, seen, 90_000)
    if (question === null) out('U3d-answer', { prompt: sendView(prompt), question: null }, false)
    else {
      await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 30_000)
      const id = newId('u3d-answer')
      phone.send({ type: 'question.answer', id, channel: info.paneId, question: question.id, call: question.call, digest: question.digest, answers: ASK.answers })
      const answer = await phone.final(id, 60_000)
      await delay(1500)
      const value = rowsOf(info).map((row) => (question.call !== null && JSON.stringify(row.raw).includes(question.call) && isRecord(row.raw.toolUseResult) && isRecord(row.raw.toolUseResult.answers) ? JSON.stringify(row.raw.toolUseResult.answers) : null)).find((item) => item !== null) ?? null
      out('U3d-answer', { prompt: prompt.final?.state ?? null, answer: answer === null ? null : `${answer.state}/${answer.reason}`, recordHasGreen: value !== null && value.includes('Green') }, answer?.state === 'delivered' && value !== null && value.includes('Green'))
    }
    await waitIdle(info)
    await startLong(phone, info, M('l598-u3d-stop-long'))
    const id = newId('u3d-stop')
    const t0 = Date.now()
    phone.send({ type: 'turn.stop', id, channel: info.paneId })
    const final = await phone.final(id, 15_000)
    await delay(1500)
    const after = await agentOf(info.paneId)
    out('U3d-stop', { stop: final === null ? null : `${final.state}/${final.reason}`, ms: final === null ? null : final.recvAt - t0, statusAfter: after.status }, final?.state === 'stopped' && after.status !== 'working')
    await waitIdle(info, 60_000)
  } finally {
    await phone.close()
  }
}

// --- U4ⓐ · U5 ----------------------------------------------------------------------------------------------

async function u4a(): Promise<void> {
  const phone = await Phone.open()
  try {
    for (let round = 0; round < 2; round += 1) {
      for (const name of ['cm', 'xm', 'gm']) {
        const info = paneOf(name)
        await waitIdle(info)
        const before = await rawAgent(info.paneId)
        const result = await sendOnce({ phone, info, text: `${M(`l598-u4a-${round}-${name}`)} reply with OK only`, marker: `u4a-${round}-${name}` })
        out(`U4a-${round}-${name}`, { pane: name, kind: info.kind, managed: before.ready, ...sendView(result) }, before.ready === true && result.final?.state === 'delivered' && result.record === 1)
      }
    }
  } finally {
    await phone.close()
  }
}

/** U5 옛 guard(main 칸) + 새 앱: 관리 pane 들어감 · 관리 밖 pane 쓰기 0 + failed/guard_outdated. 옛 guard 임을 handshake 로 확인. */
async function u5(): Promise<void> {
  const epoch = await terminal.epoch(ctx())
  const advertises = terminal.unmanagedPromptCapable()
  out('U5-handshake', { epochLength: epoch.length, unmanagedPrompt: advertises, agentOps: terminal.agentCapable() }, advertises === false && terminal.agentCapable())
  const phone = await Phone.open()
  try {
    const managed = paneOf('om')
    await waitIdle(managed)
    const a = await sendOnce({ phone, info: managed, text: `${M('l598-u5a')} reply with OK only`, marker: 'u5a' })
    out('U5a-managed', sendView(a), a.final?.state === 'delivered' && a.record === 1)
    const shell = paneOf('os')
    await waitIdle(shell)
    const marker = M('l598-u5b')
    const b = await sendOnce({ phone, info: shell, text: `${marker} reply with OK only`, marker: 'u5b', waitMs: 30_000, settleMs: 4000 })
    out('U5b-shell', { ...sendView(b), markerRows: markerRows(shell, marker), screenHasMarker: screenPlain(await screen(shell.paneId)).includes(marker) }, b.final?.state === 'failed' && b.final.reason === 'guard_outdated' && markerRows(shell, marker) === 0)
  } finally {
    await phone.close()
  }
}

/** U5 반대 조합: 새 guard + 옵션 없는 요청(CLI `terminal prompt`)을 관리 밖 pane 에 → agent_not_ready · 쓰기 0. */
async function u5r(): Promise<void> {
  const info = paneOf('cs')
  await waitIdle(info)
  await delay(3500)
  const listText = execFileSync(process.execPath, [CLI, '--socket', RPC, 'terminal', 'list', '--json'], { cwd: APP, encoding: 'utf8' })
  const listed: unknown = JSON.parse(listText)
  const terminals = isRecord(listed) && isRecord(listed.result) && Array.isArray(listed.result.terminals) ? listed.result.terminals : []
  const handle = terminals.flatMap((entry: unknown) => (isRecord(entry) && entry.paneId === info.paneId && typeof entry.handle === 'string' ? [entry.handle] : []))[0] ?? null
  if (handle === null) {
    out('U5r-cli', { error: 'no handle', count: terminals.length }, false)
    return
  }
  const marker = M('l598-u5r')
  let exit = 0
  let stdout = ''
  try {
    stdout = execFileSync(process.execPath, [CLI, '--socket', RPC, 'terminal', 'prompt', '--terminal', handle, '--text', `${marker} reply OK only`, '--json', '--timeout-ms', '20000'], { cwd: APP, encoding: 'utf8' })
  } catch (error) {
    exit = isRecord(error) && typeof error.status === 'number' ? error.status : -1
    stdout = isRecord(error) && typeof error.stdout === 'string' ? error.stdout : ''
  }
  await delay(3000)
  let code: string | null = null
  try {
    const parsed: unknown = JSON.parse(stdout)
    code = isRecord(parsed) && isRecord(parsed.error) ? str(parsed.error.code) : null
  } catch {
    code = null
  }
  const screenText = screenPlain(await screen(info.paneId))
  // CLI 는 corral 기록(AgentRecord)이 없는 pane 을 guard 에 닿기 전에 거절한다(f16: agent_not_found) — 그 결과를 그대로 적고,
  // guard 술어 쪽 「옵션 없는 요청」 은 같은 guard 봉투를 칸 없이 직접 보내 따로 본다(CLI 와 같은 모양: unmanaged_agent 없음).
  out('U5r-cli', { exit, code, rows: markerRows(info, marker), screenHasMarker: screenText.includes(marker) }, exit !== 0 && code !== null && markerRows(info, marker) === 0 && !screenText.includes(marker))
  await delay(3500)
  const now = await rawAgent(info.paneId)
  const marker2 = M('l598-u5r-raw')
  const plain = now.seq === null || now.revision === null ? null : await rawPrompt(info.paneId, { text: `${marker2} probe`, seq: now.seq, revision: now.revision, unmanagedAgent: null })
  await delay(2000)
  const screen2 = screenPlain(await screen(info.paneId))
  out('U5r-guard-no-option', { quietMs: now.quietMs, managed: now.ready, result: plain, rows: markerRows(info, marker2), screenHasMarker: screen2.includes(marker2) }, plain !== null && plain.code === 'agent_not_ready' && plain.unready === null && markerRows(info, marker2) === 0 && !screen2.includes(marker2))
}

// --- 실행 ---------------------------------------------------------------------------------------------------

const ITEMS: Record<string, () => Promise<void>> = { series, twin, u1a, u1b, u1d, u2b, u2c, u2d, u2d2, u3a, u3b, u3c, u3d, u4a, u5, u5r }
if (command === 'setup') {
  await setup()
} else if (ITEMS[command] !== undefined) {
  if (OUT === null) {
    console.error('--out 필요')
    process.exit(2)
  }
  fs.mkdirSync(OUT, { recursive: true })
  outFile = path.join(OUT, `${command}.ndjson`)
  await ITEMS[command]!()
} else {
  console.error(`명령: setup · ${Object.keys(ITEMS).join(' · ')}`)
  process.exit(2)
}
process.exit(failures === 0 ? 0 : 1)
