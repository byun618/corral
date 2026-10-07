// LIFE-505 K1·K2·K4ⓒ **격리** 실측 — before 빌드(main)와 구현 빌드에 같은 순서로 돌린다.
// l497/iso-probe.mjs 의 골격(격리 launchCorral · 바이트 싱크 · OS ⌘V keypost · OS 드래그)을 가져와 텍스트 ⌘V 경우로 바꿨다.
// 격리 = /tmp/l505i* 아래 userData·herdr 세션 `l443-gui-diff`·제어 소켓. 사용자 userData·herdr default·life417-native 는 안 건드린다.
// 관측점: ① pane 안 바이트 싱크(byte-sink.mjs — PTY 가 실제로 받은 바이트) ② 격리 herdr backend 로그(oversized·rejecting)
//         ③ xterm 화면(term-read — 셸 pane 의 틀 글자 누출).
// 입력: ⌘V·Ctrl+V = CGEvent(keypost — 맨 앞 앱이 이 Electron 일 때만) → 기본 Edit 메뉴 paste role → DOM paste (제품 경로).
// 준비 입력(싱크·셸 명령 기동, Ctrl+C 키)은 렌더러 termInput 직접 호출 — 관문 대상 아님.
// 사용: node iso-paste.mjs --app <app 폴더> --work /tmp/l505iX --port 98NN --out <raw 폴더> --label before|after [--only A,B,S,O,R,L] [--lmode 1,0] [--sizes 1024,…]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { clip, frontmost, keypost, osDrag, pause, requirements, run, sinkRows, solidPng, windowAt } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l505i')) throw new Error('--work 는 /tmp/l505i*')
if (args.label !== 'before' && args.label !== 'after') throw new Error('--label before|after')
const only = new Set((args.only ?? 'A,B,L,S,O,R').split(','))
// 504 가드 — 같은 격리 경로를 쓰는 다른 corral(Electron·herdr)이 있으면 측정하지 않고 멈춘다.
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
const files = path.join(work, 'files')
fs.mkdirSync(files, { recursive: true })
const F = { plain: path.join(files, 'plain.png'), notes: path.join(files, 'my notes.txt') }
fs.writeFileSync(F.plain, solidPng({ rgb: [220, 60, 40] }))
fs.writeFileSync(F.notes, 'notes\n')
const clipPng = path.join(files, 'clip.png')
fs.writeFileSync(clipPng, solidPng({ width: 32, height: 20, rgb: [30, 90, 200] }))
// 큰 붙여넣기 본문 — ASCII 줄(`l505-NNNNNNN ` + 채움 + \n)로 정확히 size 바이트.
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

const result = { label: args.label, app: path.resolve(args.app), work, startedAt: new Date().toISOString(), cases: [], notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-paste.json'), `${JSON.stringify(result, (key, value) => (key === 'textFull' ? undefined : value), 1)}\n`)
const owned = []
let exitCode = 0
const checks = requirements((row) => { if (!row.pass) console.log('[iso] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results
const ESC = '\x1b'
const wrap = (text) => `${ESC}[200~${text}${ESC}[201~`
const PASTE_PNG = '/corral-paste/corral-paste-\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png'
const T = {
  one: 'hello l505',
  multi: 'line1\nline2',
  crlf: 'a\r\nb\nc',
  esc: `x${ESC}[201~tail`,
}
// 기대 바이트 — after 2004 켬 = 강제 틀(\r?\n→\r, ESC→U+241B), 2004 끔 = herdr 가 틀을 벗긴다.
// before = xterm 평소 붙여넣기(xterm 비트 늘 false → 틀 없음, prepareTextForTerminal 의 \r?\n→\r).
const cr = (text) => text.replace(/\r?\n/g, '\r')
const EXPECT = {
  before: {
    'A1-one': T.one, 'A2-multi': cr(T.multi), 'A3-crlf': cr(T.crlf), 'A4-esc': null,
    'B1-one': T.one, 'B2-multi': cr(T.multi), 'B3-crlf': cr(T.crlf), 'B4-esc': null,
  },
  after: {
    'A1-one': wrap(T.one), 'A2-multi': wrap(cr(T.multi)), 'A3-crlf': wrap(cr(T.crlf)), 'A4-esc': wrap(`x␛[201~tail`),
    'B1-one': T.one, 'B2-multi': cr(T.multi), 'B3-crlf': cr(T.crlf), 'B4-esc': `x␛[201~tail`,
  },
}
const sinkFile = path.join(work, 'sink.ndjson')
let sinkAt = 0
const hex = (text) => Buffer.from(text, 'utf8').toString('hex')
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

try {
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const appPid = handle.status?.runtime?.pid
  result.appPid = appPid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  // herdr 서버 로그 — oversized·rejecting·closing 경고가 여기 찍힌다(before-1 실측: `oversized targeted pane input batch, closing`).
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
      .filter((row) => /^(paste|input|stream\.input|renderer\.console|window|drop)/.test(String(row.tag ?? '')))
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

  // document 캡처 단계 paste 기록기 — 기록만(막지 않는다). 제품 처리기가 막았는지(defaultPrevented)를 다음 틱에 본다.
  await evaluate(() => {
    window.__l505 = { pastes: [] }
    window.addEventListener('paste', (event) => {
      const row = { at: Date.now(), types: [...(event.clipboardData?.types ?? [])], textLen: (event.clipboardData?.getData('text/plain') ?? '').length }
      window.__l505.pastes.push(row)
      setTimeout(() => { row.defaultPrevented = event.defaultPrevented }, 0)
    }, true)
    return true
  })
  const takePastes = () => evaluate(() => window.__l505.pastes.splice(0))
  const type = (data) => evaluate((input) => window.corral.termInput(input), { paneId, data })
  const termRead = async () => (await control({ cmd: 'term-read' })).term

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
  }
  const stopSink = async () => {
    await type('\x1d')
    await pause(800)
  }
  const focusPane = async () => {
    await control({ cmd: 'window-visibility', action: 'show' })
    const activated = run('activate', [appPid])
    await control({ cmd: 'click', selector: `[data-term-pane-box="${paneId}"] .xterm-screen` }).catch((error) => ({ error: String(error) }))
    await pause(300)
    return { activated: activated.out, front: frontmost() }
  }
  // 싱크가 더 받지 않을 때까지(quietMs 동안 그대로) 기다린 뒤 모은다 — 큰 붙여넣기는 여러 덩어리로 온다.
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
  // 다른 앱(사용자 브라우저 등)이 맨 앞을 가져가면 keypost 가 거절한다(exit 4, before-1 실측) — 활성화부터 3번까지 다시 한다.
  const osPaste = async (mods = ['cmd']) => {
    let focus = null
    let sent = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      focus = await focusPane()
      sent = keypost({ pid: appPid, keycode: 9, mods })
      if (sent.code !== 4) break
      await pause(500)
    }
    return { focus, sent }
  }
  const textCase = async ({ name, text, want, mods = ['cmd'], small = true }) => {
    const textFile = path.join(work, `clip-${name}.txt`)
    fs.writeFileSync(textFile, text)
    const set = clip('textfile', textFile)
    const { focus, sent } = await osPaste(mods)
    checks.require(`${name}-keypost`, sent.code === 0, { sent: sent.out })
    const data = await drainSink(small ? {} : { quietMs: 3000, maxMs: 60_000 })
    const got = Buffer.concat(data.map((row) => Buffer.from(row.hex, 'hex'))).toString('utf8')
    const gotBytes = data.reduce((sum, row) => sum + row.hex.length / 2, 0)
    const entry = {
      name, kind: 'text', mods, set: set.out, focus, sent: sent.out,
      sent_text: small ? { text, hex: hex(text) } : { bytes: Buffer.byteLength(text), sha256: sha(text) },
      sink: small ? data.map(({ hex: h, text: t }) => ({ hex: h, text: t })) : { chunks: data.length, bytes: gotBytes, sha256: sha(got), head: got.slice(0, 40), tail: got.slice(-40) },
      pastes: await takePastes(), log: logRows(), backend: backendRows(),
    }
    if (want !== undefined && want !== null) {
      entry.want = small ? { text: want, hex: hex(want) } : { bytes: Buffer.byteLength(want), sha256: sha(want) }
      entry.match = got === want
      checks.require(`${name}-sink`, got === want, small ? { got, want } : { gotBytes, wantBytes: Buffer.byteLength(want) })
    }
    result.cases.push(entry)
    save()
    console.log('[iso]', name, JSON.stringify(small ? { got: got.slice(0, 120), match: entry.match } : { gotBytes, match: entry.match, chunks: data.length }))
    return { entry, got }
  }

  // ── A: 2004 켠 앱 (에이전트 TUI 조건) ──
  if (only.has('A')) {
    await startSink(1)
    logRows(); backendRows()
    await textCase({ name: 'A1-one', text: T.one, want: EXPECT[args.label]['A1-one'] })
    await textCase({ name: 'A2-multi', text: T.multi, want: EXPECT[args.label]['A2-multi'] })
    await textCase({ name: 'A3-crlf', text: T.crlf, want: EXPECT[args.label]['A3-crlf'] })
    const esc = await textCase({ name: 'A4-esc', text: T.esc, want: EXPECT[args.label]['A4-esc'] })
    // K1ⓒ — 끼어든 ESC[201~ 가 틀을 일찍 닫지 않았다 = 받은 바이트에 닫는 틀이 정확히 1개, 그것도 맨 끝에.
    if (args.label === 'after') checks.require('A4-esc-one-close-at-end', esc.got.split(`${ESC}[201~`).length === 2 && esc.got.endsWith(`${ESC}[201~`), { got: esc.got })
    // 이미지 ⌘V (497 A3 회귀)
    clip('png', clipPng)
    const img = await osPaste()
    const imgData = await drainSink()
    const imgGot = imgData.map((row) => row.text).join('')
    result.cases.push({ name: 'A5-image', kind: 'image', sent: img.sent.out, sink: imgData.map(({ hex: h, text: t }) => ({ hex: h, text: t })), pastes: await takePastes(), log: logRows() })
    checks.require('A5-image-sink', new RegExp(`^\\x1b\\[200~/.*${PASTE_PNG}\\x1b\\[201~$`).test(imgGot), { got: imgGot })
    // Ctrl+V (K4ⓒ) — 가로채지 않는다: `\x16` 한 바이트.
    await textCase({ name: 'A6-ctrlv', text: T.one, want: '\x16', mods: ['ctrl'] })
    save()
    await stopSink()
  }
  // ── B: 2004 끈 앱 (bash 3.2·/bin/sh 조건) — before 와 같은 바이트 (K1ⓑ) ──
  if (only.has('B')) {
    await startSink(0)
    await textCase({ name: 'B1-one', text: T.one, want: EXPECT[args.label]['B1-one'] })
    await textCase({ name: 'B2-multi', text: T.multi, want: EXPECT[args.label]['B2-multi'] })
    await textCase({ name: 'B3-crlf', text: T.crlf, want: EXPECT[args.label]['B3-crlf'] })
    await textCase({ name: 'B4-esc', text: T.esc, want: EXPECT[args.label]['B4-esc'] })
    clip('png', clipPng)
    const img = await osPaste()
    const imgData = await drainSink()
    const imgGot = imgData.map((row) => row.text).join('')
    result.cases.push({ name: 'B5-image', kind: 'image', sent: img.sent.out, sink: imgData.map(({ hex: h, text: t }) => ({ hex: h, text: t })), pastes: await takePastes(), log: logRows() })
    checks.require('B5-image-sink', new RegExp(`^/.*${PASTE_PNG}$`).test(imgGot), { got: imgGot })
    await stopSink()
  }
  // ── S: stale 2004 (U3) — 2004 를 켠 앱이 끄지 못하고 죽은 뒤 같은 pane 의 다음 앱/셸 ──
  if (only.has('S')) {
    const staleApp = (pidFile) => `${NODE} -e "require('fs').writeFileSync('${pidFile}',String(process.pid));process.stdout.write('\\x1b[?2004hSTALE-APP-UP\\r\\n');setInterval(()=>{},1e3)"\r`
    const waitUp = async () => {
      for (let i = 0; i < 50; i += 1) {
        if ((await termRead()).lines.some((line) => line.includes('STALE-APP-UP'))) return true
        await pause(200)
      }
      return false
    }
    for (const how of ['ctrlc', 'sigkill']) {
      const pidFile = path.join(work, `stale-${how}.pid`)
      fs.rmSync(pidFile, { force: true })
      await type('clear\r')
      await pause(500)
      await type(staleApp(pidFile))
      const up = await waitUp()
      const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0)
      if (how === 'ctrlc') await type('\x03')
      else if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch {}
      await pause(1200)
      let dead = true
      try { process.kill(pid, 0); dead = false } catch {}
      // ① 2004 를 건드리지 않는 싱크(bracketed=0)로 herdr 가 아직 틀을 붙이는지 본다.
      await startSink(0)
      const sinkCase = await textCase({ name: `S-${how}-sink0`, text: 'echo l505-stale', want: undefined })
      await stopSink()
      // ② /bin/sh(bash 3.2 — 2004 미지원) 프롬프트에 붙여 화면에 틀 글자가 보이는지.
      await type('clear\r')
      await pause(600)
      await type(staleApp(pidFile))
      await waitUp()
      const pid2 = Number(fs.readFileSync(pidFile, 'utf8'))
      if (how === 'ctrlc') await type('\x03')
      else try { process.kill(pid2, 'SIGKILL') } catch {}
      await pause(1200)
      const shText = 'echo l505-sh-a\necho l505-sh-b'
      fs.writeFileSync(path.join(work, 'clip-sh.txt'), shText)
      clip('textfile', path.join(work, 'clip-sh.txt'))
      const shSent = await osPaste()
      await pause(1500)
      const shScreen = (await termRead()).lines.filter((line) => line.trim() !== '')
      result.cases.push({ name: `S-${how}-binsh`, kind: 'stale', how, sent: shSent.sent.out, screen: shScreen.slice(-12), pastes: await takePastes() })
      await type('\x03')
      await pause(400)
      // ③ zsh -f — 프롬프트마다 2004 를 스스로 켠다. 여러 줄을 붙여 Enter 전까지 실행되지 않는지.
      await type('clear; exec /bin/zsh -f\r')
      await pause(1500)
      await type(staleApp(pidFile))
      await waitUp()
      const pid3 = Number(fs.readFileSync(pidFile, 'utf8'))
      if (how === 'ctrlc') await type('\x03')
      else try { process.kill(pid3, 'SIGKILL') } catch {}
      await pause(1200)
      const zText = 'echo l505-z-a\necho l505-z-b'
      fs.writeFileSync(path.join(work, 'clip-z.txt'), zText)
      clip('textfile', path.join(work, 'clip-z.txt'))
      const zSent = await osPaste()
      await pause(1500)
      const zScreen = (await termRead()).lines.filter((line) => line.trim() !== '')
      const executed = zScreen.some((line) => /^l505-z-a\s*$/.test(line))
      result.cases.push({ name: `S-${how}-zsh`, kind: 'stale', how, sent: zSent.sent.out, screen: zScreen.slice(-12), executed, pastes: await takePastes() })
      // zle 버퍼 비우고 /bin/sh 로 돌아간다.
      await type('\x03')
      await pause(400)
      await type('exec /bin/sh\r')
      await pause(1200)
      result.cases.push({ name: `S-${how}-summary`, kind: 'stale', up, dead, sink0Got: sinkCase.got, sink0Hex: hex(sinkCase.got), framed: sinkCase.got.includes(`${ESC}[200~`) })
      save()
      console.log('[iso] S', how, JSON.stringify({ up, dead, sink0: sinkCase.got, binsh: shScreen.slice(-4), zsh: zScreen.slice(-4), executed }))
    }
  }
  // ── O: 순서 (K1ⓓ) — 이미지 ⌘V 직후 텍스트 ⌘V. 텍스트가 대기 중인 이미지를 앞지르지 않는다 ──
  if (only.has('O')) {
    await startSink(1)
    fs.writeFileSync(path.join(work, 'clip-o.txt'), 'after-image')
    const rows = []
    for (let round = 0; round < 3; round += 1) {
      clip('png', clipPng)
      const focus = await focusPane()
      const k1 = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
      clip('textfile', path.join(work, 'clip-o.txt'))
      const k2 = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
      const data = await drainSink()
      const got = data.map((row) => row.text).join('')
      const imageAt = got.search(/corral-paste-/)
      const textAt = got.indexOf('after-image')
      const order = imageAt < 0 ? 'no-image' : textAt < 0 ? 'no-text' : imageAt < textAt ? 'image-first' : 'text-first'
      rows.push({ round, front: focus.front, k1: k1.out, k2: k2.out, sink: data.map(({ hex: h, text: t }) => ({ hex: h, text: t })), order, pastes: await takePastes(), log: logRows() })
      if (args.label === 'after') checks.require(`O${round}-image-first`, order === 'image-first', { order, got })
    }
    result.cases.push({ name: 'O-image-then-text', kind: 'order', rounds: rows })
    save()
    console.log('[iso] O', JSON.stringify(rows.map((row) => row.order)))
    await stopSink()
  }
  // ── R: 497 회귀 — 파일 드롭(C3 이미지 · C7 비이미지) · ⌘C 복사(K4ⓒ) ──
  if (only.has('R')) {
    await startSink(1)
    const geometry = async () => evaluate((id) => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
      return { screenX: window.screenX, screenY: window.screenY, chrome: window.outerHeight - window.innerHeight, outerW: window.outerWidth, outerH: window.outerHeight, pane: box(`[data-term-pane-box="${id}"]`) }
    }, paneId)
    const dropCase = async ({ name, list, want }) => {
      await focusPane()
      const g = await geometry()
      const target = { x: Math.round(g.screenX + g.pane.x + g.pane.w * 0.5), y: Math.round(g.screenY + g.chrome + g.pane.y + g.pane.h * 0.5) }
      const source = { x: Math.round(g.screenX + g.outerW - 200), y: Math.round(g.screenY + g.outerH - 140) }
      const drag = await osDrag({ files: list, source, target, expectTargetPid: appPid })
      checks.require(`${name}-drag-sent`, drag.sent === true, { refused: drag.refused ?? null, error: drag.error ?? null })
      const data = await drainSink()
      const got = data.map((row) => row.text).join('')
      result.cases.push({ name, kind: 'drop', drag, sink: data.map(({ hex: h, text: t }) => ({ hex: h, text: t })), want, match: got === want })
      checks.require(`${name}-sink`, got === want, { got, want })
      save()
      console.log('[iso]', name, JSON.stringify({ got, match: got === want }))
    }
    await dropCase({ name: 'R1-drop-png', list: [F.plain], want: wrap(F.plain) })
    await dropCase({ name: 'R2-drop-notes', list: [F.notes], want: `'${F.notes}' ` })
    await stopSink()
    // ⌘C — OS 더블클릭 선택 + OS ⌘C → 클립보드 텍스트
    await type('clear; echo L505COPYMARK\r')
    await pause(1500)
    await focusPane()
    const t = await termRead()
    const row = t.lines.findLastIndex((line) => /^L505COPYMARK\s*$/.test(line))
    const g = await geometry()
    const box = await evaluate((id) => { const el = document.querySelector(`[data-term-pane-box="${id}"] .xterm-screen`); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }, paneId)
    const point = { x: Math.round(g.screenX + box.x + (box.w / t.cols) * 4), y: Math.round(g.screenY + g.chrome + box.y + (box.h / t.rows) * (row + 0.5)) }
    const hit = windowAt([[point.x, point.y]])[0]
    clip('clear')
    let copied = null
    let sent = null
    if (row >= 0 && hit?.pid === appPid) {
      execFileSync('/opt/homebrew/bin/cliclick', [`dc:${point.x},${point.y}`])
      await pause(400)
      sent = keypost({ pid: appPid, keycode: 8, mods: ['cmd'] })
      await pause(600)
      copied = clip('get-text').out
    }
    result.cases.push({ name: 'R3-copy-cmdc', kind: 'regression', row, point, hit, sent, copied, pass: copied === 'L505COPYMARK' })
    checks.require('R3-copy-cmdc', copied === 'L505COPYMARK', { row, hit: hit?.pid ?? null, copied })
    save()
    console.log('[iso] R3-copy', JSON.stringify({ row, copied }))
  }
  // ── L: 큰 붙여넣기 (U2) — 크기별로 2004 켬/끔. 도착 바이트·sha·연결 상태(다음 작은 붙여넣기가 가는지) ──
  // 스트림이 닫히면 같은 실행 안의 뒤 경우가 다 막힌다(before-1 실측) — L 은 맨 끝, 크기·모드는 인자로 나눠 돈다.
  if (only.has('L')) {
    let lDead = false
    const sizes = (args.sizes ?? '1024,65536,262144,1048576,2097152,4194304').split(',').map(Number)
    for (const bracketed of (args.lmode ?? '1,0').split(',').map(Number)) {
      await startSink(bracketed)
      for (const size of sizes) {
        const text = bigText(size)
        const want = args.label === 'after' && bracketed === 1 ? wrap(cr(text)) : cr(text)
        const { entry } = await textCase({ name: `L${bracketed}-${size}`, text, want: null, small: false })
        const got = entry.sink
        entry.want = { bytes: Buffer.byteLength(want), sha256: sha(want) }
        entry.match = got.bytes === entry.want.bytes && got.sha256 === entry.want.sha256
        // 뒤따르는 작은 붙여넣기 — 연결이 살아 있는지(거절·끊김이면 안 온다).
        const probe = await textCase({ name: `L${bracketed}-${size}-next`, text: 'probe', want: args.label === 'after' && bracketed === 1 ? wrap('probe') : 'probe' })
        entry.nextOk = probe.entry.match
        entry.paneAlive = (await workspaceOf())?.tabs?.some((tab) => tab.panes.some((pane) => pane.paneId === paneId)) ?? false
        save()
        if (!entry.nextOk) result.notes.push(`L${bracketed}-${size}: 뒤 작은 붙여넣기가 안 왔다 — 이 실행의 L 은 여기서 멈춘다(스트림 닫힘 여부는 log·backend)`)
        console.log('[iso] L', bracketed, size, JSON.stringify({ match: entry.match, gotBytes: got.bytes, wantBytes: entry.want.bytes, nextOk: entry.nextOk, backend: entry.backend.length }))
        if (!entry.nextOk) { lDead = true; break }
      }
      if (lDead) break
      await stopSink()
    }
  }
  result.backendTail = fs.existsSync(backendLog) ? fs.readFileSync(backendLog, 'utf8').split('\n').filter((line) => /oversized|reject/i.test(line)).slice(-20) : []
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
  clip('clear')
  result.clipboardAfter = clip('dump').out
  result.exitCode = checks.exitCode(exitCode)
  save()
}
process.exit(result.exitCode)
