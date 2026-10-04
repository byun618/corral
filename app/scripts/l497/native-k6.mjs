// LIFE-497 K6·K2·U3·U5 **네이티브 첨부 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션에서 돈다.
// fixture 워크스페이스(홈 아래 trust 된 위치) 안에서만 탭을 만들고 닫는다. 복구된 사용자 세션 pane 에는 입력·닫기를 하지 않는다.
//
// 입력 경로(제품 경로):  ⌘V·Ctrl+V = CGEvent(keypost — 맨 앞 앱이 이 corral 일 때만) → 기본 Edit 메뉴 paste role → DOM paste → 제품 처리기
//                        드롭      = drag-source(NSDraggingSession) + cliclick → 진짜 OS 드롭 → preload webUtils → 렌더러 → termInput
// 준비 입력(제품 경로 아님, 관문 대상 아님): CLI 기동 명령·질문 문장·입력 지우기(Ctrl+U)·U3 수신 실측 페이로드 = 렌더러 termInput 직접 호출.
// 관측: herdr `pane read --source visible`(PTY 화면 텍스트) · 선택자 캡처(shots) · 렌더러 진단 링(corral → herdr 로 보낸 붙여넣기·드롭 바이트).
// 전송(Enter)은 CLI 당 1회 — ⓐ 뒤 "이 이미지에 뭐가 보여? 한 줄로". 나머지는 칩만 보고 지운다.
// trust·업데이트·로그인 화면이 보이면 답하지 않고 탭을 닫고 exit 5 로 멈춘다(부르는 쪽이 코디에 묻는다).
//
// 사용: node native-k6.mjs <ROOT=/tmp/l497n*> <raw 폴더> <fixture 경로(realpath)> [claude,codex,shell]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { clip, keypost, osDrag, pause, run, solidPng } from './lib.mjs'

const [root, rawd, fixture, onlyArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l497n')) throw new Error('ROOT 는 /tmp/l497n*')
if (!fixture?.startsWith('/Users/byun/l497nfx')) throw new Error('fixture 는 /Users/byun/l497nfx*')
const only = new Set((onlyArg ?? 'shell,claude,codex').split(','))
const ctl = path.join(root, 'ctl.sock')
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const HERDR = '/opt/homebrew/bin/herdr'
fs.mkdirSync(path.join(rawd, 'shots'), { recursive: true })
const control = (request, timeout = 30_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const hread = (paneId) => {
  try {
    return execFileSync(HERDR, ['pane', 'read', paneId, '--source', 'visible', '--format', 'text'], { encoding: 'utf8' })
  } catch (error) {
    return `herdr pane read 실패: ${error.message}`
  }
}
const log = []
const record = (step, detail) => {
  log.push({ step, at: new Date().toISOString(), ...detail })
  fs.writeFileSync(path.join(rawd, 'k6-log.json'), `${JSON.stringify(log, null, 1)}\n`)
  console.log(`[k6] ${step}`, JSON.stringify(detail).slice(0, 260))
}

// fixture 파일 — 공백·괄호·U+202F 이름 포함.
const files = path.join(fixture, 'files')
fs.mkdirSync(files, { recursive: true })
const F = {
  plain: path.join(files, 'plain.png'),
  paren: path.join(files, 'download (1).png'),
  shot: path.join(files, 'Screenshot 2026-10-05 at 3.04.11\u202fPM.png'),
  one: path.join(files, 'one.png'),
  two: path.join(files, 'two.png'),
  notes: path.join(files, 'my notes.txt'),
}
const colors = { plain: [220, 60, 40], paren: [240, 200, 20], shot: [150, 40, 200], one: [40, 160, 60], two: [20, 180, 200] }
for (const [key, file] of Object.entries(F)) fs.writeFileSync(file, file.endsWith('.png') ? solidPng({ width: 48, height: 32, rgb: colors[key] }) : 'notes\n')
const clipPng = path.join(root, 'clip.png')
fs.writeFileSync(clipPng, solidPng({ width: 64, height: 40, rgb: [30, 90, 200] }))

const workspaceOf = async () => {
  const state = (await control({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace ?? null
  return null
}
const fixtureTabs = async () => ((await workspaceOf())?.tabs ?? []).map((tab) => tab.tabId)
const openTab = async () => {
  const ws = await workspaceOf()
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
  await pause(600)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  for (let i = 0; i < 50 && !(await evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, created.paneId)); i += 1) await pause(200)
  await pause(1500)
  return created
}
const type = (paneId, data) => evaluate((input) => window.corral.termInput(input), { paneId, data })
const focus = async (paneId) => {
  await control({ cmd: 'window-visibility', action: 'show' })
  const activated = run('activate', [appPid]).out
  await control({ cmd: 'click', selector: `[data-term-pane-box="${paneId}"] .xterm-screen` })
  await pause(400)
  return activated
}
const ring = async () => evaluate(() => (window.corralTermProbe?.read().inputs ?? []).filter((entry) => entry.source))
let ringSeen = 0
const freshRing = async () => {
  const all = await ring()
  const fresh = all.slice(ringSeen)
  ringSeen = all.length
  return fresh.map((entry) => ({ source: entry.source, at: entry.at, text: entry.data, hex: Buffer.from(entry.data, 'utf8').toString('hex') }))
}
const shotPane = async (name, paneId) => {
  const reply = await control({ cmd: 'shot', name, selector: `[data-term-pane-box="${paneId}"]` }).catch((error) => ({ error: String(error) }))
  return reply.file ?? reply.error
}
const geometry = async (paneId) => evaluate((id) => {
  const el = document.querySelector(`[data-term-pane-box="${id}"]`)
  const r = el.getBoundingClientRect()
  return { screenX: window.screenX, screenY: window.screenY, chrome: window.outerHeight - window.innerHeight, outerW: window.outerWidth, outerH: window.outerHeight, pane: { x: r.left, y: r.top, w: r.width, h: r.height } }
}, paneId)
const dropOn = async (paneId, list) => {
  await focus(paneId)
  const g = await geometry(paneId)
  const target = { x: Math.round(g.screenX + g.pane.x + g.pane.w * 0.5), y: Math.round(g.screenY + g.chrome + g.pane.y + g.pane.h * 0.45) }
  const source = { x: Math.round(g.screenX + 20), y: Math.round(g.screenY + g.outerH - 140) }
  return osDrag({ files: list, source, target, expectTargetPid: appPid })
}
const BLOCKING = /trust (this|the) (folder|directory|files)|Do you trust|Update available|update now|Sign in with|Log in|login required|Select login method|Welcome to Codex/i

async function observe({ step, paneId, extra = {}, waitMs = 2500, expect = null }) {
  await pause(waitMs)
  const screen = hread(paneId)
  const bytes = await freshRing()
  const shot = await shotPane(`k6-${step}`, paneId)
  const screenFile = path.join(rawd, `screen-${step}.txt`)
  fs.writeFileSync(screenFile, screen)
  const matched = expect === null ? null : expect.test(screen)
  record(step, { ...extra, bytes, shot, screenFile: path.basename(screenFile), matched, tail: screen.trimEnd().split('\n').slice(-6) })
  return { screen, matched }
}
const clearInput = async (paneId, label) => {
  // Ctrl+U(줄 앞 지우기) 세 번 — 칩·경로 텍스트를 지운다. 무엇을 보냈는지 기록한다.
  for (let i = 0; i < 3; i += 1) {
    await type(paneId, '\x15')
    await pause(250)
  }
  await pause(500)
  record(`${label}-cleared`, { sent: '\\x15 ×3 (Ctrl+U)', tail: hread(paneId).trimEnd().split('\n').slice(-4) })
}

let exitCode = 0
try {
  record('start', { appPid, fixture, only: [...only], clipboardBefore: clip('dump').out })
  // 준비: fixture 레포 등록(제어 소켓 add-repo — 준비용 지름길) → 워크스페이스 열기(제품 IPC openWorktree).
  const added = await control({ cmd: 'add-repo', root: fixture })
  let ws = await workspaceOf()
  if (ws === null) {
    const opened = await evaluate((dir) => window.corral.openWorktree({ repoRoot: dir, path: dir, isLinked: false }), fixture)
    for (let i = 0; i < 150 && !(ws = await workspaceOf()); i += 1) await pause(200)
    record('fixture-open', { added: added.ok, opened })
  }
  if (ws === null) throw new Error('fixture workspace 가 안 열렸다')
  await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
  await pause(800)

  // ── 셸 pane ⓖ — 비이미지·공백 경로 드롭 → 셸이 한 인자로 받는다 ──
  if (only.has('shell')) {
    const tab = await openTab()
    record('shell-open', { tab })
    await type(tab.paneId, `cd ${fixture} && ls -l `)
    await pause(500)
    const drag1 = await dropOn(tab.paneId, [F.notes])
    await pause(1200)
    await type(tab.paneId, '\r')
    const g1 = await observe({ step: 'g1-shell-notes-ls', paneId: tab.paneId, extra: { drag: drag1 }, expect: /rw.*my notes\.txt/ })
    await type(tab.paneId, 'ls -l ')
    await pause(500)
    const drag2 = await dropOn(tab.paneId, [F.paren])
    await pause(1200)
    await type(tab.paneId, '\r')
    await observe({ step: 'g2-shell-paren-image-ls', paneId: tab.paneId, extra: { drag: drag2 }, expect: /rw.*download \(1\)\.png/ })
    record('shell-done', { pass: g1.matched })
    await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
    await pause(1500)
  }

  for (const cli of ['claude', 'codex']) {
    if (!only.has(cli)) continue
    const tab = await openTab()
    const argv = cli === 'claude' ? 'claude' : 'codex -c check_for_update_on_startup=false'
    await type(tab.paneId, `cd ${fixture} && ${argv}\r`)
    // 기동 화면 — 막는 화면이면 답하지 않고 닫는다.
    let screen = ''
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      await pause(1000)
      screen = hread(tab.paneId)
      if (BLOCKING.test(screen)) break
      if (cli === 'claude' ? /shortcuts|bypass permissions|for shortcuts|❯|>\s*$/m.test(screen) && i >= 4 : /context left|›|Ask Codex|% left/.test(screen) && i >= 4) {
        ready = true
        break
      }
    }
    fs.writeFileSync(path.join(rawd, `screen-${cli}-launch.txt`), screen)
    let processInfo = null
    try { processInfo = execFileSync(HERDR, ['pane', 'process-info', '--pane', tab.paneId], { encoding: 'utf8' }) } catch (error) { processInfo = String(error.message) }
    record(`${cli}-launch`, { tab, argv, ready, blocking: BLOCKING.test(screen), processInfo, launchShot: await shotPane(`k6-${cli}-launch`, tab.paneId) })
    if (BLOCKING.test(screen) || !ready) {
      await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
      exitCode = 5
      record(`${cli}-stopped`, { reason: BLOCKING.test(screen) ? '막는 화면(trust·업데이트·로그인) — 답하지 않고 닫음' : '준비 화면을 못 봄 — 닫음' })
      continue
    }
    await freshRing()
    const chip = cli === 'claude' ? /\[Image #\d+\]/ : /\[Image #\d+\]|\[image[^\]]*\]/i
    // ⓐ ⌘V 이미지 → 칩 → 전송 1회
    clip('png', clipPng)
    await focus(tab.paneId)
    const keyA = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
    const a = await observe({ step: `${cli}-a-cmdv-image`, paneId: tab.paneId, extra: { key: keyA.parsed ?? keyA }, expect: chip })
    if (a.matched) {
      await type(tab.paneId, '이 이미지에 뭐가 보여? 한 줄로')
      await pause(600)
      await type(tab.paneId, '\r')
      let answered = ''
      for (let i = 0; i < 90; i += 1) {
        await pause(1000)
        answered = hread(tab.paneId)
        if (i > 8 && !/esc to interrupt|Working|thinking|Thinking/i.test(answered)) break
      }
      fs.writeFileSync(path.join(rawd, `screen-${cli}-a-answer.txt`), answered)
      record(`${cli}-a-send-once`, { sent: '이 이미지에 뭐가 보여? 한 줄로 + Enter', shot: await shotPane(`k6-${cli}-a-answer`, tab.paneId), tail: answered.trimEnd().split('\n').slice(-14) })
    } else {
      await clearInput(tab.paneId, `${cli}-a`)
    }
    // ⓑ 이미지 드롭(평범한 이름)
    const b = await dropOn(tab.paneId, [F.plain])
    await observe({ step: `${cli}-b-drop-plain`, paneId: tab.paneId, extra: { drag: b }, expect: chip })
    await clearInput(tab.paneId, `${cli}-b`)
    // ⓒ 공백·괄호 이름
    const c1 = await dropOn(tab.paneId, [F.paren])
    await observe({ step: `${cli}-c1-drop-paren`, paneId: tab.paneId, extra: { drag: c1 }, expect: chip })
    await clearInput(tab.paneId, `${cli}-c1`)
    const c2 = await dropOn(tab.paneId, [F.shot])
    await observe({ step: `${cli}-c2-drop-screenshot-name`, paneId: tab.paneId, extra: { drag: c2 }, expect: chip })
    await clearInput(tab.paneId, `${cli}-c2`)
    // ⓓ 이미지 2개 동시
    const d = await dropOn(tab.paneId, [F.one, F.two])
    const dObs = await observe({ step: `${cli}-d-drop-two`, paneId: tab.paneId, extra: { drag: d }, expect: chip })
    record(`${cli}-d-chip-count`, { count: (dObs.screen.match(new RegExp(chip.source, 'gi')) ?? []).length })
    await clearInput(tab.paneId, `${cli}-d`)
    // ⓔ 비이미지 → 이스케이프된 경로 텍스트
    const e = await dropOn(tab.paneId, [F.notes])
    await observe({ step: `${cli}-e-drop-notes`, paneId: tab.paneId, extra: { drag: e }, expect: /my notes\.txt/ })
    await clearInput(tab.paneId, `${cli}-e`)
    // ⓕ Ctrl+V (K2) — corral 은 가로채지 않는다: 렌더러 링에 붙여넣기 바이트가 없어야 하고, CLI 가 직접 클립보드를 읽는다.
    clip('png', clipPng)
    await focus(tab.paneId)
    const keyF = keypost({ pid: appPid, keycode: 9, mods: ['ctrl'] })
    await observe({ step: `${cli}-f-ctrlv-image`, paneId: tab.paneId, extra: { key: keyF.parsed ?? keyF }, expect: chip, waitMs: 3500 })
    await clearInput(tab.paneId, `${cli}-f`)
    // U3 — 수신 쪽 실측: 3형식 × (괄호·공백) 이름을 bracketed paste 로 직접 넣는다(제품 경로 아님).
    const forms = [
      ['raw', (p) => p],
      ['backslash', (p) => p.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')],
      ['singlequote', (p) => `'${p.replace(/'/g, "'\\''")}'`],
    ]
    for (const [name, file] of [['paren', F.paren], ['shot', F.shot]]) {
      for (const [form, fmt] of forms) {
        await type(tab.paneId, `\x1b[200~${fmt(file)}\x1b[201~`)
        await observe({ step: `${cli}-u3-${name}-${form}`, paneId: tab.paneId, extra: { injected: fmt(file) }, expect: chip, waitMs: 2000 })
        await clearInput(tab.paneId, `${cli}-u3-${name}-${form}`)
      }
    }
    await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
    await pause(2000)
    record(`${cli}-closed`, { tabsLeft: await fixtureTabs() })
  }
} catch (error) {
  record('error', { error: String(error?.stack ?? error) })
  exitCode = 2
} finally {
  clip('clear')
  record('end', { exitCode, clipboardAfter: clip('dump').out })
}
process.exit(exitCode)
