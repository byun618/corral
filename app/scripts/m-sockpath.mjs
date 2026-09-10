// 유닉스 소켓 경로 길이 한계 실측 — Electron(Node 24) vs 하네스 Node.
//
// 왜 재나: 코디네이터 화면에 Electron 모달이 떴다. 계측용 control 소켓을 worktree 아래
// (raw/claude/_runs/<이름>/ctrl.sock = 134 bytes) 에 만들었더니 bind 가 EINVAL 로 죽었고,
// main 의 uncaught exception 이라 앱 전체가 모달에 막혔다.
//
// 이건 corral 에도 그대로 걸리는 제약이다 — herdr 세션 소켓 경로가 길어지면 붙지 못한다.
// 오늘 값: default 36 bytes · life344-probe 59 bytes (여유 있음).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, writeRaw } from './lib.mjs'

const LENGTHS = [100, 102, 103, 104, 105, 106, 120, 134]

function bindProbeSource() {
  return `
const net = require('node:net')
const fs = require('node:fs')
const pathMod = require('node:path')
const base = '/tmp/l344-sockpath'
const lengths = ${JSON.stringify(LENGTHS)}
async function tryBind(len) {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(base, { recursive: true })
  const target = pathMod.join(base, 'x'.repeat(len - (base.length + 1)))
  return new Promise((resolve) => {
    const server = net.createServer()
    server.on('error', (error) =>
      resolve({ requested: len, bytes: Buffer.byteLength(target), ok: false, code: error.code }))
    server.listen(target, () => {
      const created = fs.readdirSync(base)
      server.close()
      resolve({
        requested: len,
        bytes: Buffer.byteLength(target),
        ok: true,
        createdPathBytes: created[0] ? Buffer.byteLength(pathMod.join(base, created[0])) : null,
        truncated: created[0] ? Buffer.byteLength(pathMod.join(base, created[0])) !== len : null,
      })
    })
  })
}
;(async () => {
  const out = []
  for (const len of lengths) out.push(await tryBind(len))
  fs.rmSync(base, { recursive: true, force: true })
  process.stdout.write('RESULT ' + JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, results: out }) + '\\n')
  if (process.versions.electron) require('electron').app.quit()
})()
`
}

async function runInElectron() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l344-el-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sockpath-probe', main: 'main.cjs' }))
  fs.writeFileSync(path.join(dir, 'main.cjs'), bindProbeSource())
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(APP_DIR, 'node_modules/.bin/electron'), [dir], {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('exit', () => {
      const line = out.split('\n').find((entry) => entry.startsWith('RESULT '))
      if (!line) reject(new Error(`Electron 프로브 출력 없음:\n${out.slice(0, 800)}`))
      else resolve(JSON.parse(line.slice('RESULT '.length)))
    })
  })
}

function measurePaths() {
  const home = os.homedir()
  return {
    herdrDefault: Buffer.byteLength(path.join(home, '.config/herdr/herdr.sock')),
    herdrNamedLife344: Buffer.byteLength(path.join(home, '.config/herdr/sessions/life344-probe/herdr.sock')),
    failingControlSocket: Buffer.byteLength(
      path.join(path.dirname(APP_DIR), 'specs/LIFE-344-bootstrap/raw/claude/_runs/diag2/ctrl.sock'),
    ),
    tmpdir: Buffer.byteLength(os.tmpdir()),
  }
}

const electron = await runInElectron()
const harness = { node: process.versions.node, electron: null, results: [] }
for (const len of LENGTHS) harness.results.push(await bindHere(len))

writeRaw('12-unix-socket-path-limit.json', {
  measuredAt: new Date().toISOString(),
  note: 'macOS sockaddr_un.sun_path 는 104 bytes. Electron(Node 24)은 EINVAL 로 거부하고, Node 20 은 조용히 잘라 엉뚱한 파일을 만든다.',
  pathBytes: measurePaths(),
  electron,
  harness,
})
console.log('electron node', electron.node, electron.results.map((r) => `${r.requested}:${r.ok ? 'ok' : r.code}`).join(' '))
console.log('harness node', harness.node, harness.results.map((r) => `${r.requested}:${r.ok ? (r.truncated ? 'ok(truncated)' : 'ok') : r.code}`).join(' '))

function bindHere(len) {
  const base = '/tmp/l344-sockpath-h'
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(base, { recursive: true })
  const target = path.join(base, 'x'.repeat(len - (base.length + 1)))
  return new Promise((resolve) => {
    const server = net.createServer()
    server.on('error', (error) => resolve({ requested: len, ok: false, code: error.code }))
    server.listen(target, () => {
      const created = fs.readdirSync(base)
      server.close()
      const bytes = created[0] ? Buffer.byteLength(path.join(base, created[0])) : null
      fs.rmSync(base, { recursive: true, force: true })
      resolve({ requested: len, ok: true, createdPathBytes: bytes, truncated: bytes !== len })
    })
  })
}
