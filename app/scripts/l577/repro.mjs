#!/usr/bin/env node
// 폰 없는 모바일 repro 클라이언트 (LIFE-577 A9) — 사용법·확장 방법은 같은 폴더 README.md.
//
//   node scripts/l577/repro.mjs <명령> --url <ws://127.0.0.1:P/ws | wss://<mac>.ts.net:8577/ws> [옵션]
//
// 출력: 한 줄에 한 단계 NDJSON `{step, pass, expect, got}` + 마지막 줄 `{summary}`. 토큰·코드는 `<redacted>` 로만 찍는다.
// 종료 코드: 0 전부 통과 · 1 하나라도 실패 · 2 사용법 오류.
/* global fetch, AbortSignal */
import fs from 'node:fs'
import { WebSocket } from 'ws'

const PROTOCOL = 1
const MAX_MESSAGE_BYTES = 16 * 1024

const args = parseArgs(process.argv.slice(2))
const results = []
const secrets = new Set()

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i += 1 }
    } else out._.push(arg)
  }
  return out
}

function usage(message) {
  process.stderr.write(`${message}\n\n${fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8').split('## 사용법')[1]?.split('\n## ')[0] ?? ''}\n`)
  process.exit(2)
}

/** 원자료로 남길 수 있게 — 알고 있는 비밀은 전부 가린다. */
function redact(value) {
  let text = JSON.stringify(value)
  for (const secret of secrets) if (secret.length > 0) text = text.split(secret).join('<redacted>')
  return JSON.parse(text)
}

function record(step, pass, expect, got) {
  const row = redact({ step, pass, expect, got })
  results.push(row)
  process.stdout.write(JSON.stringify(row) + '\n')
}

function readSecretFile(file) {
  const value = fs.readFileSync(file, 'utf8').trim()
  secrets.add(value)
  return value
}

function secretArg(name) {
  const value = args[name]
  if (typeof value === 'string') secrets.add(value)
  return typeof value === 'string' ? value : null
}

// --- WS 한 연결 -----------------------------------------------------------------------------------------

/** 연결해 보낸다. 받은 메시지와 close 코드를 모은다. `waitMs` 안에 닫히지 않으면 그대로 돌려준다. */
function session(url, { send = [], waitMs = 3000, closeAfter = null } = {}) {
  return new Promise((resolve) => {
    const messages = []
    let closeCode = null
    let error = null
    const ws = new WebSocket(url, { handshakeTimeout: 5000 })
    const finish = () => {
      clearTimeout(timer)
      try { ws.terminate() } catch { /* 이미 닫힘 */ }
      resolve({ messages, closeCode, error })
    }
    const timer = setTimeout(finish, waitMs)
    ws.on('open', () => {
      for (const item of send) ws.send(typeof item === 'string' ? item : JSON.stringify(item))
    })
    ws.on('message', (data) => {
      let parsed
      try { parsed = JSON.parse(data.toString()) } catch { parsed = { raw: data.toString().slice(0, 200) } }
      if (typeof parsed.token === 'string') secrets.add(parsed.token)
      messages.push(parsed)
      if (closeAfter !== null && messages.length >= closeAfter) finish()
    })
    ws.on('close', (code) => { closeCode = code; finish() })
    ws.on('error', (err) => { error = String(err.message ?? err) })
    ws.on('unexpected-response', (_req, res) => { error = `HTTP ${res.statusCode}`; finish() })
  })
}

/** 거절 기대: 첫 메시지 `{type:'error', code}` + close 코드. */
async function expectRejected(url, step, { send, code, close }) {
  const got = await session(url, { send })
  const first = got.messages[0]
  const pass = first?.type === 'error' && first?.code === code && (close === undefined || got.closeCode === close)
  record(step, pass, { error: code, close }, { first, closeCode: got.closeCode, error: got.error })
  return pass
}

// --- 명령 -------------------------------------------------------------------------------------------------
// M2~M5 는 여기 함수 하나를 더하고 COMMANDS 에 이름을 단다(README 「확장」).

async function helloPing(url, token, label) {
  const got = await session(url, { send: [{ type: 'hello', protocol: PROTOCOL, token, client: { name: 'repro', version: '1' } }, { type: 'ping', id: 'r1' }], closeAfter: 2 })
  const [hello, pong] = got.messages
  record(`${label}:hello`, hello?.type === 'hello' && hello?.ok === true && hello?.protocol === PROTOCOL && typeof hello?.server?.version === 'string',
    { type: 'hello', ok: true, protocol: PROTOCOL, server: { version: 'string' } }, { hello, error: got.error })
  record(`${label}:ping`, pong?.type === 'pong' && pong?.id === 'r1', { type: 'pong', id: 'r1' }, { pong })
}

async function commandPair(url) {
  const code = secretArg('code')
  if (code === null) usage('pair 에는 --code 가 필요하다')
  const got = await session(url, { send: [{ type: 'pair', protocol: PROTOCOL, code, name: typeof args.name === 'string' ? args.name : 'repro' }], closeAfter: 1 })
  const paired = got.messages[0]
  const ok = paired?.type === 'paired' && typeof paired?.token === 'string' && paired?.protocol === PROTOCOL
  record('pair', ok, { type: 'paired', token: 'string', protocol: PROTOCOL }, { paired, error: got.error })
  if (!ok) return
  if (typeof args['token-out'] === 'string') fs.writeFileSync(args['token-out'], paired.token + '\n', { mode: 0o600 })
  await helloPing(url, paired.token, 'after-pair')
}

async function commandHello(url) {
  if (typeof args['token-file'] !== 'string') usage('hello 에는 --token-file 이 필요하다')
  await helloPing(url, readSecretFile(args['token-file']), 'hello')
}

async function commandMatrix(url) {
  const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '')
  // ① WS 가 아닌 HTTP — 경로·메서드 무관 404 본문 없음
  for (const [method, path] of [['GET', '/'], ['GET', '/ws'], ['POST', '/ws'], ['GET', '/status'], ['DELETE', '/x']]) {
    try {
      const response = await fetch(`${httpBase}${path}`, { method, signal: AbortSignal.timeout(5000) })
      const body = await response.text()
      record(`http:${method} ${path}`, response.status === 404 && body.length === 0, { status: 404, body: '' }, { status: response.status, bodyLength: body.length })
    } catch (error) {
      record(`http:${method} ${path}`, false, { status: 404, body: '' }, { error: String(error) })
    }
  }
  // ② 인증 전 거절
  await expectRejected(url, 'ws:no-token', { send: [{ type: 'hello', protocol: PROTOCOL }], code: 'unauthorized', close: 4001 })
  await expectRejected(url, 'ws:wrong-token', { send: [{ type: 'hello', protocol: PROTOCOL, token: 'not-a-real-token' }], code: 'unauthorized', close: 4001 })
  await expectRejected(url, 'ws:ping-before-auth', { send: [{ type: 'ping' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:unknown-before-auth', { send: [{ type: 'state' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:bad-json', { send: ['not json'], code: 'bad_json', close: 4004 })
  await expectRejected(url, 'ws:protocol-mismatch', { send: [{ type: 'hello', protocol: 999, token: 'x' }], code: 'protocol_mismatch', close: 4002 })
  {
    const got = await session(url, { send: ['x'.repeat(MAX_MESSAGE_BYTES + 1)] })
    record('ws:too-large', got.closeCode === 1009, { close: 1009 }, { closeCode: got.closeCode })
  }
  // ③ 준비물이 있는 거절(옵션)
  if (typeof args['revoked-token-file'] === 'string') {
    await expectRejected(url, 'ws:revoked-token', { send: [{ type: 'hello', protocol: PROTOCOL, token: readSecretFile(args['revoked-token-file']) }], code: 'unauthorized', close: 4001 })
  }
  const used = secretArg('used-code')
  if (used !== null) await expectRejected(url, 'ws:used-code', { send: [{ type: 'pair', protocol: PROTOCOL, code: used, name: 'r' }], code: 'pair_rejected', close: 4005 })
  const expired = secretArg('expired-code')
  if (expired !== null) await expectRejected(url, 'ws:expired-code', { send: [{ type: 'pair', protocol: PROTOCOL, code: expired, name: 'r' }], code: 'pair_rejected', close: 4005 })
  const fresh = secretArg('fresh-code')
  if (fresh !== null) {
    for (let i = 1; i <= 5; i += 1) {
      await expectRejected(url, `ws:wrong-code-${i}`, { send: [{ type: 'pair', protocol: PROTOCOL, code: 'AAAAAAAA', name: 'r' }], code: 'pair_rejected', close: 4005 })
    }
    await expectRejected(url, 'ws:right-code-after-5-wrong', { send: [{ type: 'pair', protocol: PROTOCOL, code: fresh, name: 'r' }], code: 'pair_rejected', close: 4005 })
  }
  if (args['auth-timeout'] === true) {
    const got = await session(url, { waitMs: 15_000 })
    record('ws:auth-timeout', got.messages[0]?.code === 'auth_timeout' && got.closeCode === 4008, { error: 'auth_timeout', close: 4008 }, { first: got.messages[0], closeCode: got.closeCode })
  }
  // ④ 양성 대조 — 페어링한 기기는 통과
  if (typeof args['token-file'] === 'string') await helloPing(url, readSecretFile(args['token-file']), 'positive')
  else record('positive', false, { note: '--token-file 로 양성 대조를 함께 돌린다' }, { skipped: true })
}

const COMMANDS = { pair: commandPair, hello: commandHello, matrix: commandMatrix }

const name = args._[0]
const url = typeof args.url === 'string' ? args.url : null
if (!name || !(name in COMMANDS)) usage(`명령은 ${Object.keys(COMMANDS).join(' · ')} 중 하나`)
if (url === null || !/^wss?:\/\//.test(url)) usage('--url ws://127.0.0.1:<p>/ws 또는 wss://<mac>.ts.net:<port>/ws')
await COMMANDS[name](url)
const failed = results.filter((row) => !row.pass).length
process.stdout.write(JSON.stringify({ summary: { command: name, url, steps: results.length, failed } }) + '\n')
process.exit(failed === 0 ? 0 : 1)
