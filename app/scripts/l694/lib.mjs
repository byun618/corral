/* global fetch, WebSocket */
// LIFE-694 최종 관문 공용 — up.sh 가 띄운 격리 앱(제어 소켓)·격리 herdr 이름 세션(`l694g-*`)만 친다. 설치본·사용자 세션 무접촉.
// 대기 헬퍼(`waitFor`)는 시간 초과를 **예외로** 올린다 — 부르는 쪽이 잡아 실패로 적는다(삼키지 않는다).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ctl } from '../l577/g-lib.mjs'

export { ctl }
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function checkRoot(root) {
  if (!/^\/tmp\/l694g-[a-z0-9]+$/.test(root ?? '')) throw new Error(`ROOT 는 /tmp/l694g-<꼬리> 여야 한다: ${root}`)
}
const session = (root) => fs.readFileSync(path.join(root, 'herdr.session'), 'utf8').trim()
const herdrBin = (root) => fs.readFileSync(path.join(root, 'herdr.bin'), 'utf8').trim()

/** 격리 herdr RPC 한 번. 세션 이름이 l694g- 가 아니면 거부. */
export function rpc(root, method, params = {}, timeoutMs = 15_000) {
  const name = session(root)
  if (!name.startsWith('l694g-')) throw new Error(`거부: 격리 세션 아님 ${name}`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', name, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l694', method, params }) + '\n'))
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

/** herdr CLI — corral **밖**에서 닫기(외부 닫기). 워커 env 를 넘기지 않는다. */
export function herdrCli(root, args) {
  const name = session(root)
  if (!name.startsWith('l694g-')) throw new Error(`거부: 격리 세션 아님 ${name}`)
  return new Promise((resolve) => {
    execFile(herdrBin(root), ['--session', name, ...args], { env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ argv: ['herdr', '--session', name, ...args], exit: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function waitFor(check, { timeoutMs = 20_000, everyMs = 200, label }) {
  const t0 = Date.now()
  for (;;) {
    const value = await check()
    if (value) return { value, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) throw new Error(`대기 시간 초과: ${label} (${timeoutMs}ms)`)
    await sleep(everyMs)
  }
}

export const state = async (root) => (await ctl(root, { cmd: 'state' })).state
export const evalJs = async (root, code) => {
  const r = await ctl(root, { cmd: 'eval', code })
  if (!r.ok) throw new Error(`eval 실패 ${JSON.stringify(r).slice(0, 200)}`)
  return r.result
}
export const retained = async (root) => (await state(root)).retainedAgents
export const logs = (root) => fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

/**
 * 골격이 t 이후에 **시작한** 빌드를 마쳤을 때까지 — `tree.built` 의 (기록 시각 − ms) ≥ t. 재빌드를 걸고, 기다리는 동안 3초마다 다시 건다
 * (g08: 한 번만 걸면 시작 시각이 t 와 같은 ms 로 찍혀 엄격 비교를 놓친 뒤 다음 빌드가 오지 않았다).
 */
export async function waitTreeAfter(root, t, label = 'tree.built after') {
  let asked = 0
  return (await waitFor(async () => {
    if (Date.now() - asked > 3000) { asked = Date.now(); await ctl(root, { cmd: 'rebuild-tree' }) }
    return logs(root).find((entry) => entry.tag === 'tree.built' && entry.at - entry.ms >= t)
  }, { timeoutMs: 30_000, label })).value
}

/** pane 상태(herdr). */
export async function pane(root, paneId) {
  const list = (await rpc(root, 'pane.list')).panes ?? []
  return list.find((item) => item.pane_id === paneId) ?? null
}

/** 셸 pane 을 done 으로 — report-agent working → idle(포커스 안 된 pane 에서만 done). done 을 못 보면 예외. */
export async function makeDone(root, paneId, source = 'l694-gate') {
  await rpc(root, 'pane.report_agent', { pane_id: paneId, source, agent: 'claude', state: 'working', seq: 1 })
  await sleep(1200)
  await rpc(root, 'pane.report_agent', { pane_id: paneId, source, agent: 'claude', state: 'idle', seq: 2 })
  return (await waitFor(async () => (await pane(root, paneId))?.agent_status === 'done', { timeoutMs: 8000, label: `done ${paneId}` })).ms
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** CDP 렌더러 페이지 한 연결(up.sh 의 cdp.port) — F6 포커스 흉내 전용. */
export async function cdp(root) {
  const port = fs.readFileSync(path.join(root, 'cdp.port'), 'utf8').trim()
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('CDP 렌더러 페이지 없음')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id === undefined) return
    const p = pending.get(data.id); pending.delete(data.id)
    if (data.error) p.reject(new Error(JSON.stringify(data.error))); else p.resolve(data.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  return { send, close: () => ws.close() }
}
