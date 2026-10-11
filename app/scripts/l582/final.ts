// LIFE-582 최종 관문 — 격리 회차 묶음. 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l582g-z* 에 띄운 것)과 그 이름 herdr 세션에서 **이 시험이 만든 pane 만** 친다.
// 폰 자리 = 이 스크립트의 WS 클라이언트(`ws://127.0.0.1:<서버 포트>/ws`, `q-setup.mjs mobile` 이 남긴 0600 토큰). 설치본 corral·실제 tailscale·사용자 세션 무접촉.
//   npx tsx scripts/l582/final.ts setup  --root /tmp/l582g-z1                 → 격리 레포 7개 · provider 세션(관리 = CLI `terminal create --agent` · 관리 안 됨 = herdr `agent.start` · 셸 = D1 잠금) → <ROOT>/panes.json
//   npx tsx scripts/l582/final.ts <z2|z3|z4|z5|z6|z7|z9|z10> --root /tmp/l582g-z1 --out <dir>   → 항목 회차, <dir>/<항목>.ndjson (회차마다 한 줄 · `ok`)
//   npx tsx scripts/l582/final.ts table  --root /tmp/l582g-z1 --out <dir>     → Z6ⓕ 「폰 표시 ↔ 기록」 표(<dir>/*.ndjson 의 지시 회차 전부)
// 기록 대조는 제품 코드를 쓰지 않는다 — provider 기록 줄을 이 파일이 직접 읽어 「사람이 친 줄」(CLI §4.6 과 같은 provider 별 규칙)을 센다. 회차 글은 회차마다 고유 표지(`l582f-…`)를 단다.
// 원자료에는 상태·이유·시각·바이트 수·표지·개수만 — 대화 본문 사본은 남기지 않는다(G5). 종료 0 = 그 항목 회차 전부 `ok` · 1 = 하나라도 아님 · 2 = 사용법.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { TerminalBackend, type TerminalIdentity } from '../../src/main/adapter/index.js'
import { activeQuestion, cleanBody, draftState, screenPlain } from '../../src/main/mobile/keys.js'
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
if (!/^\/tmp\/l582g-z[^/]*$/.test(ROOT)) {
  console.error('--root 는 /tmp/l582g-z*')
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
  if (!SOCK.includes('/herdr-dev/sessions/l577g-l582g-z')) throw new Error('거부: 격리 세션이 아니다')
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
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'l582f', method, params })}\n`))
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
  const text = execFileSync(process.execPath, [path.join(APP, 'scripts/l582/q-setup.mjs'), ...args, '--root', ROOT], { cwd: APP, encoding: 'utf8' })
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
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token, client: { name: 'l582-final', version: '1' } })))
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
const newId = (tag: string): string => `l582f-${tag}-${Date.now().toString(36)}-${(serial += 1)}`

// --- 세션 목록 --------------------------------------------------------------------------------------------

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
const idle = (agent: Agent): boolean => agent.ready && (agent.status === 'idle' || agent.status === 'done')
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
const lastRowTime = (info: PaneInfo): number | null => rowsOf(info).reduce<number | null>((max, row) => (row.time !== null && (max === null || row.time > max) ? row.time : max), null)

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
  claude: { args: ['--model', 'haiku', '--effort', 'low'], cli: ['--model', 'haiku', '--effort', 'low'] },
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
    } else if (info.mode !== 'shell') {
      const agent = await agentOf(info.paneId)
      if (idle(agent) && draftState({ kind: info.kind, screen: ansi }) === 'empty') return true
    } else if (index > 25 && draftState({ kind: info.kind, screen: ansi }) === 'empty') return true
    await delay(400)
  }
  return false
}

async function setup(): Promise<void> {
  // extra: 권한 대기를 실제로 띄우는 회차용 — 사용자 전역 설정(bypassPermissions · approval never)은 읽기 전용이라 실행 플래그로만 낮춘다.
  const plan: { name: string; kind: MobileAgentKind; mode: Mode; extra?: string[] }[] = [
    { name: 'cm', kind: 'claude', mode: 'managed' },
    { name: 'cu', kind: 'claude', mode: 'unmanaged' },
    { name: 'xm', kind: 'codex', mode: 'managed' },
    { name: 'xu', kind: 'codex', mode: 'unmanaged' },
    { name: 'gm', kind: 'grok', mode: 'managed' },
    { name: 'gu', kind: 'grok', mode: 'unmanaged' },
    { name: 'cs', kind: 'claude', mode: 'shell' },
    // r9 A: 첫 지시 전 새 GUI Claude 세션(대화 기록 없음) — Z8 C12
    { name: 'cn', kind: 'claude', mode: 'managed' },
    { name: 'cp', kind: 'claude', mode: 'unmanaged', extra: ['--permission-mode', 'manual'] },
    { name: 'xp', kind: 'codex', mode: 'unmanaged', extra: ['-a', 'on-request', '-s', 'read-only'] },
    { name: 'gp', kind: 'grok', mode: 'unmanaged', extra: ['--permission-mode', 'default'] },
    // r10 R9-A1: 기록 없는 셸 세션(실패 여러 개·긴 지시 스크롤 캡처)
    { name: 'cs2', kind: 'claude', mode: 'shell' },
  ]
  const existing = fs.existsSync(PANES) ? panes() : []
  const result: PaneInfo[] = [...existing]
  for (const item of plan) {
    if (existing.some((entry) => entry.name === item.name)) continue
    const made = qsetup(['pane', '--name', item.name])
    const repo = str(made.repo) ?? ''
    const shellPane = str(made.paneId) ?? ''
    let paneId = shellPane
    if (item.mode === 'managed') {
      const text = execFileSync(process.execPath, [CLI, '--socket', RPC, 'terminal', 'create', '--worktree', 'current', '--agent', item.kind, ...LAUNCH[item.kind].cli, '--title', item.name, '--json', '--timeout-ms', '90000'], { cwd: repo, encoding: 'utf8' })
      const parsed: unknown = JSON.parse(text)
      const terminalInfo = isRecord(parsed) && isRecord(parsed.result) && isRecord(parsed.result.terminal) ? parsed.result.terminal : {}
      paneId = str(terminalInfo.paneId) ?? ''
      const agentInfo = isRecord(parsed) && isRecord(parsed.result) && isRecord(parsed.result.stages) && isRecord(parsed.result.stages.agent) ? parsed.result.stages.agent : {}
      out('cli-create', { name: item.name, paneId, argv: agentInfo.argv ?? null, outcome: isRecord(parsed) && isRecord(parsed.result) ? parsed.result.outcome : null })
    } else if (item.mode === 'unmanaged') {
      await delay(1500)
      for (let attempt = 0; ; attempt += 1) {
        try {
          await herdr('agent.start', { name: `l582f-${item.name}`, kind: item.kind, pane_id: paneId, args: [...LAUNCH[item.kind].args, ...(item.extra ?? [])], timeout_ms: 30_000 }, 40_000)
          break
        } catch (error) {
          out('agent-start-retry', { name: item.name, attempt, error: String(error) })
          if (attempt >= 3) throw error
          await delay(2500)
        }
      }
    } else {
      await delay(1500)
      await desktopKeys(paneId, 'claude --model haiku --effort low\r')
    }
    const info: PaneInfo = { ...item, repo, paneId }
    const ready = await clearStartup(info)
    // Codex 는 첫 지시 전엔 세션 참조가 없다(SURFACE `no_session`) — 데스크톱 사용자의 첫 지시 1회로 세션을 연다.
    if (ready && item.kind === 'codex') {
      await desktopKeys(paneId, 'Reply with the single word OK.')
      await delay(600)
      await desktopKeys(paneId, '\r')
      await delay(4000)
      await waitIdle(info)
    }
    const agent = item.mode === 'shell' ? null : await agentOf(paneId)
    out('pane', { name: item.name, kind: item.kind, mode: item.mode, paneId, ready, agent }, ready)
    result.push(info)
    fs.writeFileSync(PANES, `${JSON.stringify(result, null, 1)}\n`)
  }
}

// --- Z2 정확히 한 번 · 문자 보존 · 격리 ≥ 20 · 잠금 · 10초 -------------------------------------------------------

async function z2(): Promise<void> {
  const phone = await Phone.open()
  if (flag('step') === 'c6') {
    // ⓒ 보충 — 본문 **끝**이 공백·줄바꿈인 글(앞 회차 c5 는 뒤에 안내 글이 붙어 끝 공백을 보지 못했다). 기대: 앞뒤 SPACE·TAB·CR·LF 를 뗀 글로 1건(정규화 규칙).
    for (const name of ['cm', 'xm', 'gm']) {
      const info = paneOf(name)
      await waitIdle(info)
      const text = `   reply OK only l582f-z2c-c6-${name}   \n `
      const result = await sendOnce({ phone, info, text, marker: `z2c-c6-${name}` })
      const row = matches(info, text).rows[0]
      out(`Z2c-c6-${name}`, { kind: info.kind, ...sendView(result), recordLeading: row?.text === null || row === undefined ? null : (row.text.match(/^[ \t\r\n]*/)?.[0].length ?? 0), recordTrailing: row?.text === null || row === undefined ? null : (row.text.match(/[ \t\r\n]*$/)?.[0].length ?? 0) }, result.final?.state === 'delivered' && result.record === 1)
    }
    await phone.close()
    return
  }
  if (flag('step') === 'ghost' || flag('step') === 'dgrok') {
    try {
      if (flag('step') === 'ghost') await z2Ghost(phone)
      else {
        // ⓓ Grok 다시(고친 코드 ba187246c) — 문장 모양은 원래 계획 그대로(제안이 뜨는 조건 유지), 표지만 z2d2.
        for (let round = 0; round < 4; round += 1) {
          for (const name of ['gm', 'gu']) {
            const info = paneOf(name)
            await waitIdle(info)
            const before = ghostOf(await screen(info.paneId))
            const result = await sendOnce({ phone, info, text: `${M(`l582f-z2d2-${round}-${name}`)} reply with OK only`, marker: `z2d2-${round}-${name}` })
            out(`Z2d2-${round}-${name}`, { pane: name, kind: info.kind, mode: info.mode, ghostBefore: before, ...sendView(result) }, result.final?.state === 'delivered' && result.record === 1 && result.textExact === true && result.ms !== null && result.ms <= 10_000)
          }
        }
      }
    } finally {
      await phone.close()
    }
    return
  }
  try {
    // ⓒ 문자 보존 — Claude 관리 세션에 다섯 + Codex·Grok 섞은 글 하나씩.
    const keep: { pane: string; text: string; tag: string }[] = [
      { pane: 'cm', tag: 'c1', text: '한글 보존 시험 가나다라 l582f-z2c-c1' },
      { pane: 'cm', tag: 'c2', text: '이모지 🙂👍🏽 시험 l582f-z2c-c2' },
      { pane: 'cm', tag: 'c3', text: '여러 줄 l582f-z2c-c3\n둘째 줄\n셋째 줄' },
      { pane: 'cm', tag: 'c4', text: '탭\t사이 l582f-z2c-c4' },
      { pane: 'cm', tag: 'c5', text: '   앞뒤 공백 l582f-z2c-c5   ' },
      { pane: 'xm', tag: 'x1', text: '한글 🙂 l582f-z2c-x1\n둘째 줄\t탭' },
      { pane: 'gm', tag: 'g1', text: '한글 🙂 l582f-z2c-g1\n둘째 줄\t탭' },
    ]
    for (const item of keep) {
      const info = paneOf(item.pane)
      await waitIdle(info)
      const result = await sendOnce({ phone, info, text: `${item.text} (reply OK only)`, marker: `z2c-${item.tag}` })
      out(`Z2c-${item.tag}`, { pane: item.pane, kind: info.kind, mode: info.mode, bytes: Buffer.byteLength(item.text), ...sendView(result) }, result.final?.state === 'delivered' && result.record === 1 && result.textExact === true)
    }
    // ⓓ·ⓕ 격리 ≥ 20 — provider 셋 × 관리/관리 안 됨, 4바퀴 = 24회. 한가한 세션에 보내고 들어감까지 시각.
    const names = ['cm', 'cu', 'xm', 'xu', 'gm', 'gu']
    for (let round = 0; round < 4; round += 1) {
      for (const name of names) {
        const info = paneOf(name)
        await waitIdle(info)
        const result = await sendOnce({ phone, info, text: `l582f-z2d-${round}-${name} reply with OK only`, marker: `z2d-${round}-${name}` })
        out(`Z2d-${round}-${name}`, { pane: name, kind: info.kind, mode: info.mode, ...sendView(result) }, result.final?.state === 'delivered' && result.record === 1 && result.ms !== null && result.ms <= 10_000)
      }
    }
    // ⓔ 소유 기록을 증명 못 하는 채널(셸에서 직접 띄운 Claude — D1) → 잠김, 기록 0. 양성 대조 = 위 ⓓ 의 관리 안 됨(agent.start) 회차.
    const shell = paneOf('cs')
    const locked = await sendOnce({ phone, info: shell, text: 'l582f-z2e-shell reply OK', marker: 'z2e-shell', waitMs: 30_000, settleMs: 5000 })
    out('Z2e-shell', { pane: 'cs', ...sendView(locked) }, locked.final?.state === 'failed' && locked.record === 0)
  } finally {
    await phone.close()
  }
}

const ESC = String.fromCharCode(27)
const ITALIC = new RegExp(`${ESC}\\[3m(?:${ESC}\\[[0-9;]*m)*([^${ESC}]*)`, 'g')
/** Grok 입력칸 제안(ghost) — 상자 안 기울임(SGR 3) run 의 글자 수와 상자 아래 `accept suggestion` 힌트(제안 글 자체는 남기지 않는다). */
function ghostOf(ansi: string): { italicChars: number; hint: boolean; draft: string } {
  const lines = ansi.split(/\r?\n/)
  const plain = screenPlain(ansi).split('\n')
  let at = -1
  plain.forEach((line, index) => { if (/^\s*│ ❯/.test(line)) at = index })
  let italicChars = 0
  let end = at
  for (let index = at; at >= 0 && index < plain.length && !/^\s*╰/.test(plain[index]!); index += 1) {
    end = index + 1
    for (const match of (lines[index] ?? '').matchAll(ITALIC)) italicChars += [...(match[1] ?? '')].length
  }
  const below = (plain[end + 1] ?? '').trim().length === 0 ? end + 2 : end + 1
  return { italicChars, hint: /accept suggestion/.test(plain[below] ?? ''), draft: draftState({ kind: 'grok', screen: ansi }) }
}

async function waitGhost(info: PaneInfo, timeoutMs = 20_000): Promise<{ italicChars: number; hint: boolean; draft: string }> {
  const until = Date.now() + timeoutMs
  let last = ghostOf(await screen(info.paneId))
  while (Date.now() < until && !(last.italicChars > 0 && last.hint)) {
    await delay(500)
    last = ghostOf(await screen(info.paneId))
  }
  return last
}

/** 최종 관문 ghost 수정 실물: 제안이 뜬 상태에서 폰 지시 delivered(합쳐진 글 0) + 사람 초안이 있으면 mac_draft 거절(양성 대조). */
async function z2Ghost(phone: Phone): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const name of ['gm', 'gu']) {
      const info = paneOf(name)
      await waitIdle(info)
      const before = await waitGhost(info)
      const text = `${M(`l582f-z2g-${round}-${name}`)} reply with OK only`
      const result = await sendOnce({ phone, info, text, marker: `z2g-${round}-${name}` })
      out(`Z2g-${round}-${name}`, { pane: name, ghostBefore: before, ...sendView(result) }, before.italicChars > 0 && before.hint && result.final?.state === 'delivered' && result.record === 1 && result.textExact === true)
    }
  }
  // 양성 대조 — 사람이 친 글(데스크톱 키, Enter 없음)이 있으면 거절, 기록 0. 끝나면 그 글을 지운다.
  const info = paneOf('gm')
  await waitIdle(info)
  const typed = 'human draft l582f'
  await desktopKeys(info.paneId, typed)
  await delay(1500)
  const before = ghostOf(await screen(info.paneId))
  const result = await sendOnce({ phone, info, text: `${M('l582f-z2g-pos-gm')} reply with OK only`, marker: 'z2g-pos-gm', waitMs: 30_000, settleMs: 3000 })
  await desktopKeys(info.paneId, '\x7f'.repeat(typed.length + 2))
  await delay(1500)
  const after = ghostOf(await screen(info.paneId))
  out('Z2g-pos-gm', { pane: 'gm', before, ...sendView(result), cleared: after }, before.draft === 'draft' && result.final?.state === 'failed' && result.final.reason === 'mac_draft' && result.record === 0 && markerRows(info, M('l582f-z2g-pos-gm')) === 0)
}

// --- Z3 작업 중 큐 · 취소 · 상한 · 끔/닫힘/재시작 ---------------------------------------------------------------

const LONG = (tag: string): string => `Run the shell command \`sleep 14\` in the foreground and wait for it, then reply with the single word DONE. ${tag}`
async function startLong(phone: Phone, info: PaneInfo, tag: string): Promise<SendResult> {
  await waitIdle(info)
  const result = await sendOnce({ phone, info, text: LONG(tag), marker: tag, settleMs: 300 })
  await waitStatus(info.paneId, (agent) => agent.status === 'working', 30_000)
  await delay(1500)
  return result
}
/** 그 표지 글이 기록에서 몇 번째 줄인가(같은 파일 안 순서) · 긴 작업의 끝(`DONE` 이 든 assistant 줄) 위치. */
function orderOf(info: PaneInfo, markers: string[], longTag: string): Record<string, number | null> {
  const rows = rowsOf(info)
  const at: Record<string, number | null> = {}
  const longRow = rows.findIndex((row) => row.role === 'user' && row.text !== null && row.text.includes(longTag))
  const done = rows.findIndex((row, index) => index > longRow && row.role === 'assistant' && JSON.stringify(row.raw).includes('DONE'))
  at.longPrompt = longRow < 0 ? null : longRow
  at.longDone = done < 0 ? null : done
  for (const marker of markers) {
    const index = rows.findIndex((row) => row.role === 'user' && row.text !== null && row.text.includes(marker))
    at[marker] = index < 0 ? null : index
  }
  return at
}

async function z3(): Promise<void> {
  const step = flag('step')
  let phone = await Phone.open()
  const info = paneOf('cm')
  try {
    if (step === null || step === 'a') {
      // ⓐ 작업 중 2건 → queued → 턴 끝난 뒤 순서대로 각 1건, 끼어들기 0.
      const long = await startLong(phone, info, M('l582f-z3a-long'))
      const ids = [M('l582f-z3a-1'), M('l582f-z3a-2')].map((marker) => ({ marker, id: newId(marker), text: `${marker} reply OK only` }))
      for (const item of ids) phone.send({ type: 'input.send', id: item.id, channel: info.paneId, text: item.text })
      const queued = await Promise.all(ids.map((item) => phone.waitFor(item.id, (wire) => wire.state === 'queued' && wire.wait === 'turn', 5000)))
      const finals = await Promise.all(ids.map((item) => phone.final(item.id, 120_000)))
      await delay(2000)
      const order = orderOf(info, ids.map((item) => item.marker), M('l582f-z3a-long'))
      const counts = ids.map((item) => matches(info, item.text).count)
      const longDone = order.longDone ?? null
      const firstAt = order[M('l582f-z3a-1')] ?? null
      const secondAt = order[M('l582f-z3a-2')] ?? null
      const inOrder = longDone !== null && firstAt !== null && secondAt !== null && longDone < firstAt && firstAt < secondAt
      out('Z3a', { long: sendView(long), states: ids.map((item) => (phone.states.get(item.id) ?? []).map((wire) => `${wire.state}${wire.wait === null ? '' : `:${wire.wait}`}`)), queued: queued.map((wire) => wire?.state ?? null), finals: finals.map((wire) => wire?.state ?? null), deliveredAt: finals.map((wire) => wire?.at ?? null), records: counts, order }, ids.every((item) => (phone.states.get(item.id) ?? []).some((wire) => wire.state === 'queued' && wire.wait === 'turn')) && finals.every((wire) => wire?.state === 'delivered') && counts.every((count) => count === 1) && inOrder)
    }
    if (step === null || step === 'b') {
      // ⓑ 대기 중 취소 → 기록 0, 취소 안 한 것은 들어감 · ⓒ 들어간 뒤 취소 → 상태 그대로(넣기 시작한 뒤 취소 없음).
      await startLong(phone, info, M('l582f-z3b-long'))
      const keep = { marker: M('l582f-z3b-keep'), id: newId('z3b-keep') }
      const drop = { marker: M('l582f-z3b-drop'), id: newId('z3b-drop') }
      phone.send({ type: 'input.send', id: drop.id, channel: info.paneId, text: `${drop.marker} reply OK only` })
      phone.send({ type: 'input.send', id: keep.id, channel: info.paneId, text: `${keep.marker} reply OK only` })
      await phone.waitFor(drop.id, (wire) => wire.state === 'queued', 5000)
      phone.send({ type: 'input.cancel', id: drop.id })
      const dropFinal = await phone.final(drop.id, 10_000)
      const keepFinal = await phone.final(keep.id, 120_000)
      await delay(2000)
      const dropCount = markerRows(info, drop.marker)
      const keepCount = matches(info, `${keep.marker} reply OK only`).count
      out('Z3b', { drop: dropFinal?.state ?? null, keep: keepFinal?.state ?? null, records: { drop: dropCount, keep: keepCount } }, dropFinal?.state === 'cancelled' && keepFinal?.state === 'delivered' && dropCount === 0 && keepCount === 1)
      const before = phone.states.get(keep.id)?.length ?? 0
      phone.send({ type: 'input.cancel', id: keep.id })
      await delay(1500)
      const after = (phone.states.get(keep.id) ?? []).slice(before).map((wire) => wire.state)
      out('Z3c', { cancelAfterDelivered: after, record: matches(info, `${keep.marker} reply OK only`).count }, after.length >= 1 && after.every((state) => state === 'delivered') && matches(info, `${keep.marker} reply OK only`).count === 1)
    }
    if (step === null || step === 'd') {
      // ⓓ 상한 — 대기 5건 + 6번째 → queue_full. 나머지는 취소(정리), 기록 0.
      await startLong(phone, info, M('l582f-z3d-long'))
      const items = Array.from({ length: 6 }, (_, index) => ({ marker: `l582f-z3d-${index}`, id: newId(`z3d-${index}`) }))
      for (const item of items) {
        phone.send({ type: 'input.send', id: item.id, channel: info.paneId, text: `${item.marker} reply OK only` })
        await delay(120)
      }
      const sixth = await phone.final(items[5]!.id, 5000)
      for (const item of items.slice(0, 5)) phone.send({ type: 'input.cancel', id: item.id })
      const rest = await Promise.all(items.slice(0, 5).map((item) => phone.final(item.id, 10_000)))
      await waitIdle(info)
      await delay(3000)
      const records = items.map((item) => markerRows(info, item.marker))
      out('Z3d', { sixth: sixth === null ? null : `${sixth.state}/${sixth.reason}`, rest: rest.map((wire) => wire?.state ?? null), records }, sixth?.state === 'failed' && sixth.reason === 'queue_full' && rest.every((wire) => wire?.state === 'cancelled') && records.every((count) => count === 0))
    }
    if (step === null || step === 'e1') {
      // ⓔ 모바일 끔 → 큐 지시 failed/mobile_off · 다시 켜도 나중에 들어가지 않음.
      await startLong(phone, info, M('l582f-z3e1-long'))
      const item = { marker: M('l582f-z3e1-q'), id: newId('z3e1') }
      phone.send({ type: 'input.send', id: item.id, channel: info.paneId, text: `${item.marker} reply OK only` })
      await phone.waitFor(item.id, (wire) => wire.state === 'queued', 5000)
      const off = execFileSync(process.execPath, [path.join(APP, 'scripts/l582/final-ctl.mjs'), 'mobile', 'off', '--root', ROOT, '--fake', ROOT.replace('/l582g-z', '/l582g-fz')], { cwd: APP, encoding: 'utf8' }).trim()
      await delay(1000)
      const on = execFileSync(process.execPath, [path.join(APP, 'scripts/l582/final-ctl.mjs'), 'mobile', 'on', '--root', ROOT, '--fake', ROOT.replace('/l582g-z', '/l582g-fz')], { cwd: APP, encoding: 'utf8' }).trim()
      phone.terminate()
      phone = await Phone.open()
      phone.send({ type: 'input.status', ids: [item.id] })
      const state = await phone.final(item.id, 10_000)
      await waitIdle(info)
      await delay(20_000)
      const count = markerRows(info, item.marker)
      out('Z3e-mobile-off', { off, on, state: state === null ? null : `${state.state}/${state.reason}`, recordAfter20s: count }, state !== null && state.state === 'failed' && count === 0)
    }
    if (step === null || step === 'e2') {
      // ⓔ pane 닫힘 — 따로 만든 Claude(agent.start) pane 을 닫는다.
      const extra = paneOf('cu')
      await startLong(phone, extra, M('l582f-z3e2-long'))
      const item = { marker: M('l582f-z3e2-q'), id: newId('z3e2') }
      phone.send({ type: 'input.send', id: item.id, channel: extra.paneId, text: `${item.marker} reply OK only` })
      await phone.waitFor(item.id, (wire) => wire.state === 'queued', 5000)
      await own(extra.paneId)
      await herdr('pane.close', { pane_id: extra.paneId })
      const state = await phone.final(item.id, 20_000)
      await delay(20_000)
      const count = markerRows(extra, item.marker)
      out('Z3e-pane-closed', { state: state === null ? null : `${state.state}/${state.reason}`, recordAfter20s: count }, state !== null && state.state === 'failed' && count === 0)
    }
  } finally {
    await phone.close()
  }
}

/** ⓔ 맥 앱 재시작 — 큐에 하나 넣고(앞 단계) 앱을 내렸다 올린 뒤(밖에서 g-down/g-up) 조회 · 기록. `z3restart --phase before|after`. */
async function z3restart(): Promise<void> {
  const phase = flag('phase')
  const info = paneOf('cm')
  const stateFile = path.join(ROOT, 'z3restart.json')
  if (phase === 'before') {
    const phone = await Phone.open()
    await startLong(phone, info, M('l582f-z3e3-long'))
    const item = { marker: M('l582f-z3e3-q'), id: newId('z3e3') }
    phone.send({ type: 'input.send', id: item.id, channel: info.paneId, text: `${item.marker} reply OK only` })
    const queued = await phone.waitFor(item.id, (wire) => wire.state === 'queued', 5000)
    fs.writeFileSync(stateFile, JSON.stringify(item))
    out('Z3e-restart-before', { queued: queued?.state ?? null, wait: queued?.wait ?? null }, queued !== null)
    await phone.close()
    return
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const item = isRecord(parsed) ? { marker: str(parsed.marker) ?? '', id: str(parsed.id) ?? '' } : { marker: '', id: '' }
  const phone = await Phone.open()
  phone.send({ type: 'input.status', ids: [item.id] })
  const state = await phone.final(item.id, 10_000)
  await waitIdle(info)
  await delay(20_000)
  const count = markerRows(info, item.marker)
  out('Z3e-app-restart', { state: state === null ? null : `${state.state}/${state.reason}`, recordAfter20s: count }, state !== null && (state.state === 'unknown' || state.state === 'failed') && count === 0)
  await phone.close()
}

// --- Z4 질문 답 ---------------------------------------------------------------------------------------------

type Ask = { tag: string; prompt: string; answers: { choices: number[]; other: string | null }[]; expect: string[] }
const CLAUDE_ASKS: Ask[] = [
  { tag: 'single', prompt: 'Call AskUserQuestion once: one question "Pick a color", single select, options Red, Green, Blue with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [1], other: null }], expect: ['Green'] },
  { tag: 'multi', prompt: 'Call AskUserQuestion once: one question "Pick fruits", multiSelect true, options Apple, Banana, Cherry with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [0, 2], other: null }], expect: ['Apple', 'Cherry'] },
  { tag: 'questions', prompt: 'Call AskUserQuestion once with TWO questions: "Pick pet" (single select: Cat, Dog) and "Pick city" (single select: Seoul, Busan), short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [1], other: null }, { choices: [0], other: null }], expect: ['Dog', 'Seoul'] },
  { tag: 'other', prompt: 'Call AskUserQuestion once: one question "Pick a drink", single select, options Tea, Coffee with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [], other: '우유 milk' }], expect: ['우유 milk'] },
]

/** 기록의 그 질문 답(도구 결과) 값 — Claude `toolUseResult.answers` 값들 · Codex 봉투 answer · Grok 메시지. 모양 검사 전용(본문 저장 안 함). */
function answerText(info: PaneInfo, call: string): string | null {
  for (const row of rowsOf(info)) {
    const raw = JSON.stringify(row.raw)
    if (!raw.includes(call)) continue
    if (info.kind === 'claude' && isRecord(row.raw.toolUseResult) && isRecord(row.raw.toolUseResult.answers)) return JSON.stringify(row.raw.toolUseResult.answers)
    if (info.kind === 'grok' && raw.includes('UserAnswered')) return raw
    if (info.kind === 'codex' && raw.includes('question_reply')) return raw
  }
  if (info.kind === 'codex') {
    const hits = rowsOf(info).filter((row) => JSON.stringify(row.raw).includes(call) && JSON.stringify(row.raw).includes('question_reply'))
    return hits.length > 0 ? hits.map((row) => JSON.stringify(row.raw)).join('\n') : null
  }
  return null
}

async function askAndAnswer(input: { phone: Phone; info: PaneInfo; ask: Ask; label: string; ok?: (answer: Wire | null, value: string | null, status: string) => boolean }): Promise<{ question: QuestionInfo | null; answer: Wire | null; value: string | null }> {
  const { phone, info, ask, label } = input
  await waitIdle(info)
  phone.subscribe(info.paneId)
  await delay(800)
  const seen = new Set([...(phone.questions.get(info.paneId)?.keys() ?? [])])
  const prompt = await sendOnce({ phone, info, text: ask.prompt, marker: `${label}-ask`, settleMs: 300 })
  const question = await phone.pendingQuestion(info.paneId, seen, 90_000)
  if (question === null) {
    out(label, { prompt: sendView(prompt), question: null }, false)
    return { question: null, answer: null, value: null }
  }
  await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 30_000)
  // 답 직전 채널 상태 — 폰 카드는 질문 대기(blocked)일 때만 열린다(최종 관문 codex ended-turn lock 5db1828d9).
  const statusAtAnswer = (await agentOf(info.paneId)).status
  const id = newId(label)
  phone.send({ type: 'question.answer', id, channel: info.paneId, question: question.id, call: question.call, digest: question.digest, answers: ask.answers })
  const answer = await phone.final(id, 60_000)
  await delay(1500)
  const value = question.call === null ? null : answerText(info, question.call)
  const resolved = phone.questions.get(info.paneId)?.get(question.id)?.state ?? null
  const hits = ask.expect.map((label2) => value !== null && value.includes(label2))
  const ok = input.ok !== undefined ? input.ok(answer, value, statusAtAnswer) : answer?.state === 'delivered' && hits.every(Boolean) && resolved === 'answered'
  out(label, { kind: info.kind, mode: info.mode, statusAtAnswer, prompt: prompt.final?.state ?? null, questionId: question.id, questions: question.count, answer: answer === null ? null : `${answer.state}/${answer.reason}`, ms: answer === null ? null : answer.at - (phone.states.get(id)?.[0]?.at ?? answer.at), recordHasExpected: hits, questionState: resolved }, ok)
  return { question, answer, value }
}

async function z4(): Promise<void> {
  const phone = await Phone.open()
  const step = flag('step')
  try {
    if (step === null || step === 'a') {
      // ⓐ Claude 하나·여럿·여러 문항·직접 입력 각 2회(관리 1 + 관리 안 됨 1).
      for (const name of ['cm', 'cu']) for (const ask of CLAUDE_ASKS) await askAndAnswer({ phone, info: paneOf(name), ask, label: `Z4a-${ask.tag}-${name}` })
    }
    if (step === null || step === 'b') {
      // ⓑ 늦은 답 ① 이미 답한 질문에 다시 → question_closed, 기록의 답 그대로 1건.
      const info = paneOf('cm')
      const first = await askAndAnswer({ phone, info, ask: CLAUDE_ASKS[0]!, label: 'Z4b-control' })
      if (first.question !== null) {
        const id = newId('z4b-late')
        phone.send({ type: 'question.answer', id, channel: info.paneId, question: first.question.id, call: first.question.call, digest: first.question.digest, answers: [{ choices: [2], other: null }] })
        const late = await phone.final(id, 30_000)
        await delay(2000)
        const value = first.question.call === null ? null : answerText(info, first.question.call)
        out('Z4b-late-closed', { answer: late === null ? null : `${late.state}/${late.reason}`, recordStillFirst: value !== null && value.includes('Green') && !value.includes('Blue') }, late?.state === 'failed' && value !== null && !value.includes('Blue'))
      }
      // ② 다른 질문으로 바뀜 — 질문 A 를 데스크톱이 답하고(맥 사용자 키 `1`) 새 질문 B 가 열린 뒤 폰이 A 에 답 → 넣지 않음.
      await waitIdle(info)
      phone.subscribe(info.paneId)
      await delay(800)
      const seen = new Set([...(phone.questions.get(info.paneId)?.keys() ?? [])])
      await sendOnce({ phone, info, text: CLAUDE_ASKS[0]!.prompt, marker: 'z4b2-ask-a', settleMs: 300 })
      const a = await phone.pendingQuestion(info.paneId, seen, 90_000)
      await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 30_000)
      await delay(800)
      await desktopKeys(info.paneId, '1')
      await waitIdle(info)
      seen.add(a?.id ?? -1)
      await sendOnce({ phone, info, text: CLAUDE_ASKS[2]!.prompt, marker: 'z4b2-ask-b', settleMs: 300 })
      const b = await phone.pendingQuestion(info.paneId, seen, 90_000)
      await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 30_000)
      const before = await screen(info.paneId)
      const id = newId('z4b-other')
      phone.send({ type: 'question.answer', id, channel: info.paneId, question: a?.id ?? -1, call: a?.call ?? null, digest: a?.digest ?? null, answers: [{ choices: [1], other: null }] })
      const late = await phone.final(id, 30_000)
      await delay(1500)
      const after = await screen(info.paneId)
      out('Z4b-late-replaced', { a: a?.id ?? null, b: b?.id ?? null, answer: late === null ? null : `${late.state}/${late.reason}`, screenUnchanged: screenPlain(before) === screenPlain(after), bStillPending: phone.questions.get(info.paneId)?.get(b?.id ?? -1)?.state ?? null }, a !== null && b !== null && late?.state === 'failed' && screenPlain(before) === screenPlain(after))
      // ⓒ 질문이 열린 동안 보낸 일반 지시 → 질문에 들어가지 않음(큐에 머묾) → 취소, 기록 0 · 질문 그대로.
      const general = { marker: M('l582f-z4c-general'), id: newId('z4c') }
      phone.send({ type: 'input.send', id: general.id, channel: info.paneId, text: `${general.marker} hello` })
      const waiting = await phone.waitFor(general.id, (wire) => wire.state === 'queued' || FINAL.has(wire.state), 5000)
      await delay(4000)
      const stillBlocked = await agentOf(info.paneId)
      phone.send({ type: 'input.cancel', id: general.id })
      const cancelled = await phone.final(general.id, 10_000)
      const afterGeneral = await screen(info.paneId)
      out('Z4c-general-during-question', { first: waiting === null ? null : `${waiting.state}:${waiting.wait}`, status: stillBlocked.status, cancelled: cancelled?.state ?? null, record: markerRows(info, general.marker), screenUnchanged: screenPlain(after) === screenPlain(afterGeneral) }, waiting?.state === 'queued' && stillBlocked.status === 'blocked' && cancelled?.state === 'cancelled' && markerRows(info, general.marker) === 0 && screenPlain(after) === screenPlain(afterGeneral))
      // 정리 — B 를 폰으로 답한다(양성 대조 하나 더).
      if (b !== null) {
        const id2 = newId('z4b-b')
        phone.send({ type: 'question.answer', id: id2, channel: info.paneId, question: b.id, call: b.call, digest: b.digest, answers: CLAUDE_ASKS[2]!.answers })
        const done = await phone.final(id2, 60_000)
        out('Z4b-b-answered', { answer: done === null ? null : `${done.state}/${done.reason}` }, done?.state === 'delivered')
      }
    }
    if (step === 'codexreply') {
      // D10 — 턴 끝난 Codex 질문에 폰(InputHub) **일반 지시**로 답 → delivered + Codex 가 그 답으로 이어 가는지(다음 응답에 고른 말).
      const info = paneOf('xm')
      await waitIdle(info)
      phone.subscribe(info.paneId)
      await delay(800)
      const seen = new Set([...(phone.questions.get(info.paneId)?.keys() ?? [])])
      const tag = M('l582f-z4r')
      const ask = await sendOnce({ phone, info, text: `Use request_user_input_async once with ONE question "Pick a word" (options Apple, Banana). No other tools. When I tell you my pick, reply with exactly that word in uppercase. ${tag}`, marker: `${tag}-ask`, settleMs: 300 })
      const question = await phone.pendingQuestion(info.paneId, seen, 90_000)
      const ended = await waitStatus(info.paneId, (agent) => agent.status === 'done' || agent.status === 'idle', 60_000)
      // 폰 카드 잠금의 근거 = 목록 상태(질문 대기 아님). 서버 판정과 같은 agent 상태를 남긴다.
      const reply = await sendOnce({ phone, info, text: `My pick: Banana ${tag}`, marker: `${tag}-reply` })
      await waitIdle(info)
      await delay(3000)
      const after = rowsOf(info).filter((row) => row.text !== null)
      const records = recordFiles(info)
      const tail = records.length === 0 ? '' : fs.readFileSync(records[records.length - 1]!, 'utf8').split('\n').slice(-40).join('\n')
      const continued = /BANANA/.test(tail)
      out('Z4r-codex-reply-as-instruction', { ask: sendView(ask), questionId: question?.id ?? null, statusAfterTurn: ended?.status ?? null, questionState: question === null ? null : (phone.questions.get(info.paneId)?.get(question.id)?.state ?? null), reply: sendView(reply), userRows: after.length, continuedWithAnswer: continued }, question !== null && ended !== null && reply.final?.state === 'delivered' && reply.record === 1 && continued)
    }
    if (step === 'dcodex') {
      // ⓓ Codex 다시(고친 코드 5db1828d9) — ① 원래 프롬프트(턴이 끝남): 채널은 질문을 기다리지 않음 → 폰 카드 잠김, 그래도 보낸 답은 거절·기록에 답 0
      // ② 턴이 질문을 기다리는 프롬프트(r3 방식) → delivered + 기록의 답 값.
      const ended = (answer: Wire | null, value: string | null, status: string): boolean => status !== 'blocked' && answer?.state === 'failed' && (value === null || value === '')
      for (const name of ['xm', 'xu']) {
        await askAndAnswer({
          phone, info: paneOf(name), label: `Z4d2-codex3-ended-${name}`, ok: ended,
          ask: { tag: 'codex3', prompt: `Use request_user_input_async once with THREE questions: "Pick tea" (options Green, Black), "Pick snack" (options Cookie, Cake), "Pick time" (options Now, Later). No other tools. After I answer reply OK. ${M('l582f-z4d2')}`, answers: [{ choices: [0], other: null }, { choices: [1], other: null }, { choices: [0], other: null }], expect: [] },
        })
      }
      await askAndAnswer({ phone, info: paneOf('xm'), label: 'Z4e2-codex-other-ended', ok: ended, ask: { tag: 'codex-other', prompt: `Use request_user_input_async once with ONE question "Pick a word" (options Yes, No). No other tools. After I answer reply OK. ${M('l582f-z4e2')}`, answers: [{ choices: [], other: 'free text' }], expect: [] } })
      for (const name of ['xm', 'xu']) {
        await askAndAnswer({
          phone, info: paneOf(name), label: `Z4d2-codex3-wait-${name}`,
          ask: { tag: 'codex3w', prompt: `Use request_user_input_async now with THREE questions: "Pick tea" (options Green, Black), "Pick snack" (options Cookie, Cake), "Pick time" (options Now, Later). No other tools. Wait for the answer, then reply OK. ${M('l582f-z4d2w')}`, answers: [{ choices: [0], other: null }, { choices: [1], other: null }, { choices: [0], other: null }], expect: ['Green', 'Cake', 'Now'] },
        })
      }
      await askAndAnswer({ phone, info: paneOf('xm'), label: 'Z4e2-codex-other-wait', ask: { tag: 'codex-otherw', prompt: `Use request_user_input_async now with ONE question "Pick a word" (options Yes, No). No other tools. Wait for the answer, then reply OK. ${M('l582f-z4e2w')}`, answers: [{ choices: [], other: 'free text' }], expect: ['free text'] } })
    }
    if (step === null || step === 'd') {
      // ⓓ Codex 3문항(D2 펼치기 포함) · Grok 하나 고름 + 직접 입력(ⓔ — provider 신호대로 열림).
      for (const name of ['xm', 'xu']) {
        await askAndAnswer({
          phone, info: paneOf(name), label: `Z4d-codex3-${name}`,
          ask: { tag: 'codex3', prompt: 'Use request_user_input_async once with THREE questions: "Pick tea" (options Green, Black), "Pick snack" (options Cookie, Cake), "Pick time" (options Now, Later). No other tools. After I answer reply OK.', answers: [{ choices: [0], other: null }, { choices: [1], other: null }, { choices: [0], other: null }], expect: ['Green', 'Cake', 'Now'] },
        })
      }
      for (const name of ['gm', 'gu']) {
        await askAndAnswer({ phone, info: paneOf(name), label: `Z4d-grok-select-${name}`, ask: { tag: 'grok', prompt: 'Call ask_user_question once: one question "Pick a color", single select, options Red, Green, Blue with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [1], other: null }], expect: ['Green'] } })
      }
      await askAndAnswer({ phone, info: paneOf('gm'), label: 'Z4e-grok-other', ask: { tag: 'grok-other', prompt: 'Call ask_user_question once: one question "Pick a word", single select, options Yes, No with short descriptions. No other tools. After I answer say OK.', answers: [{ choices: [], other: '직접 hello' }], expect: ['직접 hello'] } })
      await askAndAnswer({ phone, info: paneOf('xm'), label: 'Z4e-codex-other', ask: { tag: 'codex-other', prompt: 'Use request_user_input_async once with ONE question "Pick a word" (options Yes, No). No other tools. After I answer reply OK.', answers: [{ choices: [], other: 'free text' }], expect: [] }, ok: (answer) => answer !== null && FINAL.has(answer.state) })
    }
  } finally {
    await phone.close()
  }
}

// --- Z5 중단 -------------------------------------------------------------------------------------------------

type Snapshot = { agent: Agent; lastRecordAt: string | null; screenTail: string }
async function snap(info: PaneInfo): Promise<Snapshot> {
  const agent = await agentOf(info.paneId)
  const last = lastRowTime(info)
  const plain = screenPlain(await screen(info.paneId)).split('\n').filter((line) => line.trim() !== '')
  return { agent, lastRecordAt: last === null ? null : new Date(last).toISOString(), screenTail: plain.slice(-3).join(' ⏎ ').slice(0, 240) }
}

async function z5(): Promise<void> {
  const phone = await Phone.open()
  try {
    // ⓐ provider 별 작업 중 중단 각 3회 — ≤ 5초 · 세션 생존. C7: 직전·직후 agent.get(상태·seq·세션)·기록 끝 시각.
    for (const name of ['cm', 'cu', 'xm', 'xu', 'gm', 'gu']) {
      const info = paneOf(name)
      const rounds = name.endsWith('m') ? 2 : 1
      for (let round = 0; round < rounds; round += 1) {
        await startLong(phone, info, `l582f-z5a-${name}-${round}`)
        const before = await snap(info)
        const id = newId(`z5a-${name}`)
        const t0 = Date.now()
        phone.send({ type: 'turn.stop', id, channel: info.paneId })
        const final = await phone.final(id, 15_000)
        const ms = final === null ? null : final.recvAt - t0
        await delay(1500)
        const after = await snap(info)
        const alive = (await terminal.process(await own(info.paneId), ctx())).foreground.map((entry) => String(entry.name))
        const sessionSame = before.agent.session !== null && before.agent.session === after.agent.session
        out(`Z5a-${name}-${round}`, { kind: info.kind, mode: info.mode, stop: final === null ? null : `${final.state}/${final.reason}`, ms, before, after, foreground: alive, sessionSame }, final?.state === 'stopped' && ms !== null && ms <= 5000 && after.agent.status !== 'working' && sessionSame && alive.length > 0 && !alive.every((entry) => /^(zsh|bash|sh|-zsh)$/.test(entry)))
        await waitIdle(info, 60_000)
      }
    }
    // ⓑ 한가에 중단 → 키 넣지 않음(not_running) · 세션 생존 · 화면 무변경.
    for (const name of ['cm', 'xm', 'gm']) {
      const info = paneOf(name)
      await waitIdle(info)
      const before = await snap(info)
      const screenBefore = screenPlain(await screen(info.paneId))
      const id = newId(`z5b-${name}`)
      phone.send({ type: 'turn.stop', id, channel: info.paneId })
      const final = await phone.final(id, 10_000)
      await delay(1500)
      const after = await snap(info)
      const screenAfter = screenPlain(await screen(info.paneId))
      out(`Z5b-idle-${name}`, { stop: final === null ? null : `${final.state}/${final.reason}`, seqBefore: before.agent.seq, seqAfter: after.agent.seq, screenUnchanged: screenBefore === screenAfter, sessionSame: before.agent.session === after.agent.session }, final?.state === 'failed' && final.reason === 'not_running' && screenBefore === screenAfter && before.agent.session === after.agent.session)
    }
  } finally {
    await phone.close()
  }
}

// --- Z5ⓔ 권한 대기 -------------------------------------------------------------------------------------------

async function z5e(): Promise<void> {
  const phone = await Phone.open()
  try {
    for (const name of (flag('names') ?? 'cu,xu,gu').split(',')) {
      const info = paneOf(name)
      await waitIdle(info)
      const prompt = `Create an empty file named l582f-z5e-${name}.txt in the current directory using a shell command (touch). l582f-z5e-${name}`
      await sendOnce({ phone, info, text: prompt, marker: `z5e-${name}`, settleMs: 300 })
      const blocked = await waitStatus(info.paneId, (agent) => agent.status === 'blocked', 40_000)
      const before = await snap(info)
      const id = newId(`z5e-${name}`)
      phone.send({ type: 'turn.stop', id, channel: info.paneId })
      const final = await phone.final(id, 15_000)
      await delay(2000)
      const after = await snap(info)
      const fileMade = fs.existsSync(path.join(info.repo, `l582f-z5e-${name}.txt`))
      out(`Z5e-${name}`, { kind: info.kind, sawBlocked: blocked !== null, stop: final === null ? null : `${final.state}/${final.reason}`, before, after, fileMade }, blocked !== null && final !== null && FINAL.has(final.state))
      if (after.agent.status === 'blocked') {
        // 아직 권한을 묻고 있으면 데스크톱 사용자가 거절(Esc) — 다음 회차를 위한 정리.
        await desktopKeys(info.paneId, '\x1b')
      }
      await waitIdle(info, 90_000)
    }
  } finally {
    await phone.close()
  }
}

// --- Z6 재연결 --------------------------------------------------------------------------------------------

async function z6(): Promise<void> {
  // ⓐ 보낸 직후 끊김 → 재연결 → 같은 id 조회로 상태 확정, 재주입 0. provider 셋.
  for (const name of ['cm', 'xm', 'gm']) {
    const info = paneOf(name)
    await waitIdle(info)
    const first = await Phone.open()
    const marker = `l582f-z6a-${name}`
    const text = `${marker} reply OK only`
    const id = newId(`z6a-${name}`)
    first.send({ type: 'input.send', id, channel: info.paneId, text })
    await delay(30)
    first.terminate()
    await delay(12_000)
    const second = await Phone.open()
    second.send({ type: 'input.status', ids: [id] })
    const state = await second.final(id, 30_000)
    // 같은 id 를 다시 보내도 다시 넣지 않는다.
    second.send({ type: 'input.send', id, channel: info.paneId, text })
    await delay(8000)
    const count = matches(info, text).count
    const resend = (second.states.get(id) ?? []).map((wire) => wire.state)
    out(`Z6a-${name}`, { id, state: state === null ? null : `${state.state}/${state.reason}`, afterResend: resend, record: count }, state !== null && ((state.state === 'delivered' && count === 1) || (state.state === 'failed' && count === 0) || state.state === 'unconfirmed'))
    await second.close()
  }
  // ⓒ 서버가 모르는 id → unknown(앱 「확인하지 못했습니다」).
  const phone = await Phone.open()
  const unknownId = newId('z6c-never-sent')
  phone.send({ type: 'input.status', ids: [unknownId] })
  const unknown = await phone.final(unknownId, 10_000)
  out('Z6c-unknown-id', { state: unknown === null ? null : `${unknown.state}/${unknown.reason}` }, unknown?.state === 'unknown')
  await phone.close()
}

// --- Z7 맥 초안 섞임 -------------------------------------------------------------------------------------------

async function z7(): Promise<void> {
  const phone = await Phone.open()
  try {
    for (const name of ['cm', 'xm', 'gm']) {
      const info = paneOf(name)
      await waitIdle(info)
      const draft = `l582f-z7-draft-${name}`
      await desktopKeys(info.paneId, draft)
      await delay(1200)
      const shown = draftState({ kind: info.kind, screen: await screen(info.paneId) })
      const marker = `l582f-z7-phone-${name}`
      const result = await sendOnce({ phone, info, text: `${marker} reply OK only`, marker: `z7-${name}`, waitMs: 30_000, settleMs: 3000 })
      // 맥 초안 지우기(데스크톱 사용자의 백스페이스).
      await desktopKeys(info.paneId, '\x7f'.repeat(draft.length + 4))
      await delay(1000)
      const merged = rowsOf(info).filter((row) => row.role === 'user' && row.text !== null && (row.text.includes(marker) || row.text.includes(draft))).length
      out(`Z7-${name}`, { kind: info.kind, draftOnScreen: shown, ...sendView(result), mergedOrAnyRows: merged, draftCleared: draftState({ kind: info.kind, screen: await screen(info.paneId) }) }, result.final !== null && result.final.state === 'failed' && result.final.reason === 'mac_draft' && merged === 0)
    }
  } finally {
    await phone.close()
  }
}

// --- Z9 표면 · 제어 문자 · 상한 · 거절 --------------------------------------------------------------------------

async function z9(): Promise<void> {
  const phone = await Phone.open()
  if (flag('step') === 'revoke') {
    // ⓒ 해지·replaced 뒤 그 연결의 쓰기 0 — 양성 대조(해지 전 같은 연결 delivered) · 해지 → 연결 닫힘 · 닫힌 연결로 보내기 · 해지 토큰 재접속 거절.
    await phone.close()
    const info = paneOf('cm')
    const rev = await Phone.open(path.join(ROOT, 'sec/token-rev'))
    await waitIdle(info)
    const control = await sendOnce({ phone: rev, info, text: `${M('l582f-z9c-control')} reply OK only`, marker: 'z9c-control' })
    const device = flag('device') ?? ''
    execFileSync(process.execPath, [path.join(import.meta.dirname, '../l578/srv.mjs'), ROOT, 'revoke', device], { stdio: 'ignore' })
    for (let index = 0; index < 50 && rev.closed === null; index += 1) await delay(100)
    const after = M('l582f-z9c-after-revoke')
    let sendError: string | null = null
    try {
      rev.send({ type: 'input.send', id: newId('z9c-after'), channel: info.paneId, text: `${after} reply OK only` })
    } catch (error) {
      sendError = String(error)
    }
    let reopen: string
    try {
      const again = await Phone.open(path.join(ROOT, 'sec/token-rev'))
      reopen = `opened closed=${JSON.stringify(again.closed)}`
      await again.close()
    } catch (error) {
      reopen = `rejected ${String(error).slice(0, 80)}`
    }
    await delay(8000)
    const revokedRows = markerRows(info, after)
    out('Z9c-revoke', { control: sendView(control), closed: rev.closed, sendError: sendError === null ? null : sendError.slice(0, 80), reopen, recordAfterRevoke: revokedRows }, control.final?.state === 'delivered' && rev.closed !== null && revokedRows === 0 && reopen.startsWith('rejected'))
    // replaced — 같은 토큰 두 번째 연결이 첫 연결을 밀어낸다(4006). 밀려난 연결로 보내기 → 기록 0, 새 연결은 그대로 쓴다.
    const first = await Phone.open()
    const second = await Phone.open()
    for (let index = 0; index < 50 && first.closed === null; index += 1) await delay(100)
    const stale = M('l582f-z9c-replaced')
    try {
      first.send({ type: 'input.send', id: newId('z9c-replaced'), channel: info.paneId, text: `${stale} reply OK only` })
    } catch {
      // 닫힌 소켓 — 보내지지 않는다
    }
    await waitIdle(info)
    const fresh = await sendOnce({ phone: second, info, text: `${M('l582f-z9c-fresh')} reply OK only`, marker: 'z9c-fresh' })
    await delay(5000)
    out('Z9c-replaced', { firstClosed: first.closed, recordFromReplaced: markerRows(info, stale), fresh: sendView(fresh) }, first.closed?.code === 4006 && markerRows(info, stale) === 0 && fresh.final?.state === 'delivered')
    await second.close()
    return
  }
  if (flag('step') === 'closed') {
    // ⓓ 닫힌 세션 — Z3ⓔ2 가 cu 를 닫은 뒤에만(앞 실행 f031 은 cu 가 살아 있을 때 돌아 delivered — 측정 순서 오류).
    const channel = paneOf('cu').paneId
    const listed = (await paneList()).some((pane) => pane.paneId === channel)
    const id = newId('z9d-closed2')
    phone.send({ type: 'input.send', id, channel, text: M('l582f-z9d-closed2') })
    const final = await phone.final(id, 15_000)
    out('Z9d-closed2', { channel, paneStillListed: listed, state: final === null ? null : `${final.state}/${final.reason}` }, !listed && final?.state === 'failed')
    await phone.close()
    return
  }
  try {
    // ⓔ 본문 안 ESC · Ctrl+C · CR 이 키로 작동하지 않음 — 세션 생존 · 기록 1건(제어 문자 지운 글).
    const info = paneOf('cm')
    await waitIdle(info)
    const raw = 'l582f-z9e esc\x1b[2J ctrlc\x03 cr\r end reply OK only'
    const before = await agentOf(info.paneId)
    const result = await sendOnce({ phone, info, text: raw, marker: 'z9e' })
    const after = await agentOf(info.paneId)
    const cleaned = cleanBody(raw)
    out('Z9e-control-chars', { ...sendView(result), cleanedBytes: Buffer.byteLength(cleaned), cleanedHasControl: [...cleaned].some((char) => (char.charCodeAt(0) < 32 && char !== '\t' && char !== '\n') || char.charCodeAt(0) === 127), sessionSame: before.session === after.session }, result.final?.state === 'delivered' && result.record === 1 && before.session === after.session)
    // ⓓ 셸 pane · 목록 밖 · 닫힌 세션 → 거절.
    const shellPane = (await paneList()).find((pane) => real(pane.cwd) === real(paneOf('cm').repo) && pane.paneId !== paneOf('cm').paneId)
    for (const [label, channel] of [['shell', shellPane?.paneId ?? 'none'], ['not-listed', 'w99:p99'], ['closed', paneOf('cu').paneId]]) {
      const id = newId(`z9d-${label}`)
      phone.send({ type: 'input.send', id, channel, text: `l582f-z9d-${label}` })
      const final = await phone.final(id, 15_000)
      out(`Z9d-${label}`, { channel, state: final === null ? null : `${final.state}/${final.reason}` }, final?.state === 'failed')
    }
    // ⓖ 상한 — 65536 바이트 지시는 받음(들어감까지는 보지 않는다 — 비용), 65537 은 거절. 대상은 셸 pane(넣지 않고 not_listed 로 끝나도 크기 관문은 그 앞이다).
    const big = (bytes: number): string => `l582f-z9g ${'a'.repeat(bytes - 'l582f-z9g '.length)}`
    for (const bytes of [65536, 65537]) {
      const id = newId(`z9g-${bytes}`)
      phone.send({ type: 'input.send', id, channel: shellPane?.paneId ?? 'none', text: big(bytes) })
      const final = await phone.final(id, 15_000)
      const errors = [...phone.errors]
      out(`Z9g-${bytes}`, { bytes, state: final === null ? null : `${final.state}/${final.reason}`, errors, closed: phone.closed }, bytes === 65536 ? final !== null && final.reason !== 'too_large' : final === null || final.reason === 'too_large' || errors.length > 0)
    }
  } finally {
    await phone.close()
  }
}

// --- Z10 데스크톱 직접 입력·중단 불변(폰 연결 중) ----------------------------------------------------------------------

async function z10(): Promise<void> {
  const phone = await Phone.open()
  try {
    const info = paneOf('cm')
    phone.subscribe(info.paneId)
    await waitIdle(info)
    const text = 'l582f-z10c-desktop reply OK only'
    await desktopKeys(info.paneId, text)
    await delay(800)
    await desktopKeys(info.paneId, '\r')
    await delay(6000)
    await waitIdle(info)
    const typed = matches(info, text).count
    // 데스크톱 Esc 중단(작업 중).
    await desktopKeys(info.paneId, `${LONG('l582f-z10c-long')}`)
    await delay(800)
    await desktopKeys(info.paneId, '\r')
    await waitStatus(info.paneId, (agent) => agent.status === 'working', 30_000)
    await delay(1500)
    const t0 = Date.now()
    await desktopKeys(info.paneId, '\x1b')
    const stopped = await waitStatus(info.paneId, (agent) => agent.status !== 'working', 10_000)
    out('Z10c-desktop', { typedRecord: typed, escStoppedMs: stopped === null ? null : Date.now() - t0, status: stopped?.status ?? null, phoneErrors: phone.errors, phoneClosed: phone.closed }, typed === 1 && stopped !== null && phone.closed === null)
  } finally {
    await phone.close()
  }
}

// --- Z6ⓕ 표 -------------------------------------------------------------------------------------------------

function table(): void {
  if (OUT === null) throw new Error('--out')
  const rows: { file: string; step: string; final: string | null; record: number | null }[] = []
  for (const name of fs.readdirSync(OUT).filter((file) => file.endsWith('.ndjson') && !file.startsWith('table'))) {
    for (const line of fs.readFileSync(path.join(OUT, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) continue
      const step = str(parsed.step) ?? ''
      if (!/^Z[236]/.test(step)) continue
      const final = str(parsed.final) ?? (typeof parsed.state === 'string' ? parsed.state.split('/')[0] ?? null : null)
      const record = num(parsed.record) ?? num(parsed.recordAfter20s)
      if (final !== null && record !== null) rows.push({ file: name, step, final, record })
      const records = parsed.records
      if (step === 'Z3a' && Array.isArray(parsed.finals) && Array.isArray(records)) {
        parsed.finals.forEach((state: unknown, index: number) => rows.push({ file: name, step: `Z3a[${index}]`, final: str(state), record: num(records[index]) }))
      }
      if (step === 'Z3b' && isRecord(records)) {
        rows.push({ file: name, step: 'Z3b[drop]', final: str(parsed.drop), record: num(records.drop) })
        rows.push({ file: name, step: 'Z3b[keep]', final: str(parsed.keep), record: num(records.keep) })
      }
      if (step === 'Z3d' && Array.isArray(parsed.rest) && Array.isArray(records)) {
        parsed.rest.forEach((state: unknown, index: number) => rows.push({ file: name, step: `Z3d[${index}]`, final: str(state), record: num(records[index]) }))
        rows.push({ file: name, step: 'Z3d[5]', final: (str(parsed.sixth) ?? '').split('/')[0] ?? null, record: num(records[5]) })
      }
    }
  }
  const verdict = (row: { final: string | null; record: number | null }): string => {
    if (row.final === 'delivered') return row.record === 1 ? 'match' : 'MISMATCH'
    if (row.final === 'failed' || row.final === 'cancelled') return row.record === 0 ? 'match' : 'MISMATCH'
    return 'separate'
  }
  const lines = rows.map((row) => ({ ...row, verdict: verdict(row) }))
  const summary = { rows: lines.length, match: lines.filter((row) => row.verdict === 'match').length, mismatch: lines.filter((row) => row.verdict === 'MISMATCH').length, separate: lines.filter((row) => row.verdict === 'separate').length }
  fs.writeFileSync(path.join(OUT, 'table-z6f.json'), `${JSON.stringify({ summary, lines }, null, 1)}\n`)
  out('Z6f-table', summary, summary.mismatch === 0 && summary.rows > 0)
}

// --- 실행 --------------------------------------------------------------------------------------------------

if (OUT !== null) {
  fs.mkdirSync(OUT, { recursive: true })
  outFile = path.join(OUT, `${command}${flag('step') === null ? '' : `-${flag('step')}`}${flag('phase') === null ? '' : `-${flag('phase')}`}.ndjson`)
}
try {
  if (command === 'setup') await setup()
  else if (command === 'z2') await z2()
  else if (command === 'z3') await z3()
  else if (command === 'z3restart') await z3restart()
  else if (command === 'z4') await z4()
  else if (command === 'z5') await z5()
  else if (command === 'z5e') await z5e()
  else if (command === 'z6') await z6()
  else if (command === 'z7') await z7()
  else if (command === 'z9') await z9()
  else if (command === 'z10') await z10()
  else if (command === 'table') table()
  else if (command === 'watch') {
    // 상태·화면 변화 관찰 — `--json` 글을 데스크톱 키로 넣고(+Enter) `--ms` 동안 300ms 마다 상태·활성 질문 판독을 찍는다. 화면이 바뀐 프레임만 남긴다.
    const info = panes().find((pane) => pane.name === flag('pane'))
    const parsed: unknown = JSON.parse(flag('json') ?? '""')
    if (info === undefined || typeof parsed !== 'string') throw new Error('--pane · --json')
    await desktopKeys(info.paneId, parsed)
    await delay(600)
    await desktopKeys(info.paneId, '\r')
    const t0 = Date.now()
    let last = ''
    while (Date.now() - t0 < Number(flag('ms') ?? '20000')) {
      const agent = await agentOf(info.paneId)
      const ansi = await screen(info.paneId)
      const key = `${agent.status}|${screenPlain(ansi)}`
      if (key !== last) {
        last = key
        out('watch', { pane: info.name, t: Date.now() - t0, agent, active: activeQuestion({ kind: info.kind, screen: ansi }), screen: ansi }, true)
      }
      await delay(300)
    }
  }
  else if (command === 'keys') {
    // 데스크톱 키(사람 키와 같은 경로) — 이 시험이 만든 pane 에만. `--json` 은 JSON 문자열(예: "\u001b[1;2D").
    const info = panes().find((pane) => pane.name === flag('pane'))
    const parsed: unknown = JSON.parse(flag('json') ?? '""')
    if (info === undefined || typeof parsed !== 'string') throw new Error('--pane · --json')
    const before = await agentOf(info.paneId)
    await desktopKeys(info.paneId, parsed)
    await delay(Number(flag('wait') ?? '1500'))
    out('keys', { pane: info.name, keys: JSON.stringify(parsed), before, after: await agentOf(info.paneId), screen: await screen(info.paneId) }, true)
  }
  else if (command === 'screen') {
    const info = panes().find((pane) => pane.name === flag('pane'))
    if (info === undefined) throw new Error('--pane 이름 없음')
    out('screen', { pane: info.name, agent: await agentOf(info.paneId), screen: await screen(info.paneId) }, true)
  }
  else {
    console.error('명령: setup · z2 · z3 [--step a|b|d|e1|e2] · z3restart --phase before|after · z4 [--step a|b|d] · z5 · z5e · z6 · z7 · z9 · z10 · table')
    process.exit(2)
  }
} catch (error) {
  out('error', { error: String(error instanceof Error ? (error.stack ?? error.message) : error) }, false)
}
process.exit(failures === 0 ? 0 : 1)
