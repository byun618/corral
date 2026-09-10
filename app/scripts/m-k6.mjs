// K6 — A5 재현. 격리 세션 서버를 죽였다 살렸을 때 앱이 사람 개입 없이 5단계를 해내는가.
//   ① 끊김 감지 ② 재연결 ③ 재구독 ④ 스냅샷 재획득 ⑤ live push 재개
//
// 시계 정의: **`herdr session stop` 을 낸 시각이 0** 이다. 복구 완료는 **⑤ live push 재개**로 본다
// (④ 스냅샷까지만 재면 통과선의 5단계 중 하나를 빼고 재는 것이다 — 판정문 M1).
//
// **수정 1회차 (판정문 M2·M4)**: 1회차 측정은 stop 154ms 뒤에 곧바로 되살려 다운타임이 사실상 0
// 이었다. 그래서 앱이 "서버 없는 동안 재시도하며 기다리는" 시간이 한 번도 안 들어갔고, 스파이크
// A5 의 3.4초와 같은 시계가 아니었다. 이제 K6_RESTART_DELAY_MS(기본 4000ms)만큼 **꺼진 채로 둔다**.
//
// 격리: 대상은 life344-* 세션뿐이다. socketPath() 가 코드 레벨에서 default 를 거부한다.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION, request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
socketPath() // 격리 가드

// 서버를 꺼 둔 채로 두는 시간. 0 이면 1회차와 같은 "다운타임 없는" 측정이 된다.
const RESTART_DELAY_MS = Number(process.env.K6_RESTART_DELAY_MS ?? 4000)

await tidySession()
const app = await startApp({ name: 'k6' })
await sleep(500)
await app.shot('k6-before-kill')
const before = await app.state()

// --- 서버를 내린다 (정상 종료 경로 — `kill -9` 는 K7 이 따로 쟀다) ------
const killAt = Date.now()
const stop = await run('herdr', ['session', 'stop', SESSION])

// --- 꺼진 채로 둔다 — 앱이 "없는 서버"를 상대로 재시도하는 시간을 실제로 만든다 ---
await sleep(RESTART_DELAY_MS)

// --- 곧바로 재기동을 건다 -----------------------------------------------
// herdr 는 스스로 뜨지 않는다. `herdr session attach` 는 TTY 를 요구하는데, Orca 탭 대신
// `script(1)` 로 PTY 만 붙여 주면 **헤드리스로 0.2초 만에** 뜬다 (킥오프의 "헤드리스 자동
// 기동이 안 된다"는 전제를 정정한다 — 안 되는 건 TTY 없는 기동이지 헤드리스가 아니다).
// Orca 탭 경로는 이번 1회 측정에서 61.5초가 걸렸다 (raw/claude/25-restart-paths.json).
const restartAt = Date.now()
const restart = spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], {
  detached: true,
  stdio: 'ignore',
})
restart.unref()

// --- 앱이 스스로 복구하는 것을 기다린다 (사람 개입 없음) -----------------
const deadline = Date.now() + 60000
let recovered = null
while (Date.now() < deadline) {
  const entries = app.entries()
  const live = entries.filter((entry) => entry.tag === 'link.phase' && entry.phase === 'live')
  if (live.length >= 2) {
    recovered = live[live.length - 1]
    break
  }
  await sleep(100)
}
if (recovered === null) throw new Error('60초 안에 복구하지 못했다')

// --- ⑤ live push 재개 확인 — 복구 후 변화가 목록에 반영되는가 ------------
const pushTriggeredAt = Date.now()
const response = await request('workspace.create')
const workspaceId = response.result?.workspace?.workspace_id
let pushSeenAt = null
const pushDeadline = Date.now() + 8000
while (Date.now() < pushDeadline) {
  const hit = app
    .entries()
    .find((entry) => entry.tag === 'push.applied' && entry.subject === workspaceId && entry.at >= pushTriggeredAt)
  if (hit) {
    pushSeenAt = hit.at
    break
  }
  await sleep(50)
}
// ⑤ 를 확인했으면 프로브가 만든 workspace 를 먼저 닫는다 — 복구 화면에 측정용 잔여물이
// 남지 않게 (판정문 M6). 목록에서 실제로 빠진 것을 확인하고 찍는다.
await request('workspace.close', { workspace_id: workspaceId }).catch(() => {})
const cleanDeadline = Date.now() + 5000
let cleaned = false
while (Date.now() < cleanDeadline) {
  const now = await app.state()
  if (!now.state.workspaces.some((row) => row.workspaceId === workspaceId)) {
    cleaned = true
    break
  }
  await sleep(100)
}
await sleep(300)
await app.shot('k6-after-recovery')
const after = await app.state()

const entries = app.entries()
const at = (predicate) => entries.find(predicate)?.at ?? null
const drop = at((entry) => entry.tag === 'link.dropped' && entry.at >= killAt)
const retries = entries.filter((entry) => entry.tag === 'link.retry.scheduled' && entry.at >= killAt)
// ② 재연결 = 소켓이 실제로 붙은 시각. `sub.tx` 는 붙은 커넥션에만 쓸 수 있으므로 그 증거다
// (`sub.conn.open` 은 connect 를 **걸기 전** 로그라 재연결 성공의 근거가 아니다 — 판정문 낮음 2).
const reconnected = at((entry) => entry.tag === 'sub.tx' && entry.at >= killAt)
const resubscribeAck = at((entry) => entry.tag === 'boot.subscribe.ack' && entry.at >= killAt)
const snapshotApplied = at((entry) => entry.tag === 'boot.snapshot.applied' && entry.at >= killAt)
const failures = entries.filter((entry) => entry.tag === 'boot.failed' && entry.at >= killAt)

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  clockDefinition: 'kill 명령을 낸 시각을 0 으로 잰다. 재기동은 stop 직후 스크립트가 건다(사람 대기 없음).',
  killCommand: { at: killAt, stdout: stop.stdout.trim(), stderr: stop.stderr.trim() },
  restartCommand: {
    at: restartAt,
    msAfterKill: restartAt - killAt,
    plannedDelayMs: RESTART_DELAY_MS,
    how: 'script -q /dev/null herdr session attach (PTY, 헤드리스)',
  },
  downtimeMs: restartAt - killAt,
  stages: {
    '1_detectedDisconnect': { at: drop, msFromKill: drop === null ? null : drop - killAt, how: 'socket EOF' },
    '2_reconnected': {
      at: reconnected,
      msFromKill: reconnected === null ? null : reconnected - killAt,
      how: 'sub.tx — 붙은 커넥션에 events.subscribe 를 쓴 시각',
    },
    '3_resubscribed': { at: resubscribeAck, msFromKill: resubscribeAck === null ? null : resubscribeAck - killAt },
    '4_snapshotReacquired': {
      at: snapshotApplied,
      msFromKill: snapshotApplied === null ? null : snapshotApplied - killAt,
    },
    '5_livePushResumed': { at: pushSeenAt, msFromKill: pushSeenAt === null ? null : pushSeenAt - killAt },
  },
  // 통과선은 ①~⑤ **전부**다. 그래서 총 복구 시간은 ⑤ 기준으로 잰다 (판정문 M1).
  totalRecoveryMs: pushSeenAt === null ? null : pushSeenAt - killAt,
  totalRecoveryBasis: '5_livePushResumed',
  snapshotPhaseLiveMs: recovered.at - killAt,
  underFifteenSeconds: pushSeenAt !== null && pushSeenAt - killAt <= 15000,
  humanIntervention: false,
  failedAttemptsWhileDown: failures.length,
  errorCodesWhileDown: [...new Set(failures.map((entry) => entry.code))],
  retryDelaysMs: retries.map((entry) => entry.delayMs),
  probeWorkspace: { workspaceId, closedBeforeShot: cleaned },
  workspacesBefore: before.state.workspaces.map((row) => row.workspaceId),
  workspacesAfter: after.state.workspaces.map((row) => row.workspaceId),
  // 주장은 여기까지다: **목록이 다시 채워졌고 빈 상태로 남지 않았다.** 재기동된 herdr 는 새 서버·
  // 새 PTY 라 pane 제목까지 같기를 요구할 수 없다 (판정문 M6).
  listRestored:
    JSON.stringify(before.state.workspaces.map((row) => row.workspaceId)) ===
    JSON.stringify(after.state.workspaces.map((row) => row.workspaceId)),
  timeline: entries
    .filter((entry) => entry.at >= killAt - 200)
    .filter((entry) =>
      ['link.dropped', 'link.phase', 'link.retry.scheduled', 'boot.failed', 'sub.tx', 'boot.subscribe.ack', 'boot.snapshot.applied', 'boot.converged', 'push.applied'].includes(
        entry.tag,
      ),
    )
    .map((entry) => ({
      ts: entry.ts,
      msFromKill: entry.at - killAt,
      tag: entry.tag,
      detail: entry.phase ?? entry.code ?? entry.event ?? entry.delayMs ?? null,
    })),
}

writeRaw('24-k6-recovery.json', result)
writeRaw(
  '24-k6-timeline.txt',
  [
    `# K6 — 서버 kill → 자동 복구 타임라인 (0 = kill 명령 시각, 세션 ${SESSION})`,
    '',
    ...result.timeline.map((entry) => `+${String(entry.msFromKill).padStart(6)}ms  ${entry.tag}  ${entry.detail ?? ''}`),
  ].join('\n') + '\n',
)
console.log(
  JSON.stringify(
    {
      stages: Object.fromEntries(Object.entries(result.stages).map(([key, value]) => [key, value.msFromKill])),
      downtimeMs: result.downtimeMs,
      totalRecoveryMs: result.totalRecoveryMs,
      underFifteenSeconds: result.underFifteenSeconds,
      retryDelaysMs: result.retryDelaysMs,
      errorCodesWhileDown: result.errorCodesWhileDown,
      listRestored: result.listRestored,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()
