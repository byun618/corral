// LIFE-580 측정 공용 — 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l580g-* 에 띄운 것)에 붙는다. 설치본·실제 tailscale·사용자 herdr 무접촉.
// - 앱: 제어 소켓 `<ROOT>/ctl/ctl.sock` (l577 `g-lib.mjs` 의 ctl·openMobile·clickSwitch 재사용)
// - herdr: g-up 이 띄운 이름 세션 `l577g-<ROOT 꼬리>` 의 소켓 — 그 밖의 세션 이름이면 거부한다
// - 폰 자리: Node `ws` 클라이언트(페어링 → hello → list.subscribe). 토큰·코드는 원자료에 남기지 않는다(G5).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { clickSwitch, ctl, evalJs, openMobile, setFake, sleep, status, switchChecked, until } from '../l577/g-lib.mjs'

export { ctl, sleep, until }
export const PROTOCOL = 1

/** ROOT 는 /tmp/l580g-* 만 — g-up.sh 와 같은 축. FAKE 도 /tmp/l580g-f*. */
export function checkRoots({ root, fake }) {
  if (!/^\/tmp\/l580g-[^/]+$/.test(root ?? '')) throw new Error(`ROOT 는 /tmp/l580g-* 여야 한다: ${root}`)
  if (!/^\/tmp\/l580g-f[^/]*$/.test(fake ?? '')) throw new Error(`FAKE 는 /tmp/l580g-f* 여야 한다: ${fake}`)
}

/** g-up.sh 와 같은 공식 — `l577g-<basename(ROOT) 에서 l577g- 뗀 것>`. */
export function herdrSession(root) {
  return `l577g-${path.basename(root).replace(/^l577g-/, '')}`
}

/** 격리 herdr 세션 RPC 한 번(요청 1건 = 커넥션 1개). 세션 이름이 l580 격리가 아니면 거부. */
export function herdr(root, method, params = {}, timeoutMs = 10_000) {
  const session = herdrSession(root)
  if (!session.startsWith('l577g-l580g-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l580', method, params }) + '\n'))
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

/** 에이전트 상태 보고 — 변화를 일으킨 시각(ⓑ 시작)은 요청 **직전**에 찍는다. */
export async function reportAgent(root, { paneId, state, agent = 'claude' }) {
  const causeAt = Date.now()
  await herdr(root, 'pane.report_agent', { pane_id: paneId, source: 'l580-measure', agent, state })
  return causeAt
}

/** 설정 화면(오버레이)이 열려 있나 — 열려 있으면 본문(탭·터미널)을 덮는다(R1-A2: `div.settings-topbar` 가 탭 클릭을 막았다). */
export const settingsOpen = (root) => evalJs(root, `!!document.querySelector('[data-settings-page],[data-settings-topbar]')`)

/** 설정을 사람의 길(뒤로 버튼)로 닫고 오버레이가 사라질 때까지 기다린다. 이미 닫혀 있으면 그대로. */
export async function closeSettings(root) {
  if (!(await settingsOpen(root))) return
  const clicked = await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-settings-back]' })).hit === true, { timeoutMs: 10_000, everyMs: 200, label: '설정 뒤로' })
  if (!clicked.value) throw new Error('설정 뒤로 버튼을 누르지 못했다')
  await until(async () => !(await settingsOpen(root)), { timeoutMs: 10_000, label: '설정 오버레이 닫힘' })
}

/** 설정 › Mobile 스위치를 원하는 쪽으로(가짜 tailscale 이 serve 를 받는 상태) — 켜면 노출(exposed)까지 기다리고, **설정을 닫고** 돌아온다. */
export async function setMobile(root, fake, on) {
  if (on) setFake(fake, { serve: {} })
  await openMobile(root)
  const checked = (await switchChecked(root)) === 'true'
  if (checked !== on) await clickSwitch(root)
  const reached = await until(async () => {
    const s = await status(root)
    return on ? (s.exposure.kind === 'exposed' && s.serverPort !== null ? s : null) : (s.enabled === false && s.serverPort === null ? s : null)
  }, { timeoutMs: 20_000, label: on ? 'mobile 켜짐' : 'mobile 꺼짐' })
  await closeSettings(root)
  return reached.value
}

/**
 * 폰 자리 클라이언트 — 새 코드로 페어링 → hello → list.subscribe. 받은 목록마다 `onList({ message, recvAt })`.
 * `clockOffset()` = ping/pong 으로 잰 (서버 시각 − 내 시각) 추정(왕복 가장 짧은 표본의 중간점). 같은 기계라 0 근처가 기대값이다.
 */
export async function phone(root, { onList, onClose = () => {}, name = 'l580-measure' }) {
  const port = (await status(root)).serverPort
  if (port === null) throw new Error('모바일 서버가 안 떠 있다')
  const url = `ws://127.0.0.1:${port}/ws`
  const pairing = await ctl(root, { cmd: 'mobile-pairing' })
  if (!pairing.ok || !pairing.pairing?.ok) throw new Error(`페어링 코드 실패 ${JSON.stringify({ ok: pairing.ok, error: pairing.error ?? pairing.pairing?.error })}`)
  const token = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('pair 시간 초과')) }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL, code: pairing.pairing.code, name })))
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      clearTimeout(timer)
      ws.close()
      if (message.type === 'paired' && typeof message.token === 'string') resolve(message.token)
      else reject(new Error(`pair 실패 ${message.type} ${message.code ?? ''}`))
    })
    ws.on('error', reject)
  })
  const ws = new WebSocket(url)
  const pings = new Map()
  const offsets = []
  let deviceId = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello 시간 초과')), 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, client: { name, version: '1' } })))
    ws.on('message', (data) => {
      const recvAt = Date.now()
      const message = JSON.parse(data.toString())
      if (message.type === 'hello' && message.ok === true) {
        deviceId = message.device?.id ?? null
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'list.subscribe' }))
        resolve()
      } else if (message.type === 'list') onList({ message, recvAt })
      else if (message.type === 'pong' && pings.has(message.id) && typeof message.at === 'number') {
        const sentAt = pings.get(message.id)
        offsets.push({ rtt: recvAt - sentAt, offset: message.at - (sentAt + recvAt) / 2 })
        pings.delete(message.id)
      } else if (message.type === 'error') reject(new Error(`서버 오류 ${message.code}`))
    })
    ws.on('error', reject)
  })
  // 구독 유지 확인(R1-A1) — 측정 구간 안에 연결이 닫히면 그 회차는 B 조건(구독 1)을 못 지킨 것이다.
  ws.on('close', (code) => onClose({ code, at: Date.now() }))
  let n = 0
  const ping = async () => {
    const id = `c${(n += 1)}`
    pings.set(id, Date.now())
    ws.send(JSON.stringify({ type: 'ping', id }))
    await sleep(150)
  }
  return {
    deviceId,
    ping,
    clockOffset: () => {
      if (offsets.length === 0) return null
      const best = [...offsets].sort((a, b) => a.rtt - b.rtt)[0]
      return { offsetMs: Math.round(best.offset), rttMs: best.rtt, samples: offsets.length }
    },
    resubscribe: () => ws.send(JSON.stringify({ type: 'list.subscribe' })),
    close: () => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else { ws.once('close', resolve); ws.close() } }),
  }
}

/** 기기 해지 — 측정 끝 정리(격리 userData 안). */
export async function revokeAll(root) {
  const s = await status(root)
  for (const device of s.devices ?? []) await ctl(root, { cmd: 'mobile-revoke', id: device.id })
}

/** 격리 레포를 하나 만들고 등록 → 그 레포에 탭(pane) 하나. 반환 = pane id. */
export async function freshPane(root, { name = 'repo' } = {}) {
  const repo = path.join(root, name)
  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true })
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.name=l580', '-c', 'user.email=l580@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
  }
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  // 등록만으로 열린 작업 공간이 생기지 않으면 격리 herdr 에 직접 연다(앱의 open-workspace 와 같은 요청).
  const existing = ((await herdr(root, 'pane.list')).panes ?? []).some((item) => typeof item.cwd === 'string' && safeReal(item.cwd) === fs.realpathSync(repo))
  if (!existing) await herdr(root, 'workspace.create', { cwd: repo, focus: false })
  const pane = await until(async () => {
    const panes = (await herdr(root, 'pane.list')).panes ?? []
    return panes.find((item) => typeof item.cwd === 'string' && fs.realpathSync(repo) === safeReal(item.cwd))?.pane_id ?? null
  }, { timeoutMs: 15_000, label: '격리 레포 pane' })
  return { repo, paneId: pane.value }
}

function safeReal(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

export function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
