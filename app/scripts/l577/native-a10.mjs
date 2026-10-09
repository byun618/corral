#!/usr/bin/env node
// LIFE-577 A10 네이티브 회차 — 실제 tailscale·설치본(구현 브랜치 dmg)에서 코디·사용자가 한 걸음씩 돌린다. 절차·체크리스트는 native-a10.md.
//
//   node scripts/l577/native-a10.mjs <걸음> [--raw <원자료 폴더>]
//
// 걸음: pre · b · c · d · e · f · status   (ⓐ 켜기·⌘Q·끄기·해지는 사람이 화면에서 — 이 스크립트는 그 앞뒤를 읽어 판정한다)
//
// **이 스크립트는 tailscale 에 쓰지 않는다.** 부르는 것은 `version`·`status --json`·`serve status --json` 뿐이다.
// serve 항목을 올리고 내리는 것은 corral 앱이다. 실패해서 손으로 지워야 할 때의 명령은 화면에 찍기만 한다(native-a10.md 「멈춤·원복」).
//
// 환경(기본값은 네이티브. 드라이런은 가짜 CLI·개발 실행으로 바꾼다 — g-run.mjs a10dry):
//   A10_TAILSCALE   tailscale CLI 경로(기본 /Applications/Tailscale.app/Contents/MacOS/Tailscale → PATH 의 tailscale)
//   A10_APP_MATCH   앱 프로세스를 찾는 pgrep -f 패턴(기본 /Applications/corral.app/Contents/MacOS/corral)
//   A10_URL         repro 대상(기본 wss://<CertDomains[0]>:8577/ws — status --json 에서 읽는다, 하드코딩 없음)
//   A10_STATE       토큰·전후 원본 보관 폴더(기본 /tmp/l577a10, 0700 — 커밋 안 함, 끝(f)에 지운다)
//   A10_RAW         원자료 폴더(기본 ../specs/LIFE-577-mobile-server/raw/a10). --raw 가 우선
//
// 원자료에는 토큰·코드 원문이 없다(`<redacted>`). 맥 이름은 `<mac-name>`, 노드 DNS 이름은 `<host>`, tailnet 이름은 `<tailnet>` 으로 가린다.
// 종료 코드: 0 그 걸음 통과 · 1 미달(멈춤·원복 절차로) · 2 사용법·전제 오류.
/* global structuredClone */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const PORT = 8577
const argv = process.argv.slice(2)
const step = argv[0]
const rawFlag = argv.indexOf('--raw')
const RAW = path.resolve(rawFlag === -1 ? (process.env.A10_RAW ?? path.join(APP, '../specs/LIFE-577-mobile-server/raw/a10')) : argv[rawFlag + 1])
const STATE = process.env.A10_STATE ?? '/tmp/l577a10'
const APP_MATCH = process.env.A10_APP_MATCH ?? '/Applications/corral.app/Contents/MacOS/corral'
const TS = process.env.A10_TAILSCALE ?? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((bin) => fs.existsSync(bin)) ?? 'tailscale'
const STEPS = ['pre', 'b', 'c', 'd', 'e', 'f', 'status']
if (!STEPS.includes(step)) {
  console.error(`사용법: node scripts/l577/native-a10.mjs <${STEPS.join('|')}> [--raw <폴더>] — 절차는 scripts/l577/native-a10.md`)
  process.exit(2)
}
fs.mkdirSync(RAW, { recursive: true })
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 })
fs.chmodSync(STATE, 0o700)

// --- 읽기 전용 tailscale ---------------------------------------------------------------------------------
function ts(args) {
  const run = spawnSync(TS, args, { encoding: 'utf8', timeout: 10_000 })
  if (run.status !== 0) throw new Error(`tailscale ${args.join(' ')} 실패(exit ${run.status}): ${(run.stderr ?? '').trim().slice(0, 200)}`)
  return run.stdout
}
const readStatus = () => JSON.parse(ts(['status', '--json']))
const readServe = () => JSON.parse(ts(['serve', 'status', '--json']) || '{}')

// --- 가림 -------------------------------------------------------------------------------------------------
const hidden = []
function addHidden(value, label) { if (typeof value === 'string' && value.length > 0) hidden.push([value, label]) }
for (const read of [() => execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(), () => os.hostname().replace(/\.local$/, '')]) {
  try { addHidden(read(), '<mac-name>') } catch { /* 없음 */ }
}
let HOST = null
function learnHost(status) {
  const dns = String(status?.Self?.DNSName ?? '').replace(/\.$/, '')
  const cert = Array.isArray(status?.CertDomains) ? status.CertDomains[0] : null
  HOST = cert ?? (dns || null)
  if (dns) {
    const [label, ...rest] = dns.split('.')
    addHidden(dns, '<host>')
    addHidden(rest.join('.'), '<tailnet>')
    addHidden(label, '<mac-name>')
  }
  if (cert && cert !== dns) addHidden(cert, '<host>')
}
function mask(text) {
  let out = text
  for (const [value, label] of [...hidden].sort((a, b) => b[0].length - a[0].length)) out = out.split(value).join(label)
  for (const secret of secrets()) out = out.split(secret).join('<redacted>')
  return out.split(os.homedir()).join('~')
}
function secrets() {
  const file = path.join(STATE, 'token')
  return fs.existsSync(file) ? [fs.readFileSync(file, 'utf8').trim()].filter(Boolean) : []
}

// --- 원자료 -----------------------------------------------------------------------------------------------
const files = { pre: '00-pre', b: '02-serve-diff', c: '03-repro', d: '04-lsof', e: '05-quit-relaunch', f: '06-off-restore', status: '99-status' }
const rawFile = path.join(RAW, `a10-${files[step]}.txt`)
let rawText = ''
const out = (...parts) => {
  const line = mask(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
  rawText += line + '\n'
  console.log(line)
}
const verdicts = []
const judge = (item, pass, detail) => { verdicts.push(pass); out(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '') }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- serve 대조 -------------------------------------------------------------------------------------------
/** corral 항목 = `<HOST>:8577` 의 `/` Proxy http://127.0.0.1:<p>. */
function corralEntry(serve) {
  const proxy = serve?.Web?.[`${HOST}:${PORT}`]?.Handlers?.['/']?.Proxy
  return typeof proxy === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(proxy) ? proxy : null
}
/** corral 항목을 뺀 설정 — 전(pre)과 같아야 「corral 항목만 바뀌었다」. 빈 Web·TCP 칸은 지운다. */
function withoutCorral(serve) {
  const copy = structuredClone(serve ?? {})
  const key = `${HOST}:${PORT}`
  if (corralEntry(copy) !== null) {
    delete copy.Web[key].Handlers['/']
    if (Object.keys(copy.Web[key].Handlers).length === 0) {
      delete copy.Web[key]
      if (copy.TCP?.[String(PORT)]?.HTTPS === true) delete copy.TCP[String(PORT)]
    }
  }
  if (copy.Web && Object.keys(copy.Web).length === 0) delete copy.Web
  if (copy.TCP && Object.keys(copy.TCP).length === 0) delete copy.TCP
  if (copy.AllowFunnel && copy.AllowFunnel[key] === false) delete copy.AllowFunnel[key]
  if (copy.AllowFunnel && Object.keys(copy.AllowFunnel).length === 0) delete copy.AllowFunnel
  return copy
}
const canonical = (value) => JSON.stringify(value, Object.keys(flatKeys(value)).sort())
function flatKeys(value, acc = {}) {
  if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { acc[key] = true; flatKeys(inner, acc) }
  return acc
}
function funnelOn(config) {
  const allow = config?.AllowFunnel ?? {}
  if (Object.values(allow).some((value) => value === true)) return true
  return Object.values(config?.Foreground ?? {}).some((session) => funnelOn(session))
}
const preFile = path.join(STATE, 'serve-pre.json')
const readPre = () => {
  if (!fs.existsSync(preFile)) { console.error('pre 를 먼저 돌린다'); process.exit(2) }
  return JSON.parse(fs.readFileSync(preFile, 'utf8'))
}

// --- 앱 프로세스 -----------------------------------------------------------------------------------------
function appPids() {
  const run = spawnSync('pgrep', ['-f', '--', APP_MATCH], { encoding: 'utf8' })
  return run.stdout.split('\n').filter(Boolean).map(Number).filter((pid) => pid !== process.pid)
}
function tree(rootPids) {
  const table = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
  const all = new Set(rootPids)
  let grew = true
  while (grew) { grew = false; for (const row of table) if (all.has(row.ppid) && !all.has(row.pid)) { all.add(row.pid); grew = true } }
  return table.filter((row) => all.has(row.pid))
}

// --- 걸음 -------------------------------------------------------------------------------------------------
async function pre() {
  out(`# A10 pre ${new Date().toISOString()} — 읽기만(version · status --json · serve status --json). CLI=${TS}`)
  out('코디가 먼저 끝냈는가(이 스크립트는 하지 않는다): ① 설치본 userData 백업·해시 ② 원래 /Applications/corral.app 백업 ③ 구현 브랜치 dmg 설치')
  out('tailscale version:', ts(['version']).split('\n')[0])
  const status = readStatus()
  learnHost(status)
  const dns = String(status?.Self?.DNSName ?? '').replace(/\.$/, '')
  const certs = Array.isArray(status.CertDomains) ? status.CertDomains : []
  const serve = readServe()
  fs.writeFileSync(preFile, JSON.stringify(serve), { mode: 0o600 })
  fs.writeFileSync(path.join(STATE, 'host'), `${HOST}\n`, { mode: 0o600 })
  out('BackendState:', status.BackendState, '· Self.DNSName:', dns, '· CertDomains:', certs, '· URL:', process.env.A10_URL ?? `wss://${HOST}:${PORT}/ws`)
  out('serve status (전):', serve)
  judge('pre 로그인(Running)', status.BackendState === 'Running')
  judge('pre HTTPS 인증서(CertDomains 에 자기 이름)', certs.includes(dns))
  judge('pre Funnel 꺼짐(최상위·Foreground)', !funnelOn(serve))
  judge(`pre ${PORT} 비어 있음(남의 항목 없음)`, !serve?.TCP?.[String(PORT)] && !Object.keys(serve?.Web ?? {}).some((key) => key.endsWith(`:${PORT}`)))
  out('다음: 사람 — 설치본에서 설정 › Mobile › 「Mobile 켜기」(A10ⓐ). 점검표 4줄 ✓·상태 「노출됨」 을 화면에서 확인한 뒤 `b`.')
}

async function stepB() {
  const pre = readPre()
  learnHost(readStatus())
  const now = readServe()
  const entry = corralEntry(now)
  out(`# A10ⓑ serve 전후 ${new Date().toISOString()}`)
  out('전:', pre)
  out('후:', now)
  out('corral 항목:', entry)
  judge('A10ⓑ corral 항목 1개(`<host>:8577 /` → http://127.0.0.1:<p>)', entry !== null && now?.TCP?.[String(PORT)]?.HTTPS === true)
  judge('A10ⓑ 차이 = corral 항목뿐(항목 뺀 후 == 전)', canonical(withoutCorral(now)) === canonical(withoutCorral(pre)), { withoutCorral: withoutCorral(now) })
  judge('A10ⓑ Funnel 여전히 꺼짐', !funnelOn(now))
  out('다음: 사람 — 「QR 만들기」 → 화면의 8자 코드를 아래 `c` 가 묻는 곳에 입력(화면에 안 찍힌다).')
}

async function stepC() {
  learnHost(readStatus())
  const url = process.env.A10_URL ?? `wss://${HOST}:${PORT}/ws`
  out(`# A10ⓒ repro ${new Date().toISOString()} url=${url}`)
  const tokenFile = path.join(STATE, 'token')
  if (fs.existsSync(tokenFile)) { out(`${tokenFile} 가 이미 있다 — 전 회차 토큰. f 로 정리하거나 지운 뒤 다시`); process.exit(2) }
  const code = await readCode()
  const pair = spawnSync(process.execPath, ['scripts/l577/repro.mjs', 'pair', '--url', url, '--code', code, '--name', 'a10-repro', '--token-out', tokenFile], { cwd: APP, encoding: 'utf8', timeout: 60_000 })
  out(`$ node scripts/l577/repro.mjs pair --url ${url} --code <redacted> --name a10-repro --token-out ${tokenFile} → exit ${pair.status}`)
  out(pair.stdout.split(code).join('<redacted>').trim())
  judge('A10ⓒ pair → hello → ping 통과(wss, tailscale serve 경유)', pair.status === 0)
  const matrix = spawnSync(process.execPath, ['scripts/l577/repro.mjs', 'matrix', '--url', url, '--token-file', tokenFile], { cwd: APP, encoding: 'utf8', timeout: 120_000 })
  out(`$ node scripts/l577/repro.mjs matrix --url ${url} --token-file ${tokenFile} → exit ${matrix.status}`)
  out(matrix.stdout.trim())
  const rows = matrix.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const passed = (name) => rows.some((row) => row.step === name && row.pass === true)
  judge('A10ⓒ 미페어링 거절(토큰 없음·틀린 토큰) + 양성 대조(페어링한 기기 hello·ping)', passed('ws:no-token') && passed('ws:wrong-token') && passed('positive:hello') && passed('positive:ping'))
  judge('A10ⓒ 행렬 전 줄 통과(exit 0)', matrix.status === 0)
  out('다음: `d`(lsof).')
}

/** 코드는 화면에서 사람이 읽어 넣는다 — 터미널이면 에코 없이, 파이프면 첫 줄. 원자료에 남지 않는다. */
function readCode() {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (stdin.isTTY) {
      process.stdout.write('화면의 페어링 코드(8자, 입력은 안 보인다): ')
      stdin.setRawMode(true)
      let text = ''
      stdin.on('data', (chunk) => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') { stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(text.trim().toUpperCase()); return }
          if (char === '\u0003') process.exit(130)
          if (char === '\u007f') text = text.slice(0, -1)
          else text += char
        }
      })
      stdin.resume()
    } else {
      let text = ''
      stdin.on('data', (chunk) => { text += chunk })
      stdin.on('end', () => resolve(text.split('\n')[0].trim().toUpperCase()))
    }
  })
}

async function stepD() {
  out(`# A10ⓓ lsof ${new Date().toISOString()} — 앱 프로세스 트리(pgrep -f ${APP_MATCH} + 자손)`)
  const roots = appPids()
  const rows = tree(roots)
  for (const row of rows) out(`  pid=${row.pid} ppid=${row.ppid} ${row.command.slice(0, 140)}`)
  const pids = rows.map((row) => row.pid)
  const run = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')], { encoding: 'utf8' })
  const lines = run.stdout.split('\n').filter((line) => line && !line.startsWith('COMMAND'))
  out(`$ lsof -nP -iTCP -sTCP:LISTEN -a -p ${pids.join(',')} → ${lines.length}줄 (exit ${run.status})`)
  for (const line of lines) out(`  ${line}`)
  judge('A10ⓓ 앱 프로세스 찾음', roots.length > 0, { roots })
  judge('A10ⓓ LISTEN 이 전부 127.0.0.1(*·::·LAN·100.x 없음) · 1줄 이상', lines.length >= 1 && lines.every((line) => /\s127\.0\.0\.1:\d+ \(LISTEN\)$/.test(line)))
  out('다음: 사람 — 설치본에서 ⌘Q(메뉴 corral › 종료). `e` 를 먼저 띄워 두면 종료·재기동을 기다린다.')
}

async function stepE() {
  learnHost(readStatus())
  out(`# A10ⓔ + A7ⓓ ⌘Q → 제거 → Finder 재기동 → 재등록 ${new Date().toISOString()}`)
  const before = corralEntry(readServe())
  out('지금 corral 항목:', before)
  out('사람: ⌘Q 로 종료한다 — 앱 프로세스가 사라질 때까지 기다린다(최대 5분).')
  const t0 = Date.now()
  while (appPids().length > 0) { if (Date.now() - t0 > 300_000) { judge('A10ⓔ 종료 대기', false); return }; await sleep(250) }
  const tQuit = Date.now()
  await sleep(500)
  const afterQuit = readServe()
  out(`앱 끝 ${new Date(tQuit).toISOString()} · serve:`, afterQuit)
  judge('A10ⓔ ⌘Q 뒤 corral 항목 제거(나머지는 전과 같음)', corralEntry(afterQuit) === null && canonical(withoutCorral(afterQuit)) === canonical(withoutCorral(readPre())))
  out('사람: Finder 에서(Dock·Spotlight 아님, 셸 아님) /Applications/corral.app 를 연다 — 켜 둔 상태라 재등록을 기다린다(최대 5분).')
  let entry = null
  let pids = []
  while (entry === null) {
    if (Date.now() - tQuit > 300_000) break
    await sleep(1000)
    pids = appPids()
    if (pids.length > 0) entry = corralEntry(readServe())
  }
  const main = pids.length > 0 ? Math.min(...pids) : null
  const ppid = main === null ? null : Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(main)], { encoding: 'utf8' }).trim())
  out(`재기동 pid=${main} ppid=${ppid} (Finder·launchd 로 띄우면 ppid 1 — 셸 PATH 가 없다) · 항목: ${entry}`)
  judge('A10ⓔ 재기동(켜 둔 상태) → corral 항목 재등록', entry !== null, { before, after: entry, targetChanged: before !== entry })
  judge('A7ⓓ Finder 기동(ppid 1, 셸 PATH 없음)에서 CLI 를 찾아 재등록', entry !== null && ppid === 1, { ppid })
  out('다음: 사람 — 화면 점검표 「Tailscale CLI ✓ <경로>」 를 확인(캡처는 코디 재량). 이어서 「Mobile 켜기」 끄기 → `f`.')
}

async function stepF() {
  learnHost(readStatus())
  const pre = readPre()
  out(`# A10ⓕ 끄기 → serve 원복 ${new Date().toISOString()}`)
  let now = readServe()
  const t0 = Date.now()
  while (corralEntry(now) !== null && Date.now() - t0 < 120_000) { await sleep(1000); now = readServe() }
  out('전(pre):', pre)
  out('지금:', now)
  judge('A10ⓕ 끄기 → serve 가 관문 전과 같다(pre 가 {} 면 {})', canonical(now) === canonical(pre))
  out('사람: 설정 › Mobile › 기기 목록에서 「a10-repro」 를 해지한다(화면에서 사라짐 확인).')
  for (const file of ['token', 'serve-pre.json', 'host']) fs.rmSync(path.join(STATE, file), { force: true })
  out(`토큰·전 원본 지움: ${STATE}/{token,serve-pre.json,host} — 폴더 남은 것: ${fs.readdirSync(STATE).join(',') || '(없음)'}`)
  out('다음: 코디 — 원래 .app 복원 · userData 해시 대조(native-a10.md 「끝」).')
}

async function stepStatus() {
  learnHost(readStatus())
  const serve = readServe()
  out(`# 지금 ${new Date().toISOString()} corral 항목: ${corralEntry(serve)} · Funnel: ${funnelOn(serve)} · 앱 pid: ${appPids().join(',') || '(없음)'}`)
  out('serve:', serve)
}

const run = { pre, b: stepB, c: stepC, d: stepD, e: stepE, f: stepF, status: stepStatus }
try {
  await run[step]()
} catch (error) {
  out('중단:', String(error?.message ?? error))
  verdicts.push(false)
}
fs.writeFileSync(rawFile, rawText)
console.log(`원자료 → ${rawFile}`)
process.exit(verdicts.every(Boolean) ? 0 : 1)
