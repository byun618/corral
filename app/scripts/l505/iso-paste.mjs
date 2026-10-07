// LIFE-505 K1·K2·K4ⓒ **격리** 실측 — before 빌드(main)와 구현 빌드에 같은 순서로 돌린다.
// l497/iso-probe.mjs 의 골격(격리 launchCorral · 바이트 싱크)을 가져와 텍스트 붙여넣기 경우로 바꿨다.
// 격리 = /tmp/l505i* 아래 userData·herdr 세션 `l443-gui-diff`·제어 소켓. 사용자 userData·herdr default·life417-native 는 안 건드린다.
//
// v2 (코디 답 2026-10-07): **포커스를 뺏지 않는다.** v1(OS ⌘V·창 activate·OS 드래그)은 사용자가 쓰는 중인 기계에서
// 사용자 타건이 격리 pane 으로 섞였다(before-2 A1~A3). 그래서
//   · 텍스트 붙여넣기 = 렌더러에서 합성 ClipboardEvent('paste', DataTransfer text/plain)를 그 pane 의 xterm textarea 에 dispatch.
//     제품 캡처 리스너·xterm 리스너를 그대로 탄다. 시스템 클립보드 불변. (OS 메뉴 → DOM paste 단계는 이 작업이 바꾸지 않고 K3 네이티브가 덮는다)
//   · 이미지 붙여넣기 = 같은 합성 paste(텍스트 없음) — 제품이 main 에서 시스템 클립보드를 읽으므로 **유휴 가드 + 클립보드 저장·복원** 안에서만.
//   · Ctrl+V = 제어 소켓 key(sendInputEvent — 앱을 앞으로 가져오지 않는다). ⌘C 복사 = 합성 더블클릭(선택) + 합성 copy 이벤트.
//   · 파일 드롭 = OS 드래그를 쓰지 않는다 → 이 드라이버는 재지 않는다(단위 테스트·diff 로 대신, RESULT 에 기록).
//   · 앱 기동은 창을 앞으로 가져온다(ready-to-show) — 기동 전 유휴 가드, 기동 직후 이전 맨 앞 앱을 다시 앞으로.
// 관측점: ① pane 안 바이트 싱크(byte-sink.mjs — PTY 가 실제로 받은 바이트) ② 격리 herdr 서버 로그(oversized·closing)
//         ③ xterm 버퍼(term-read — 셸 화면) ④ 렌더러 진단 링(window.corralTermProbe inputs — 렌더러가 보낸 바이트·출처).
// 사용: node iso-paste.mjs --app <앱 폴더> --work /tmp/l505iX --port 98NN --out <raw 폴더> --label before|after
//        [--only A,B,S,O,X,I,R,L] [--lmode 1,0] [--sizes 1024,…,mb1572864]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { clip, frontmost, pause, requirements, run, sinkRows, solidPng, waitIdle } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l505i')) throw new Error('--work 는 /tmp/l505i*')
if (args.label !== 'before' && args.label !== 'after') throw new Error('--label before|after')
const only = new Set((args.only ?? 'A,B,S,O,R').split(','))
// 504 가드 — 같은 격리 경로를 쓰는 다른 프로세스(Electron·herdr)가 있으면 측정하지 않고 멈춘다.
const clash = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(work) && !line.includes('iso-paste.mjs'))
if (clash.length > 0) {
  console.log('[iso] 같은 격리 경로에 다른 프로세스가 있다 — 멈춘다\n' + clash.join('\n'))
  process.exit(9)
}
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true })
const NODE = `${process.env.HOME}/.nvm/versions/node/v24.14.1/bin/node`
const HERE = path.dirname(new URL(import.meta.url).pathname)
const SINK_SCRIPT = path.join(HERE, 'byte-sink.mjs')

const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const clipPng = path.join(work, 'clip.png')
fs.writeFileSync(clipPng, solidPng({ width: 32, height: 20, rgb: [30, 90, 200] }))
// 큰 붙여넣기 본문 — ASCII 64바이트 줄(`l505-NNNNNNN ` + 채움 + \n), 정확히 size 바이트.
const bigText = (size) => {
  const lines = []
  let total = 0
  for (let i = 0; total < size; i += 1) {
    const head = `l505-${String(i).padStart(7, '0')} `
    const line = `${head}${'x'.repeat(Math.max(0, 63 - head.length))}\n`
    lines.push(line)
    total += line.length
  }
  return lines.join('').slice(0, size - 1) + '\n'
}

// fix1 F3 — 한글·이모지 섞인 본문, UTF-8 으로 정확히 size 바이트 이상(마지막 줄 끝 \n). 1MB 경계가 다바이트 글자 사이에 떨어진다.
const bigTextMb = (size) => {
  const lines = []
  let total = 0
  for (let i = 0; total < size; i += 1) {
    const line = `l505-${String(i).padStart(7, '0')} 한글붙여넣기😀테스트 ${'가나다'.repeat(3)}\n`
    lines.push(line)
    total += Buffer.byteLength(line)
  }
  return lines.join('')
}
const result = { label: args.label, harness: 'v2 합성 paste (포커스 안 뺏음) + fix1(L·S 판정 승격·다바이트·선택 X·큰 이미지 I)', app: path.resolve(args.app), work, startedAt: new Date().toISOString(), cases: [], notes: [], guard: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-paste.json'), `${JSON.stringify(result, null, 1)}\n`)
const owned = []
let exitCode = 0
const checks = requirements((row) => { if (!row.pass) console.log('[iso] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results
const ESC = '\x1b'
const wrap = (text) => `${ESC}[200~${text}${ESC}[201~`
const PASTE_PNG = '/corral-paste/corral-paste-\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png'
const T = { one: 'hello l505', multi: 'line1\nline2', crlf: 'a\r\nb\nc', esc: `x${ESC}[201~tail` }
// 기대 바이트 — before = xterm 평소 붙여넣기(corral xterm 의 2004 비트는 늘 false → 틀 없음, prepareTextForTerminal 의 \r?\n→\r).
// after 2004 켬 = 강제 틀(\r?\n→\r, 안쪽 ESC→U+241B) 그대로 도착 · 2004 끔 = herdr 가 틀을 벗긴다.
// before 의 ESC 경우는 기대값을 두지 않는다(기록만) — 틀 없는 ESC[201~ 를 분류기가 어떻게 다루는지가 관측 대상이다.
const cr = (text) => text.replace(/\r?\n/g, '\r')
const EXPECT = {
  before: { 'A1-one': T.one, 'A2-multi': cr(T.multi), 'A3-crlf': cr(T.crlf), 'A4-esc': null, 'B1-one': T.one, 'B2-multi': cr(T.multi), 'B3-crlf': cr(T.crlf), 'B4-esc': null },
  after: {
    'A1-one': wrap(T.one), 'A2-multi': wrap(cr(T.multi)), 'A3-crlf': wrap(cr(T.crlf)), 'A4-esc': wrap('x␛[201~tail'),
    'B1-one': T.one, 'B2-multi': cr(T.multi), 'B3-crlf': cr(T.crlf), 'B4-esc': 'x␛[201~tail',
  },
}
const sinkFile = path.join(work, 'sink.ndjson')
let sinkAt = 0
const hex = (text) => Buffer.from(text, 'utf8').toString('hex')
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

// 시스템 클립보드를 쓰는 회차 — 유휴 가드 → 쓰기 직전 내용 저장 → fn → 복원(텍스트면 바이트, 그 밖은 종류만 기록).
const withSystemClipboard = async (name, fn) => {
  const idle = await waitIdle({ log: (row) => console.log('[iso] 유휴 대기', name, JSON.stringify(row)) })
  const saved = { dump: clip('dump').out }
  const items = (() => { try { return JSON.parse(saved.dump).items } catch { return [] } })()
  const hasText = items.some((types) => types.includes('public.utf8-plain-text'))
  const savedFile = path.join(work, `clip-saved-${name}.txt`)
  if (hasText) {
    const text = execFileSync('/tmp/l505b/clip', ['get-text'], { encoding: 'utf8' }).replace(/\n$/, '')
    fs.writeFileSync(savedFile, text)
    saved.textBytes = Buffer.byteLength(text)
    saved.sha256 = sha(text)
  }
  const row = { name, idle, saved }
  result.guard.push(row)
  if (!idle.ok) {
    row.skipped = '유휴 20초를 10분 안에 못 봤다 — 보류'
    save()
    return null
  }
  try {
    return await fn()
  } finally {
    if (hasText) {
      clip('textfile', savedFile)
      const back = execFileSync('/tmp/l505b/clip', ['get-text'], { encoding: 'utf8' }).replace(/\n$/, '')
      row.restored = { sha256: sha(back), match: sha(back) === saved.sha256 }
    } else {
      clip('clear')
      row.restored = { cleared: true, before: items }
    }
    fs.rmSync(savedFile, { force: true })
    save()
  }
}

try {
  const front0 = frontmost()
  const launchIdle = await waitIdle({ log: (row) => console.log('[iso] 기동 전 유휴 대기', JSON.stringify(row)) })
  result.guard.push({ name: 'launch', idle: launchIdle, front: front0 })
  if (!launchIdle.ok) throw new Error('기동 전 유휴 가드 실패 — 보류')
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const appPid = handle.status?.runtime?.pid
  result.appPid = appPid
  // 기동이 창을 앞으로 가져왔다 — 이전 맨 앞 앱을 되돌린다(사용자 타건이 이 창으로 오지 않게).
  if (front0?.pid && front0.pid !== appPid) result.guard.push({ name: 'refocus', restored: run('activate', [front0.pid]).out, front: frontmost() })
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  // herdr 서버 로그 — oversized·closing 경고가 여기 찍힌다(before-1 실측: `oversized targeted pane input batch, closing`).
  const backendLog = path.join(work, 'corral-herdr', 'herdr', 'sessions', 'l443-gui-diff', 'herdr-server.log')
  let backendAt = 0
  const backendRows = () => {
    if (!fs.existsSync(backendLog)) return []
    const text = fs.readFileSync(backendLog, 'utf8')
    const fresh = text.slice(backendAt)
    backendAt = text.length
    return fresh.split('\n').filter((line) => /WARN|ERROR|oversized|reject/.test(line)).slice(0, 20)
  }
  const ndjson = path.join(handle.paths.userData, 'corral.ndjson')
  let logAt = 0
  const logRows = () => {
    if (!fs.existsSync(ndjson)) return []
    const lines = fs.readFileSync(ndjson, 'utf8').split('\n').filter(Boolean)
    const fresh = lines.slice(logAt)
    logAt = lines.length
    return fresh.map((line) => { try { return JSON.parse(line) } catch { return { raw: line } } })
      .filter((row) => /^(paste|stream\.(closed|input_blocked|error)|renderer\.console|drop)/.test(String(row.tag ?? '')))
      .map((row) => JSON.parse(JSON.stringify(row, (key, value) => (typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…(${value.length})` : value))))
      .slice(0, 30)
  }

  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  let ws = null
  for (let i = 0; i < 150 && !(ws = await workspaceOf()); i += 1) await pause(200)
  if (!ws) throw new Error('fixture workspace 가 안 열렸다')
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  const paneId = created.paneId
  result.pane = { created }
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  for (let i = 0; i < 50 && !(await evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneId)); i += 1) await pause(200)
  await pause(1500)

  const type = (data) => evaluate((input) => window.corral.termInput(input), { paneId, data })
  const termRead = async () => (await control({ cmd: 'term-read' })).term
  let ringSeen = 0
  const freshRing = async () => {
    const all = await evaluate(() => (window.corralTermProbe?.read().inputs ?? []).map((entry) => ({ source: entry.source ?? 'onData', len: entry.data.length, head: entry.data.slice(0, 60) })))
    const fresh = all.slice(ringSeen)
    ringSeen = all.length
    return fresh
  }
  // 합성 paste — 그 pane 의 xterm textarea 에 ClipboardEvent 를 쏜다. 큰 본문은 렌더러에 512KB 씩 나눠 싣는다(제어 소켓 줄 크기).
  const synthPaste = async (text) => {
    await evaluate(() => { window.__l505text = ''; return true })
    if (text !== null) for (let i = 0; i < text.length; i += 512 * 1024) await evaluate((chunk) => { window.__l505text += chunk; return window.__l505text.length }, text.slice(i, i + 512 * 1024))
    return evaluate((input) => {
      const box = document.querySelector(`[data-term-pane-box="${input.paneId}"]`)
      const area = box?.querySelector('textarea.xterm-helper-textarea')
      if (!area) return { dispatched: false, reason: 'textarea 없음' }
      const data = new DataTransfer()
      if (input.hasText) data.setData('text/plain', window.__l505text)
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      area.dispatchEvent(event)
      window.__l505text = ''
      return { dispatched: true, defaultPrevented: event.defaultPrevented, textLen: data.getData('text/plain').length, types: [...data.types] }
    }, { paneId, hasText: text !== null })
  }

  const startSink = async (bracketed) => {
    const before = sinkRows(sinkFile, 0).next
    await type(`${NODE} ${SINK_SCRIPT} ${sinkFile} ${bracketed}\r`)
    const t0 = Date.now()
    while (!sinkRows(sinkFile, before).rows.some((row) => row.event === 'start' && row.bracketed === (bracketed === 1))) {
      if (Date.now() - t0 > 15_000) throw new Error(`싱크가 안 떴다 (bracketed=${bracketed})`)
      await pause(200)
    }
    await pause(300)
    sinkAt = sinkRows(sinkFile, 0).next
    await freshRing()
  }
  const stopSink = async () => {
    await type('\x1d')
    await pause(800)
    await freshRing()
  }
  // 싱크가 quietMs 동안 더 받지 않을 때까지 기다린 뒤 모은다 — 큰 붙여넣기는 여러 덩어리로 온다.
  const drainSink = async ({ quietMs = 1500, maxMs = 30_000 } = {}) => {
    const t0 = Date.now()
    let last = sinkRows(sinkFile, sinkAt).rows.length
    let stableSince = Date.now()
    while (Date.now() - t0 < maxMs) {
      await pause(250)
      const now = sinkRows(sinkFile, sinkAt).rows.length
      if (now !== last) { last = now; stableSince = Date.now() } else if (Date.now() - stableSince >= quietMs) break
    }
    const { rows, next } = sinkRows(sinkFile, sinkAt)
    sinkAt = next
    return rows.filter((row) => row.event === 'data')
  }
  const textCase = async ({ name, text, want, small = true }) => {
    const sent = await synthPaste(text)
    const data = await drainSink(small ? {} : { quietMs: 3000, maxMs: 60_000 })
    const got = Buffer.concat(data.map((row) => Buffer.from(row.hex, 'hex'))).toString('utf8')
    const gotBytes = data.reduce((sum, row) => sum + row.hex.length / 2, 0)
    const entry = {
      name, kind: 'text', method: 'synthetic ClipboardEvent paste → xterm textarea', sent,
      sentText: small ? { text, hex: hex(text) } : { bytes: Buffer.byteLength(text), sha256: sha(text) },
      sink: small ? data.map(({ hex: h, text: t }) => ({ hex: h, text: t })) : { chunks: data.length, bytes: gotBytes, sha256: sha(got), head: got.slice(0, 40), tail: got.slice(-40) },
      ring: await freshRing(), log: logRows(), backend: backendRows(),
    }
    if (want !== undefined && want !== null) {
      entry.want = small ? { text: want, hex: hex(want) } : { bytes: Buffer.byteLength(want), sha256: sha(want) }
      entry.match = got === want
      if (small) checks.require(`${name}-sink`, got === want, { got, want })
    }
    result.cases.push(entry)
    save()
    console.log('[iso]', name, JSON.stringify(small ? { got: got.slice(0, 120), match: entry.match, prevented: sent.defaultPrevented } : { gotBytes, match: entry.match, chunks: data.length }))
    return { entry, got }
  }
  const imageCase = async ({ name, want }) => {
    const done = await withSystemClipboard(name, async () => {
      clip('png', clipPng)
      const sent = await synthPaste(null)
      const data = await drainSink()
      return { sent, data }
    })
    if (done === null) {
      result.cases.push({ name, kind: 'image', skipped: '유휴 가드 — 보류' })
      return
    }
    const got = done.data.map((row) => row.text).join('')
    result.cases.push({ name, kind: 'image', method: 'synthetic paste(텍스트 없음) + 시스템 클립보드 PNG(가드 안)', sent: done.sent, sink: done.data.map(({ hex: h, text: t }) => ({ hex: h, text: t })), ring: await freshRing(), log: logRows() })
    checks.require(`${name}-sink`, want.test(got), { got })
    save()
    console.log('[iso]', name, JSON.stringify({ got: got.slice(0, 120) }))
  }

  // ── A: 2004 켠 앱 (에이전트 TUI 조건) ──
  if (only.has('A')) {
    await startSink(1)
    logRows(); backendRows()
    await textCase({ name: 'A1-one', text: T.one, want: EXPECT[args.label]['A1-one'] })
    await textCase({ name: 'A2-multi', text: T.multi, want: EXPECT[args.label]['A2-multi'] })
    await textCase({ name: 'A3-crlf', text: T.crlf, want: EXPECT[args.label]['A3-crlf'] })
    const esc = await textCase({ name: 'A4-esc', text: T.esc, want: EXPECT[args.label]['A4-esc'] })
    // K1ⓒ — 끼어든 ESC[201~ 가 틀을 일찍 닫지 않았다 = 받은 바이트의 닫는 틀이 정확히 1개, 맨 끝.
    if (args.label === 'after') checks.require('A4-esc-one-close-at-end', esc.got.split(`${ESC}[201~`).length === 2 && esc.got.endsWith(`${ESC}[201~`), { got: esc.got })
    await imageCase({ name: 'A5-image', want: new RegExp(`^\\x1b\\[200~/.*${PASTE_PNG}\\x1b\\[201~$`) })
    // Ctrl+V (K4ⓒ) — 가로채지 않는다: `\x16` 한 바이트. 제어 소켓 key(sendInputEvent) — 포커스 안 뺏음.
    await evaluate((id) => { document.querySelector(`[data-term-pane-box="${id}"] textarea.xterm-helper-textarea`)?.focus(); return document.activeElement?.className }, paneId)
    const key = await control({ cmd: 'key', keyCode: 'V', modifiers: ['control'] })
    const kd = await drainSink()
    const kgot = kd.map((row) => row.text).join('')
    result.cases.push({ name: 'A6-ctrlv', kind: 'key', method: 'control key (sendInputEvent) Ctrl+V', key, sink: kd.map(({ hex: h, text: t }) => ({ hex: h, text: t })), ring: await freshRing() })
    checks.require('A6-ctrlv-sink', kgot === '\x16', { got: kgot })
    console.log('[iso] A6-ctrlv', JSON.stringify({ got: kgot }))
    save()
    await stopSink()
  }
  // ── B: 2004 끈 앱 (bash 3.2 `/bin/sh` 조건) — before 와 같은 바이트 (K1ⓑ) ──
  if (only.has('B')) {
    await startSink(0)
    await textCase({ name: 'B1-one', text: T.one, want: EXPECT[args.label]['B1-one'] })
    await textCase({ name: 'B2-multi', text: T.multi, want: EXPECT[args.label]['B2-multi'] })
    await textCase({ name: 'B3-crlf', text: T.crlf, want: EXPECT[args.label]['B3-crlf'] })
    await textCase({ name: 'B4-esc', text: T.esc, want: EXPECT[args.label]['B4-esc'] })
    await imageCase({ name: 'B5-image', want: new RegExp(`^/.*${PASTE_PNG}$`) })
    await stopSink()
  }
  // ── S: stale 2004 (U3) — 2004 를 켠 앱이 끄지 못하고 죽은 뒤 같은 pane 의 다음 앱·셸 ──
  if (only.has('S')) {
    const staleApp = (pidFile) => `${NODE} -e "require('fs').writeFileSync('${pidFile}',String(process.pid));process.stdout.write('\\x1b[?2004hSTALE-APP-UP\\r\\n');setInterval(()=>{},1e3)"\r`
    const startStale = async (pidFile) => {
      fs.rmSync(pidFile, { force: true })
      await type(staleApp(pidFile))
      for (let i = 0; i < 50; i += 1) {
        if (fs.existsSync(pidFile) && (await termRead()).lines.some((line) => line.includes('STALE-APP-UP'))) return Number(fs.readFileSync(pidFile, 'utf8'))
        await pause(200)
      }
      return 0
    }
    const killStale = async (how, pid) => {
      if (how === 'ctrlc') await type('\x03')
      else if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch {}
      await pause(1200)
      try { process.kill(pid, 0); return false } catch { return true }
    }
    for (const how of ['ctrlc', 'sigkill']) {
      const pidFile = path.join(work, `stale-${how}.pid`)
      await type('clear\r')
      await pause(500)
      // ① 2004 를 건드리지 않는 싱크(bracketed=0)로 — herdr 가 죽은 앱의 비트로 아직 틀을 붙이는가.
      const pid1 = await startStale(pidFile)
      const dead1 = await killStale(how, pid1)
      await startSink(0)
      const sinkCase = await textCase({ name: `S-${how}-sink0`, text: 'echo l505-stale', want: undefined })
      await stopSink()
      // ② /bin/sh(bash 3.2 — 2004 미지원) 프롬프트 — 여러 줄을 붙이면 화면에 틀 글자가 새는가, 줄이 실행되는가.
      await type('clear\r')
      await pause(600)
      const pid2 = await startStale(pidFile)
      const dead2 = await killStale(how, pid2)
      const shSent = await synthPaste('echo l505-sh-a\necho l505-sh-b')
      await pause(1500)
      const shScreen = (await termRead()).lines.filter((line) => line.trim() !== '').map((line) => line.trimEnd())
      result.cases.push({ name: `S-${how}-binsh`, kind: 'stale', how, pid: pid2, dead: dead2, sent: shSent, screen: shScreen.slice(-12), ring: await freshRing() })
      await type('\x03')
      await pause(500)
      // ③ zsh -f — 프롬프트마다 2004 를 스스로 켠다. 여러 줄을 붙여 Enter 전까지 실행되지 않는지.
      await type('clear; exec /bin/zsh -f\r')
      await pause(1500)
      const pid3 = await startStale(pidFile)
      const dead3 = await killStale(how, pid3)
      const zSent = await synthPaste('echo l505-z-a\necho l505-z-b')
      await pause(1500)
      const zScreen = (await termRead()).lines.filter((line) => line.trim() !== '').map((line) => line.trimEnd())
      const executed = zScreen.some((line) => /^l505-z-a$/.test(line))
      result.cases.push({ name: `S-${how}-zsh`, kind: 'stale', how, pid: pid3, dead: dead3, sent: zSent, screen: zScreen.slice(-12), executed, ring: await freshRing() })
      await type('\x03')
      await pause(500)
      await type('exec /bin/sh\r')
      await pause(1200)
      result.cases.push({ name: `S-${how}-summary`, kind: 'stale', pid1, dead1, sink0Got: sinkCase.got, sink0Hex: hex(sinkCase.got), framed: sinkCase.got.includes(`${ESC}[200~`) })
      // fix1 F3 — 관측이 성립했는가(앱이 정말 죽었다·싱크가 받았다)와 after 의 zsh 미실행을 종료코드에 건다.
      // stale 누출 자체(sink0 framed·/bin/sh 의 00~)는 K2ⓑ 에서 「의도적 + 사유」로 닫은 관측값이라 기록만 한다.
      checks.require(`S-${how}-app-dead`, dead1 && dead2 && dead3, { dead1, dead2, dead3 })
      checks.require(`S-${how}-sink0-received`, sinkCase.got.includes('echo l505-stale'), { got: sinkCase.got })
      if (args.label === 'after') checks.require(`S-${how}-zsh-not-executed`, executed === false, { screen: zScreen.slice(-6) })
      save()
      console.log('[iso] S', how, JSON.stringify({ dead1, sink0: sinkCase.got, binsh: shScreen.slice(-4), zsh: zScreen.slice(-4), executed }))
    }
  }
  // ── O: 순서 (K1ⓓ) — 이미지 붙여넣기(main 왕복 대기) 직후 텍스트 붙여넣기. 텍스트가 대기 중인 이미지를 앞지르지 않는다 ──
  // 텍스트는 합성 DataTransfer 로 실으므로 시스템 클립보드를 바꾸지 않는다 — v1 의 클립보드 경합(no-image)이 없다.
  if (only.has('O')) {
    await startSink(1)
    const rounds = []
    for (let round = 0; round < 3; round += 1) {
      const done = await withSystemClipboard(`O${round}`, async () => {
        clip('png', clipPng)
        const image = await evaluate((input) => {
          const area = document.querySelector(`[data-term-pane-box="${input.paneId}"] textarea.xterm-helper-textarea`)
          const fire = (text) => {
            const data = new DataTransfer()
            if (text !== null) data.setData('text/plain', text)
            const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
            area.dispatchEvent(event)
            return event.defaultPrevented
          }
          // 같은 태스크 안에서 연달아 — 이미지 저장 왕복이 끝나기 전에 텍스트가 들어온다.
          return { imagePrevented: fire(null), textPrevented: fire('after-image') }
        }, { paneId })
        return { image, data: await drainSink() }
      })
      if (done === null) { rounds.push({ round, skipped: '유휴 가드 — 보류' }); continue }
      const got = done.data.map((row) => row.text).join('')
      const imageAt = got.search(/corral-paste-/)
      const textAt = got.indexOf('after-image')
      const order = imageAt < 0 ? 'no-image' : textAt < 0 ? 'no-text' : imageAt < textAt ? 'image-first' : 'text-first'
      rounds.push({ round, fired: done.image, sink: done.data.map(({ hex: h, text: t }) => ({ hex: h, text: t })), order, ring: await freshRing(), log: logRows() })
      if (args.label === 'after') checks.require(`O${round}-image-first`, order === 'image-first', { order, got })
    }
    result.cases.push({ name: 'O-image-then-text', kind: 'order', rounds })
    save()
    console.log('[iso] O', JSON.stringify(rounds.map((row) => row.order ?? row.skipped)))
    await stopSink()
  }
  // ── X: 선택 중 붙여넣기 (fix1 F1) — 선택이 남으면 flush 가 프레임을 보류해 에코가 안 그려진다 ──
  // 셸 프롬프트에서: (대조) 선택 없이 합성 paste → 에코 보임 / (시험) 합성 더블클릭으로 선택 → 합성 paste → 선택 해제·에코 보임.
  // 판별: 선택 여부는 합성 copy 이벤트가 xterm 에서 받아 낸 글자(비면 선택 없음). 에코는 xterm 버퍼(term-read).
  if (only.has('X')) {
    const selectedText = () => evaluate((id) => {
      const area = document.querySelector(`[data-term-pane-box="${id}"] textarea.xterm-helper-textarea`)
      const data = new DataTransfer()
      area.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    }, paneId)
    const selectMarker = async () => {
      const t = await termRead()
      const row = t.lines.findLastIndex((line) => /^L505SELMARK\s*$/.test(line))
      await evaluate((input) => {
        const screen = document.querySelector(`[data-term-pane-box="${input.paneId}"] .xterm-screen`)
        const r = screen.getBoundingClientRect()
        const x = r.left + (r.width / input.cols) * 4
        const y = r.top + (r.height / input.rows) * (input.row + 0.5)
        for (const detail of [1, 2]) {
          screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
          screen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
        }
        return true
      }, { paneId, cols: t.cols, rows: t.rows, row })
      return row
    }
    const echoed = async (needle) => {
      for (let i = 0; i < 15; i += 1) {
        await pause(200)
        if ((await termRead()).lines.some((line) => line.includes(needle))) return true
      }
      return false
    }
    for (const [name, select] of [['X1-no-selection', false], ['X2-selection', true]]) {
      await type('clear; echo L505SELMARK\r')
      await pause(1500)
      const row = select ? await selectMarker() : null
      const before = await selectedText()
      const needle = `echo l505-${name}`
      const sent = await synthPaste(needle)
      const shown = await echoed(needle)
      const after = await selectedText()
      const screen = (await termRead()).lines.filter((line) => line.trim() !== '').map((line) => line.trimEnd()).slice(-6)
      result.cases.push({ name, kind: 'selection', row, selectedBefore: before, selectedAfter: after, sent, echoShown: shown, screen, ring: await freshRing() })
      if (select) checks.require(`${name}-was-selected`, before === 'L505SELMARK', { before })
      if (args.label === 'after' || !select) checks.require(`${name}-echo-shown`, shown, { screen })
      if (args.label === 'after' && select) checks.require(`${name}-selection-cleared`, after === '', { after })
      save()
      console.log('[iso]', name, JSON.stringify({ before, after, shown }))
      // 셸 입력줄 비우기(실행하지 않는다) — 선택이 남아 있으면 클릭으로 풀어 다음 회차가 깨끗하게.
      await type('\x15')
      await control({ cmd: 'click', selector: `[data-term-pane-box="${paneId}"] .xterm-screen` }).catch(() => null)
      await pause(500)
    }
  }
  // fix2 R2-3 — 이미지 ⌘V 도 진입 즉시 선택을 푼다(왕복을 기다리지 않는다). 시스템 클립보드 PNG 라 유휴 가드 안.
  if (only.has('X') && args.label === 'after') {
    await type('clear; echo L505SELMARK\r')
    await pause(1500)
    const t = await termRead()
    const row = t.lines.findLastIndex((line) => /^L505SELMARK\s*$/.test(line))
    const done = await withSystemClipboard('X3', async () => {
      clip('png', clipPng)
      return evaluate((input) => {
        const box = document.querySelector(`[data-term-pane-box="${input.paneId}"]`)
        const screen = box.querySelector('.xterm-screen')
        const area = box.querySelector('textarea.xterm-helper-textarea')
        const r = screen.getBoundingClientRect()
        const x = r.left + (r.width / input.cols) * 4
        const y = r.top + (r.height / input.rows) * (input.row + 0.5)
        for (const detail of [1, 2]) {
          screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
          screen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
        }
        const copy = () => {
          const data = new DataTransfer()
          area.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
          return data.getData('text/plain')
        }
        const before = copy()
        area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))
        // 같은 태스크 안 — 이미지 왕복(main IPC)이 끝나기 전에 본다.
        return { before, afterSync: copy() }
      }, { paneId, cols: t.cols, rows: t.rows, row })
    })
    await pause(1500)
    await type('\x15')
    if (done === null) result.cases.push({ name: 'X3-image-selection', skipped: '유휴 가드 — 보류' })
    else {
      result.cases.push({ name: 'X3-image-selection', kind: 'selection', row, ...done, ring: await freshRing() })
      checks.require('X3-was-selected', done.before === 'L505SELMARK', done)
      checks.require('X3-cleared-before-roundtrip', done.afterSync === '', done)
      console.log('[iso] X3-image-selection', JSON.stringify(done))
    }
    save()
  }
  // ── I: 큰 이미지 ⌘V 왕복 시간 (fix1 F2 타임아웃 근거) — 잡음 PNG(압축 안 되는) 를 시스템 클립보드에 (가드 안) ──
  if (only.has('I')) {
    await startSink(1)
    const zlib = await import('node:zlib')
    const noisePng = (width, height) => {
      const chunk = (kind, data) => {
        const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
        return Buffer.concat([len, body, crc])
      }
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
      const raw = Buffer.alloc((width * 3 + 1) * height)
      crypto.randomFillSync(raw)
      for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
    }
    for (const [w, h] of [[1920, 1080], [6016, 3384]]) {
      const file = path.join(work, `noise-${w}x${h}.png`)
      fs.writeFileSync(file, noisePng(w, h))
      const bytes = fs.statSync(file).size
      const done = await withSystemClipboard(`I-${w}x${h}`, async () => {
        clip('png', file)
        const t0 = Date.now()
        const sent = await synthPaste(null)
        let data = []
        for (let i = 0; i < 100 && data.length === 0; i += 1) {
          await pause(100)
          data = sinkRows(sinkFile, sinkAt).rows.filter((row) => row.event === 'data')
        }
        const ms = Date.now() - t0
        await drainSink()
        return { sent, ms, arrived: data.length > 0 }
      })
      const ring = await freshRing()
      result.cases.push({ name: `I-${w}x${h}`, kind: 'image-timing', pngBytes: bytes, ...done, ring, log: logRows() })
      // fix2 R2-1 — 5초 타임아웃(CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS)의 근거를 판정으로: 도착 + 상한의 1/4(1250ms) 안.
      if (done !== null) checks.require(`I-${w}x${h}-within-quarter-timeout`, done.arrived && done.ms < 5000 / 4, { ms: done.ms, arrived: done.arrived })
      save()
      console.log('[iso] I', w, h, JSON.stringify({ bytes, ms: done?.ms, arrived: done?.arrived }))
    }
    await stopSink()
  }
  // ── R: ⌘C 복사 회귀 (K4ⓒ) — 합성 더블클릭으로 단어 선택 → 합성 copy 이벤트 → xterm 이 DataTransfer 에 쓴 글자 ──
  if (only.has('R')) {
    await type('clear; echo L505COPYMARK\r')
    await pause(1500)
    const t = await termRead()
    const row = t.lines.findLastIndex((line) => /^L505COPYMARK\s*$/.test(line))
    const copied = await evaluate((input) => {
      const box = document.querySelector(`[data-term-pane-box="${input.paneId}"]`)
      const screen = box.querySelector('.xterm-screen')
      const r = screen.getBoundingClientRect()
      const x = r.left + (r.width / input.cols) * 4
      const y = r.top + (r.height / input.rows) * (input.row + 0.5)
      for (const detail of [1, 2]) {
        screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
        screen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }))
      }
      const area = box.querySelector('textarea.xterm-helper-textarea')
      const data = new DataTransfer()
      const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
      area.dispatchEvent(event)
      return { text: data.getData('text/plain'), prevented: event.defaultPrevented }
    }, { paneId, cols: t.cols, rows: t.rows, row })
    result.cases.push({ name: 'R3-copy', kind: 'regression', method: '합성 dblclick + 합성 copy', row, copied, pass: copied?.text === 'L505COPYMARK' })
    checks.require('R3-copy', copied?.text === 'L505COPYMARK', { row, copied })
    save()
    console.log('[iso] R3-copy', JSON.stringify({ row, copied }))
  }
  // ── L: 큰 붙여넣기 (U2) — 크기별. 도착 바이트·sha·연결 상태(뒤따르는 작은 붙여넣기가 가는지) ──
  // 스트림이 닫히면 같은 실행의 뒤 경우가 다 막힌다(before-1 실측) — L 은 맨 끝, 모드·크기는 인자로 나눠 돈다.
  // fix1 F3: oracle 은 **UTF-8 바이트** 기준 — 2004 켬이면 받은 바이트를 틀마다 갈라 ① 틀 본문이 각각 1MB 이하 ② 본문을 이으면
  // 원문(cr)과 바이트가 같다 ③ 틀 밖 바이트 없음. 2004 끔이면 받은 바이트 = 원문(cr). after 는 일치·연결 유지를 checks.require 로 건다.
  // `mb<N>` 크기 = 한글·이모지 섞인 본문(bigTextMb).
  if (only.has('L')) {
    let dead = false
    const MAX = 1048576
    const START = Buffer.from(`${ESC}[200~`)
    const END = Buffer.from(`${ESC}[201~`)
    const frames = (buf) => {
      const bodies = []
      let at = 0
      while (at < buf.length) {
        if (buf.indexOf(START, at) !== at) return { ok: false, reason: `틀 밖 바이트 @${at}`, bodies }
        const end = buf.indexOf(END, at + START.length)
        if (end < 0) return { ok: false, reason: '닫는 틀 없음', bodies }
        bodies.push(buf.subarray(at + START.length, end))
        at = end + END.length
      }
      return { ok: true, bodies }
    }
    const sizes = (args.sizes ?? '1024,65536,262144,1048576').split(',')
    for (const bracketed of (args.lmode ?? '1,0').split(',').map(Number)) {
      await startSink(bracketed)
      backendRows()
      for (const token of sizes) {
        const multibyte = token.startsWith('mb')
        const size = Number(multibyte ? token.slice(2) : token)
        const text = multibyte ? bigTextMb(size) : bigText(size)
        const name = `L${bracketed}-${token}`
        const want = Buffer.from(cr(text), 'utf8')
        const t0 = Date.now()
        const sent = await synthPaste(text)
        const data = await drainSink({ quietMs: 3000, maxMs: 60_000 })
        const got = Buffer.concat(data.map((row) => Buffer.from(row.hex, 'hex')))
        let verdict
        if (args.label === 'after' && bracketed === 1) {
          const parsed = frames(got)
          const joined = Buffer.concat(parsed.bodies)
          verdict = { framed: parsed.ok, reason: parsed.reason ?? null, frames: parsed.bodies.length, maxBody: Math.max(0, ...parsed.bodies.map((body) => body.length)), bodiesEqual: joined.equals(want) }
          verdict.match = parsed.ok && verdict.bodiesEqual && verdict.maxBody <= MAX
        } else {
          verdict = { match: got.equals(want) }
        }
        const entry = {
          name, kind: 'text-large', multibyte, method: 'synthetic ClipboardEvent paste → xterm textarea', sent, ms: Date.now() - t0,
          sentText: { bytes: Buffer.byteLength(text), chars: text.length, sha256: sha(text) },
          want: { bytes: want.length, sha256: crypto.createHash('sha256').update(want).digest('hex') },
          sink: { chunks: data.length, bytes: got.length, sha256: crypto.createHash('sha256').update(got).digest('hex') },
          ...verdict, ring: await freshRing(), log: logRows(), backend: backendRows(),
        }
        const probe = await textCase({ name: `${name}-next`, text: 'probe', want: undefined })
        entry.nextGot = probe.got
        entry.nextOk = probe.got.includes('probe')
        result.cases.push(entry)
        if (args.label === 'after') {
          checks.require(`${name}-match`, entry.match === true, { verdict, gotBytes: got.length, wantBytes: want.length })
          checks.require(`${name}-next`, entry.nextOk, { nextGot: entry.nextGot })
        }
        save()
        console.log('[iso] L', bracketed, token, JSON.stringify({ ...verdict, gotBytes: got.length, wantBytes: want.length, nextOk: entry.nextOk, backend: entry.backend }))
        if (!entry.nextOk) {
          result.notes.push(`${name}: 뒤 작은 붙여넣기가 안 왔다 — 이 실행의 L 은 여기서 멈춘다(log·backend 참조)`)
          dead = true
          break
        }
      }
      if (dead) break
      await stopSink()
    }
  }
  result.backendTail = fs.existsSync(backendLog) ? fs.readFileSync(backendLog, 'utf8').split('\n').filter((line) => /WARN|ERROR/.test(line)).slice(-20) : []
} catch (error) {
  result.error = String(error?.stack ?? error)
  exitCode = 2
} finally {
  for (const entry of [...owned].reverse()) {
    if (!entry.pid) continue
    try { process.kill(entry.pid, 'SIGTERM') } catch {}
  }
  await pause(2500)
  result.owned = owned
  result.survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
  if (result.survivors.length > 0 && exitCode === 0) exitCode = 3
  result.clipboardAfter = clip('dump').out
  result.exitCode = checks.exitCode(exitCode)
  save()
}
process.exit(result.exitCode)
