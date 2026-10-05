/* global window, document, getComputedStyle, TextDecoder -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-512 U9·U10 **격리** 실측 — herdr 프레임이 색을 인덱스로 보내는가, DECSCUSR 를 언제·무슨 값으로 보내는가.
// 격리 = launchCorral(/tmp/l512i* 아래 userData·herdr 세션·제어 소켓). 사용자 userData·herdr 기본 세션은 안 건드린다.
//
// 관측점:
//   ① 렌더러가 받은 프레임 바이트(`window.corral.onTermFrame` 에 구독을 하나 더 단다 — 읽기 전용, 제품 경로의 그 바이트)
//   ② xterm DOM 렌더러의 span 클래스(`xterm-fg-N` = 팔레트 인덱스 · inline style = RGB)와 계산 색
//   ③ 커서 span 클래스(`xterm-cursor-block|bar|underline`·`xterm-cursor-blink`)
// 셸 pane 에서 printf 로 16색·256색·RGB·기본색을 찍고, 이어 `\e[5 q`(bar 깜박임)·`\e[0 q`(기본) 를 앱처럼 요청한다.
// 사용: node iso-u9.mjs --app <app 폴더> --work /tmp/l512iX --port 95NN --out <raw 폴더> [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause } from '../l497/lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l512i')) throw new Error('--work 는 /tmp/l512i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `node app/scripts/l512/iso-u9.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'U9·U10 (K3ⓐ·K4ⓐ 격리 — 프레임 색 인코딩·DECSCUSR)'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const rawRel = ledger ? path.relative(path.resolve(ledger, '../../../../..'), out) : out
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: rawRel }) : null

const guard = (() => { try { return execFileSync('pgrep', ['-fl', `${work}|l443-gui-diff`], { encoding: 'utf8' }).trim() } catch { return '' } })()
fs.writeFileSync(path.join(out, 'guard-before.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${guard === '' ? '(없음)' : `\n${guard}`}\n`)
if (guard !== '') {
  console.log('[u9] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

const result = { app: path.resolve(args.app), startedAt: new Date().toISOString(), phases: {}, notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-u9.json'), `${JSON.stringify(result, null, 1)}\n`)
const owned = []
const ESC = String.fromCharCode(27)
let exitCode = 0
let handle = null

// printf 본문 — 표식 글자(T..) 바로 앞의 SGR 이 그 색이 어떻게 실려 왔는지를 말한다.
const E = '\\033['
const lines = [
  // 16색 전경: 30–37·90–97
  [...Array(8).keys()].map((i) => `${E}${30 + i}mF${30 + i}${E}0m`).join(' ') + ' ' + [...Array(8).keys()].map((i) => `${E}${90 + i}mF${90 + i}${E}0m`).join(' '),
  // 16색 배경: 40–47·100–107
  [...Array(8).keys()].map((i) => `${E}${40 + i}mB${40 + i}${E}0m`).join(' ') + ' ' + [...Array(8).keys()].map((i) => `${E}${100 + i}mB${100 + i}${E}0m`).join(' '),
  // 256색(인덱스 0–15 포함)과 RGB
  [1, 9, 15, 100, 196, 244].map((n) => `${E}38;5;${n}mX${n}${E}0m`).join(' ') + ' ' + `${E}48;5;100mY100${E}0m ${E}38;2;10;200;30mRGBF${E}0m ${E}48;2;200;10;30mRGBB${E}0m`,
  // 기본색 명시(39/49)·굵게 기본색
  `${E}31m${E}39mD39${E}0m ${E}41m${E}49mD49${E}0m ${E}1mBOLDDEF${E}0m PLAIN`,
]
const printfCmd = `clear; printf '${lines.join('\\n')}\\n'\r`

try {
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  result.appPid = handle.status?.runtime?.pid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const until = async (label, fn, timeout = 10_000) => {
    const t0 = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
      await pause(150)
    }
  }
  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const ws = await until('fixture workspace', workspaceOf, 30_000)
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  const pane = created.paneId
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  await until('pane box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, pane))
  await pause(1500)
  result.pane = pane

  // 프레임 구독 (읽기 전용) — 같은 preload 구독 경로에 하나 더 붙는다.
  await evaluate((id) => {
    window.__l512 = { frames: [] }
    const decoder = new TextDecoder()
    window.__l512.off = window.corral.onTermFrame((frame) => {
      if (frame.paneId !== id) return
      window.__l512.frames.push({ seq: frame.seq, at: Date.now(), cols: frame.cols, rows: frame.rows, text: decoder.decode(frame.data) })
      if (window.__l512.frames.length > 300) window.__l512.frames.shift()
    })
    return true
  }, pane)

  const takeFrames = () => evaluate(() => { const f = window.__l512.frames; window.__l512.frames = []; return f })
  const readDom = () => evaluate((id) => {
    const box = document.querySelector(`[data-term-pane-box="${id}"]`)
    const spans = [...box.querySelectorAll('.xterm-rows span')].filter((span) => /^(F|B|X|Y|RGB|D|BOLD|PLAIN)/.test(span.textContent.trim()))
    const cursor = box.querySelector('.xterm-cursor')
    const xtermRoot = box.querySelector('.xterm')
    return {
      spans: spans.map((span) => ({ text: span.textContent, className: span.className, style: span.getAttribute('style'), color: getComputedStyle(span).color, background: getComputedStyle(span).backgroundColor })),
      cursor: cursor ? { className: cursor.className, text: cursor.textContent } : null,
      rowsHtmlSample: box.querySelector('.xterm-rows')?.innerHTML.slice(0, 4000) ?? null,
      xtermClass: xtermRoot?.className ?? null,
      viewportBg: getComputedStyle(box.querySelector('.xterm-viewport') ?? box).backgroundColor,
    }
  }, pane)
  const decscusr = (frames) => {
    const counts = {}
    for (const frame of frames) {
      const found = [...frame.text.matchAll(new RegExp(`${ESC}\\[(\\d*) q`, 'g'))].map((m) => m[1])
      const key = found.length === 0 ? '(없음)' : found.join(',')
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }
  const sgrOfTokens = (text) => {
    // 각 SGR 뒤에 이어지는 글자 덩어리를 짝짓는다.
    const pairs = []
    for (const match of text.matchAll(new RegExp(`${ESC}\\[([0-9;:]*)m([^${ESC}]+)`, 'g'))) {
      const token = match[2].trim()
      if (/^(F|B|X|Y|RGB|D|BOLD|PLAIN)/.test(token)) pairs.push({ sgr: match[1], text: match[2] })
    }
    return pairs
  }
  const escape = (text) => text.replaceAll(ESC, '\\e')

  // ── phase idle: 셸 프롬프트만 있을 때 프레임 (DECSCUSR 기본값) ──
  await takeFrames()
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: 'echo idle\r' })
  await pause(1500)
  const idleFrames = await takeFrames()
  result.phases.idle = { frameCount: idleFrames.length, decscusr: decscusr(idleFrames), lastFrameTail: idleFrames.length ? escape(idleFrames.at(-1).text.slice(-120)) : null, dom: await readDom() }
  save()

  // ── phase colors (U9) ──
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: printfCmd })
  await pause(2000)
  const colorFrames = await takeFrames()
  const last = colorFrames.at(-1)
  result.phases.colors = {
    frameCount: colorFrames.length,
    decscusr: decscusr(colorFrames),
    sgrPairs: last ? sgrOfTokens(last.text) : [],
    lastFrameEscaped: last ? escape(last.text) : null,
    dom: await readDom(),
  }
  fs.writeFileSync(path.join(out, 'u9-last-frame.txt'), last ? escape(last.text) : '(프레임 없음)')
  save()

  // ── phase bar (U10): 앱이 `\e[5 q` 를 요청 ──
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: "clear; printf '\\033[5 q'; echo bar-requested\r" })
  await pause(1500)
  const barFrames = await takeFrames()
  // 요청 뒤 프레임이 더 오는 동안(입력 없이 프롬프트만) 유지되는가 — 한 줄 더 쳐서 프레임을 하나 더 만든다.
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: 'echo after-bar\r' })
  await pause(1500)
  const afterBarFrames = await takeFrames()
  result.phases.bar = { decscusr: decscusr(barFrames), dom: await readDom(), afterBar: { decscusr: decscusr(afterBarFrames), frameCount: afterBarFrames.length } }
  result.phases.bar.domAfter = await readDom()
  save()

  // ── phase reset: `\e[0 q` ──
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: "clear; printf '\\033[0 q'; echo reset-requested\r" })
  await pause(1500)
  const resetFrames = await takeFrames()
  result.phases.reset = { decscusr: decscusr(resetFrames), dom: await readDom() }
  // ── phase steady-block: `\e[2 q` ──
  await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: "clear; printf '\\033[2 q'; echo steady-block\r" })
  await pause(1500)
  const steadyFrames = await takeFrames()
  result.phases.steadyBlock = { decscusr: decscusr(steadyFrames), dom: await readDom() }
  save()
  console.log('[u9] idle', JSON.stringify(result.phases.idle.decscusr), 'colors', JSON.stringify(result.phases.colors.sgrPairs.slice(0, 6)))
  console.log('[u9] bar', JSON.stringify(result.phases.bar.decscusr), 'reset', JSON.stringify(result.phases.reset.decscusr), 'steady', JSON.stringify(result.phases.steadyBlock.decscusr))
} catch (error) {
  exitCode = 1
  result.error = String(error?.stack ?? error)
  console.log('[u9] 오류', result.error)
} finally {
  result.endedAt = new Date().toISOString()
  save()
  try { handle?.cdp?.close?.() } catch { /* 닫기 실패는 정리에서 본다 */ }
  // 띄운 쪽이 끈다 (격리 규칙 7) — 소유한 pid 만. 안 죽으면 SIGKILL, 격리 경로를 쥔 잔존도 끈다(l511 iso-u1 과 같은 순서).
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  result.owned = owned
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2000)
  result.alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of result.alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  const leftover = (() => { try { return execFileSync('pgrep', ['-fl', work], { encoding: 'utf8' }).trim() } catch { return '' } })()
  result.leftover = leftover
  for (const line of leftover.split('\n').filter(Boolean)) { try { process.kill(Number(line.split(' ')[0]), 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(1000)
  const left = (() => { try { return execFileSync('pgrep', ['-fl', `${work}|l443-gui-diff`], { encoding: 'utf8' }).trim() } catch { return '' } })()
  fs.writeFileSync(path.join(out, 'guard-after.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${left === '' ? '(없음)' : `\n${left}`}\nowned=${JSON.stringify(owned)}\n`)
  if (left !== '') { exitCode = exitCode || 4; console.log('[u9] 남은 프로세스\n' + left) }
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: rawRel, result: exitCode === 0 ? '통과(실측 완료 — 해석은 RESULT)' : '실패' })
  process.exit(exitCode)
}
