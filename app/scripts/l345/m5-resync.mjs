// R 블록 — 재동기·복구. R1(정책 비용) · R2(유실 회복) · R3(재연결) · R4(전환 세대) · R5(pane 소멸).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { panes, request, run, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

const exec = promisify(execFile)
const SESSION = process.env.LIFE345_SESSION ?? 'life345-claude'
const SOCK = socketPath()

const screenOf = async (app) => {
  const dump = (await app.dump()).dump
  return dump.grid
    .map((row) => row.map((cell) => (cell?.w === 0 ? '' : (cell?.ch ?? ' '))).join('').trimEnd())
    .join('\n')
    .trimEnd()
}

const out = {}

// ==========================================================================
// R1 — 정책의 비용. 정지 화면(유휴)과 출력이 쏟아질 때 각각 초당 요청 수를 센다.
// ==========================================================================
{
  const paneId = await tidySession()
  await run(paneId, 'clear; printf "R1 정지 화면\\n"', { settleMs: 900 })
  const app = await startApp({ name: 'r1' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(2500)

  const policy = (await app.policy()).policy
  const mark = () => {
    const entries = app.entries()
    return {
      at: Date.now(),
      reads: entries.filter((entry) => entry.tag === 'req.tx' && entry.method === 'pane.read').length,
      frames: entries.filter((entry) => entry.tag === 'term.frame').length,
    }
  }

  const idleStart = mark()
  await sleep(20_000)
  const idleEnd = mark()

  // 출력이 쏟아질 때 — 알트스크린 티커를 돌린다.
  await run(paneId, `sh ${process.cwd()}/scripts/l345/fixtures/04-ticker.sh &`, { settleMs: 1500 })
  const busyStart = mark()
  await sleep(20_000)
  const busyEnd = mark()
  await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
  await sleep(500)
  await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 700 })

  const rate = (a, b) => ({
    seconds: (b.at - a.at) / 1000,
    reads: b.reads - a.reads,
    frames: b.frames - a.frames,
    readsPerSecond: Number((((b.reads - a.reads) * 1000) / (b.at - a.at)).toFixed(2)),
    framesPerSecond: Number((((b.frames - a.frames) * 1000) / (b.at - a.at)).toFixed(2)),
  })
  out.r1 = { policy, idle: rate(idleStart, idleEnd), busy: rate(busyStart, busyEnd) }
  console.log('R1 idle', JSON.stringify(out.r1.idle), 'busy', JSON.stringify(out.r1.busy))
  await app.stop()
}

// ==========================================================================
// R2 — 유실 회복. `pane.updated` 를 인위로 떨어뜨린 채 화면을 바꾸고, 정책이 약속한 창
//      (심장박동 + 왕복) 안에 수렴하는지 잰다.
// ==========================================================================
{
  const paneId = await tidySession()
  await run(paneId, 'clear; printf "R2 시작 화면\\n"', { settleMs: 900 })
  const app = await startApp({ name: 'r2', env: { CORRAL_INJECT_DROP_PANE_UPDATED: '1' } })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(3000)

  const policy = (await app.policy()).policy
  const before = await screenOf(app)
  const marker = 'R2RECOVERED'
  const at = Date.now()
  await request('pane.send_text', { pane_id: paneId, text: `printf '${marker}\\n'\n` })

  let convergedMs = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const screen = await screenOf(app)
    if (screen.includes(marker)) {
      convergedMs = Date.now() - at
      break
    }
    await sleep(80)
  }
  const after = await screenOf(app)
  const dropped = app.entries().filter((entry) => entry.tag === 'term.event.dropped_by_injection').length
  out.r2 = {
    injection: 'CORRAL_INJECT_DROP_PANE_UPDATED=1 — pane.updated 를 터미널 층이 못 보게 막는다',
    droppedEvents: dropped,
    promisedWindowMs: policy.recoveryWindowMs,
    convergedMs,
    withinPromise: convergedMs !== null && convergedMs <= policy.recoveryWindowMs,
    before: before.split('\n').slice(0, 4),
    after: after.split('\n').slice(0, 4),
    shot: (await app.termShot('r2-after')).file,
  }
  console.log('R2 converged', convergedMs, 'ms / 약속', policy.recoveryWindowMs, 'dropped', dropped)
  await app.stop()
}

// ==========================================================================
// R3 — 재연결. herdr 세션을 죽였다 살리면 터미널 층도 스스로 회복하나.
// ==========================================================================
{
  const paneId = await tidySession()
  await run(paneId, 'clear; printf "R3 이전 화면\\n"', { settleMs: 900 })
  const app = await startApp({ name: 'r3' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(2500)
  const framesBefore = (await app.state()).state.terminal.frames

  await exec('herdr', ['session', 'stop', SESSION]).catch(() => {})
  for (let i = 0; i < 60 && fs.existsSync(SOCK); i++) await sleep(100)
  const downAt = Date.now()
  await sleep(1500)
  // PTY 래퍼로 되살린다 (LIFE-344 실측 경로 — Orca 탭 없이 헤드리스로 뜬다).
  const { spawn } = await import('node:child_process')
  spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 150 && !fs.existsSync(SOCK); i++) await sleep(100)
  const upMs = Date.now() - downAt

  // 서버가 새로 뜨면 pane id 가 처음부터 다시 매겨진다. 링크가 live 로 돌아오는지,
  // 그리고 그 pane 을 고르면 터미널이 다시 그려지는지 본다.
  let livedAgain = false
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const entries = app.entries()
    const phases = entries.filter((entry) => entry.tag === 'link.phase').map((entry) => entry.phase)
    if (phases.lastIndexOf('live') > phases.indexOf('live')) {
      livedAgain = true
      break
    }
    await sleep(200)
  }
  await sleep(1500)
  const newPanes = await panes()
  const newPaneId = newPanes[0]?.pane_id ?? null
  await app.selectPane(newPaneId)
  await sleep(2500)
  const marker = 'R3ALIVE'
  await request('pane.send_text', { pane_id: newPaneId, text: `printf '${marker}\\n'\n` })
  await sleep(2500)
  const screen = await screenOf(app)
  const state = (await app.state()).state.terminal

  out.r3 = {
    stoppedSession: SESSION,
    restartMs: upMs,
    linkWentLiveAgain: livedAgain,
    oldPaneId: paneId,
    newPaneId,
    framesBefore,
    framesAfter: state.frames,
    terminalRecovered: screen.includes(marker),
    shot: (await app.termShot('r3-after')).file,
  }
  console.log('R3', JSON.stringify({ ...out.r3, shot: undefined }))
  await app.stop()
}

// ==========================================================================
// R4 — 전환 세대. 느린 pane A 를 고른 직후 B 를 고르면 A 의 늦은 응답이 B 화면에 부어지나.
// ==========================================================================
{
  const paneId = await tidySession()
  await run(paneId, 'clear; printf "PANE-A-CONTENT\\n"', { settleMs: 900 })
  const split = await request('pane.split', { pane_id: paneId, direction: 'right' })
  const paneB = split.pane.pane_id
  await sleep(1200)
  await run(paneB, 'clear; printf "PANE-B-CONTENT\\n"', { settleMs: 1200 })

  // 모든 pane.read 를 1.2초 늦춘다 — A 의 응답이 B 선택 뒤에 돌아오게 만든다.
  const app = await startApp({ name: 'r4', env: { CORRAL_INJECT_READ_DELAY_MS: '1200' } })
  await sleep(1500)
  await app.selectPane(paneId)
  await sleep(200) // A 의 첫 읽기가 아직 나가 있는 사이에
  await app.selectPane(paneB)
  await sleep(6000)

  const screen = await screenOf(app)
  const stale = app.entries().filter((entry) => entry.tag === 'term.read.stale' || entry.tag === 'link.attempt.stale')
  out.r4 = {
    injection: 'CORRAL_INJECT_READ_DELAY_MS=1200',
    paneA: paneId,
    paneB,
    showsB: screen.includes('PANE-B-CONTENT'),
    showsA: screen.includes('PANE-A-CONTENT'),
    staleDrops: stale.length,
    staleDetail: stale.slice(0, 5),
    screen: screen.split('\n').slice(0, 5),
    shot: (await app.termShot('r4-after')).file,
  }
  out.r4.ok = out.r4.showsB && !out.r4.showsA
  console.log('R4', JSON.stringify({ showsA: out.r4.showsA, showsB: out.r4.showsB, staleDrops: stale.length }))
  await request('pane.close', { pane_id: paneB }).catch(() => {})
  await app.stop()
}

// ==========================================================================
// R5 — pane 소멸. 죽은 pane 을 산 것처럼 계속 그리면 미달.
// ==========================================================================
{
  const paneId = await tidySession()
  const split = await request('pane.split', { pane_id: paneId, direction: 'right' })
  const victim = split.pane.pane_id
  await sleep(1200)
  await run(victim, 'clear; printf "VICTIM PANE\\n"', { settleMs: 1200 })

  const app = await startApp({ name: 'r5' })
  await sleep(1500)
  await app.selectPane(victim)
  await sleep(2500)
  const alive = (await app.state()).state.terminal
  const shotAlive = (await app.termShot('r5-alive')).file

  await request('pane.close', { pane_id: victim })
  await sleep(2500)
  const dead = (await app.state()).state.terminal
  const framesAfterDeath = dead.frames
  await sleep(6000)
  const later = (await app.state()).state.terminal

  out.r5 = {
    victim,
    aliveBefore: alive.alive,
    aliveAfter: dead.alive,
    deadReason: dead.deadReason,
    inputBlockedAfter: dead.inputBlocked,
    framesAtDeath: framesAfterDeath,
    framesSixSecondsLater: later.frames,
    // 죽은 뒤에도 프레임이 늘면 죽은 pane 을 계속 그리고 있는 것이다.
    keptDrawing: later.frames > framesAfterDeath,
    shotAlive,
    shotDead: (await app.termShot('r5-dead')).file,
  }
  console.log('R5', JSON.stringify({ ...out.r5, shotAlive: undefined, shotDead: undefined }))
  await app.stop()
}

writeRaw('30-resync.json', { measuredAt: new Date().toISOString(), ...out })
process.exit(0)
