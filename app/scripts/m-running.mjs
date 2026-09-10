// 세션 목록의 `running` — 멈춘 세션과 산 세션이 화면에서 갈리는가.
//
// `herdr session list --json` 은 **멈춘 세션도 준다**. 1회차 화면은 그 필드를 안 써서 둘이
// 똑같이 보였다 — 누르면 붙지 않는 행을 붙는 행과 구별할 수 없다. 사용자가 짚은 것이다.
//
// 격리: 여기서 만들고 지우는 것은 life344-* 뿐이다.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION, sleep, socketPath, startApp, writeRaw } from './lib.mjs'

const run = promisify(execFile)
const STOPPED = 'life344-stopped'
socketPath(SESSION)
socketPath(STOPPED) // 격리 가드 — 둘 다 life344- 접두여야 한다

// --- 멈춘 세션을 하나 만든다 (띄웠다가 바로 내린다) -----------------------
const born = spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', STOPPED], {
  detached: true,
  stdio: 'ignore',
})
born.unref()
await sleep(2500)
const stopped = await run('herdr', ['session', 'stop', STOPPED])
await sleep(800)
const listing = JSON.parse((await run('herdr', ['session', 'list', '--json'])).stdout)

const app = await startApp({ name: 'running' })
await sleep(800)
await app.shot('l1-running-flag')
const state = await app.state()

const rows = state.state.sessions.map((session) => ({
  name: session.name,
  running: session.running,
  isDefault: session.isDefault,
}))
const cliRows = listing.sessions.map((session) => ({ name: session.name, running: session.running === true }))
const stoppedRow = rows.find((row) => row.name === STOPPED) ?? null
const agrees = cliRows.every((cli) => rows.find((row) => row.name === cli.name)?.running === cli.running)

const result = {
  measuredAt: new Date().toISOString(),
  question: 'herdr 가 알려 주는 running 을 앱이 화면에 쓰는가 (멈춘 세션이 구별되는가)',
  cli: cliRows,
  app: rows,
  stoppedSessionInList: stoppedRow !== null,
  stoppedSessionShownAsStopped: stoppedRow !== null && stoppedRow.running === false,
  appAgreesWithCli: agrees,
  stopStdout: stopped.stdout.trim(),
  screenshot: 'shots/l1-running-flag.png',
  conclusion:
    stoppedRow === null
      ? '멈춘 세션이 목록에 안 나왔다 — 이 측정으로는 확인할 수 없다. 공백으로 남긴다.'
      : stoppedRow.running === false && agrees
        ? '멈춘 세션이 목록에 stopped 로 뜨고, 앱의 running 이 CLI 와 한 줄씩 일치한다. ' +
          '화면에서는 흐리게 + stopped 태그로 갈린다 (shots/l1-running-flag.png).'
        : '앱이 running 을 CLI 와 다르게 들고 있다. 결과 문서에 미달로 적을 것.',
}

writeRaw('34-session-running.json', result)
console.log(JSON.stringify({ app: rows, agrees, stoppedShown: result.stoppedSessionShownAsStopped }, null, 2))

await app.stop()
// 만든 것은 지운다 — 사용자 화면에 남기지 않는다.
await run('herdr', ['session', 'delete', STOPPED]).catch(() => {})
