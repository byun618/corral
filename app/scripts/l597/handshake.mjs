#!/usr/bin/env node
// LIFE-597 U8 — herdr guard 의 능력 광고를 읽기 전용으로 확인한다(operation 없는 corral.terminal handshake 한 번 — pane 을 겨냥하지 않고 아무것도 쓰지 않는다).
//   node app/scripts/l597/handshake.mjs [소켓 — 기본: 설치본 동봉 herdr ~/.config/corral-herdr/herdr.sock]
// 출력 JSON 한 줄: guard_version · agent_ops · unmanaged_prompt(새 guard = 1, 이 작업 전 guard = 없음) · epoch 길이. 종료 0 = unmanaged_prompt 1, 1 = 없음, 2 = 연결·응답 오류.
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const socketPath = process.argv[2] ?? path.join(os.homedir(), '.config/corral-herdr/herdr.sock')
const socket = net.createConnection(socketPath)
let buffer = ''
const timer = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'timeout' })); process.exit(2) }, 5000)
socket.setEncoding('utf8')
socket.on('error', (error) => { console.log(JSON.stringify({ ok: false, error: error.code ?? String(error) })); process.exit(2) })
socket.on('connect', () => socket.write(JSON.stringify({ id: 'l597-handshake', method: 'corral.terminal', params: {} }) + '\n'))
socket.on('data', (chunk) => {
  buffer += chunk
  const index = buffer.indexOf('\n')
  if (index === -1) return
  clearTimeout(timer)
  socket.destroy()
  const message = JSON.parse(buffer.slice(0, index))
  const result = message.result ?? {}
  const out = { ok: message.error === undefined, guard_version: result.guard_version ?? null, agent_ops: result.agent_ops ?? null, unmanaged_prompt: result.unmanaged_prompt ?? null, epochLength: typeof result.epoch === 'string' ? result.epoch.length : null, error: message.error?.code ?? null }
  console.log(JSON.stringify(out))
  process.exit(out.unmanaged_prompt === 1 ? 0 : out.ok ? 1 : 2)
})
