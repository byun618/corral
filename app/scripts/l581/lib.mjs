// LIFE-581 최종 관문 공용 — 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l581g-* 에 띄운 것)에 붙는다. 설치본·실제 tailscale·사용자 herdr·사용자 세션 기록 무접촉.
// - 앱: 제어 소켓 `<ROOT>/ctl/ctl.sock` (l577 `g-lib.mjs` · l580 `lib.mjs` 의 모바일 켜기·페어링·해지 재사용)
// - herdr: g-up 이 띄운 이름 세션 `l577g-l581g-*` 만(그 밖이면 거부)
// - 대화 기록: **합성 기록 파일**(`<ROOT>/rec/…`)을 격리 pane 에 세션 경로로 붙인다(`pane.report_agent` 의 `agent_session_path`).
//   사용자 기록(~/.claude·~/.codex·~/.grok)은 읽지도 않는다. 큰 기록 회차(Y4ⓒ)만 `/tmp/l581w*` 사본을 붙인다.
// - 폰 자리: Node `ws` 클라이언트(페어링 → hello → list.subscribe → chat.subscribe). 토큰·코드는 원자료에 남기지 않는다(G5).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { ctl, evalJs, sleep, status, until } from '../l577/g-lib.mjs'
import { pairDevice, pct, revokeAll, setMobile, writeJson } from '../l580/lib.mjs'

export { ctl, evalJs, pairDevice, pct, revokeAll, setMobile, sleep, status, until, writeJson }
export const PROTOCOL = 1

/** ROOT 는 /tmp/l581g-* · FAKE 는 /tmp/l581g-f* — g-up.sh 와 같은 축. */
export function checkRoots({ root, fake }) {
  if (!/^\/tmp\/l581g-[^/]+$/.test(root ?? '') || /^\/tmp\/l581g-f/.test(root)) throw new Error(`ROOT 는 /tmp/l581g-*(f 로 시작하지 않는 꼬리) 여야 한다: ${root}`)
  if (!/^\/tmp\/l581g-f[^/]*$/.test(fake ?? '')) throw new Error(`FAKE 는 /tmp/l581g-f* 여야 한다: ${fake}`)
}

export const herdrSession = (root) => `l577g-${path.basename(root)}`

/** 격리 herdr 세션 RPC 한 번. 세션 이름이 l581 격리가 아니면 거부. */
export function herdr(root, method, params = {}, timeoutMs = 10_000) {
  const session = herdrSession(root)
  if (!session.startsWith('l577g-l581g-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l581', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}

const safeReal = (p) => { try { return fs.realpathSync(p) } catch { return p } }

/** 격리 레포 하나 + 그 레포 pane 하나(반환 pane id). 같은 이름이면 같은 레포에 pane 을 하나 더(split) 연다. */
export async function freshPane(root, { name = 'repo' } = {}) {
  const repo = path.join(root, name)
  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.name=l581', '-c', 'user.email=l581@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const added = await ctl(root, { cmd: 'add-repo', root: repo })
    if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  }
  const inRepo = async () => ((await herdr(root, 'pane.list')).panes ?? []).filter((item) => typeof item.cwd === 'string' && safeReal(item.cwd) === fs.realpathSync(repo)).map((item) => item.pane_id)
  const before = await inRepo()
  await herdr(root, 'workspace.create', { cwd: repo, focus: false })
  const pane = await until(async () => (await inRepo()).find((id) => !before.includes(id)) ?? null, { timeoutMs: 15_000, label: '격리 레포 pane' })
  return { repo, paneId: pane.value }
}

/**
 * pane 을 에이전트 세션으로 만든다 — 상태 보고 + 세션 경로(합성 기록). Grok 은 `updates.jsonl` 의 형제 `chat_history.jsonl` 경로를 붙인다(판독기가 형제를 고른다).
 * 변화를 일으킨 시각은 요청 **직전**.
 */
export async function reportSession(root, { paneId, agent, file, state = 'idle', seq }) {
  const sessionPath = agent === 'grok' ? path.join(path.dirname(file), 'chat_history.jsonl') : file
  const causeAt = Date.now()
  await herdr(root, 'pane.report_agent', { pane_id: paneId, source: 'l581-measure', agent, state, agent_session_path: sessionPath, ...(seq === undefined ? {} : { seq }) })
  return causeAt
}

/**
 * 폰 자리 — hello → list.subscribe. 받은 프레임마다 `onFrame({ message, recvAt })`(목록 포함). `chat(channel, resume?)` 로 대화 구독.
 * `clockOffset()` = ping/pong 으로 잰 (서버 시각 − 내 시각)(왕복 가장 짧은 표본의 중간점). 같은 기계라 0 근처.
 */
export async function phone(root, { token, onFrame = () => {}, onClose = () => {}, name = 'l581-measure', url: forced = null }) {
  const port = (await status(root)).serverPort
  if (port === null && forced === null) throw new Error('모바일 서버가 안 떠 있다')
  const url = forced ?? `ws://127.0.0.1:${port}/ws`
  const ws = new WebSocket(url)
  const pings = new Map()
  const offsets = []
  const frames = []
  let lastList = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello 시간 초과')), 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, client: { name, version: '1' } })))
    ws.on('message', (data) => {
      const recvAt = Date.now()
      const text = data.toString()
      const message = JSON.parse(text)
      if (message.type === 'hello' && message.ok === true) {
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'list.subscribe' }))
        resolve()
        return
      }
      if (message.type === 'pong' && pings.has(message.id) && typeof message.at === 'number') {
        const sentAt = pings.get(message.id)
        offsets.push({ rtt: recvAt - sentAt, offset: message.at - (sentAt + recvAt) / 2 })
        pings.delete(message.id)
        return
      }
      if (message.type === 'list') lastList = message
      if (message.type === 'error') reject(new Error(`서버 오류 ${message.code}`))
      frames.push({ message, recvAt, bytes: Buffer.byteLength(text), raw: text })
      onFrame({ message, recvAt, raw: text })
    })
    ws.on('error', reject)
  })
  ws.on('close', (code) => onClose({ code, at: Date.now() }))
  let n = 0
  return {
    frames,
    lastList: () => lastList,
    ping: async () => {
      const id = `c${(n += 1)}`
      pings.set(id, Date.now())
      ws.send(JSON.stringify({ type: 'ping', id }))
      await sleep(120)
    },
    clockOffset: () => {
      if (offsets.length === 0) return null
      const best = [...offsets].sort((a, b) => a.rtt - b.rtt)[0]
      return { offsetMs: Math.round(best.offset), rttMs: best.rtt, samples: offsets.length }
    },
    chat: (channel, resume = null) => ws.send(JSON.stringify(resume === null ? { type: 'chat.subscribe', channel } : { type: 'chat.subscribe', channel, ...resume })),
    older: (gen, before) => ws.send(JSON.stringify({ type: 'chat.older', gen, before })),
    unsubscribe: () => ws.send(JSON.stringify({ type: 'chat.unsubscribe' })),
    send: (value) => ws.send(JSON.stringify(value)),
    close: () => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else { ws.once('close', resolve); ws.close() } }),
    terminate: () => ws.terminate(),
  }
}

/** 목록에서 pane id 의 채널(없으면 null). */
export function channelOf(list, paneId) {
  if (!list?.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === paneId) return channel
  return null
}

/** 격리 main 로그(`<ROOT>/ud/corral.ndjson`)의 대화 계측 줄 — `mobile.chat_*`. 글은 원래 없다(개수·크기·시간). */
export function chatLog(root, { since = 0 } = {}) {
  const file = path.join(root, 'ud/corral.ndjson')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('"mobile.chat_')).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((row) => row !== null && (Date.parse(row.ts ?? row.at ?? 0) || row.t || 0) >= since)
}

/** 계측 소켓 루프 지연 — 첫 요청이 히스토그램을 켜고, 요청마다 지난 요청 이후 분포를 주고 비운다(`app/src/main/control.ts`). */
export const loopDelay = (root) => ctl(root, { cmd: 'loop-delay' })
