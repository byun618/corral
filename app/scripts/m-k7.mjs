// K7 — 끊김 감지와 재시도의 성질.
//   A. 정상 종료(`herdr session stop`) 로 오래 내려 두고: EOF 감지 · ENOENT · 백오프+jitter
//   B. 크래시(`kill -9`) 로: 소켓 파일이 남는가, 그러면 ECONNREFUSED 인가 (분석 공백 6)
// 그리고 두 경우 모두 **재시도 루프가 프로세스를 죽이지 않는지** 본다.
//
// 격리: kill 대상 PID 는 life344-* 소켓을 들고 있고 **default 소켓을 들고 있지 않은** 것만 고른다.
// 확인 못 하면 그 자리에서 멈춘다 — 사용자의 default 세션을 죽이는 사고를 코드로 막는다.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { SESSION, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
const SOCK = socketPath()
const DEFAULT_SOCK = path.join(os.homedir(), '.config', 'herdr', 'herdr.sock')

/** life344 서버 PID 를 찾되, default 소켓을 들고 있으면 절대 돌려주지 않는다. */
async function findIsolatedServerPid() {
  const { stdout } = await run('/bin/sh', ['-c', `lsof -U 2>/dev/null | grep ${SOCK} || true`])
  const pids = [...new Set(stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)[1]))]
  if (pids.length !== 1) throw new Error(`life344 소켓을 든 프로세스가 ${pids.length}개다: ${pids.join(',')}`)
  const pid = pids[0]
  const { stdout: own } = await run('/bin/sh', ['-c', `lsof -p ${pid} 2>/dev/null || true`])
  if (!own.includes(SOCK)) throw new Error(`PID ${pid} 가 life344 소켓을 들고 있지 않다`)
  if (own.includes(DEFAULT_SOCK)) throw new Error(`거부: PID ${pid} 가 default 소켓도 들고 있다`)
  return { pid, evidence: own.split('\n').filter((line) => line.includes('.config/herdr')).join('\n') }
}

function restartHeadless() {
  spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], { detached: true, stdio: 'ignore' }).unref()
}

async function waitSocket(present, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCK) === present) return true
    await sleep(50)
  }
  return false
}

async function waitLive(app, count, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = app.entries().filter((entry) => entry.tag === 'link.phase' && entry.phase === 'live')
    if (live.length >= count) return live[live.length - 1]
    await sleep(100)
  }
  return null
}

await tidySession()
const app = await startApp({ name: 'k7' })

// --- A. 정상 종료 + 오래 내려 두기 ---------------------------------------
const stopAt = Date.now()
await run('herdr', ['session', 'stop', SESSION])
const socketGoneAfterStop = await waitSocket(false, 10000)
await sleep(9000) // 재시도가 여러 번 돌 시간을 준다
const duringDown = app.entries().filter((entry) => entry.at >= stopAt)
const stopFailures = duringDown.filter((entry) => entry.tag === 'boot.failed')
const stopRetries = duringDown.filter((entry) => entry.tag === 'link.retry.scheduled')
restartHeadless()
const recoveredA = await waitLive(app, 2)
if (recoveredA === null) throw new Error('A 경로 복구 실패')

// --- B. 크래시 (kill -9) -------------------------------------------------
await sleep(1500)
const target = await findIsolatedServerPid()
const crashAt = Date.now()
await run('kill', ['-9', target.pid])
await sleep(1200)
const socketSurvivedCrash = fs.existsSync(SOCK)
await sleep(6000)
const afterCrash = app.entries().filter((entry) => entry.at >= crashAt)
const crashFailures = afterCrash.filter((entry) => entry.tag === 'boot.failed')
const crashRetries = afterCrash.filter((entry) => entry.tag === 'link.retry.scheduled')
const crashDrop = afterCrash.find((entry) => entry.tag === 'link.dropped') ?? null

restartHeadless()
const recoveredB = await waitLive(app, 3)
await sleep(500)
await app.shot('k7-after-crash-recovery')
const finalState = await app.state()

const entries = app.entries()
const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  killTarget: target,
  gracefulStop: {
    socketFileRemoved: socketGoneAfterStop,
    detectedBy: (duringDown.find((entry) => entry.tag === 'sub.drop') ?? {}).reason ?? null,
    errorCodes: [...new Set(stopFailures.map((entry) => entry.code))],
    retryCount: stopRetries.length,
    retryDelaysMs: stopRetries.map((entry) => entry.delayMs),
    recoveredMsFromStop: recoveredA.at - stopAt,
  },
  crash: {
    socketFileSurvived: socketSurvivedCrash,
    detectedBy: crashDrop?.reason ?? null,
    errorCodes: [...new Set(crashFailures.map((entry) => entry.code))],
    retryCount: crashRetries.length,
    retryDelaysMs: crashRetries.map((entry) => entry.delayMs),
    recovered: recoveredB !== null,
    recoveredMsFromCrash: recoveredB === null ? null : recoveredB.at - crashAt,
  },
  processSurvived: {
    appAlive: finalState.ok === true,
    uncaughtExceptions: entries.filter((entry) => entry.tag === 'main.uncaught_exception').length,
    unhandledRejections: entries.filter((entry) => entry.tag === 'main.unhandled_rejection').length,
    totalAttempts: entries.filter((entry) => entry.tag === 'boot.subscribe.begin').length,
  },
  backoff: {
    // "간격이 실제로 벌어지는가" — 시도가 거듭될수록 상한이 커진다 (equal jitter, 상한 2000ms)
    allDelays: entries.filter((entry) => entry.tag === 'link.retry.scheduled').map((entry) => entry.delayMs),
    distinctDelays: new Set(entries.filter((entry) => entry.tag === 'link.retry.scheduled').map((entry) => entry.delayMs))
      .size,
    busyLoop: entries.filter((entry) => entry.tag === 'link.retry.scheduled').some((entry) => entry.delayMs < 50),
  },
}

writeRaw('26-k7-errors-backoff.json', result)
console.log(
  JSON.stringify(
    {
      gracefulSocketRemoved: result.gracefulStop.socketFileRemoved,
      gracefulCodes: result.gracefulStop.errorCodes,
      crashSocketSurvived: result.crash.socketFileSurvived,
      crashCodes: result.crash.errorCodes,
      crashRecovered: result.crash.recovered,
      distinctDelays: result.backoff.distinctDelays,
      busyLoop: result.backoff.busyLoop,
      uncaught: result.processSurvived.uncaughtExceptions,
      appAlive: result.processSurvived.appAlive,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()
