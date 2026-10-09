#!/usr/bin/env node
// LIFE-577 최종 관문 — 격리 회차 묶음 드라이버(A1~A9). app/ 에서:
//
//   node scripts/l577/g-run.mjs <단계> <ROOT=/tmp/l577g-*> <FAKE=/tmp/l577g-f*> [OUT=<ROOT>/out]
//
// 단계: a1 · a3 · a3exp(10분 만료 대기 — 따로 돌린다) · a6 · a7 · a8 · a10dry(native-a10.mjs 드라이런) · clean-check
// 각 단계는 새 ROOT 에서 g-up.sh 로 개발 Electron 을 띄우고 g-down.sh 로 내린다(끝에 herdr 세션까지). 화면은 제어 소켓의
// DOM 합성(sendInputEvent·executeJavaScript)으로만 움직인다 — OS 입력 없음. tailscale 은 가짜 CLI(FAKE)만, 실제 CLI 는 `ip -4` 읽기 하나.
// 원자료는 OUT/g-<단계>-*.  토큰·코드는 메모리와 ROOT/sec(0700·0600)에만 두고 원자료에는 `<redacted>`, 맥 이름은 `<mac-name>`.
// 종료 코드: 0 단계의 모든 판정 통과 · 1 하나라도 미달 · 2 사용법.
/* global structuredClone */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  APP, calls, clickSwitch, ctl, evalJs, fakeState, lsofListen, openMobile, processSet, recorder, serveWrites,
  setFake, sleep, status, switchChecked, until,
} from './g-lib.mjs'

const [phase, ROOT, FAKE, OUT_ARG] = process.argv.slice(2)
const PHASES = ['a1', 'a3', 'a3exp', 'a6', 'a7', 'a8', 'a10dry', 'clean-check']
if (!PHASES.includes(phase) || !ROOT?.startsWith('/tmp/l577g-') || !FAKE?.startsWith('/tmp/l577g-f')) {
  console.error(`사용법: node scripts/l577/g-run.mjs <${PHASES.join('|')}> /tmp/l577g-<n> /tmp/l577g-f<n> [OUT]`)
  process.exit(2)
}
const OUT = path.resolve(OUT_ARG ?? path.join(ROOT, 'out'))
const PORT = 8577
const HOST = 'fake-mac.example.ts.net'
const VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version

// --- 가림 ----------------------------------------------------------------------------------------------
const secrets = new Set()
const macNames = new Set()
for (const read of [() => execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(), () => os.hostname(), () => os.hostname().replace(/\.local$/, '')]) {
  try { const name = read(); if (name.length > 0) macNames.add(name) } catch { /* 없음 */ }
}
const userName = os.userInfo().username
function mask(text) {
  let out = text
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join('<redacted>')
  for (const name of [...macNames].sort((a, b) => b.length - a.length)) out = out.split(name).join('<mac-name>')
  return out.split(`/Users/${userName}`).join('~')
}
const rec = recorder(path.join(OUT, `g-${phase}.log`))
const log = (...parts) => rec(mask(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')))
const verdicts = []
function judge(item, pass, detail) {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}

// --- 기동·종료 ----------------------------------------------------------------------------------------
let launches = 0
function up(extra = []) {
  launches += 1
  const run = spawnSync('sh', ['scripts/l577/g-up.sh', ROOT, FAKE, ...extra], { cwd: APP, encoding: 'utf8' })
  log(`$ sh scripts/l577/g-up.sh ${ROOT} ${FAKE} ${extra.join(' ')} → exit ${run.status}`)
  log(run.stdout.trim())
  if (run.status !== 0) { log(run.stderr); throw new Error('g-up 실패') }
}
function down(mode = 'term') {
  const run = spawnSync('sh', ['scripts/l577/g-down.sh', ROOT, mode], { cwd: APP, encoding: 'utf8' })
  log(`$ sh scripts/l577/g-down.sh ${ROOT} ${mode} → exit ${run.status}`)
  log(run.stdout.trim())
  const ms = run.stdout.match(/exit_ms=(\d+)/)
  return ms === null ? null : Number(ms[1])
}
async function waitExposure(kinds, timeoutMs = 20_000) {
  return until(async () => { const s = await status(ROOT); return kinds.includes(s.exposure.kind) ? s : null }, { timeoutMs, label: `exposure ${kinds}` })
}
const serveOf = () => fakeState(FAKE)?.serve ?? {}
const ownEntries = (serve) => Object.entries(serve.Web ?? {}).filter(([key]) => key.endsWith(`:${PORT}`)).flatMap(([key, site]) => Object.entries(site.Handlers ?? {}).map(([p, h]) => ({ key, path: p, proxy: h.Proxy })))
function shot(name, selector) {
  return ctl(ROOT, selector === undefined ? { cmd: 'shot', name } : { cmd: 'shot', name, selector }).then((reply) => {
    if (!reply.ok) throw new Error(`shot 실패 ${JSON.stringify(reply)}`)
    const target = path.join(OUT, `g-${name}.png`)
    fs.copyFileSync(reply.file, target)
    log(`shot ${name} → ${target}`)
    return target
  })
}
function lsofRecord(label) {
  const set = processSet(ROOT)
  log(`${label} pid 산출: 씨앗(명령줄에 ${ROOT}/ 를 가진 프로세스 중 부모가 씨앗 아닌 것 + herdr.pid) = ${set.roots.join(',')} → 자손 포함 ${set.pids.length}개`)
  for (const row of set.rows) log(`  pid=${row.pid} ppid=${row.ppid} ${row.command}`)
  const lines = lsofListen(set.pids)
  log(`$ lsof -nP -iTCP -sTCP:LISTEN -a -p ${set.pids.join(',')} → ${lines.length}줄`)
  for (const line of lines) log(`  ${line}`)
  return lines.filter((line) => !line.startsWith('COMMAND'))
}
function secDir() {
  const dir = path.join(ROOT, 'sec')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  return dir
}
function remember(token) { secrets.add(token); return token }
function repro(name, args) {
  const run = spawnSync(process.execPath, ['scripts/l577/repro.mjs', ...args], { cwd: APP, encoding: 'utf8', timeout: 120_000 })
  const file = path.join(OUT, `g-${phase}-repro-${name}.ndjson`)
  const shown = args.map((arg, i) => (['--code', '--used-code', '--expired-code', '--fresh-code'].includes(args[i - 1]) ? '<redacted>' : arg))
  fs.writeFileSync(file, mask(`# $ node scripts/l577/repro.mjs ${shown.join(' ')}\n${run.stdout}${run.stderr ? `# stderr: ${run.stderr.split('\n')[0]}\n` : ''}# exit ${run.status}\n`))
  log(`repro ${name} → exit ${run.status} (${file})`)
  const rows = run.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { code: run.status, rows, stdout: run.stdout }
}
async function newCode() {
  const reply = await ctl(ROOT, { cmd: 'mobile-pairing' })
  if (!reply.ok || !reply.pairing?.ok) return { ok: false, reply }
  secrets.add(reply.pairing.code)
  return { ok: true, code: reply.pairing.code, payload: reply.pairing.payload }
}
/** 인증한 WS 하나를 열어 둔다 — 해지·유지·모르는 타입 시험용. */
function holder(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messages = []
    const state = { ws, messages, closedAt: null, closeCode: null }
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); if (messages.length === 1) resolve(state) })
    ws.on('close', (code) => { state.closedAt = Date.now(); state.closeCode = code })
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token, client: { name: 'g-holder', version: '1' } })))
  })
}
const nextMessage = (state, count) => until(() => (state.messages.length >= count ? state.messages[count - 1] : null), { timeoutMs: 5000, label: 'ws 메시지' })
function ndjsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}
const corralLog = () => path.join(ROOT, 'ud', 'corral.ndjson')

// --- A1 꺼짐 무회귀 + A2 loopback --------------------------------------------------------------------------
async function a1() {
  setFake(FAKE, { serve: {} })
  log('## ① 새 userData 기동 — 꺼짐·LISTEN 0·tailscale 호출 0')
  up()
  await sleep(5000)
  const first = await status(ROOT)
  judge('A1ⓐ 새 userData 꺼짐(main)', first.enabled === false && first.serverPort === null, { enabled: first.enabled, serverPort: first.serverPort })
  const off1 = lsofRecord('A1ⓑ 새 userData')
  judge('A1ⓑ 새 userData LISTEN 0', off1.length === 0, { lines: off1.length })
  const calls1 = calls(FAKE).length
  down()
  const calls1b = calls(FAKE).length
  judge('A1ⓒ 새 userData 기동·종료 tailscale 호출 0', calls1 === 0 && calls1b === 0, { duringRun: calls1, afterQuit: calls1b })

  log('## ② 다시 기동 — 화면 스위치 꺼짐 → 켜기(양성 대조·A2) → 끄기')
  up()
  await openMobile(ROOT)
  const aria = await switchChecked(ROOT)
  judge('A1ⓐ 화면 스위치 꺼짐', aria === 'false', { ariaChecked: aria })
  await clickSwitch(ROOT)
  const on = await waitExposure(['exposed'])
  log('켜짐', { serverPort: on.value.serverPort, exposure: on.value.exposure, ms: on.ms })
  const onLines = lsofRecord('A1ⓑ 양성 대조(켜짐)')
  judge('A1ⓑ 양성 대조 — 켜면 LISTEN ≥1', onLines.length >= 1, { lines: onLines.length })
  const loopbackOnly = onLines.length >= 1 && onLines.every((line) => line.includes(`127.0.0.1:${on.value.serverPort} (LISTEN)`))
  judge('A2ⓐ 리슨 주소 127.0.0.1 만', loopbackOnly, { lines: onLines.map((line) => line.replace(/\s+/g, ' ')) })
  await a2Connect(on.value.serverPort)
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  await until(async () => (await status(ROOT)).serverPort === null, { label: '서버 정지' })
  const offAgain = lsofRecord('A1ⓑ 켰다 끈 뒤(같은 실행)')
  judge('A1ⓑ 켰다 끈 뒤 LISTEN 0', offAgain.length === 0, { lines: offAgain.length })
  down()
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'ud', 'settings.json'), 'utf8'))
  log('settings.json mobileEnabled =', settings.mobileEnabled)
  const calls2 = calls(FAKE).length

  log('## ③ 켰다 끈 뒤 재기동 — LISTEN 0·호출 증가 0')
  up()
  await sleep(5000)
  const third = await status(ROOT)
  const off3 = lsofRecord('A1ⓑ on→off→재기동')
  judge('A1ⓑ on→off→재기동 LISTEN 0', third.enabled === false && off3.length === 0, { enabled: third.enabled, lines: off3.length })
  const calls3 = calls(FAKE).length
  down('herdr')
  const calls3b = calls(FAKE).length
  judge('A1ⓒ on→off→재기동 기동·종료 tailscale 호출 0', calls3 === calls2 && calls3b === calls2, { before: calls2, duringRun: calls3, afterQuit: calls3b })
  log('calls.ndjson 전체(②의 켜기·끄기 호출만 있어야 한다):')
  for (const call of calls(FAKE)) log(' ', call)
}

/** A2ⓑ — 같은 포트에 LAN·tailnet IP 로 직접 접속 실패, 127.0.0.1 양성 대조 성공. */
async function a2Connect(port) {
  const tryConnect = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(3000, () => done('timeout'))
    socket.on('connect', () => done('connected'))
    socket.on('error', (error) => done(error.code ?? String(error)))
  })
  const lan = (() => { try { return execFileSync('ipconfig', ['getifaddr', 'en0'], { encoding: 'utf8' }).trim() } catch { return '' } })()
  const tsBin = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].find((bin) => fs.existsSync(bin))
  const tailnet = (() => { try { return execFileSync(tsBin, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0] } catch { return '' } })()
  const hidden = (ip) => (ip === '' ? '(없음)' : `${ip.split('.')[0]}.x.x.x`)
  log(`A2ⓑ 주소: en0=${hidden(lan)} tailnet(실제 CLI \`ip -4\` 읽기, ${tsBin ?? 'CLI 없음'})=${hidden(tailnet)}`)
  const results = {}
  for (const [label, host] of [['127.0.0.1', '127.0.0.1'], ['en0', lan], ['tailnet', tailnet]]) {
    results[label] = host === '' ? 'no-address' : await tryConnect(host)
    log(`  connect ${label}(${label === '127.0.0.1' ? host : hidden(host)}):${port} → ${results[label]}`)
  }
  judge('A2ⓑ 양성 대조 127.0.0.1 접속', results['127.0.0.1'] === 'connected')
  judge('A2ⓑ en0 LAN IP 접속 실패', lan !== '' && results.en0 !== 'connected', { result: results.en0 })
  judge('A2ⓑ tailnet 100.x 접속 실패', tailnet.startsWith('100.') && results.tailnet !== 'connected', { result: results.tailnet })
}

// --- A3·A4·A5·A9 + A8ⓒ(CSP)·QR 캡처 -----------------------------------------------------------------------
async function a3() {
  setFake(FAKE, { serve: {} })
  const sec = secDir()
  up()
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  const on = (await waitExposure(['exposed'])).value
  const url = `ws://127.0.0.1:${on.serverPort}/ws`
  log('서버', { url, exposure: on.exposure })

  log('## A4ⓐ 화면 「QR 만들기」 — QR·텍스트')
  const consoleBefore = ndjsonLines(corralLog()).filter((line) => line.includes('"renderer.console"')).length
  const click = await ctl(ROOT, { cmd: 'click', selector: '[data-mobile-create-pairing]' })
  log('click QR 만들기', { ok: click.ok, method: click.method })
  await until(() => evalJs(ROOT, `!!document.querySelector('[data-mobile-qr]')`), { label: 'QR' })
  const shown = await evalJs(ROOT, `(() => ({
    code: document.querySelector('[data-mobile-pairing-code]')?.textContent ?? '',
    url: document.querySelector('[data-mobile-pairing-url]')?.textContent ?? '',
    payload: document.querySelector('[data-mobile-pairing-payload]')?.textContent ?? '',
    qrCells: document.querySelectorAll('[data-mobile-qr] rect, [data-mobile-qr] path').length,
    qrViewBox: document.querySelector('[data-mobile-qr]')?.getAttribute('viewBox'),
  }))()`)
  secrets.add(shown.code)
  const uiCode = shown.code
  judge('A4ⓐ QR(svg)·텍스트(주소·코드·페이로드) 표시', shown.qrCells > 0 && /^[A-Z2-9]{8}$/.test(shown.code) && shown.url === `wss://${HOST}:${PORT}/ws` && shown.payload.includes(shown.code) && shown.payload.includes(HOST),
    { codeLength: shown.code.length, url: shown.url, payloadHasCode: shown.payload.includes(shown.code), payloadShape: mask(shown.payload), qrNodes: shown.qrCells, qrViewBox: shown.qrViewBox })
  await sleep(1500)
  const consoleLines = ndjsonLines(corralLog()).filter((line) => line.includes('"renderer.console"'))
  const cspLines = consoleLines.slice(consoleBefore).filter((line) => /Content Security Policy|Refused to/i.test(line))
  judge('A8ⓒ QR 표시 중 렌더러 콘솔 CSP 위반 0', cspLines.length === 0, { rendererConsoleSinceQr: consoleLines.length - consoleBefore, csp: cspLines.length })
  // 양성 대조 — 인라인 스크립트를 넣으면 CSP 가 막고 콘솔에 남는다(같은 수집 경로가 위반을 보는가).
  await evalJs(ROOT, `(() => { const s = document.createElement('script'); s.textContent = 'window.__l577g = 1'; document.head.appendChild(s); s.remove(); return window.__l577g ?? null })()`)
  await sleep(1500)
  const cspAfter = ndjsonLines(corralLog()).filter((line) => line.includes('"renderer.console"') && /Content Security Policy|Refused to/i.test(line))
  judge('A8ⓒ 양성 대조 — 인라인 스크립트 주입은 CSP 위반으로 잡힌다', cspAfter.length >= 1, { csp: cspAfter.length, sample: cspAfter[0]?.slice(0, 300) })
  // QR 캡처 — QR 이 코드를 담으므로 QR·코드·페이로드를 흐리게 한 뒤 찍는다(G5). 흐리기 전 표시는 위 DOM 조회가 원자료.
  await evalJs(ROOT, `for (const el of document.querySelectorAll('[data-mobile-qr],[data-mobile-pairing-code],[data-mobile-pairing-payload]')) el.style.filter = 'blur(9px)'; true`)
  await evalJs(ROOT, `document.querySelector('[data-mobile-pairing]')?.scrollIntoView({ block: 'center' }); true`)
  await shot('a8-qr-blurred')
  await evalJs(ROOT, `for (const el of document.querySelectorAll('[data-mobile-qr],[data-mobile-pairing-code],[data-mobile-pairing-payload]')) el.style.filter = ''; true`)

  log('## A4ⓒ 상한 5대 — 화면 코드로 1대, 계측 코드로 4대')
  const tokens = []
  const ids = []
  const pairOne = async (index, code) => {
    const before = new Set((await status(ROOT)).devices.map((device) => device.id))
    const file = path.join(sec, `d${index}`)
    const out = repro(`pair-d${index}`, ['pair', '--url', url, '--code', code, '--name', `g-d${index}`, '--token-out', file])
    const token = fs.existsSync(file) ? remember(fs.readFileSync(file, 'utf8').trim()) : null
    const after = (await status(ROOT)).devices.map((device) => device.id)
    const id = after.find((one) => !before.has(one)) ?? null
    tokens[index] = token
    ids[index] = id
    return { out, id }
  }
  const p1 = await pairOne(1, uiCode)
  const pairs = [p1]
  for (let i = 2; i <= 5; i += 1) {
    const fresh = await newCode()
    if (!fresh.ok) { log('코드 실패', fresh.reply); break }
    pairs.push(await pairOne(i, fresh.code))
  }
  const afterFive = await status(ROOT)
  judge('A4ⓒ 5대 페어링 성공(repro pair exit 0 ×5)', pairs.length === 5 && pairs.every((pair) => pair.out.code === 0 && pair.id !== null) && afterFive.devices.length === 5, { exits: pairs.map((pair) => pair.out.code), devices: afterFive.devices.length })
  const sixth = await ctl(ROOT, { cmd: 'mobile-pairing' })
  await ctl(ROOT, { cmd: 'click', selector: '[data-mobile-create-pairing]' })
  const sixthUi = await until(() => evalJs(ROOT, `document.querySelector('[data-mobile-pair-error]')?.textContent ?? null`), { label: '6번째 오류' }).catch(() => ({ value: null }))
  judge('A4ⓒ 6번째 거절 — 코드 발급부터 상한 거절(계측·화면)', sixth.ok === true && sixth.pairing?.ok === false && /상한/.test(sixth.pairing?.error ?? '') && /상한/.test(sixthUi.value ?? ''),
    { control: sixth.pairing, screen: sixthUi.value, note: '서버 pair 단계의 device_limit 은 코드가 발급되지 않아 실서버로 닿지 않는다 — pairing.test.ts·server.test.ts 단위 시험이 덮는다' })

  log('## A4ⓓ 기기 목록')
  const listed = await evalJs(ROOT, `Array.from(document.querySelectorAll('[data-mobile-device]')).map((el) => ({ id: el.getAttribute('data-mobile-device'), text: el.textContent }))`)
  log('status.devices', afterFive.devices)
  log('화면 행', listed)
  judge('A4ⓓ 기기 목록(이름·페어링 시각·마지막 접속) 5행', listed.length === 5 && afterFive.devices.every((device) => typeof device.name === 'string' && device.pairedAt > 0 && device.lastSeenAt !== null), { rows: listed.length })
  await evalJs(ROOT, `document.querySelector('[data-mobile-device]')?.scrollIntoView({ block: 'center' }); true`)
  await shot('a4-devices')

  log('## A4ⓔ 해지 즉시 거절 · A5ⓐⓑⓓ — d2·d3 연결을 열어 두고 d2 를 화면에서 해지')
  const h2 = await holder(url, tokens[2])
  const h3 = await holder(url, tokens[3])
  const hello = h3.messages[0]
  judge('A5ⓑ server.version = 앱 버전(package.json) · 프로토콜 숫자', hello.type === 'hello' && hello.ok === true && hello.server?.version === VERSION && hello.protocol === 1,
    { server: { ...hello.server, macName: hello.server?.macName === undefined ? undefined : '<mac-name>' }, protocol: hello.protocol, packageVersion: VERSION })
  const macName = hello.server?.macName
  judge('A5ⓓ 인증 뒤 hello 에 macName(비어 있지 않음, 이 맥의 이름과 일치)', typeof macName === 'string' && macName.length > 0 && macNames.has(macName), { macNameLength: macName?.length, matchesComputerNameOrHost: macNames.has(macName) })
  const connected = await status(ROOT)
  log('연결 표시', connected.devices.map((device) => ({ id: device.id, connected: device.connected })))
  const t0 = Date.now()
  const revokeClick = await ctl(ROOT, { cmd: 'click', selector: `[data-mobile-revoke="${ids[2]}"]` })
  await until(() => h2.closedAt, { timeoutMs: 5000, label: 'd2 닫힘' }).catch(() => null)
  const closeMs = h2.closedAt === null ? null : h2.closedAt - t0
  const revokedMessage = h2.messages.at(-1)
  await sleep(1500)
  h3.ws.send(JSON.stringify({ type: 'ping', id: 'g1' }))
  const pong = await nextMessage(h3, 2).then((r) => r.value).catch(() => null)
  judge('A4ⓔ 해지한 d2 의 열린 WS 1초 안에 닫힘(4003 revoked)', revokeClick.ok && closeMs !== null && closeMs <= 1000 && h2.closeCode === 4003, { clickOk: revokeClick.ok, closeMs, closeCode: h2.closeCode, last: revokedMessage })
  judge('A4ⓔ 양성 대조 — d3 는 1.5초 뒤에도 연결 유지(ping→pong)', h3.closedAt === null && pong?.type === 'pong', { pong })
  h3.ws.send(JSON.stringify({ type: 'state' }))
  const unknown = await nextMessage(h3, 3).then((r) => r.value).catch(() => null)
  judge('A5ⓐ 인증 뒤 모르는 타입 → 문서화된 오류', unknown?.type === 'error' && unknown?.code === 'unknown_type', { got: unknown })
  h3.ws.close()
  await sleep(300)

  log('## A3ⓑⓒ·A4ⓖ·A5ⓒ·A9 거절 행렬 — 실서버')
  const m1 = repro('matrix-1', ['matrix', '--url', url, '--token-file', path.join(sec, 'd1'), '--revoked-token-file', path.join(sec, 'd2'), '--used-code', uiCode, '--auth-timeout'])
  const fresh = await newCode()
  const m2 = repro('matrix-2', ['matrix', '--url', url, '--token-file', path.join(sec, 'd1'), '--fresh-code', fresh.code])
  const rows = [...m1.rows, ...m2.rows].filter((row) => typeof row.step === 'string')
  const failed = rows.filter((row) => row.pass !== true).map((row) => row.step)
  const stepPass = (step) => rows.some((row) => row.step === step && row.pass === true)
  judge('A3ⓑ 거절 행렬 + 양성 대조 전 줄 통과(matrix 2회 exit 0)', m1.code === 0 && m2.code === 0 && failed.length === 0, { exits: [m1.code, m2.code], rows: rows.length, failed })
  judge('A3ⓒ 미인증 시간 제한(4008)·크기 상한(1009) 각 1회', stepPass('ws:auth-timeout') && stepPass('ws:too-large'))
  judge('A4ⓖ code_used · code_invalid 실서버(만료는 a3exp 단계)', stepPass('ws:used-code') && stepPass('ws:unknown-code') && stepPass('ws:right-code-after-5-wrong'))
  judge('A5ⓒ 프로토콜 불일치 거절', stepPass('ws:protocol-mismatch'))
  const preAuthWithMac = rows.filter((row) => !/hello|pair|positive/.test(row.step) && JSON.stringify(row.got ?? {}).includes('macName'))
  judge('A5ⓓ 인증 전 응답에 macName 없음(행렬 거절 줄 전부)', preAuthWithMac.length === 0, { preAuthRows: rows.filter((row) => row.step.startsWith('ws:') || row.step.startsWith('http:')).length, withMacName: preAuthWithMac.length })

  log('## A4ⓕ·A8ⓐ 재기동 — 스위치 유지·재등록·기기·토큰 유효')
  const devicesBefore = (await status(ROOT)).devices.map((device) => device.id).sort()
  down()
  log('재기동 전 serve(종료 경로로 내려갔어야 함)', serveOf())
  up()
  const again = (await waitExposure(['exposed'])).value
  await openMobile(ROOT)
  const ariaAgain = await switchChecked(ROOT)
  const url2 = `ws://127.0.0.1:${again.serverPort}/ws`
  const devicesAfter = again.devices.map((device) => device.id).sort()
  const h1 = repro('hello-after-restart', ['hello', '--url', url2, '--token-file', path.join(sec, 'd1')])
  const hRevoked = repro('hello-revoked-after-restart', ['hello', '--url', url2, '--token-file', path.join(sec, 'd2')])
  judge('A4ⓕ 재기동 뒤 기기 목록 동일·토큰 유효(hello exit 0)·해지 토큰 거절(exit 1)', JSON.stringify(devicesBefore) === JSON.stringify(devicesAfter) && h1.code === 0 && hRevoked.code === 1, { before: devicesBefore.length, after: devicesAfter.length, helloExit: h1.code, revokedExit: hRevoked.code })
  judge('A8ⓐ 재기동 뒤 스위치 유지 + serve 재등록', ariaAgain === 'true' && ownEntries(serveOf()).length === 1 && ownEntries(serveOf())[0].proxy === `http://127.0.0.1:${again.serverPort}`, { ariaChecked: ariaAgain, entries: ownEntries(serveOf()) })
  const usage = repro('usage-error', ['nope'])
  judge('A9 종료 코드 0·1·2 각 1회 이상(실서버)', [m1.code, h1.code].includes(0) && hRevoked.code === 1 && usage.code === 2, { zero: m1.code, one: hRevoked.code, two: usage.code })

  await clickSwitch(ROOT)
  await waitExposure(['off'])
  down('herdr')
  a3Grep({ deviceId: devicesAfter[0] })
}

/** A3ⓓ — 이 회차의 토큰·코드가 userData·로그에 0건. 검색어는 0600 임시 파일(ROOT/sec)에만, 원자료엔 건수만. */
function a3Grep({ deviceId }) {
  const sec = secDir()
  const terms = path.join(sec, 'terms')
  fs.writeFileSync(terms, [...secrets].join('\n') + '\n', { mode: 0o600 })
  fs.chmodSync(terms, 0o600)
  const count = (file, target) => {
    // -l 만 — BSD grep 은 -c 를 같이 주면 맞지 않은 파일도 `file:0` 으로 찍는다(a3 1회차 미달 원인, g-a3-try1-grep-cause.txt).
    const run = spawnSync('/usr/bin/grep', ['-rFl', '-f', file, target], { encoding: 'utf8' })
    return { exit: run.status, files: run.stdout.split('\n').filter(Boolean).length }
  }
  const codes = [...secrets].filter((value) => value.length === 8).length
  const tokenCount = secrets.size - codes
  log(`A3ⓓ 검색어 ${secrets.size}개(코드 ${codes} · 토큰 ${tokenCount}) — ${terms}(0600, 커밋 안 함)`)
  const ud = count(terms, path.join(ROOT, 'ud'))
  const logOnly = count(terms, corralLog())
  log(`$ grep -rFl -f <terms> ${ROOT}/ud → 맞은 파일 ${ud.files}개 (exit ${ud.exit})`)
  log(`$ grep -rFl -f <terms> ${ROOT}/ud/corral.ndjson → 맞은 파일 ${logOnly.files}개 (exit ${logOnly.exit})`)
  const control = path.join(sec, 'control')
  fs.writeFileSync(control, `${deviceId}\n`, { mode: 0o600 })
  const positive = count(control, path.join(ROOT, 'ud'))
  log(`양성 대조: 기기 id(devices.json 에 있어야 함)로 같은 grep → 맞은 파일 ${positive.files}개 (exit ${positive.exit})`)
  const raw = count(terms, OUT)
  log(`원자료 폴더 ${OUT} 같은 grep → 맞은 파일 ${raw.files}개`)
  judge('A3ⓓ 토큰·코드 원문 userData·corral.ndjson 0건(+ 양성 대조 ≥1)', ud.exit === 1 && ud.files === 0 && logOnly.files === 0 && positive.files >= 1 && raw.files === 0, { udFiles: ud.files, logFiles: logOnly.files, positiveFiles: positive.files, rawFiles: raw.files })
  const deviceFile = execFileSync('find', [path.join(ROOT, 'ud'), '-name', 'devices.json'], { encoding: 'utf8' }).trim().split('\n')[0]
  const statOf = (file) => execFileSync('stat', ['-f', '%Sp %Lp %N', file], { encoding: 'utf8' }).trim()
  const fileStat = statOf(deviceFile)
  const dirStat = statOf(path.dirname(deviceFile))
  log(`$ stat ${fileStat}`)
  log(`$ stat ${dirStat}`)
  judge('A3ⓓ 기기 파일 0600 · 디렉터리 0700', fileStat.split(' ')[1] === '600' && dirStat.split(' ')[1] === '700', { file: fileStat, dir: dirStat })
}

// --- A4ⓖ 만료 — 10분 대기, 따로 돌린다 ------------------------------------------------------------------
async function a3exp() {
  setFake(FAKE, { serve: {} })
  const sec = secDir()
  up()
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  const on = (await waitExposure(['exposed'])).value
  const url = `ws://127.0.0.1:${on.serverPort}/ws`
  const first = await newCode()
  const pair = repro('pair-d1', ['pair', '--url', url, '--code', first.code, '--name', 'g-exp', '--token-out', path.join(sec, 'd1')])
  remember(fs.readFileSync(path.join(sec, 'd1'), 'utf8').trim())
  const doomed = await newCode()
  const t0 = Date.now()
  log(`만료될 코드 발급 ${new Date(t0).toISOString()} — 10분 + 15초 대기`)
  await sleep(10 * 60 * 1000 + 15_000)
  const st = await status(ROOT)
  log(`대기 끝 ${new Date().toISOString()} (경과 ${Math.round((Date.now() - t0) / 1000)}초) pairingExpiresAt=${st.pairingExpiresAt}`)
  const m = repro('matrix-expired', ['matrix', '--url', url, '--token-file', path.join(sec, 'd1'), '--expired-code', doomed.code, '--used-code', first.code])
  const row = m.rows.find((one) => one.step === 'ws:expired-code')
  judge('A4ⓖ code_expired 실서버(10분 실제 대기) + 행렬 전 줄 통과', pair.code === 0 && m.code === 0 && row?.pass === true, { pairExit: pair.code, matrixExit: m.code, expired: row })
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  down('herdr')
  a3Grep({ deviceId: st.devices[0]?.id })
}

// --- A6 serve 항목 ---------------------------------------------------------------------------------------
async function a6() {
  setFake(FAKE, { serve: {} })
  up()
  await openMobile(ROOT)
  log('## A6ⓐ 켜기 → 항목 1개')
  const before = serveOf()
  await clickSwitch(ROOT)
  const on = (await waitExposure(['exposed'])).value
  const after = serveOf()
  log('전', before); log('후', after)
  const entries = ownEntries(after)
  judge('A6ⓐ 켜기 → 8577 항목 1개, 대상 = 실서버 포트', JSON.stringify(before) === '{}' && entries.length === 1 && entries[0].path === '/' && entries[0].proxy === `http://127.0.0.1:${on.serverPort}` && after.TCP?.[String(PORT)]?.HTTPS === true && Object.keys(after.TCP).length === 1, { entries })

  log('## A6ⓑ 남의 항목(다른 포트 443 · 같은 포트 /other)이 있는 채 끄기 → 차이 = corral 항목뿐')
  const withForeign = structuredClone(after)
  withForeign.TCP['443'] = { HTTPS: true }
  withForeign.Web[`${HOST}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }
  withForeign.Web[`${HOST}:${PORT}`].Handlers['/other'] = { Proxy: 'http://127.0.0.1:4000' }
  setFake(FAKE, { serve: withForeign })
  const beforeOff = serveOf()
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  const afterOff = serveOf()
  log('전', beforeOff); log('후', afterOff)
  const expected = structuredClone(beforeOff)
  delete expected.Web[`${HOST}:${PORT}`].Handlers['/']
  judge('A6ⓑ 끄기 전후 차이 = corral `/` 하나', JSON.stringify(afterOff) === JSON.stringify(expected), { diff: 'Web[host:8577].Handlers["/"] 삭제만' })

  log('## A6ⓒ 8577 에 남의 항목 → 쓰기 0 + foreign 안내')
  setFake(FAKE, { serve: { TCP: { [PORT]: { HTTPS: true } }, Web: { [`${HOST}:${PORT}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } })
  const foreignBefore = serveOf()
  const mark = calls(FAKE).length
  await clickSwitch(ROOT)
  const foreign = (await waitExposure(['foreign'])).value
  await sleep(1000)
  const writes = serveWrites(calls(FAKE).slice(mark))
  const message = await evalJs(ROOT, `document.querySelector('[data-mobile-exposure]')?.textContent ?? ''`)
  log('calls(이 구간)', calls(FAKE).slice(mark))
  judge('A6ⓒ 8577 점유 → serve 쓰기 0 · 설정 그대로 · 안내', writes.length === 0 && JSON.stringify(serveOf()) === JSON.stringify(foreignBefore) && foreign.exposure.kind === 'foreign', { writes: writes.length, exposure: foreign.exposure, screen: message })
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  setFake(FAKE, { serve: {} })

  log('## A6ⓓ 정상 종료 ① SIGTERM(= 메뉴 ⌘Q 의 role quit 과 같은 before-quit 경로) → 제거')
  await clickSwitch(ROOT)
  await waitExposure(['exposed'])
  log('종료 전', serveOf())
  const termMs = down()
  log('종료 후', serveOf())
  judge('A6ⓓ SIGTERM(before-quit) 종료 → 항목 제거', JSON.stringify(serveOf()) === '{}', { exitMs: termMs })

  log('## A6ⓓ 정상 종료 ② 창 닫기(window.close → window-all-closed → app.quit) → 제거 · A8ⓐ 재기동 재등록')
  up()
  const re = (await waitExposure(['exposed'])).value
  log('재기동 뒤(스위치 유지)', { entries: ownEntries(serveOf()), serverPort: re.serverPort })
  judge('A8ⓐ 재기동 → 스위치 유지 · 재등록(대상 = 새 포트)', ownEntries(serveOf()).length === 1 && ownEntries(serveOf())[0].proxy === `http://127.0.0.1:${re.serverPort}`)
  const appPid = processSet(ROOT).roots[0]
  const tClose = Date.now()
  await ctl(ROOT, { cmd: 'eval', code: 'setTimeout(() => window.close(), 50); true' }).catch((error) => log('eval 응답', String(error)))
  await until(() => { try { process.kill(appPid, 0); return false } catch { return true } }, { timeoutMs: 20_000, label: '창 닫기 종료' })
  log(`창 닫기 → 프로세스 끝 ${Date.now() - tClose}ms`)
  log('종료 후', serveOf())
  judge('A6ⓓ 창 닫기 종료 → 항목 제거', JSON.stringify(serveOf()) === '{}')
  down()

  log('## A6ⓔ SIGKILL 뒤 재기동 — 켜 둔 상태 → 정확히 1개(대상 갱신)')
  up()
  const k1 = (await waitExposure(['exposed'])).value
  const portBefore = k1.serverPort
  down('kill')
  const leftover = ownEntries(serveOf())
  log('SIGKILL 뒤 남은 항목', leftover, '소유 기록', (() => { try { return fs.readdirSync(path.join(ROOT, 'ud', 'mobile')).join(',') } catch (error) { return String(error.code) } })())
  up()
  const k2 = (await waitExposure(['exposed'])).value
  const afterKill = ownEntries(serveOf())
  log('재기동 뒤', afterKill, { portBefore, portAfter: k2.serverPort })
  judge('A6ⓔ SIGKILL→재기동(켜짐) 항목 정확히 1개 · 대상 갱신', leftover.length === 1 && afterKill.length === 1 && afterKill[0].proxy === `http://127.0.0.1:${k2.serverPort}`, { portBefore, portAfter: k2.serverPort })
  log('## A6ⓔ SIGKILL 뒤 재기동 — 꺼 둔 상태 → 0 (죽은 동안 스위치를 바꿀 수 없어 settings.json mobileEnabled=false 를 오프라인 편집)')
  down('kill')
  const settingsFile = path.join(ROOT, 'ud', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, mobileEnabled: false }, null, 2))
  log('SIGKILL 뒤 남은 항목', ownEntries(serveOf()))
  up()
  await until(async () => ownEntries(serveOf()).length === 0 && (await status(ROOT)).exposure.kind === 'off', { label: '꺼짐 정리' }).catch(() => null)
  await sleep(1000)
  judge('A6ⓔ SIGKILL→재기동(꺼짐) 항목 0 (소유 기록과 대조해 제거)', ownEntries(serveOf()).length === 0 && JSON.stringify(serveOf()) === '{}', { serve: serveOf(), calls: calls(FAKE).slice(-3) })

  log('## A6ⓖ 5회 연타 → 마지막 값')
  await openMobile(ROOT)
  const stamps = []
  for (let i = 0; i < 5; i += 1) stamps.push((await clickSwitch(ROOT)).at)
  log('클릭 시각 간격(ms)', stamps.map((t, i) => (i === 0 ? 0 : t - stamps[i - 1])))
  await sleep(4000)
  const burst = await status(ROOT)
  judge('A6ⓖ 꺼짐에서 5회 → 켜짐 · 항목 1개 · 중복 없음', (await switchChecked(ROOT)) === 'true' && burst.exposure.kind === 'exposed' && ownEntries(serveOf()).length === 1, { exposure: burst.exposure.kind, entries: ownEntries(serveOf()) })
  for (let i = 0; i < 5; i += 1) await clickSwitch(ROOT)
  await sleep(4000)
  const burst2 = await status(ROOT)
  judge('A6ⓖ 켜짐에서 5회 → 꺼짐 · 항목 0', (await switchChecked(ROOT)) === 'false' && burst2.exposure.kind === 'off' && JSON.stringify(serveOf()) === '{}', { exposure: burst2.exposure.kind, serve: serveOf() })

  log('## A6ⓕ 종료 중 serve-remove 무응답 → 10초 안에 종료')
  await clickSwitch(ROOT)
  await waitExposure(['exposed'])
  setFake(FAKE, { hang: ['serve-remove'] })
  const hangMs = down()
  const hung = spawnSync('pgrep', ['-f', 'fake-tailscale.mjs'], { encoding: 'utf8' }).stdout.trim()
  log(`남은 가짜 CLI 프로세스: ${hung === '' ? '없음' : hung}`)
  judge('A6ⓕ serve-remove 무응답에도 10초 안에 종료', hangMs !== null && hangMs <= 10_000, { exitMs: hangMs })
  setFake(FAKE, { hang: [], serve: {} })
  down('herdr')
}

// --- A7 점검표·거부 + A8ⓔ 캡처 ----------------------------------------------------------------------------
async function a7() {
  setFake(FAKE, { serve: {} })
  up()
  await openMobile(ROOT)
  await shot('a8-off', '[data-settings-section="mobile"]').catch(() => shot('a8-off'))
  log('## A7ⓐ 점검표 4줄')
  await clickSwitch(ROOT)
  await waitExposure(['exposed'])
  const checks = await evalJs(ROOT, `Array.from(document.querySelectorAll('[data-mobile-check]')).map((el) => ({ key: el.getAttribute('data-mobile-check'), state: el.getAttribute('data-mobile-check-state'), text: el.textContent }))`)
  log('점검표', checks)
  judge('A7ⓐ 점검표 4줄(cli·loggedIn·https·funnelOff) 모두 ok', checks.length === 4 && checks.map((c) => c.key).join() === 'cli,loggedIn,https,funnelOff' && checks.every((c) => c.state === 'ok'))
  await shot('a8-on', '[data-settings-section="mobile"]').catch(() => shot('a8-on'))
  await clickSwitch(ROOT)
  await waitExposure(['off'])

  const scenarios = [
    ['logged-out', { backendState: 'NeedsLogin' }, 'logged_out'],
    ['https-off', { certDomains: [] }, 'https'],
    ['funnel-top', { serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [`${HOST}:443`]: true } } }, 'funnel'],
    ['funnel-foreground', { serve: { Foreground: { sess1: { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [`${HOST}:443`]: true } } } } }, 'funnel'],
    ['cli-hang', { hang: ['status'] }, 'unreadable'],
  ]
  for (const [name, patch, reason] of scenarios) {
    log(`## A7ⓑ ${name}`)
    setFake(FAKE, { backendState: 'Running', certDomains: [HOST], serve: {}, hang: [], ...patch })
    const mark = calls(FAKE).length
    const t0 = Date.now()
    await clickSwitch(ROOT)
    const blocked = (await waitExposure(['blocked'], 30_000)).value
    const writes = serveWrites(calls(FAKE).slice(mark))
    const screen = await evalJs(ROOT, `({ exposure: document.querySelector('[data-mobile-exposure]')?.textContent ?? '', checks: Array.from(document.querySelectorAll('[data-mobile-check]')).map((el) => el.getAttribute('data-mobile-check') + '=' + el.getAttribute('data-mobile-check-state')) })`)
    log('calls(이 구간)', calls(FAKE).slice(mark).map((c) => c.argv.join(' ')))
    judge(`A7ⓑ ${name} → 거부(${reason}) · serve 쓰기 0`, blocked.exposure.reason === reason && writes.length === 0, { ms: Date.now() - t0, exposure: blocked.exposure, screen })
    if (name === 'https-off') await shot('a8-rejected', '[data-settings-section="mobile"]').catch(() => shot('a8-rejected'))
    await clickSwitch(ROOT)
    await waitExposure(['off'])
    await sleep(500)
  }
  setFake(FAKE, { backendState: 'Running', certDomains: [HOST], serve: {}, hang: [] })
  down()

  log('## A7ⓑ cli-missing — CORRAL_TAILSCALE_BIN=/nonexistent 로 다시 기동')
  const mark = calls(FAKE).length
  up(['CORRAL_TAILSCALE_BIN=/nonexistent/tailscale'])
  await openMobile(ROOT)
  if ((await switchChecked(ROOT)) === 'false') await clickSwitch(ROOT)
  const missing = (await waitExposure(['blocked'])).value
  const screen = await evalJs(ROOT, `document.querySelector('[data-mobile-exposure]')?.textContent ?? ''`)
  judge('A7ⓑ cli-missing → 거부(cli) · 가짜 CLI 호출 0', missing.exposure.reason === 'cli' && calls(FAKE).length === mark, { exposure: missing.exposure, checklist: missing.checklist.cli, screen })
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  down()

  log('## A7ⓒ 켜진 동안 Funnel 켜짐 → 주기 재확인(30초)에서 제거·경고')
  up()
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  await waitExposure(['exposed'])
  const serve = serveOf()
  serve.TCP['443'] = { HTTPS: true }
  serve.Web[`${HOST}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }
  serve.AllowFunnel = { [`${HOST}:443`]: true }
  const tOn = Date.now()
  setFake(FAKE, { serve })
  log(`Funnel 켬(가짜 상태) ${new Date(tOn).toISOString()}`)
  const caught = await until(async () => { const s = await status(ROOT); return s.exposure.kind !== 'exposed' ? s : null }, { timeoutMs: 70_000, everyMs: 250, label: 'Funnel 감지' })
  const tCaught = Date.now()
  const warning = await evalJs(ROOT, `document.querySelector('[data-mobile-warning]')?.textContent ?? document.querySelector('[data-mobile-exposure]')?.textContent ?? ''`)
  log(`감지 ${new Date(tCaught).toISOString()} (Δ ${tCaught - tOn}ms)`, caught.value.exposure, { warning: caught.value.warning, screen: warning })
  log('serve 후', serveOf())
  judge('A7ⓒ Funnel 켜짐 → 60초 안 재확인에서 corral 항목 제거·경고', tCaught - tOn <= 60_000 && ownEntries(serveOf()).length === 0 && caught.value.exposure.reason === 'funnel', { deltaMs: tCaught - tOn })
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  setFake(FAKE, { serve: {} })
  down('herdr')
}

// --- A8ⓑⓓ 한 절·검색·팔레트 -----------------------------------------------------------------------------
async function a8() {
  setFake(FAKE, { serve: {} })
  up()
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  await waitExposure(['exposed'])
  const section = await evalJs(ROOT, `(() => { const s = document.querySelector('[data-settings-section="mobile"]'); if (!s) return null; const has = (q) => !!s.querySelector(q); return {
    sections: document.querySelectorAll('[data-settings-section]').length,
    switch: has('[data-settings-mobile-row="enabled"] [data-settings-switch]'), checklist: s.querySelectorAll('[data-mobile-check]').length,
    address: has('[data-mobile-address]'), qrButton: has('[data-mobile-create-pairing]'), devices: has('[data-mobile-devices-empty]') || has('[data-mobile-device]'),
  } })()`)
  judge('A8ⓑ 스위치·점검표·주소·QR·기기 목록이 한 절(data-settings-section=mobile)', section !== null && section.switch && section.checklist === 4 && section.address && section.qrButton && section.devices, section)
  log('## A8ⓓ 설정 검색')
  const clearSearch = async () => {
    const length = (await evalJs(ROOT, `document.querySelector('[data-settings-search]')?.value.length ?? 0`)) ?? 0
    for (let i = 0; i < length; i += 1) await ctl(ROOT, { cmd: 'key', keyCode: 'Backspace' })
  }
  const searched = {}
  for (const term of ['Mobile', 'Tailscale', 'QR']) {
    await ctl(ROOT, { cmd: 'click', selector: '[data-settings-search]' })
    // 합성 ⌘A 는 입력칸 전체 선택이 안 된다(a8 1회차 — 검색어가 이어 붙었다) — 글자 수만큼 Backspace 로 비운다.
    await clearSearch()
    await ctl(ROOT, { cmd: 'type', text: term })
    await sleep(400)
    const value = await evalJs(ROOT, `document.querySelector('[data-settings-search]')?.value ?? null`)
    searched[term] = await evalJs(ROOT, `Array.from(document.querySelectorAll('[data-settings-nav-item]')).map((el) => el.getAttribute('data-settings-nav-item'))`)
    log(`검색 "${term}" (입력칸 값 "${value}") → nav`, searched[term])
  }
  judge('A8ⓓ 설정 검색(Mobile·Tailscale·QR)에 mobile 절이 잡힌다', Object.values(searched).every((items) => items.includes('mobile')))
  await clearSearch()
  log('## A8ⓓ 팔레트')
  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await sleep(300)
  await ctl(ROOT, { cmd: 'key', keyCode: 'K', modifiers: ['meta'] })
  await until(() => evalJs(ROOT, `!!document.querySelector('[role="combobox"]')`), { label: '팔레트' })
  await ctl(ROOT, { cmd: 'type', text: 'Mobile' })
  await sleep(400)
  const entries = await evalJs(ROOT, `Array.from(document.querySelectorAll('[data-palette-entry]')).map((el) => el.getAttribute('data-palette-entry'))`)
  log('팔레트 항목', entries)
  const pick = await ctl(ROOT, { cmd: 'click', selector: '[data-palette-entry="settings.section:mobile"]' })
  await sleep(500)
  const active = await evalJs(ROOT, `document.querySelector('[data-settings-nav-item][aria-current="page"]')?.getAttribute('data-settings-nav-item') ?? null`)
  judge('A8ⓓ 팔레트 "Mobile" → settings.section:mobile → 실행 시 Mobile 절', entries.includes('settings.section:mobile') && pick.ok && active === 'mobile', { clickOk: pick.ok, active })
  await shot('a8-palette-landed', '[data-settings-section="mobile"]').catch(() => null)
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  down('herdr')
}

// --- A10 준비 — native-a10.mjs 드라이런(가짜 CLI · 개발 실행, 실제 tailscale 쓰기 없음) ------------------------
async function a10dry() {
  setFake(FAKE, { serve: {} })
  const env = {
    ...process.env, A10_TAILSCALE: path.join(APP, 'scripts/l577/fake-tailscale.mjs'), FAKE_TAILSCALE_DIR: FAKE,
    A10_APP_MATCH: `--user-data-dir=${ROOT}/ud`, A10_STATE: path.join(ROOT, 'a10state'), A10_RAW: path.join(OUT, 'a10-dryrun'),
  }
  const native = (stepName, extra = {}) => {
    const run = spawnSync(process.execPath, ['scripts/l577/native-a10.mjs', stepName], { cwd: APP, encoding: 'utf8', env: { ...env, ...extra.env }, input: extra.input ?? '', timeout: 600_000 })
    log(`$ node scripts/l577/native-a10.mjs ${stepName} → exit ${run.status}`)
    return run.status
  }
  log('드라이런 — 사람 걸음은 대역: 켜기·끄기 = 제어 소켓 DOM 클릭 · QR 코드 = mobile-pairing 계측 → stdin · ⌘Q = SIGTERM(g-down) · Finder 기동 = g-up(nohup, 부모가 끝나 ppid 1 — A7ⓓ 판정은 네이티브에서만)')
  up()
  const exits = {}
  exits.pre = native('pre')
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  const on = (await waitExposure(['exposed'])).value
  exits.b = native('b')
  const code = await newCode()
  const urlEnv = { A10_URL: `ws://127.0.0.1:${on.serverPort}/ws` }
  exits.c = native('c', { env: urlEnv, input: `${code.code}\n` })
  exits.d = native('d')
  // e — 앱 종료를 기다리는 동안 SIGTERM(⌘Q 대역) → 재기동(Finder 대역).
  const { spawn } = await import('node:child_process')
  const eRun = spawn(process.execPath, ['scripts/l577/native-a10.mjs', 'e'], { cwd: APP, env, stdio: 'ignore' })
  const eDone = new Promise((resolve) => eRun.on('exit', (status) => resolve(status)))
  await sleep(2000)
  down()
  await sleep(2000)
  up()
  exits.e = await eDone
  log(`$ node scripts/l577/native-a10.mjs e → exit ${exits.e}`)
  await openMobile(ROOT)
  await clickSwitch(ROOT)
  await waitExposure(['off'])
  exits.f = native('f')
  const device = (await status(ROOT)).devices.find((one) => one.name === 'a10-repro')
  const revoked = device === undefined ? null : await ctl(ROOT, { cmd: 'mobile-revoke', id: device.id })
  log('해지(사람 대역 — 계측 mobile-revoke)', { found: device !== undefined, revoked: revoked?.revoked })
  exits.status = native('status')
  log('calls(가짜 CLI) — native-a10 이 부른 것은 읽기뿐인지:', calls(FAKE).map((c) => c.argv.join(' ')).filter((line, i, all) => all.indexOf(line) === i))
  down('herdr')
  judge('A10 준비 — native-a10.mjs 드라이런 걸음 pre·b·c·d·e·f·status 모두 exit 0', Object.values(exits).every((exit) => exit === 0), exits)
}

/** 끝 정리 확인 — 이 ROOT 의 앱·herdr·가짜 CLI 가 안 남았나, 고아(PPID 1) 목록. */
function cleanCheck() {
  const left = spawnSync('pgrep', ['-fl', `${ROOT}/|l577g-|fake-tailscale.mjs`], { encoding: 'utf8' }).stdout.trim()
  log(`남은 프로세스(${ROOT}/ · l577g- · fake-tailscale.mjs): ${left === '' ? '0' : mask(left)}`)
  const orphans = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => /\s1\s/.test(line.slice(0, 16)) && /l577g|fake-tailscale|LIFE-577-mobile-server-claude\/app\/node_modules\/electron/.test(line))
  log(`고아(PPID 1) 중 이 작업 것: ${orphans.length}`)
  for (const line of orphans) log(' ', mask(line))
  judge('정리 — 남은 프로세스 0 · 고아 0', left === '' && orphans.length === 0)
}

const steps = { a1, a3, a3exp, a6, a7, a8, a10dry, 'clean-check': cleanCheck }
log(`# g-run ${phase} ROOT=${ROOT} FAKE=${FAKE} HEAD=${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim()} 시작 ${new Date().toISOString()} node ${process.version}`)
try {
  await steps[phase]()
} catch (error) {
  log('중단', String(error?.stack ?? error))
  verdicts.push({ item: '단계 완주', pass: false })
  try { down('herdr') } catch { /* 이미 내려감 */ }
}
const failed = verdicts.filter((v) => !v.pass)
log(`# 끝 ${new Date().toISOString()} 판정 ${verdicts.length - failed.length}/${verdicts.length} 통과 · 기동 ${launches}회${failed.length ? ` · 미달: ${failed.map((v) => v.item).join(' | ')}` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
