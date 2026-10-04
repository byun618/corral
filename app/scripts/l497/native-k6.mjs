// LIFE-497 K6·K2·U3·U5 **네이티브 첨부 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션에서 돈다.
// fixture 워크스페이스(홈 아래 trust 된 위치) 안에서만 탭을 만들고 닫는다. 복구된 사용자 세션 pane 에는 입력·닫기를 하지 않는다.
//
// 입력 경로(제품 경로):  ⌘V·Ctrl+V = CGEvent(keypost — 맨 앞 앱이 이 corral 일 때만) → 기본 Edit 메뉴 paste role → DOM paste → 제품 처리기
//                        드롭      = drag-source(NSDraggingSession) + cliclick → 진짜 OS 드롭 → preload webUtils → 렌더러 → termInput
// 준비 입력(제품 경로 아님, 관문 대상 아님): CLI 기동 명령·질문 문장·입력 지우기(Ctrl+U)·U3 수신 실측 페이로드 = 렌더러 termInput 직접 호출.
// 관측: herdr `pane read --source visible`(PTY 화면 텍스트) · 선택자 캡처(shots) · 렌더러 진단 링(corral → herdr 로 보낸 붙여넣기·드롭 바이트).
// 전송(Enter)은 하지 않는다 — r1 이 CLI 당 1회를 이미 썼다(fix1 지시). 칩만 보고 지운다.
// 판정은 **지금 입력줄(composer)** 만 본다(R1-04, input-line.mjs) — 대화 기록에 남은 칩은 세지 않는다.
// 필수 조건(OS 입력 보호 통과·드래그 전송·입력줄 칩 수·링 바이트·지우기)이 하나라도 어긋나면 종료코드 1 (R1-05).
// ⓖ 순서: 서로 다른 이미지 두 장을 연달아 ⌘V → 링의 두 경로가 그 순서의 이미지(PNG 크기로 식별)인지 (R1-03).
// trust·업데이트·로그인 화면이 보이면 답하지 않고 탭을 닫고 exit 5 로 멈춘다(부르는 쪽이 코디에 묻는다).
//
// 사용: node native-k6.mjs <ROOT=/tmp/l497n*> <raw 폴더> <fixture 경로(realpath)> [claude,codex,shell]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { clip, keypost, osDrag, pause, requirements, run, solidPng } from './lib.mjs'
import { composerChips } from './input-line.mjs'

const [root, rawd, fixture, onlyArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l497n')) throw new Error('ROOT 는 /tmp/l497n*')
if (!fixture?.startsWith('/Users/byun/l497nfx')) throw new Error('fixture 는 /Users/byun/l497nfx*')
// `claude@/private/tmp` 꼴이면 그 CLI 프로세스의 cwd 만 바꾼다(pane 은 fixture 탭 그대로) — r1 에서 claude 가 fixture 에 trust 화면을 띄웠다(코디 승인, native/r1/ask-trust-cwd.txt).
const entries = (onlyArg ?? 'shell,claude,codex').split(',').map((entry) => entry.split('@'))
const only = new Set(entries.map(([name]) => name))
const cwdOf = Object.fromEntries(entries.map(([name, dir]) => [name, dir ?? fixture]))
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
const clipPng2 = path.join(root, 'clip2.png')
fs.writeFileSync(clipPng2, solidPng({ width: 72, height: 28, rgb: [230, 120, 20] }))
const checks = requirements((row) => record(`require:${row.name}`, row))
/** 링에 남은 붙여넣기 경로의 PNG 크기 — ⓖ 순서 판정용(두 이미지는 크기가 다르다). */
const pngSize = (data) => {
  const file = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')
  try {
    const head = fs.readFileSync(file).subarray(16, 24)
    return { file, width: head.readUInt32BE(0), height: head.readUInt32BE(4) }
  } catch (error) {
    return { file, error: String(error.message) }
  }
}

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

async function observe({ step, paneId, extra = {}, waitMs = 2500, expect = null, cli = null }) {
  await pause(waitMs)
  const screen = hread(paneId)
  const bytes = await freshRing()
  const shot = await shotPane(`k6-${step}`, paneId)
  const screenFile = path.join(rawd, `screen-${step}.txt`)
  fs.writeFileSync(screenFile, screen)
  const matched = expect === null ? null : expect.test(screen)
  const composer = cli === null ? null : composerChips(cli, screen)
  record(step, { ...extra, bytes, shot, screenFile: path.basename(screenFile), matched, composer, tail: screen.trimEnd().split('\n').slice(-6) })
  return { screen, matched, bytes, composer }
}
const clearInput = async (paneId, label, cli = null) => {
  // Ctrl+U(줄 앞 지우기) 세 번 — 칩·경로 텍스트를 지운다. 무엇을 보냈는지 기록한다.
  for (let i = 0; i < 3; i += 1) {
    await type(paneId, '\x15')
    await pause(250)
  }
  await pause(500)
  const screen = hread(paneId)
  const composer = cli === null ? null : composerChips(cli, screen)
  record(`${label}-cleared`, { sent: '\\x15 ×3 (Ctrl+U)', composer, tail: screen.trimEnd().split('\n').slice(-4) })
  // 지워졌다 = 입력줄에 칩도 fixture·붙여넣기 경로도 없다(codex 는 빈 입력줄에 바뀌는 안내 문구를 띄운다).
  if (cli !== null) checks.require(`${label}-cleared`, composer !== null && composer.chips.length === 0 && !/l497nfx|corral-paste/.test(composer.text), { composer })
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
    checks.require('g1-drag-sent', drag1.sent === true, { refused: drag1.refused ?? null })
    const g1 = await observe({ step: 'g1-shell-notes-ls', paneId: tab.paneId, extra: { drag: drag1 }, expect: /rw.*my notes\.txt/ })
    checks.require('g1-ls-one-arg', g1.matched === true)
    await type(tab.paneId, 'ls -l ')
    await pause(500)
    const drag2 = await dropOn(tab.paneId, [F.paren])
    await pause(1200)
    await type(tab.paneId, '\r')
    checks.require('g2-drag-sent', drag2.sent === true, { refused: drag2.refused ?? null })
    const g2 = await observe({ step: 'g2-shell-paren-image-ls', paneId: tab.paneId, extra: { drag: drag2 }, expect: /rw.*download \(1\)\.png/ })
    checks.require('g2-ls-one-arg', g2.matched === true)
    record('shell-done', { pass: g1.matched })
    await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
    await pause(1500)
  }

  for (const cli of ['claude', 'codex']) {
    if (!only.has(cli)) continue
    const tab = await openTab()
    const argv = cli === 'claude' ? 'claude' : 'codex -c check_for_update_on_startup=false'
    await type(tab.paneId, `cd ${cwdOf[cli]} && ${argv}\r`)
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
    record(`${cli}-launch`, { tab, argv, cwd: cwdOf[cli], ready, blocking: BLOCKING.test(screen), processInfo, launchShot: await shotPane(`k6-${cli}-launch`, tab.paneId) })
    if (BLOCKING.test(screen) || !ready) {
      await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
      exitCode = 5
      checks.require(`${cli}-ready`, false, { blocking: BLOCKING.test(screen) })
      record(`${cli}-stopped`, { reason: BLOCKING.test(screen) ? '막는 화면(trust·업데이트·로그인) — 답하지 않고 닫음' : '준비 화면을 못 봄 — 닫음' })
      continue
    }
    await freshRing()
    // 한 경우 = OS 입력 1회 → 입력줄 칩 수·링 바이트 확인 → 지우기. 기대가 어긋나면 필수 조건 실패.
    const expectCase = ({ step, obs, chips, ring, text = null }) => {
      checks.require(`${step}-composer`, obs.composer !== null && obs.composer.chips.length === chips && (text === null || text.test(obs.composer.text)), { composer: obs.composer, wantChips: chips })
      checks.require(`${step}-ring`, obs.bytes.length === ring.length && obs.bytes.every((entry, index) => entry.source === ring[index]), { got: obs.bytes.map((entry) => entry.source), want: ring })
    }
    const pasteKey = async (mods) => {
      await focus(tab.paneId)
      const key = keypost({ pid: appPid, keycode: 9, mods })
      return { key, ok: key.code === 0 }
    }
    const dropCase = async ({ step, list, chips, text = null }) => {
      const drag = await dropOn(tab.paneId, list)
      checks.require(`${step}-drag-sent`, drag.sent === true, { refused: drag.refused ?? null, error: drag.error ?? null })
      const obs = await observe({ step, paneId: tab.paneId, extra: { drag }, cli })
      expectCase({ step, obs, chips, text, ring: dropRing(list) })
      await clearInput(tab.paneId, step, cli)
    }
    // 드롭 하나는 경로마다 file-drop 한 덩어리(이미지 raw 경로·비이미지 이스케이프 + 사이 공백 규칙 — dropPathPayloads).
    const dropRing = (list) => list.map(() => 'file-drop')
    // ⓐ ⌘V 이미지 → 칩 1
    clip('png', clipPng)
    const a = await pasteKey(['cmd'])
    checks.require(`${cli}-a-keypost`, a.ok, { key: a.key.out })
    const aObs = await observe({ step: `${cli}-a-cmdv-image`, paneId: tab.paneId, extra: { key: a.key.parsed ?? a.key }, cli })
    expectCase({ step: `${cli}-a`, obs: aObs, chips: 1, ring: ['paste-image'] })
    await clearInput(tab.paneId, `${cli}-a`, cli)
    // ⓑ 이미지 드롭(평범한 이름) · ⓒ 공백·괄호·U+202F 이름 · ⓓ 이미지 2개 동시 · ⓔ 비이미지 → 이스케이프된 경로 텍스트
    await dropCase({ step: `${cli}-b-drop-plain`, list: [F.plain], chips: 1 })
    await dropCase({ step: `${cli}-c1-drop-paren`, list: [F.paren], chips: 1 })
    await dropCase({ step: `${cli}-c2-drop-screenshot-name`, list: [F.shot], chips: 1 })
    await dropCase({ step: `${cli}-d-drop-two`, list: [F.one, F.two], chips: 2 })
    await dropCase({ step: `${cli}-e-drop-notes`, list: [F.notes], chips: 0, text: /my notes\.txt/ })
    // ⓕ Ctrl+V (K2) — corral 은 가로채지 않는다: 링에 생성 바이트가 없어야 하고, CLI 가 직접 클립보드를 읽어 칩을 만든다.
    clip('png', clipPng)
    const f = await pasteKey(['ctrl'])
    checks.require(`${cli}-f-keypost`, f.ok, { key: f.key.out })
    const fObs = await observe({ step: `${cli}-f-ctrlv-image`, paneId: tab.paneId, extra: { key: f.key.parsed ?? f.key }, waitMs: 3500, cli })
    expectCase({ step: `${cli}-f`, obs: fObs, chips: 1, ring: [] })
    await clearInput(tab.paneId, `${cli}-f`, cli)
    // ⓖ 서로 다른 이미지 연속 ⌘V 2회 — 입력줄 칩 2, 링의 두 경로가 첫째(64×40)·둘째(72×28) 순서.
    // 둘째 클립보드는 첫 저장이 끝난 뒤에 바꾼다(첫 ⌘V 가 바뀐 클립보드를 읽지 않게) — 순서 보장 자체는 단위 테스트가 역순 완료로 본다.
    clip('png', clipPng)
    const g1 = await pasteKey(['cmd'])
    await pause(900)
    clip('png', clipPng2)
    const g2 = await pasteKey(['cmd'])
    checks.require(`${cli}-g-keypost`, g1.ok && g2.ok, { keys: [g1.key.out, g2.key.out] })
    const gObs = await observe({ step: `${cli}-g-cmdv-two-order`, paneId: tab.paneId, extra: { keys: [g1.key.parsed, g2.key.parsed] }, cli })
    expectCase({ step: `${cli}-g`, obs: gObs, chips: 2, ring: ['paste-image', 'paste-image'] })
    const sizes = gObs.bytes.map((entry) => pngSize(entry.text))
    record(`${cli}-g-order`, { sizes })
    checks.require(`${cli}-g-order`, sizes.length === 2 && sizes[0].width === 64 && sizes[0].height === 40 && sizes[1].width === 72 && sizes[1].height === 28, { sizes })
    await clearInput(tab.paneId, `${cli}-g`, cli)
    // U3 — 수신 쪽 실측: 3형식 × (괄호·공백) 이름을 bracketed paste 로 직접 넣는다(제품 경로 아님).
    const forms = [
      ['raw', (p) => p],
      ['backslash', (p) => p.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')],
      ['singlequote', (p) => `'${p.replace(/'/g, "'\\''")}'`],
    ]
    for (const [name, file] of [['paren', F.paren], ['shot', F.shot]]) {
      for (const [form, fmt] of forms) {
        await type(tab.paneId, `\x1b[200~${fmt(file)}\x1b[201~`)
        // U3 는 수신 쪽 참고 실측이라 필수 조건이 아니다 — 입력줄만 기록하고, 지우기는 다음 경우를 위해 확인한다.
        await observe({ step: `${cli}-u3-${name}-${form}`, paneId: tab.paneId, extra: { injected: fmt(file) }, waitMs: 2000, cli })
        await clearInput(tab.paneId, `${cli}-u3-${name}-${form}`, cli)
      }
    }
    await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
    await pause(2000)
    record(`${cli}-closed`, { tabsLeft: await fixtureTabs() })
    checks.require(`${cli}-tab-closed`, !(await fixtureTabs()).includes(tab.tabId))
  }
} catch (error) {
  record('error', { error: String(error?.stack ?? error) })
  exitCode = 2
} finally {
  clip('clear')
  exitCode = checks.exitCode(exitCode)
  record('end', { exitCode, failed: checks.failed().map((row) => row.name), clipboardAfter: clip('dump').out })
}
process.exit(exitCode)
