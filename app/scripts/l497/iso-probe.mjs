// LIFE-497 U1·U2·U4·K5 **격리** 실측 — before 빌드와 구현 빌드에 같은 순서로 돌린다.
// 격리 = launchCorral(/tmp/l497i* 아래 userData·herdr 세션 `l443-gui-diff`·제어 소켓). 사용자 userData·herdr 기본 세션은 안 건드린다.
// 관측점 셋: ① pane 안의 바이트 싱크(byte-sink.mjs — PTY 가 실제로 받은 바이트) ② 렌더러 document 캡처 단계 paste 기록기
// (읽기만, preventDefault 안 함) ③ main 로그(corral.ndjson 의 paste.* · input.raw).
// 입력 방법(U1): os = CGEvent ⌘V(keypost — 맨 앞 앱이 이 Electron 일 때만) · sie = 제어 소켓 key(sendInputEvent) · cdp = Input.dispatchKeyEvent commands:['paste'].
// 드롭(U2·U4) = drag-source 창 + cliclick dd/dm/du — 진짜 OS 드래그. 출발·도착의 맨 위 창이 기대와 다르면 끌지 않는다.
// 사용: node iso-probe.mjs --app <app 폴더> --work /tmp/l497iX --port 97NN --out <raw 폴더> --label before|after
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { clip, frontmost, keypost, osDrag, pause, run, sinkRows, solidPng, windowAt } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l497i')) throw new Error('--work 는 /tmp/l497i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true })
const NODE = `${process.env.HOME}/.nvm/versions/node/v24.14.1/bin/node`
const SINK_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'byte-sink.mjs')

// fixture — 레포 + 이미지(공백·괄호·U+202F 이름 포함) + 비이미지.
const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const files = path.join(work, 'files')
fs.mkdirSync(files, { recursive: true })
const F = {
  plain: path.join(files, 'plain.png'),
  paren: path.join(files, 'download (1).png'),
  shot: path.join(files, 'Screenshot 2026-10-05 at 3.04.11\u202fPM.png'),
  one: path.join(files, 'one.png'),
  two: path.join(files, 'two.png'),
  notes: path.join(files, 'my notes.txt'),
}
for (const [key, file] of Object.entries(F)) {
  if (file.endsWith('.png')) fs.writeFileSync(file, solidPng({ rgb: key === 'two' ? [40, 160, 60] : [220, 60, 40] }))
  else fs.writeFileSync(file, 'notes\n')
}
const many = path.join(files, 'many')
fs.mkdirSync(many, { recursive: true })
const manyFiles = Array.from({ length: 257 }, (_, i) => path.join(many, `f${i}.txt`))
for (const file of manyFiles) fs.writeFileSync(file, 'x')
const clipPng = path.join(files, 'clip.png')
fs.writeFileSync(clipPng, solidPng({ width: 32, height: 20, rgb: [30, 90, 200] }))

const result = { label: args.label, app: path.resolve(args.app), startedAt: new Date().toISOString(), cases: [], notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-probe.json'), `${JSON.stringify(result, null, 1)}\n`)
const owned = []
let exitCode = 0
const sinkFile = path.join(work, 'sink.ndjson')
let sinkAt = 0

try {
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const appPid = handle.status?.runtime?.pid
  result.appPid = appPid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  let logAt = 0
  const logRows = () => {
    if (!fs.existsSync(logPath)) return []
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    const fresh = lines.slice(logAt)
    logAt = lines.length
    return fresh.map((line) => { try { return JSON.parse(line) } catch { return { raw: line } } }).filter((row) => /^(paste|input\.raw|renderer\.console|window|drop|stream\.scroll)/.test(String(row.tag ?? '')))
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
  // 화면에 붙여야 입력이 간다 — 붙지 않은 pane 입력은 main 이 막는다(stream.input_blocked "no group holds this pane", before-1 실측).
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  for (let i = 0; i < 50 && !(await evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneId)); i += 1) await pause(200)
  await pause(1500)

  // 관측 ②: document 캡처 단계 paste 기록기 — 기록만 한다(제품 처리기보다 먼저 돌지만 막지 않는다).
  await evaluate(() => {
    window.__l497 = { pastes: [] }
    window.addEventListener('paste', (event) => {
      const row = { at: Date.now(), types: [...(event.clipboardData?.types ?? [])], textLen: (event.clipboardData?.getData('text/plain') ?? '').length, target: event.target?.className ?? null }
      window.__l497.pastes.push(row)
      setTimeout(() => { row.defaultPrevented = event.defaultPrevented }, 0)
    }, true)
    return true
  })
  const takePastes = () => evaluate(() => window.__l497.pastes.splice(0))

  const startSink = async (bracketed) => {
    const before = sinkRows(sinkFile, 0).next
    await evaluate((input) => window.corral.termInput(input), { paneId, data: `${NODE} ${SINK_SCRIPT} ${sinkFile} ${bracketed}\r` })
    const t0 = Date.now()
    while (!sinkRows(sinkFile, before).rows.some((row) => row.event === 'start' && row.bracketed === (bracketed === 1))) {
      if (Date.now() - t0 > 15_000) throw new Error(`싱크가 안 떴다 (bracketed=${bracketed})`)
      await pause(200)
    }
    await pause(300)
    sinkAt = sinkRows(sinkFile, 0).next
  }
  const stopSink = async () => {
    await evaluate((input) => window.corral.termInput(input), { paneId, data: '\x1d' })
    await pause(800)
  }
  const focusPane = async () => {
    await control({ cmd: 'window-visibility', action: 'show' })
    const activated = run('activate', [appPid])
    await control({ cmd: 'click', selector: `[data-term-pane-box="${paneId}"] .xterm-screen` }).catch((error) => ({ error: String(error) }))
    await pause(300)
    const active = await evaluate(() => document.activeElement?.className ?? null)
    return { activated: activated.out, activeElement: active, front: frontmost() }
  }
  const observe = async (name, extra) => {
    await pause(1500)
    const { rows, next } = sinkRows(sinkFile, sinkAt)
    sinkAt = next
    const entry = {
      name,
      ...extra,
      sink: rows.filter((row) => row.event === 'data').map(({ hex, text }) => ({ hex, text })),
      pastes: await takePastes(),
      log: logRows(),
      href: await evaluate(() => location.href).catch((error) => `eval 실패: ${error}`),
    }
    result.cases.push(entry)
    save()
    console.log('[probe]', name, JSON.stringify({ sink: entry.sink.map((row) => row.text).join('|').slice(0, 160), pastes: entry.pastes.length, href: String(entry.href).slice(-40) }))
    return entry
  }
  const setClip = (kind, value) => {
    if (kind === 'text') return clip('text', value)
    if (kind === 'png') return clip('png', value)
    if (kind === 'fileref') return clip('fileref', value)
    if (kind === 'finder' || kind === 'fileicon') return clip(kind, value)
    return clip('clear')
  }
  const pasteCase = async ({ name, clipKind, clipValue, method }) => {
    const set = setClip(clipKind, clipValue)
    const dump = clip('dump').out
    const focus = await focusPane()
    let sent
    if (method === 'os') sent = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
    else if (method === 'os-ctrl') sent = keypost({ pid: appPid, keycode: 9, mods: ['ctrl'] })
    else if (method === 'sie') sent = await control({ cmd: 'key', keyCode: 'V', modifiers: ['meta'] })
    else if (method === 'cdp') {
      await handle.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4, windowsVirtualKeyCode: 86, commands: ['paste'] })
      await handle.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 4, windowsVirtualKeyCode: 86 })
      sent = { ok: true, via: 'cdp commands:paste' }
    }
    return observe(name, { kind: 'paste', clipKind, clipValue, method, set, clipboardTypes: dump, focus, sent })
  }

  // ── A: bracketed 모드 켠 앱(에이전트 TUI 조건) ──
  await startSink(1)
  logRows()
  await pasteCase({ name: 'A1-text-os', clipKind: 'text', clipValue: 'hello l497', method: 'os' })
  await pasteCase({ name: 'A2-multiline-os', clipKind: 'text', clipValue: 'line1\nline2', method: 'os' })
  await pasteCase({ name: 'A3-image-os', clipKind: 'png', clipValue: clipPng, method: 'os' })
  await pasteCase({ name: 'A4-image-sie', clipKind: 'png', clipValue: clipPng, method: 'sie' })
  await pasteCase({ name: 'A5-image-cdp', clipKind: 'png', clipValue: clipPng, method: 'cdp' })
  await pasteCase({ name: 'A6-fileref-os', clipKind: 'fileref', clipValue: F.plain, method: 'os' })
  await pasteCase({ name: 'A7-image-ctrlv-os', clipKind: 'png', clipValue: clipPng, method: 'os-ctrl' })
  await pasteCase({ name: 'A8-empty-os', clipKind: 'clear', clipValue: null, method: 'os' })
  await pasteCase({ name: 'A9-text-sie', clipKind: 'text', clipValue: 'hello sie', method: 'sie' })
  await pasteCase({ name: 'A10-finder-os', clipKind: 'finder', clipValue: F.plain, method: 'os' })
  await pasteCase({ name: 'A11-fileicon-os', clipKind: 'fileicon', clipValue: F.plain, method: 'os' })
  await stopSink()
  // ── B: bracketed 모드 꺼진 앱(셸 조건) ──
  await startSink(0)
  await pasteCase({ name: 'B1-text-os', clipKind: 'text', clipValue: 'hello l497', method: 'os' })
  await pasteCase({ name: 'B2-multiline-os', clipKind: 'text', clipValue: 'line1\nline2', method: 'os' })
  await pasteCase({ name: 'B3-image-os', clipKind: 'png', clipValue: clipPng, method: 'os' })
  await stopSink()

  // ── C: OS 드롭 — pane 밖 먼저(창 이탈 여부 U4), 그다음 pane ──
  await startSink(1)
  const geometry = async () => evaluate((id) => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
    return { screenX: window.screenX, screenY: window.screenY, chrome: window.outerHeight - window.innerHeight, outerW: window.outerWidth, outerH: window.outerHeight, pane: box(`[data-term-pane-box="${id}"]`), sidebar: box('[data-sidebar]'), strip: box('[data-main-tab-strip]') }
  }, paneId)
  const toScreen = (g, rect, fx = 0.5, fy = 0.5) => ({ x: Math.round(g.screenX + rect.x + rect.w * fx), y: Math.round(g.screenY + g.chrome + rect.y + rect.h * fy) })
  const dropCase = async ({ name, list, where }) => {
    await focusPane()
    const g = await geometry()
    const rect = g[where]
    if (rect === null) {
      result.cases.push({ name, kind: 'drop', where, skipped: `${where} 상자 없음`, geometry: g })
      save()
      return null
    }
    const target = toScreen(g, rect, where === 'sidebar' ? 0.5 : 0.5, where === 'sidebar' ? 0.3 : 0.5)
    const source = { x: Math.round(g.screenX + g.outerW - 200), y: Math.round(g.screenY + g.outerH - 140) }
    const drag = await osDrag({ files: list, source, target, expectTargetPid: appPid })
    const shot = await control({ cmd: 'shot', name: `${args.label}-${name}` }).catch((error) => ({ error: String(error) }))
    return observe(name, { kind: 'drop', where, geometry: g, drag, shot: shot.file ?? shot.error })
  }
  await dropCase({ name: 'C1-sidebar-png', list: [F.plain], where: 'sidebar' })
  await dropCase({ name: 'C2-strip-png', list: [F.plain], where: 'strip' })
  const href = await evaluate(() => location.href).catch(() => null)
  if (!String(href).includes('index.html')) {
    result.notes.push(`pane 밖 드롭 뒤 창이 ${href} 로 이탈 — pane 드롭 회차는 건너뛴다`)
  } else {
    await dropCase({ name: 'C3-pane-plain', list: [F.plain], where: 'pane' })
    await dropCase({ name: 'C4-pane-paren', list: [F.paren], where: 'pane' })
    await dropCase({ name: 'C5-pane-shot202f', list: [F.shot], where: 'pane' })
    await dropCase({ name: 'C6-pane-two', list: [F.one, F.two], where: 'pane' })
    await dropCase({ name: 'C7-pane-notes', list: [F.notes], where: 'pane' })
    await dropCase({ name: 'C8-pane-257', list: manyFiles, where: 'pane' })
  }
  await stopSink().catch(() => {})

  // ── D: 회귀(K5ⓑⓓ) — 터미널 ⌘C 복사(OS 더블클릭 선택 + OS ⌘C) · 휠(제어 소켓 wheel = 제품 휠 처리기) · ⌘W pane 닫기(OS) · preload 표면 ──
  result.surface = await evaluate(() => ({ preloadEnv: window.corral.preloadEnv, keys: Object.keys(window.corral).sort(), require: typeof window.require, process: typeof window.process }))
  await evaluate((input) => window.corral.termInput(input), { paneId, data: 'seq 1 200; echo L497COPYMARK\r' })
  await pause(2000)
  const termRead = async () => (await control({ cmd: 'term-read' })).term
  const screenBox = async () => evaluate((id) => { const el = document.querySelector(`[data-term-pane-box="${id}"] .xterm-screen`); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }, paneId)
  {
    await focusPane()
    const t = await termRead()
    const row = t.lines.findLastIndex((line) => /^L497COPYMARK\s*$/.test(line))
    const g = await geometry()
    const box = await screenBox()
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
    result.cases.push({ name: 'D1-copy-cmdc', kind: 'regression', row, point, hit, sent, copied, pass: copied === 'L497COPYMARK' })
    save()
    console.log('[probe] D1-copy-cmdc', JSON.stringify({ row, copied }))
  }
  {
    const before = (await termRead()).lines.join('\n')
    const wheel = await control({ cmd: 'wheel', deltaY: -400 })
    await pause(1000)
    const up = (await termRead()).lines.join('\n')
    await control({ cmd: 'wheel', deltaY: 4000 })
    await pause(1000)
    const down = (await termRead()).lines.join('\n')
    result.cases.push({ name: 'D2-wheel', kind: 'regression', wheel, scrolledUp: up !== before, returned: down === before, pass: up !== before && down === before, upTail: up.split('\n').slice(-3) })
    save()
    console.log('[probe] D2-wheel', JSON.stringify({ scrolledUp: up !== before, returned: down === before }))
  }
  {
    await focusPane()
    const sent = keypost({ pid: appPid, keycode: 13, mods: ['cmd'] })
    await pause(2000)
    const ws2 = await workspaceOf()
    const still = (ws2?.tabs ?? []).some((tab) => tab.panes.some((pane) => pane.paneId === paneId))
    const windowAlive = await evaluate(() => location.href).catch(() => null)
    result.cases.push({ name: 'D3-cmdw-close-pane', kind: 'regression', sent, paneStillThere: still, windowAlive, pass: !still && windowAlive !== null })
    save()
    console.log('[probe] D3-cmdw', JSON.stringify({ still, windowAlive: windowAlive !== null }))
  }
  result.finalHref = await evaluate(() => location.href).catch((error) => String(error))
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
  // 클립보드 원복 — 관문 전 사용자 클립보드는 항목 0(clipboard-before.json)이었다.
  clip('clear')
  result.clipboardAfter = clip('dump').out
  result.exitCode = exitCode
  save()
}
process.exit(exitCode)
