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
  // R5 A5ⓓ — 인증 뒤 hello 에 맥 이름(표시용)이 있어야 한다. 줄에 그대로 찍는다(사람이 맞는 맥인지 본다).
  const macName = hello?.server?.macName
  record(`${label}:hello`, hello?.type === 'hello' && hello?.ok === true && hello?.protocol === PROTOCOL && typeof hello?.server?.version === 'string' && typeof macName === 'string' && macName.length > 0,
    { type: 'hello', ok: true, protocol: PROTOCOL, server: { version: 'string', macName: 'string(비어 있지 않음)' } }, { hello, macName, error: got.error })
  record(`${label}:ping`, pong?.type === 'pong' && pong?.id === 'r1', { type: 'pong', id: 'r1' }, { pong })
}

async function commandPair(url) {
  const code = secretArg('code')
  if (code === null) usage('pair 에는 --code 가 필요하다')
  // --token-out 은 **새 파일만**(R2-A4) — 이미 있는 파일·심링크(대상 없는 것 포함)는 pair 전에 거절해 코드를 소모하지 않는다.
  const tokenOut = typeof args['token-out'] === 'string' ? args['token-out'] : null
  if (tokenOut !== null && pathTaken(tokenOut)) usage(`--token-out ${tokenOut} 가 이미 있다(파일·심링크) — 새 경로를 준다`)
  const got = await session(url, { send: [{ type: 'pair', protocol: PROTOCOL, code, name: typeof args.name === 'string' ? args.name : 'repro' }], closeAfter: 1 })
  const paired = got.messages[0]
  const ok = paired?.type === 'paired' && typeof paired?.token === 'string' && paired?.protocol === PROTOCOL && typeof paired?.server?.macName === 'string'
  record('pair', ok, { type: 'paired', token: 'string', protocol: PROTOCOL, server: { macName: 'string' } }, { paired, error: got.error })
  if (!ok) return
  if (tokenOut !== null && !writeNewSecret({ file: tokenOut, text: paired.token + '\n' })) return
  await helloPing(url, paired.token, 'after-pair')
}

function pathTaken(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

/** O_CREAT|O_EXCL(`wx`)로 새 파일만 만들고(심링크를 따라가지 않는다) umask 와 무관하게 0600 으로 고정한 뒤 쓴다. */
function writeNewSecret(input) {
  let fd
  try {
    fd = fs.openSync(input.file, 'wx', 0o600)
    fs.fchmodSync(fd, 0o600)
    fs.writeSync(fd, input.text)
    return true
  } catch (error) {
    record('token-out', false, { file: 'new 0600' }, { error: String(error?.code ?? error) })
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
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
  // LIFE-580 — 목록 구독도 인증 전에는 거절(새 메시지가 인증 전 표면을 넓히지 않는다).
  await expectRejected(url, 'ws:list-before-auth', { send: [{ type: 'list.subscribe' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:bad-json', { send: ['not json'], code: 'bad_json', close: 4004 })
  await expectRejected(url, 'ws:protocol-mismatch', { send: [{ type: 'hello', protocol: 999, token: 'x' }], code: 'protocol_mismatch', close: 4002 })
  {
    const got = await session(url, { send: ['x'.repeat(MAX_MESSAGE_BYTES + 1)] })
    record('ws:too-large', got.closeCode === 1009, { close: 1009 }, { closeCode: got.closeCode })
  }
  // 모르는 코드 → code_invalid (R5 A4ⓖ). 활성 코드가 있으면 그 실패 1회로 센다 — README 「코드 실패 횟수」.
  await expectRejected(url, 'ws:unknown-code', { send: [{ type: 'pair', protocol: PROTOCOL, code: 'ABCDEFGH', name: 'r' }], code: 'code_invalid', close: 4005 })
  // ③ 준비물이 있는 거절(옵션) — 세 실패 코드를 각각 기대값으로 가른다(R5 A4ⓖ).
  if (typeof args['revoked-token-file'] === 'string') {
    await expectRejected(url, 'ws:revoked-token', { send: [{ type: 'hello', protocol: PROTOCOL, token: readSecretFile(args['revoked-token-file']) }], code: 'unauthorized', close: 4001 })
  }
  const used = secretArg('used-code')
  if (used !== null) await expectRejected(url, 'ws:used-code', { send: [{ type: 'pair', protocol: PROTOCOL, code: used, name: 'r' }], code: 'code_used', close: 4005 })
  const expired = secretArg('expired-code')
  if (expired !== null) await expectRejected(url, 'ws:expired-code', { send: [{ type: 'pair', protocol: PROTOCOL, code: expired, name: 'r' }], code: 'code_expired', close: 4005 })
  const fresh = secretArg('fresh-code')
  if (fresh !== null) {
    for (let i = 1; i <= 5; i += 1) {
      await expectRejected(url, `ws:wrong-code-${i}`, { send: [{ type: 'pair', protocol: PROTOCOL, code: 'AAAAAAAA', name: 'r' }], code: 'code_invalid', close: 4005 })
    }
    await expectRejected(url, 'ws:right-code-after-5-wrong', { send: [{ type: 'pair', protocol: PROTOCOL, code: fresh, name: 'r' }], code: 'code_invalid', close: 4005 })
  }
  if (args['auth-timeout'] === true) {
    const got = await session(url, { waitMs: 15_000 })
    record('ws:auth-timeout', got.messages[0]?.code === 'auth_timeout' && got.closeCode === 4008, { error: 'auth_timeout', close: 4008 }, { first: got.messages[0], closeCode: got.closeCode })
  }
  // ④ 양성 대조 — 페어링한 기기는 통과
  if (typeof args['token-file'] === 'string') await helloPing(url, readSecretFile(args['token-file']), 'positive')
  else record('positive', false, { note: '--token-file 로 양성 대조를 함께 돌린다' }, { skipped: true })
}

/** open + 첫 hello 응답까지의 전체 마감 — 서버가 업그레이드 뒤 침묵하면 실패로 끝낸다(LIFE-578 R4-A1). */
const HELD_HELLO_TIMEOUT_MS = 10_000

/**
 * 인증된 연결 하나를 열어 둔다 — autoPong:false 면 서버 WS ping 에 답하지 않는다(망이 죽은 폰 흉내, LIFE-578 E3).
 * open + 첫 응답이 `HELD_HELLO_TIMEOUT_MS` 안에 없으면 소켓을 끊고 `hello=null`·`error='hello_timeout'` 으로 돌려준다.
 */
function heldConnection(url, token, { autoPong }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000, autoPong })
    const held = { ws, messages: [], hello: null, closeCode: null, closedAt: null, error: null, closed: null }
    const settle = () => {
      clearTimeout(timer)
      resolve(held)
    }
    const timer = setTimeout(() => {
      held.error = 'hello_timeout'
      try { ws.terminate() } catch { /* 이미 닫힘 */ }
      settle()
    }, HELD_HELLO_TIMEOUT_MS)
    held.closed = new Promise((done) => ws.on('close', (code) => { held.closeCode = code; held.closedAt = Date.now(); done(code) }))
    ws.on('error', (err) => { if (held.error === null) held.error = String(err.message ?? err) })
    ws.on('unexpected-response', (_req, res) => { held.error = `HTTP ${res.statusCode}`; settle() })
    ws.on('message', (data) => {
      let parsed
      try { parsed = JSON.parse(data.toString()) } catch { parsed = { raw: data.toString().slice(0, 200) } }
      if (held.hello === null) { held.hello = parsed; settle() } else held.messages.push(parsed)
    })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, client: { name: 'repro', version: '1' } })))
    held.closed.then(settle)
  })
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** 서버 연결 수명(LIFE-578 E3 · P7) — ① 같은 기기 재인증이 이전 연결을 replaced(4006)로 닫는다 ② (옵션) ping 에 답하지 않는 연결을 서버가 마감 안에 끊는다. */
async function commandLifetime(url) {
  if (typeof args['token-file'] !== 'string') usage('lifetime 에는 --token-file 이 필요하다')
  const token = readSecretFile(args['token-file'])
  // ① 이전 연결(서버 ping 에 답 없음) → 같은 토큰으로 새 연결
  const old = await heldConnection(url, token, { autoPong: false })
  record('lifetime:old-hello', old.hello?.type === 'hello', { type: 'hello' }, { hello: old.hello, error: old.error })
  // 인증이 안 되면(마감·거절) 뒤 단계는 볼 것이 없다 — 실패 행만 남기고 끝낸다(R4-A1).
  if (old.hello?.type !== 'hello') return old.ws.terminate()
  const fresh = await heldConnection(url, token, { autoPong: true })
  record('lifetime:new-hello', fresh.hello?.type === 'hello', { type: 'hello' }, { hello: fresh.hello, error: fresh.error })
  if (fresh.hello?.type !== 'hello') {
    old.ws.terminate()
    fresh.ws.terminate()
    return
  }
  await Promise.race([old.closed, wait(3000)])
  record('lifetime:old-replaced', old.messages[0]?.code === 'replaced' && old.closeCode === 4006, { error: 'replaced', close: 4006 }, { first: old.messages[0], closeCode: old.closeCode })
  fresh.ws.send(JSON.stringify({ type: 'ping', id: 'l1' }))
  await wait(500)
  const pong = fresh.messages.find((message) => message.type === 'pong')
  record('lifetime:new-alive', pong?.id === 'l1' && fresh.closeCode === null, { type: 'pong', id: 'l1', open: true }, { pong, closeCode: fresh.closeCode })
  fresh.ws.close()
  // ② 무수신 정리 — 서버 기본값(주기 10초·마감 30초)이면 최대 40초를 기다린다.
  if (typeof args['idle-max-ms'] === 'string') {
    const maxMs = Number(args['idle-max-ms'])
    const silent = await heldConnection(url, token, { autoPong: false })
    if (silent.hello?.type !== 'hello') {
      record('lifetime:idle-drop', false, { closedWithinMs: maxMs }, { hello: silent.hello, error: silent.error })
      silent.ws.terminate()
      return
    }
    const startedAt = Date.now()
    await Promise.race([silent.closed, wait(maxMs + 5000)])
    const elapsedMs = silent.closedAt === null ? null : silent.closedAt - startedAt
    record('lifetime:idle-drop', silent.hello?.type === 'hello' && elapsedMs !== null && elapsedMs <= maxMs,
      { closedWithinMs: maxMs }, { elapsedMs, closeCode: silent.closeCode })
  }
}

/** 목록 한 건의 요약 — 제목·미리보기 글은 찍지 않는다(G5). 수·상태 점 분포·셸 채널 수만. */
function listSummary(message) {
  const list = message.list ?? {}
  const channels = (list.repos ?? []).flatMap((repo) => (repo.tasks ?? []).flatMap((task) => task.channels ?? []))
  const dots = {}
  for (const channel of channels) dots[channel.dot] = (dots[channel.dot] ?? 0) + 1
  return {
    seq: message.seq,
    epoch: message.epoch,
    available: list.available,
    repos: (list.repos ?? []).length,
    tasks: (list.repos ?? []).reduce((sum, repo) => sum + (repo.tasks ?? []).length, 0),
    channels: channels.length,
    closed: channels.filter((channel) => channel.status === 'closed').length,
    waiting: (list.waiting ?? []).length,
    shellKinds: channels.filter((channel) => channel.kind === 'shell').length,
    dots,
  }
}

/**
 * 목록 구독(LIFE-580 L1ⓔ) — hello 뒤 `list.subscribe` → 전체 스냅샷, `--watch-ms` 동안 push 를 모은다. `--resubscribe` 면 중간에 다시 구독해 전체를 다시 받는지 본다.
 * `--ndjson-out <파일>` 이면 받은 목록마다 한 줄(받은 시각·seq·서버 시각 `at`·`changedAt`·요약)을 쓴다 — 3초 측정(J5)의 원자료.
 */
async function commandList(url) {
  if (typeof args['token-file'] !== 'string') usage('list 에는 --token-file 이 필요하다')
  const token = readSecretFile(args['token-file'])
  const watchMs = typeof args['watch-ms'] === 'string' ? Number(args['watch-ms']) : 3000
  const out = typeof args['ndjson-out'] === 'string' ? args['ndjson-out'] : null
  const received = []
  const errors = []
  let closeCode = null
  await new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 })
    const timer = setTimeout(() => { ws.terminate(); resolve() }, watchMs + 1000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, client: { name: 'repro', version: '1' } })))
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello' && message.ok === true) {
        ws.send(JSON.stringify({ type: 'list.subscribe' }))
        if (args.resubscribe === true) setTimeout(() => ws.send(JSON.stringify({ type: 'list.subscribe' })), Math.min(1000, watchMs / 2))
        return
      }
      if (message.type === 'list') {
        const row = { recvAt: Date.now(), seq: message.seq, epoch: message.epoch, at: message.at, changedAt: message.changedAt, summary: listSummary(message) }
        received.push(row)
        if (out !== null) fs.appendFileSync(out, JSON.stringify(row) + '\n')
        return
      }
      if (message.type === 'error') errors.push(message.code)
    })
    ws.on('close', (code) => { closeCode = code; clearTimeout(timer); resolve() })
    ws.on('error', (error) => errors.push(String(error.message ?? error)))
  })
  const first = received[0]
  record('list:snapshot', first !== undefined && typeof first.seq === 'number' && first.summary.available !== undefined, { type: 'list', seq: 'number', list: 'available 칸' }, { first: first?.summary ?? null, errors, closeCode })
  const seqs = received.map((row) => row.seq)
  const monotonic = seqs.every((seq, index) => index === 0 || seq >= seqs[index - 1])
  record('list:seq-monotonic', received.length > 0 && monotonic, { seq: '단조 증가(같은 번호 = 재구독)' }, { seqs })
  record('list:no-shell', received.every((row) => row.summary.shellKinds === 0), { shellKinds: 0 }, { shellKinds: received.map((row) => row.summary.shellKinds) })
  if (args.resubscribe === true) record('list:resubscribe-full', received.length >= 2, { snapshots: '≥ 2 (구독 + 재구독)' }, { count: received.length })
}

const COMMANDS = { pair: commandPair, hello: commandHello, matrix: commandMatrix, lifetime: commandLifetime, list: commandList }

const name = args._[0]
const url = typeof args.url === 'string' ? args.url : null
// 자기 속성만 명령이다 — `toString`·`__proto__` 같은 상속 이름이 함수로 풀리지 않게(fix1 R1-A9).
if (!name || !Object.hasOwn(COMMANDS, name)) usage(`명령은 ${Object.keys(COMMANDS).join(' · ')} 중 하나`)
if (url === null || !/^wss?:\/\//.test(url)) usage('--url ws://127.0.0.1:<p>/ws 또는 wss://<mac>.ts.net:<port>/ws')
await COMMANDS[name](url)
// 실행한 단계가 0 이면 아무것도 확인하지 않은 것 — 통과(0)가 아니라 사용법 오류다.
if (results.length === 0) usage(`${name}: 실행한 단계가 없다`)
const failed = results.filter((row) => !row.pass).length
process.stdout.write(JSON.stringify({ summary: { command: name, url, steps: results.length, failed } }) + '\n')
process.exit(failed === 0 ? 0 : 1)
