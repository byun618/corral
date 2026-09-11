// R 블록 — 재동기·복구. R1(정책 비용) · R2(유실 회복) · R3(재연결) · R4(전환 세대) · R5(pane 소멸).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { panes, rendererErrors, request, run, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

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
  // **표본 하나로는 부족하다** — 심장박동 위상에 따라 0ms 에 가깝게도, 주기 전체만큼도 걸린다.
  // 여러 번 재서 **최악값**을 약속과 견준다.
  const rounds = []
  for (let i = 0; i < 6; i++) {
    const marker = `R2RECOVERED${i}`
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
      await sleep(40)
    }
    rounds.push({ i, marker, convergedMs })
    console.log('R2 round', i, convergedMs, 'ms')
    // 다음 표본이 앞 표본의 심장박동 위상을 물려받지 않게 흩는다.
    await sleep(300 + i * 170)
  }
  // --- idle 변형 (판정 M4) ------------------------------------------------
  // 위 6회는 표본 사이 간격이 짧아 **전부 hot(250ms) 구간**에서 났다. 그런데 약속 창
  // `recoveryWindowMs` 를 지탱하는 것은 idle(2000ms) 쪽이다 — 지탱하는 경로를 한 번도 안 재고
  // "약속 안에 들어왔다"고 쓴 것이라 판정이 보류로 갔다. 여기서는 매 표본 전에
  // **HOT_WINDOW_MS(10초) 넘게 화면을 정지시켜** idle 로 떨어뜨린 뒤 잰다.
  const idleRounds = []
  for (let i = 0; i < 4; i++) {
    const beforeIdle = (await app.state()).state.terminal
    await sleep(12_000) // > HOT_WINDOW_MS. 이 사이 화면이 안 바뀌므로 심장박동이 idle 로 내려간다.
    const stateBefore = (await app.state()).state.terminal
    // **정말 조용했나**를 증거로 남긴다. 프롬프트에 시계가 있는 셸이면 화면이 매초 바뀌어
    // hot 에서 안 내려온다 — 그러면 이 표본은 idle 을 잰 것이 아니다.
    const framesDuringIdle = stateBefore.frames - beforeIdle.frames
    const readsDuringIdle = stateBefore.reads - beforeIdle.reads
    const marker = `R2IDLE${i}`
    const at = Date.now()
    await request('pane.send_text', { pane_id: paneId, text: `printf '${marker}\n'\n` })
    let convergedMs = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const screen = await screenOf(app)
      if (screen.includes(marker)) {
        convergedMs = Date.now() - at
        break
      }
      await sleep(40)
    }
    idleRounds.push({
      i,
      marker,
      convergedMs,
      idleGapMs: 12_000,
      framesDuringIdle,
      // 읽기 횟수는 참고값이다 — 12초 중 앞 10초는 직전 표본이 만든 hot 꼬리라 250ms 로 돌고
      // 뒤 2초만 idle 주기다. 그래서 이 값으로는 idle 여부를 못 가른다.
      readsDuringIdle,
      // **프레임 0장이 판별자다.** 12초 동안 화면이 한 번도 안 바뀌었다는 뜻이고,
      // 그러면 `lastChangeAt` 이 12초 이상 묵어 HOT_WINDOW_MS(10초)를 넘긴다 — 보내는 순간
      // 심장박동은 idle(2000ms) 이다.
      wasIdle: framesDuringIdle === 0,
    })
    console.log('R2 idle round', i, convergedMs, 'ms')
  }
  const idleConverged = idleRounds.map((round) => round.convergedMs).filter((value) => value !== null)

  const converged = rounds.map((round) => round.convergedMs).filter((value) => value !== null)
  const before = ''
  const after = await screenOf(app)
  const dropped = app.entries().filter((entry) => entry.tag === 'term.event.dropped_by_injection').length
  out.r2 = {
    injection: 'CORRAL_INJECT_DROP_PANE_UPDATED=1 — pane.updated 를 터미널 층이 못 보게 막는다',
    droppedEvents: dropped,
    promisedWindowMs: policy.recoveryWindowMs,
    rounds,
    convergedAll: converged,
    worstMs: converged.length ? Math.max(...converged) : null,
    medianMs: converged.length ? converged.slice().sort((a, b) => a - b)[Math.floor(converged.length / 2)] : null,
    missed: rounds.length - converged.length,
    withinPromise: converged.length === rounds.length && Math.max(...converged) <= policy.recoveryWindowMs,
    idle: {
      note: '표본마다 12초 정지시켜 idle(2000ms) 구간으로 떨어뜨린 뒤 잰 값 (판정 M4)',
      rounds: idleRounds,
      convergedAll: idleConverged,
      worstMs: idleConverged.length ? Math.max(...idleConverged) : null,
      medianMs: idleConverged.length
        ? idleConverged.slice().sort((a, b) => a - b)[Math.floor(idleConverged.length / 2)]
        : null,
      missed: idleRounds.length - idleConverged.length,
      allSamplesWereIdle: idleRounds.every((round) => round.wasIdle),
      withinPromise:
        idleConverged.length === idleRounds.length && Math.max(...idleConverged) <= policy.recoveryWindowMs,
    },
    pollMs: 40,
    before,
    after: after.split('\n').slice(0, 4),
    shot: (await app.termShot('r2-after')).file,
  }
  console.log('R2 worst', out.r2.worstMs, 'ms / 약속', policy.recoveryWindowMs, 'dropped', dropped)
  console.log('R2 idle worst', out.r2.idle.worstMs, 'ms / 약속', policy.recoveryWindowMs, '놓침', out.r2.idle.missed)
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
  // **크기를 정한 PTY** 로 되살린다. `script -q /dev/null` 로 띄우면 제어 터미널이 없어
  // PTY 가 80x24 로 잡히고, 그 뒤 측정이 전부 그 세계에서 돌아간다 (T2 가 pane 80칸인데
  // corral 120칸을 그리는 것으로 잡았다). 측정 세계를 결정적으로 두려고 크기를 박는다.
  const { spawn } = await import('node:child_process')
  spawn('python3', [`${process.cwd()}/scripts/l345/attach.py`, SESSION, '40', '120'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
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

  const r3Attach = app.entries().filter((entry) => entry.tag === 'term.frame' && entry.kind === 'attach')
  out.r3 = {
    stoppedSession: SESSION,
    restartMs: upMs,
    // **한 세대에 attach 프레임 한 장** (2회차 리뷰 G2). 1차 원자료(`_runs/r3/app.ndjson`)에서는
    // 세대 2에 두 장이 나갔다 — `onLinkLive` 가 가드 없이 bootstrap 을 또 불렀기 때문이다.
    attachFramesByGeneration: r3Attach.reduce((acc, frame) => {
      acc[frame.generation] = (acc[frame.generation] ?? 0) + 1
      return acc
    }, {}),
    reliveLogs: app.entries().filter((entry) => entry.tag === 'term.relive').length,
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
  const screenAlive = await screenOf(app)

  await request('pane.close', { pane_id: victim })
  await sleep(3000)
  const dead = (await app.state()).state.terminal
  const framesAfterDeath = dead.frames
  const screenDead = await screenOf(app)
  await sleep(7000)
  const later = (await app.state()).state.terminal

  out.r5 = {
    victim,
    aliveBefore: alive.alive,
    aliveAfter: dead.alive,
    deadReason: dead.deadReason,
    inputBlockedAfter: dead.inputBlocked,
    framesAtDeath: framesAfterDeath,
    framesSevenSecondsLater: later.frames,
    // 죽은 뒤에도 프레임이 늘면 죽은 pane 을 계속 그리고 있는 것이다.
    keptDrawing: later.frames > framesAfterDeath,
    // 마지막 화면을 그대로 들고 있나 (지워 버리면 무엇이 죽었는지 안 남는다).
    keptLastScreen: screenDead.includes('VICTIM PANE'),
    screenAliveHead: screenAlive.split('\n').filter((line) => line.trim()).slice(0, 2),
    screenDeadHead: screenDead.split('\n').filter((line) => line.trim()).slice(0, 2),
    shotAlive,
    shotDead: (await app.termShot('r5-dead')).file,
    fullShotDead: (await app.shot('r5-dead-full')).file,
  }
  console.log('R5', JSON.stringify({ ...out.r5, shotAlive: undefined, shotDead: undefined }))
  await app.stop()
}

// ==========================================================================
// R6 — **선택을 유지한 채 링크가 되살아날 때** 스크롤백이 겹치나 (2회차 리뷰 G2 의 미측정 경로)
// ==========================================================================
//
// 1차에는 이 경로를 아무도 안 밟았다. R3 은 재기동 뒤 pane 을 **다시 고르는** 모양이라 겹침이
// 안 보인다고 형제 리뷰가 적었는데, 원자료를 다시 보니 pane id 가 그대로여서 선택은 no-op 이었고
// **세대 2에 `attach` 프레임이 두 장** 나가 있었다 (`_runs/r3/app.ndjson`, 1차 빌드).
//
// 두 갈래로 잰다:
//   ⓐ 렌더러 성질 — 같은 세대에 씨앗형 바이트를 한 번 더 쓰면 **기존 스크롤백 위에 쌓인다**
//      (`term.reset()` 은 세대가 바뀔 때만 탄다). 이게 겹침의 기전이다
//   ⓑ 제품 경로 — 링크를 끊었다 살렸을 때 그 세대에 `attach` 프레임이 **한 장만** 나가는가
{
  const paneId = await tidySession()
  await run(paneId, 'clear; for i in $(seq 1 120); do printf "R6HIST %03d\n" $i; done', { settleMs: 3000 })
  const app = await startApp({ name: 'r6' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(3000)

  const markersOf = (lines) => lines.map((line) => line.match(/R6HIST (\d{3})/)?.[1] ?? null).filter((m) => m !== null)
  const before = (await app.dump()).dump
  const beforeMarkers = markersOf(before.scrollback)

  // ⓐ 기전 — 씨앗과 같은 모양의 바이트를 한 번 더 쓴다 (5줄 + 개행 rows-1).
  const seedLike =
    '\u001b[?2026h\u001b[?7h\u001b[H' +
    [1, 2, 3, 4, 5].map((n) => `R6SEED ${n}\u001b[0m\r\n`).join('') +
    '\n'.repeat(before.rows - 1) +
    '\u001b[?2026l'
  await app.write(seedLike)
  await sleep(800)
  const replayed = (await app.dump()).dump

  // ⓑ 제품 경로 — 링크를 끊었다 살린다. 선택은 그대로 둔다 (재선택 없음).
  await exec('herdr', ['session', 'stop', SESSION]).catch(() => {})
  for (let i = 0; i < 60 && fs.existsSync(SOCK); i++) await sleep(100)
  await sleep(1200)
  const { spawn } = await import('node:child_process')
  spawn('python3', [`${process.cwd()}/scripts/l345/attach.py`, SESSION, '40', '120'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
  for (let i = 0; i < 150 && !fs.existsSync(SOCK); i++) await sleep(100)
  let livedAgain = false
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const phases = app.entries().filter((entry) => entry.tag === 'link.phase').map((entry) => entry.phase)
    if (phases.lastIndexOf('live') > phases.indexOf('live')) {
      livedAgain = true
      break
    }
    await sleep(200)
  }
  await sleep(4000)

  const after = (await app.dump()).dump
  const afterMarkers = markersOf(after.scrollback)
  const entries = app.entries()
  const attachFrames = entries.filter((entry) => entry.tag === 'term.frame' && entry.kind === 'attach')
  const byGeneration = attachFrames.reduce((acc, frame) => {
    acc[frame.generation] = (acc[frame.generation] ?? 0) + 1
    return acc
  }, {})
  const counts = {}
  for (const marker of afterMarkers) counts[marker] = (counts[marker] ?? 0) + 1

  out.r6 = {
    note: '선택을 유지한 채 링크가 다시 live 가 되는 경로 (G2). 1차에는 어떤 측정도 이 길을 안 밟았다',
    paneId,
    rendererSeedReplay: {
      note: '같은 세대에 씨앗형 바이트를 한 번 더 쓰면 기존 스크롤백 **위에 쌓인다** — 겹침의 기전',
      baseYBefore: before.baseY,
      baseYAfter: replayed.baseY,
      grew: replayed.baseY - before.baseY,
      seedLines: 5,
      stacked: replayed.baseY > before.baseY,
    },
    linkWentLiveAgain: livedAgain,
    reliveLogs: entries.filter((entry) => entry.tag === 'term.relive').length,
    // **이 값은 G2 가 도는 증거가 아니다** (3회차 리뷰 N1). `bootstrap` 의 인플라이트 가드는
    // 지금 코드에서 안 문다 — 호출자 둘 다 진입 직전에 같은 플래그를 동기로 처리하고 사이에
    // `await` 가 없다. 그래서 이 0 은 가드가 있든 없든 나온다. **침입 탐지용 0** 으로만 남긴다:
    // 0 이 아니게 되는 날은 세 번째 호출자가 생겼거나 그 사이에 `await` 가 낀 날이다.
    // G2 를 받치는 것은 아래 `oneAttachFramePerGeneration` 과 마커 중복 0 이다.
    attachBusyTripwire: entries.filter((entry) => entry.tag === 'term.attach.busy').length,
    attachFramesByGeneration: byGeneration,
    // 이것이 이번 회차의 통과 조건이다 — 세대마다 한 장.
    oneAttachFramePerGeneration: Object.values(byGeneration).every((count) => count === 1),
    markersBefore: beforeMarkers.length,
    markersAfter: afterMarkers.length,
    duplicatedMarkers: Object.entries(counts).filter(([, count]) => count > 1).length,
    baseYAfterRelive: after.baseY,
    rendererErrors: rendererErrors(entries),
    shot: (await app.termShot('r6-after')).file,
  }
  console.log('R6', JSON.stringify({ ...out.r6, shot: undefined, rendererErrors: out.r6.rendererErrors.count }))
  await app.stop()
}

writeRaw('30-resync.json', { measuredAt: new Date().toISOString(), ...out })
process.exit(0)
