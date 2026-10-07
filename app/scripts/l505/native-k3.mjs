// LIFE-505 K3 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 지정 빌드(before = main, after = 구현) + herdr 정식 `default` 세션.
// fixture 워크스페이스(/Users/byun/l505nfx) 안에서만 탭을 만들고 닫는다. 복구된 사용자 세션 pane 에는 입력·닫기를 하지 않는다.
//
// 입력 경로(제품 경로): ⌘V = CGEvent(keypost) → 기본 Edit 메뉴 paste role → DOM paste → 제품 처리기.
// 준비 입력(제품 경로 아님): CLI 기동 명령·입력 지우기(Ctrl+U)·zsh 버퍼 비우기(Ctrl+C) = 렌더러 termInput 직접 호출.
// 관측: herdr `pane read --source visible`(PTY 화면 텍스트) · 선택자 캡처(shots) · 렌더러 진단 링(corral → herdr 로 보낸 붙여넣기 바이트).
//
// **사용자 유휴 가드** (코디 답 2026-10-07): 매 OS 입력(activate·CGEvent·시스템 클립보드 쓰기) 직전 HIDIdleTime ≥ 20초(최대 10분 대기,
// 넘으면 그 회차 보류) → corral activate → 맨 앞 앱이 corral 인지 확인(아니면 입력하지 않음) → ⌘V → 즉시 이전 맨 앞 앱으로 되돌림.
// 입력 직후 입력창을 관측해 기대 밖 글자가 보이면 Enter 없이 지우고 그 회차 무효(실패 원자료).
// 시스템 클립보드는 회차마다 쓰기 직전 저장 → 회차 직후 복원(텍스트면 바이트, 그 밖은 종류만 기록).
// **Enter 는 보내지 않는다.** 모델 전송은 before 증상(틀 없는 CR 이 Enter 로 감) 그 자체로만 생길 수 있다 — 그래서 CLI 마다 첫 줄은
// 무해한 문장이고, before 에서는 큰 붙여넣기(줄마다 Enter → 여러 번 전송)를 하지 않는다.
// trust·업데이트·로그인 화면이 보이면 답하지 않고 탭을 닫고 exit 5 로 멈춘다(부르는 쪽이 코디에 묻는다).
//
// 사용: node native-k3.mjs <ROOT=/tmp/l505n*> <raw 폴더> <fixture 경로(realpath)> <before|after> [zsh,claude,codex]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { clip, frontmost, keypost, pause, requirements, run, waitIdle } from './lib.mjs'
import { composerText } from './input-line.mjs'

const [root, rawd, fixture, label, onlyArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l505n')) throw new Error('ROOT 는 /tmp/l505n*')
if (!fixture?.startsWith('/Users/byun/l505nfx')) throw new Error('fixture 는 /Users/byun/l505nfx*')
if (label !== 'before' && label !== 'after') throw new Error('before|after')
const only = new Set((onlyArg ?? 'zsh,claude,codex').split(','))
const CWD = { claude: '/private/tmp', codex: '/Users/byun' } // 497 실측 trust 된 위치(킥오프 격리 5)
const ctl = path.join(root, 'ctl.sock')
const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
const HERDR = '/opt/homebrew/bin/herdr'
fs.mkdirSync(rawd, { recursive: true })
const control = (request, timeout = 30_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
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
  fs.writeFileSync(path.join(rawd, 'k3-log.json'), `${JSON.stringify(log, null, 1)}\n`)
  console.log(`[k3] ${step}`, JSON.stringify(detail).slice(0, 300))
}
const checks = requirements((row) => record(`require:${row.name}`, row))

// 붙일 텍스트 — 첫 줄은 모델에 가도 무해한 문장(before 증상이 전송하면 그것이 그 CLI 의 1회다).
const TEXT = {
  zsh: 'echo l505-a\necho l505-b',
  agent: 'l505 paste probe: please reply with only the word OK\nsecond line l505-tail',
  // K3ⓓ 큰 텍스트 — 수 KB, 여러 줄(after 에서만).
  big: Array.from({ length: 120 }, (_, i) => `l505-big line ${String(i).padStart(3, '0')} ${'abcdefghij'.repeat(4)}`).join('\n'),
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
const closeTab = async (tab) => {
  await evaluate((input) => window.corral.closeRow(input), { tabId: tab.tabId, confirmed: true })
  await pause(2000)
  return !(await fixtureTabs()).includes(tab.tabId)
}
const type = (paneId, data) => evaluate((input) => window.corral.termInput(input), { paneId, data })
let ringSeen = 0
const freshRing = async () => {
  const all = await evaluate(() => (window.corralTermProbe?.read().inputs ?? []).filter((entry) => entry.source))
  const fresh = all.slice(ringSeen)
  ringSeen = all.length
  return fresh.map((entry) => ({ source: entry.source, len: entry.data.length, sha256: sha(entry.data), head: entry.data.slice(0, 80), tail: entry.data.slice(-20) }))
}
const shotPane = async (name, paneId) => {
  const reply = await control({ cmd: 'shot', name, selector: `[data-term-pane-box="${paneId}"]` }).catch((error) => ({ error: String(error) }))
  return reply.file ?? reply.error
}

/** OS ⌘V 한 번 — 유휴 가드 → 클립보드 저장 → 텍스트 쓰기 → activate → 맨 앞 확인 → ⌘V → 이전 앱 복귀 → 클립보드 복원. */
async function osPaste({ name, text, paneId }) {
  const idle = await waitIdle({ log: (row) => record(`${name}-idle-wait`, row) })
  if (!idle.ok) return { ok: false, skipped: '유휴 20초를 10분 안에 못 봤다 — 보류', idle }
  const savedDump = clip('dump').out
  const items = (() => { try { return JSON.parse(savedDump).items } catch { return [] } })()
  const hasText = items.some((types) => types.includes('public.utf8-plain-text'))
  const savedFile = path.join(root, `clip-saved-${name}.txt`)
  let savedSha = null
  if (hasText) {
    const saved = execFileSync('/tmp/l505b/clip', ['get-text'], { encoding: 'utf8' }).replace(/\n$/, '')
    fs.writeFileSync(savedFile, saved)
    savedSha = sha(saved)
  }
  const clipFile = path.join(root, `clip-${name}.txt`)
  fs.writeFileSync(clipFile, text)
  const front0 = frontmost()
  let key = null
  let front = null
  try {
    clip('textfile', clipFile)
    await control({ cmd: 'click', selector: `[data-term-pane-box="${paneId}"] .xterm-screen` }).catch(() => null)
    run('activate', [appPid])
    await pause(400)
    front = frontmost()
    // 활성화 직후 다시 본다 — 그새 사용자가 만졌으면 입력하지 않는다.
    if (front?.pid === appPid && (await waitIdle({ minSec: 3, maxMs: 0 })).ok) key = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
  } finally {
    if (front0?.pid && front0.pid !== appPid) run('activate', [front0.pid])
    if (hasText) clip('textfile', savedFile)
    else clip('clear')
    fs.rmSync(savedFile, { force: true })
  }
  const restoredSha = hasText ? sha(execFileSync('/tmp/l505b/clip', ['get-text'], { encoding: 'utf8' }).replace(/\n$/, '')) : null
  const row = { ok: key?.code === 0, idle, front0, front, key: key?.out ?? null, clipboard: { before: items, savedSha, restoredSha, restored: hasText ? restoredSha === savedSha : 'cleared' } }
  if (key === null) row.skipped = '맨 앞 앱이 corral 이 아니거나 활성화 직후 사용자 입력 — 입력하지 않음'
  return row
}

async function observe({ step, paneId, waitMs = 2500, cli = null }) {
  await pause(waitMs)
  const screen = hread(paneId)
  const screenFile = path.join(rawd, `screen-${step}.txt`)
  fs.writeFileSync(screenFile, screen)
  const composer = cli === null ? null : composerText(cli, screen)
  const bytes = await freshRing()
  const shot = await shotPane(`k3-${label}-${step}`, paneId)
  record(step, { bytes, shot, screenFile: path.basename(screenFile), composer, tail: screen.trimEnd().split('\n').slice(-8) })
  return { screen, composer, bytes }
}
const clearAgentInput = async (paneId, step, cli) => {
  // Ctrl+U(줄 앞 지우기) — 여러 줄 입력이라 여러 번. Enter 는 보내지 않는다.
  for (let i = 0; i < 6; i += 1) {
    await type(paneId, '\x15')
    await pause(200)
  }
  await pause(600)
  const screen = hread(paneId)
  const composer = composerText(cli, screen)
  record(`${step}-cleared`, { sent: '\\x15 ×6 (Ctrl+U)', composer, tail: screen.trimEnd().split('\n').slice(-5) })
  return composer !== null && !/l505/.test(composer)
}
const BLOCKING = /trust (this|the) (folder|directory|files)|Do you trust|Update available|update now|Sign in with|Log in|login required|Select login method|Welcome to Codex/i
// 입력창에 우리가 붙인 것 말고 다른 글자가 섞였나(사용자 타건 오염) — 우리 텍스트의 글자·placeholder·CLI 안내 문구만 허용.
const foreign = (composer, allowed) => {
  if (composer === null) return null
  const rest = composer.replace(/\[Pasted (text|Content)[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim()
  return allowed.some((one) => rest === one.replace(/\s+/g, ' ').trim()) || rest === '' ? null : rest
}

let exitCode = 0
try {
  record('start', { label, appPid, fixture, only: [...only], clipboardBefore: clip('dump').out })
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

  // ── ⓒ zsh — 여러 줄 붙여넣기가 Enter 전까지 실행되지 않는가 ──
  if (only.has('zsh')) {
    const tab = await openTab()
    let processInfo = null
    try { processInfo = execFileSync(HERDR, ['pane', 'process-info', '--pane', tab.paneId], { encoding: 'utf8' }) } catch (error) { processInfo = String(error.message) }
    await type(tab.paneId, 'clear\r')
    await pause(1200)
    await freshRing()
    record('zsh-open', { tab, processInfo })
    const sent = await osPaste({ name: 'zsh-multi', text: TEXT.zsh, paneId: tab.paneId })
    record('zsh-multi-sent', sent)
    if (sent.ok) {
      const obs = await observe({ step: 'zsh-multi', paneId: tab.paneId })
      const lines = obs.screen.split('\n').map((line) => line.trimEnd())
      const executedA = lines.some((line) => line === 'l505-a')
      const executedB = lines.some((line) => line === 'l505-b')
      record('zsh-multi-judge', { executedA, executedB })
      if (label === 'after') {
        checks.require('zsh-multi-not-executed', !executedA && !executedB, { executedA, executedB })
        checks.require('zsh-multi-ring-paste-text', obs.bytes.length === 1 && obs.bytes[0].source === 'paste-text', { bytes: obs.bytes })
      }
    } else checks.require('zsh-multi-sent', false, sent)
    await type(tab.paneId, '\x03')
    await pause(500)
    checks.require('zsh-tab-closed', await closeTab(tab))
  }

  for (const cli of ['claude', 'codex']) {
    if (!only.has(cli)) continue
    const tab = await openTab()
    const argv = cli === 'claude' ? 'claude' : 'codex -c check_for_update_on_startup=false'
    await type(tab.paneId, `cd ${CWD[cli]} && ${argv}\r`)
    let screen = ''
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      await pause(1000)
      screen = hread(tab.paneId)
      if (BLOCKING.test(screen)) break
      if (cli === 'claude' ? /shortcuts|bypass permissions|for shortcuts|❯/m.test(screen) && i >= 4 : /context left|›|Ask Codex|% left/.test(screen) && i >= 4) {
        ready = true
        break
      }
    }
    fs.writeFileSync(path.join(rawd, `screen-${cli}-launch.txt`), screen)
    let processInfo = null
    try { processInfo = execFileSync(HERDR, ['pane', 'process-info', '--pane', tab.paneId], { encoding: 'utf8' }) } catch (error) { processInfo = String(error.message) }
    record(`${cli}-launch`, { tab, argv, cwd: CWD[cli], ready, blocking: BLOCKING.test(screen), processInfo, launchShot: await shotPane(`k3-${label}-${cli}-launch`, tab.paneId) })
    if (BLOCKING.test(screen) || !ready) {
      await closeTab(tab)
      exitCode = 5
      checks.require(`${cli}-ready`, false, { blocking: BLOCKING.test(screen) })
      record(`${cli}-stopped`, { reason: BLOCKING.test(screen) ? '막는 화면(trust·업데이트·로그인) — 답하지 않고 닫음' : '준비 화면을 못 봄 — 닫음' })
      continue
    }
    await freshRing()
    // ⓐ·ⓑ 여러 줄 텍스트 — after: 전송되지 않고 입력창에 남는다. before: 증상 기록(U1).
    const sent = await osPaste({ name: `${cli}-multi`, text: TEXT.agent, paneId: tab.paneId })
    record(`${cli}-multi-sent`, sent)
    if (sent.ok) {
      const obs = await observe({ step: `${cli}-multi`, paneId: tab.paneId, waitMs: 3000, cli })
      // 전송됐다 = 입력창 밖(대화 기록)에 첫 줄이 올라갔다. 몇 초 더 기다려 응답도 본다(before 증상).
      const later = await observe({ step: `${cli}-multi-later`, paneId: tab.paneId, waitMs: 8000, cli })
      const outside = later.screen.split('\n').filter((line) => line.includes('l505 paste probe')).length > (later.composer?.includes('l505 paste probe') ? 1 : 0)
      const stray = foreign(obs.composer, [TEXT.agent, 'l505 paste probe: please reply with only the word OK second line l505-tail'])
      record(`${cli}-multi-judge`, { composer: obs.composer, composerLater: later.composer, submitted: outside, stray })
      if (label === 'after') {
        checks.require(`${cli}-multi-not-submitted`, !outside, { composer: later.composer })
        checks.require(`${cli}-multi-in-composer`, later.composer !== null && /second line l505-tail|Pasted/.test(later.composer), { composer: later.composer })
        checks.require(`${cli}-multi-no-stray`, stray === null, { stray })
        checks.require(`${cli}-multi-ring-paste-text`, obs.bytes.length === 1 && obs.bytes[0].source === 'paste-text', { bytes: obs.bytes })
      }
      checks.require(`${cli}-multi-cleared`, await clearAgentInput(tab.paneId, `${cli}-multi`, cli))
    } else checks.require(`${cli}-multi-sent`, false, sent)
    // ⓓ 큰 텍스트 — placeholder 여부(U4). after 만(before 는 줄마다 Enter 로 여러 번 전송된다).
    if (label === 'after') {
      const big = await osPaste({ name: `${cli}-big`, text: TEXT.big, paneId: tab.paneId })
      record(`${cli}-big-sent`, { ...big, bytes: Buffer.byteLength(TEXT.big), lines: TEXT.big.split('\n').length })
      if (big.ok) {
        const obs = await observe({ step: `${cli}-big`, paneId: tab.paneId, waitMs: 3500, cli })
        const placeholder = obs.composer?.match(/\[Pasted (text|Content)[^\]]*\]/i)?.[0] ?? null
        const submitted = obs.screen.split('\n').some((line) => /l505-big line 000/.test(line)) && !(obs.composer ?? '').includes('l505-big line 000')
        record(`${cli}-big-judge`, { placeholder, submitted, composer: obs.composer })
        checks.require(`${cli}-big-not-submitted`, !submitted, { composer: obs.composer })
        checks.require(`${cli}-big-ring-paste-text`, obs.bytes.length === 1 && obs.bytes[0].source === 'paste-text', { bytes: obs.bytes })
        checks.require(`${cli}-big-cleared`, await clearAgentInput(tab.paneId, `${cli}-big`, cli))
      } else checks.require(`${cli}-big-sent`, false, big)
    }
    checks.require(`${cli}-tab-closed`, await closeTab(tab))
    record(`${cli}-closed`, { tabsLeft: await fixtureTabs() })
  }
} catch (error) {
  record('error', { error: String(error?.stack ?? error) })
  exitCode = 2
} finally {
  exitCode = checks.exitCode(exitCode)
  record('end', { exitCode, failed: checks.failed().map((row) => row.name), clipboardAfter: clip('dump').out })
}
process.exit(exitCode)
