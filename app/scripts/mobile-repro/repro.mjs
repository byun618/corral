#!/usr/bin/env node
// 폰 없는 모바일 repro 클라이언트 (LIFE-577 A9) — 사용법·확장 방법은 같은 폴더 README.md.
//
//   node scripts/mobile-repro/repro.mjs <명령> --url <ws://127.0.0.1:P/ws | wss://<mac>.ts.net:8577/ws> [옵션]
//
// 출력: 한 줄에 한 단계 NDJSON `{step, pass, expect, got}` + 마지막 줄 `{summary}`. 토큰·코드는 `<redacted>` 로만 찍는다.
// 종료 코드: 0 전부 통과 · 1 하나라도 실패 · 2 사용법 오류.
/* global fetch, AbortSignal */
import { randomBytes } from 'node:crypto'
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
  // LIFE-581 — 대화 메시지도 인증 전에는 거절.
  await expectRejected(url, 'ws:chat-subscribe-before-auth', { send: [{ type: 'chat.subscribe', channel: 'w1:p1' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:chat-older-before-auth', { send: [{ type: 'chat.older', gen: 'g', before: 1 }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:chat-unsubscribe-before-auth', { send: [{ type: 'chat.unsubscribe' }], code: 'not_authenticated', close: 4001 })
  // LIFE-582 — 쓰기 메시지 다섯도 인증 전에는 거절.
  await expectRejected(url, 'ws:input-send-before-auth', { send: [{ type: 'input.send', id: 'repro-0000-0001', channel: 'w1:p1', text: 'x' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:input-cancel-before-auth', { send: [{ type: 'input.cancel', id: 'repro-0000-0001' }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:input-status-before-auth', { send: [{ type: 'input.status', ids: ['repro-0000-0001'] }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:question-answer-before-auth', { send: [{ type: 'question.answer', id: 'repro-0000-0001', channel: 'w1:p1', question: 1, answers: [{ choices: [0], other: null }] }], code: 'not_authenticated', close: 4001 })
  await expectRejected(url, 'ws:turn-stop-before-auth', { send: [{ type: 'turn.stop', id: 'repro-0000-0001', channel: 'w1:p1' }], code: 'not_authenticated', close: 4001 })
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

/** 말풍선 요약 — 글은 찍지 않는다(G5). 종류별 개수·id 범위·잘림 수만. */
function chatSummary(items) {
  const kinds = {}
  for (const item of items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1
  return { items: items.length, kinds, firstId: items[0]?.id ?? null, lastId: items.at(-1)?.id ?? null, clipped: items.filter((item) => item.body?.clipped != null).length }
}

/**
 * 대화 구독(LIFE-581 Y2ⓔ) — hello → list.subscribe 로 채널을 고르고(`--channel` 이 없으면 목록의 첫 AI 채널) → chat.subscribe → 첫 페이지,
 * `--older N` 이면 과거 페이지를 N 번(또는 처음까지) 요청, `--watch-ms` 동안 push 를 모은다. `--resume` 이면 끝에 끊고 같은 세대·마지막 id 로
 * 다시 붙어 `resume` 을 받는지 본다. `--ndjson-out` 이면 받은 프레임마다 한 줄(받은 시각·서버 시각·readAt·writtenAt·말풍선 id·시각 — 글 없음).
 */
async function commandChat(url) {
  if (typeof args['token-file'] !== 'string') usage('chat 에는 --token-file 이 필요하다')
  const token = readSecretFile(args['token-file'])
  const watchMs = typeof args['watch-ms'] === 'string' ? Number(args['watch-ms']) : 2000
  const olderRounds = typeof args.older === 'string' ? Number(args.older) : 0
  const out = typeof args['ndjson-out'] === 'string' ? args['ndjson-out'] : null
  const wanted = typeof args.channel === 'string' ? args.channel : null
  const frames = []
  const errors = []
  let channel = wanted
  let gen = null
  let cursor = 0
  const held = new Map()
  const note = (frame) => {
    const items = Array.isArray(frame.items) ? frame.items : []
    const row = { recvAt: Date.now(), type: frame.type, mode: frame.mode ?? null, gen: frame.gen ?? null, at: frame.at ?? null, readAt: frame.readAt ?? null, writtenAt: frame.writtenAt ?? null, ids: items.map((item) => item.id), itemAts: items.map((item) => item.at), reason: frame.reason ?? null, summary: chatSummary(items) }
    frames.push(row)
    for (const item of items) held.set(item.id, item)
    if (out !== null) fs.appendFileSync(out, JSON.stringify(row) + '\n')
  }
  const run = (resume) => new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 })
    let olderLeft = olderRounds
    const finish = () => { clearTimeout(timer); try { ws.terminate() } catch { /* 닫힘 */ } resolve() }
    const timer = setTimeout(finish, watchMs + 3000)
    const ask = (frame) => ws.send(JSON.stringify(frame))
    ws.on('open', () => ask({ type: 'hello', protocol: PROTOCOL, token, client: { name: 'repro', version: '1' } }))
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello' && message.ok === true) {
        if (channel !== null) ask(resume === null ? { type: 'chat.subscribe', channel } : { type: 'chat.subscribe', channel, gen: resume.gen, from: resume.from, cursor: resume.cursor })
        else ask({ type: 'list.subscribe' })
        return
      }
      if (message.type === 'list' && channel === null) {
        const channels = (message.list?.repos ?? []).flatMap((repo) => (repo.tasks ?? []).flatMap((task) => task.channels ?? []))
        channel = channels.find((item) => item.kind !== null && item.status === 'live')?.id ?? null
        if (channel === null) { errors.push('no_ai_channel'); finish(); return }
        ask({ type: 'chat.subscribe', channel })
        return
      }
      if (message.type === 'chat.page' || message.type === 'chat.items' || message.type === 'chat.unavailable') {
        note(message)
        if (typeof message.gen === 'string') gen = message.gen
        if (typeof message.cursor === 'number' && message.mode !== 'older') cursor = Math.max(cursor, message.cursor)
        if (message.type === 'chat.page' && message.hasOlder === true && olderLeft > 0) {
          olderLeft -= 1
          const first = Math.min(...[...held.keys()])
          ask({ type: 'chat.older', gen: message.gen, before: first })
          return
        }
        if (message.type === 'chat.page' && message.mode !== 'older') setTimeout(finish, watchMs)
        if (message.type === 'chat.page' && message.mode === 'older' && (message.hasOlder !== true || olderLeft === 0)) setTimeout(finish, watchMs)
        if (message.type === 'chat.unavailable') finish()
        return
      }
      if (message.type === 'error') errors.push(message.code)
    })
    ws.on('close', () => finish())
    ws.on('error', (error) => errors.push(String(error.message ?? error)))
  })
  await run(null)
  const first = frames.find((row) => row.type === 'chat.page')
  record('chat:page', first !== undefined && typeof first.gen === 'string' && first.summary.items > 0, { type: 'chat.page', gen: 'string', items: '> 0' }, { first: first ?? null, unavailable: frames.find((row) => row.type === 'chat.unavailable')?.reason ?? null, errors })
  const ids = [...held.keys()].sort((a, b) => a - b)
  const pageIds = frames.filter((row) => row.type === 'chat.page').flatMap((row) => row.ids)
  record('chat:no-duplicate-across-pages', new Set(pageIds).size === pageIds.length, { duplicates: 0 }, { pageItems: pageIds.length, unique: new Set(pageIds).size })
  if (olderRounds > 0) record('chat:older', frames.some((row) => row.mode === 'older'), { mode: 'older' }, { olderPages: frames.filter((row) => row.mode === 'older').length })
  if (args.resume === true && gen !== null && ids.length > 0) {
    const before = frames.length
    // 이어 받기(R1-A2) — 받은 세대 · 들고 있는 첫 id · 받은 가장 큰 변경 순번. 서버는 그 뒤에 생기거나 바뀐 것만 준다(끊긴 동안 변화가 없으면 0개).
    await run({ gen, from: ids[0], cursor })
    const resumed = frames.slice(before).find((row) => row.type === 'chat.page')
    record('chat:resume', resumed?.mode === 'resume' && resumed.ids.every((id) => id >= ids[0]), { mode: 'resume', idsFrom: ids[0] }, { mode: resumed?.mode ?? null, firstId: resumed?.ids[0] ?? null, items: resumed?.summary.items ?? 0 })
  }
  record('chat:summary', true, { note: '글 없이 개수·종류만' }, { frames: frames.length, pushes: frames.filter((row) => row.type === 'chat.items').length, held: chatSummary([...held.values()]) })
}

const FINAL_INPUT = new Set(['delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped', 'unknown'])

/**
 * 쓰기(LIFE-582) — hello → `--op` 하나를 보내고 그 id 의 `input.state` 를 끝 상태까지 모은다. 본문은 출력하지 않는다(바이트 수만).
 *   --op send   --channel <id> --text <글> | --text-file <파일>   [--repeat N — 같은 id 로 N 번 더 보낸다(Z2ⓐ)]
 *   --op cancel --id <id> · --op status --id <id>[,<id>…](모든 id 가 끝 상태여야 통과 — C3) · --op pending(이 기기의 끝나지 않은 요청, R1-A8 — 받은 개수)
 *   --op answer --channel <id> --question <말풍선 id | auto — 대화를 구독해 마지막 대기 질문> [--call <도구 호출 id — auto 면 그 질문의 것>]
 *               [--digest <질문 내용 지문 — auto 면 그 질문의 것, R2-A1>] --choice <0부터>[,…] | --other <글>
 *   --op stop   --channel <id>
 *   [--id <id>] [--expect <상태 — 끝 상태가 아니어도 된다(queued 면 대기에 들어간 순간 끝)>] [--wait-ms 30000]
 */
async function commandInput(url) {
  if (typeof args['token-file'] !== 'string') usage('input 에는 --token-file 이 필요하다')
  const token = readSecretFile(args['token-file'])
  const op = typeof args.op === 'string' ? args.op : ''
  const id = typeof args.id === 'string' ? args.id : `repro-${randomBytes(6).toString('hex')}`
  const channel = typeof args.channel === 'string' ? args.channel : null
  const waitMs = Number(args['wait-ms'] ?? 30_000)
  const repeat = Number(args.repeat ?? 0)
  let body
  switch (op) {
    case 'send': {
      const text = typeof args['text-file'] === 'string' ? fs.readFileSync(args['text-file'], 'utf8') : typeof args.text === 'string' ? args.text : null
      if (channel === null || text === null) usage('input --op send 에는 --channel 과 --text(또는 --text-file)가 필요하다')
      body = { type: 'input.send', id, channel, text }
      break
    }
    case 'cancel':
      body = { type: 'input.cancel', id }
      break
    case 'status':
      body = { type: 'input.status', ids: id.split(',') }
      break
    case 'answer': {
      const question = args.question === 'auto' ? -1 : Number(args.question)
      if (channel === null || !Number.isInteger(question)) usage('input --op answer 에는 --channel 과 --question(번호 또는 auto)이 필요하다')
      const choices = typeof args.choice === 'string' ? args.choice.split(',').map(Number) : []
      body = { type: 'question.answer', id, channel, question, call: typeof args.call === 'string' ? args.call : null, digest: typeof args.digest === 'string' ? args.digest : null, answers: [{ choices, other: typeof args.other === 'string' ? args.other : null }] }
      break
    }
    case 'pending':
      body = { type: 'input.pending' }
      break
    case 'stop':
      if (channel === null) usage('input --op stop 에는 --channel 이 필요하다')
      body = { type: 'turn.stop', id, channel }
      break
    default:
      usage('input 의 --op 는 send · cancel · status · pending · answer · stop 중 하나')
  }
  const expect = typeof args.expect === 'string' ? args.expect : null
  const watched = new Set(op === 'status' ? id.split(',') : [id])
  let picked = null
  const states = []
  const errors = []
  const finals = new Map()
  await new Promise((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.terminate(); resolve() }, waitMs)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token })))
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      const fire = () => {
        ws.send(JSON.stringify(body))
        for (let index = 0; index < repeat; index += 1) ws.send(JSON.stringify(body))
      }
      if (message.type === 'hello') {
        // `--question auto` — 그 채널 대화의 첫 페이지에서 마지막 대기 질문 id 를 고른다(글은 읽지 않는다).
        if (body.type === 'question.answer' && body.question === -1) ws.send(JSON.stringify({ type: 'chat.subscribe', channel }))
        else fire()
        if (op === 'pending') {
          clearTimeout(timer)
          setTimeout(() => { ws.close(); resolve() }, 1500)
        }
        return
      }
      if (message.type === 'chat.page' && body.type === 'question.answer' && body.question === -1) {
        const pending = (message.items ?? []).filter((item) => item.kind === 'question' && item.state === 'pending')
        const open = pending.at(-1) ?? null
        picked = open?.id ?? null
        if (picked === null) { errors.push('no_pending_question'); clearTimeout(timer); ws.close(); resolve(); return }
        body.question = picked
        if (body.call === null) body.call = typeof open.call === 'string' ? open.call : null
        if (body.digest === null) body.digest = typeof open.digest === 'string' ? open.digest : null
        fire()
        return
      }
      if (message.type === 'error') errors.push(message.code)
      // 복구 조회 — 보낸 뒤 1.5초 동안 온 것을 모은다(0건이면 아무것도 안 온다). 본문은 바이트 수만.
      if (op === 'pending') {
        if (message.type === 'input.state') states.push({ id: message.id, state: message.state, wait: message.wait, reason: message.reason, op: message.op, textBytes: typeof message.text === 'string' ? Buffer.byteLength(message.text) : null })
        return
      }
      if (message.type !== 'input.state' || !watched.has(message.id)) return
      states.push({ id: message.id, state: message.state, wait: message.wait, reason: message.reason })
      if (FINAL_INPUT.has(message.state)) finals.set(message.id, message.state)
      // 같은 id 를 다시 보냈으면 그만큼의 응답(지금 상태 재전송)도 받는다.
      const reached = expect !== null && !FINAL_INPUT.has(expect) && message.state === expect
      const enough = reached || (op === 'send' ? states.filter((row) => FINAL_INPUT.has(row.state)).length >= 1 && states.length >= 1 + repeat : finals.size === watched.size)
      if (enough) {
        clearTimeout(timer)
        setTimeout(() => { ws.close(); resolve() }, 300)
      }
    })
    ws.on('error', (error) => { errors.push(String(error)); clearTimeout(timer); resolve() })
  })
  // 지켜본 id 마다 마지막 상태 — 여러 id 조회(status)는 전부가 끝(또는 기대) 상태여야 한다(C3: 쉼표 붙은 문자열과 비교하던 결함).
  const lastOf = (one) => states.filter((row) => row.id === one).at(-1) ?? null
  const reachedAll = [...watched].every((one) => {
    const last = lastOf(one)
    return last !== null && (expect === null ? FINAL_INPUT.has(last.state) : last.state === expect)
  })
  const done = op === 'pending' ? expect === null || states.length === Number(expect) : reachedAll
  record(`input:${op}`, errors.length === 0 && done,
    { state: expect ?? 'any final' },
    { id, states, errors, question: picked, bytes: op === 'send' && typeof body.text === 'string' ? Buffer.byteLength(body.text) : null })
}

const COMMANDS = { pair: commandPair, hello: commandHello, matrix: commandMatrix, lifetime: commandLifetime, list: commandList, chat: commandChat, input: commandInput }

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
