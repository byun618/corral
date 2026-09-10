// K1 — 부트스트랩 순서(구독→ack→버퍼링→snapshot→멱등 적용)와 수렴 일치.
//
// 부트스트랩 창은 100ms 안팎이라 가만히 두면 버퍼가 빈다. 그래서 **먼저 흔들기 시작하고**
// 그 와중에 앱을 띄운다 — 스파이크 A4 와 같은 조건이다.
//
// **수정 1회차 (판정문 H1)**: 1회차 측정은 흔들기가 만든 것을 stop 에서 전부 닫아 버려,
// 비교가 `{w1}` vs `{w1}` 이 됐다 — 통과선이 요구한 "수렴 집합 == 실제 상태" 를 원소 1개로
// 쟀으니 증명이 아니다. 이제 흔들기가 workspace 를 **닫지 않고 남긴다**(startChurn 의 keep).
// A4 는 pane 7개(그중 churn 생존분 2개)를 비교했다 — 여기서도 생존분을 3개 이상 남겨 비교한다.
//
// 그리고 N회 돌려 **모든 회차의 로그를 _runs/k1-1 … k1-N 에 남긴다** (판정문 M4).

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION, request, sleep, socketPath, startApp, startChurn, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
socketPath() // 격리 가드

const RUNS = Number(process.env.K1_RUNS ?? 6)
// 남길 것을 시각으로 흩는다 — 전부 부트스트랩 이전 생성분이 되면 "버퍼로 배운 것"이 안 남는다.
// 실측상 부트스트랩(ack ~ 버퍼 적용)은 churn 시작 기준 **790~960ms** 에 열린다. 뒤쪽 offset 들이
// 그 창을 겨눈다 — 창에 걸린 생존분은 스냅샷이 아니라 **버퍼로 배운** 것이 된다.
// 흔들기를 12갈래로 돌리는 또 다른 이유: 부트스트랩 창은 실측 ~110ms 라, 푸시 밀도가 낮으면
// 그 창에 이벤트가 하나도 안 걸려 **버퍼링을 아예 못 재는 회차**가 나온다. 8갈래에서 6회 중
// 2회가 그랬다 — 서버에 닫힌 workspace 가 쌓일수록 push 가 느려진다(§5-⑥ 의 유실과 같은 성질).
// 그래서 갈래를 늘리고, 회차 **전에 격리 세션 서버를 새로 띄운다**.
const KEEP_OFFSETS_MS = [0, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300]
// 통과선의 강도: 흔들기 생존분이 이만큼은 비교에 들어와야 한다 (A4 = 2개).
const MIN_RESIDUAL = 3

const runs = []
for (let i = 1; i <= RUNS; i++) runs.push(await once(i))

const summary = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  runs: RUNS,
  passBar: {
    order: '구독 → ack → 버퍼링 → snapshot 요청 → snapshot 적용 → 버퍼 적용 (타임스탬프 부등식)',
    converge: '조용해진 뒤 수렴 집합 == 직후 재조회한 실제 상태',
    strength: `비교 집합에 흔들기 생존 workspace 가 ${MIN_RESIDUAL}개 이상 (A4 는 2개였다)`,
  },
  verdict: {
    orderOk: runs.every((run) => run.orderOk),
    bufferingProven: runs.filter((run) => run.bufferingProven).length,
    convergeMatch: runs.filter((run) => run.verifyAfterQuiet.match === true).length,
    strengthOk: runs.filter((run) => run.residualWorkspaces.length >= MIN_RESIDUAL).length,
    pass: runs.every((run) => run.pass),
  },
  // 1회차 측정이 못 쟀던 것: 조용해지기 **전** 비교는 흔드는 중이라 원리상 어긋난다. 값만 남긴다.
  verifyDuringChurnMatches: runs.filter((run) => run.verifyDuringChurn === true).length,
  runDetail: runs,
}

writeRaw('20-k1-bootstrap.json', summary)
writeRaw(
  '20-k1-order.txt',
  [
    `# K1 — 부트스트랩 순서 (앱 로그의 타임스탬프 그대로). ${RUNS}회 전부.`,
    `# 로그 전문은 raw/claude/_runs/k1-1 … k1-${RUNS}/app.ndjson 에 회차별로 있다.`,
    ...runs.flatMap((run) => [
      '',
      `## run ${run.run} — orderOk=${run.orderOk} match=${run.verifyAfterQuiet.match} 비교 workspace ${run.comparedWorkspaces}개(생존분 ${run.residualWorkspaces.length})`,
      ...run.orderLog.map(
        (entry) =>
          `${entry.ts}  ${entry.tag}${entry.event ? ' ' + entry.event : ''}${entry.subject ? ' ' + entry.subject : ''}${entry.note ? ' — ' + entry.note : ''}`,
      ),
    ]),
  ].join('\n') + '\n',
)
console.log(JSON.stringify(summary.verdict, null, 2))
await tidySession()

async function once(runIndex) {
  await freshServer()
  await tidySession()
  // 부트스트랩 창은 실측 ~106ms 다. 그 안에 이벤트를 넣으려면 촘촘해야 해서 병렬로 돌린다.
  const churns = KEEP_OFFSETS_MS.map((keepAfterMs) => startChurn({ intervalMs: 0, keep: 1, keepAfterMs }))
  await sleep(600)

  const app = await startApp({
    name: `k1-${runIndex}`,
    env: { CORRAL_VERIFY_CONVERGE: '1' },
    waitFor: (entries) => entries.some((entry) => entry.tag === 'boot.verify'),
  })

  // 흔들기를 멈추고 **실제로 조용해진 뒤에** 수렴 비교를 한다 — 흔드는 중의 비교는 서로 다른
  // 시점을 비교하는 것이라 의미가 없다 (A4 도 churn 을 멈추고 비교했다).
  // "조용해졌다"는 앱 로그에 push 가 일정 시간 안 들어온 것으로 판정한다 (시계를 믿지 않는다).
  const kept = []
  const churnEvents = []
  for (const churn of churns) {
    const stopped = await churn.stop()
    kept.push(...stopped.kept)
    churnEvents.push(...churn.events)
  }
  const quietAfterMs = await waitQuiet(app, 1500, 30000)
  const verifyAfterQuiet = await app.verify()
  const entries = app.entries()
  await app.stop()

  const ORDER_TAGS = [
    'boot.subscribe.begin',
    'boot.subscribe.ack',
    'push.buffered',
    'boot.snapshot.request',
    'boot.snapshot.applied',
    'boot.buffer.apply.begin',
    'boot.buffer.apply',
    'boot.converged',
    'boot.verify',
  ]
  const orderLog = entries
    .filter((entry) => ORDER_TAGS.includes(entry.tag))
    .map((entry) => ({
      ts: entry.ts,
      at: entry.at,
      tag: entry.tag,
      event: entry.event ?? null,
      subject: entry.subject ?? null,
      note: entry.note ?? null,
    }))

  const stamp = (tag) => entries.find((entry) => entry.tag === tag)?.at ?? null
  const buffered = entries.filter((entry) => entry.tag === 'push.buffered')
  const applied = entries.filter((entry) => entry.tag === 'boot.buffer.apply')
  const converged = entries.find((entry) => entry.tag === 'boot.converged') ?? null
  const verify = entries.find((entry) => entry.tag === 'boot.verify') ?? null

  const actual = verifyAfterQuiet.verify?.actual ?? { workspaces: [] }
  // 비교 집합 중 흔들기가 남긴 것 = 이번 측정이 실제로 증명하는 대상.
  const residualWorkspaces = actual.workspaces.filter((id) => kept.includes(id))
  // 그중 **버퍼를 거쳐** 알게 된 것 (스냅샷이 아니라). 부트스트랩 창에 걸린 생성분이다.
  const bufferSubjects = new Set(applied.map((entry) => entry.subject).filter((id) => id !== null))
  const learnedFromBuffer = residualWorkspaces.filter((id) => bufferSubjects.has(id))
  // 흔들기가 만들고 닫은 것들 — 하나라도 목록에 살아 있으면 수렴이 깨진 것이다.
  const closedByChurn = churnEvents.filter((event) => event.kind === 'close').map((event) => event.workspaceId)
  const ghosts = actual.workspaces.filter((id) => closedByChurn.includes(id))

  const orderOk =
    stamp('boot.subscribe.begin') <= stamp('boot.subscribe.ack') &&
    stamp('boot.subscribe.ack') <= stamp('boot.snapshot.request') &&
    stamp('boot.snapshot.request') <= stamp('boot.snapshot.applied') &&
    stamp('boot.snapshot.applied') <= stamp('boot.buffer.apply.begin')

  // 통과선의 "버퍼링" 칸을 따로 세운다 (판정문 낮음 7 — 1회차는 이걸 부등식에 안 넣었다).
  // 버퍼가 비면 이 회차는 버퍼링을 **증명하지 못한 것**이지 통과한 것이 아니다.
  const bufferingProven =
    buffered.length > 0 &&
    buffered.every(
      (entry) => entry.at >= stamp('boot.subscribe.ack') && entry.at <= stamp('boot.buffer.apply.begin'),
    ) &&
    applied.length === buffered.length

  const result = {
    run: runIndex,
    logDir: `_runs/k1-${runIndex}`,
    orderOk,
    bufferingProven,
    bufferedCount: buffered.length,
    bufferedBeforeSnapshotApplied: buffered.every((entry) => entry.at <= stamp('boot.snapshot.applied')),
    appliedFromBuffer: applied.length,
    idempotentAbsorbed: applied.filter((entry) => entry.changed === false).map((entry) => entry.note),
    heldOrphansAtConverge: converged?.heldOrphans ?? [],
    timestamps: {
      subscribeBegin: stamp('boot.subscribe.begin'),
      subscribeAck: stamp('boot.subscribe.ack'),
      firstBufferedPush: stamp('push.buffered'),
      snapshotRequest: stamp('boot.snapshot.request'),
      snapshotApplied: stamp('boot.snapshot.applied'),
      bufferApplyBegin: stamp('boot.buffer.apply.begin'),
      converged: stamp('boot.converged'),
    },
    keptByChurn: kept,
    comparedWorkspaces: actual.workspaces.length,
    residualWorkspaces,
    learnedFromBuffer,
    ghostWorkspaces: ghosts,
    quietAfterMs,
    verifyDuringChurn: verify?.match ?? null,
    verifyAfterQuiet: verifyAfterQuiet.verify,
    orderLog,
    pass:
      orderOk &&
      bufferingProven &&
      verifyAfterQuiet.verify?.match === true &&
      residualWorkspaces.length >= MIN_RESIDUAL &&
      ghosts.length === 0,
  }
  console.log(
    `run ${runIndex}: order=${result.orderOk} buffer=${result.bufferingProven}(${buffered.length}) match=${result.verifyAfterQuiet?.match} ` +
      `비교=${result.comparedWorkspaces} 생존분=${residualWorkspaces.length} 버퍼경유=${learnedFromBuffer.length} pass=${result.pass}`,
  )
  return result
}

/** 마지막 push.applied 이후 quietMs 가 지날 때까지 기다린다. 못 기다리면 null. */
async function waitQuiet(app, quietMs, timeoutMs) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const pushes = app.entries().filter((entry) => entry.tag === 'push.applied')
    const last = pushes.length === 0 ? started : pushes[pushes.length - 1].at
    if (Date.now() - last >= quietMs) return Date.now() - started
    await sleep(100)
  }
  return null
}

/**
 * 격리 세션 서버를 새로 띄운다. 회차를 거듭할수록 닫힌 workspace 가 쌓여 push 가 느려지고,
 * 부트스트랩 창(~110ms)에 이벤트가 하나도 안 걸리는 회차가 생긴다 — 그걸 없애기 위한 것뿐이다.
 * 재는 대상(부트스트랩 순서·수렴)은 서버가 새것이든 아니든 달라지지 않는다.
 */
async function freshServer() {
  await run('herdr', ['session', 'stop', SESSION]).catch(() => {})
  await sleep(400)
  const restart = spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], {
    detached: true,
    stdio: 'ignore',
  })
  restart.unref()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      await request('ping', {}, { timeoutMs: 800 })
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error('격리 세션이 20초 안에 안 떴다')
}
