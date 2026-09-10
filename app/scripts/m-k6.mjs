// K6 — A5 재현. 격리 세션 서버를 죽였다 살렸을 때 앱이 사람 개입 없이 5단계를 해내는가.
//   ① 끊김 감지 ② 재연결 ③ 재구독 ④ 스냅샷 재획득 ⑤ live push 재개
//
// 시계 정의: **kill 명령을 낸 시각이 0** 이고, 재기동은 stop 이 끝나자마자 스크립트가 건다
// (스파이크 A5 와 같은 정의 — 사람이 손으로 늦게 켜는 시간은 앱의 복구 시간이 아니다).
//
// 격리: 대상은 life344-* 세션뿐이다. socketPath() 가 코드 레벨에서 default 를 거부한다.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION, request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
socketPath() // 격리 가드

await tidySession()
const app = await startApp({ name: 'k6' })
await sleep(500)
await app.shot('k6-before-kill')
const before = await app.state()

// --- 서버를 죽인다 (정상 종료 경로) --------------------------------------
const killAt = Date.now()
const stop = await run('herdr', ['session', 'stop', SESSION])

// --- 곧바로 재기동을 건다 -----------------------------------------------
// herdr 는 스스로 뜨지 않는다. `herdr session attach` 는 TTY 를 요구하는데, Orca 탭 대신
// `script(1)` 로 PTY 만 붙여 주면 **헤드리스로 0.2초 만에** 뜬다 (킥오프의 "헤드리스 자동
// 기동이 안 된다"는 전제를 정정한다 — 안 되는 건 TTY 없는 기동이지 헤드리스가 아니다).
// Orca 탭 경로는 같은 조건에서 63초가 걸렸다 (raw/claude/25-restart-paths.json).
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
await sleep(400)
await app.shot('k6-after-recovery')
const after = await app.state()
await request('workspace.close', { workspace_id: workspaceId }).catch(() => {})

const entries = app.entries()
const at = (predicate) => entries.find(predicate)?.at ?? null
const drop = at((entry) => entry.tag === 'link.dropped' && entry.at >= killAt)
const retries = entries.filter((entry) => entry.tag === 'link.retry.scheduled' && entry.at >= killAt)
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
    how: 'script -q /dev/null herdr session attach (PTY, 헤드리스)',
  },
  stages: {
    '1_detectedDisconnect': { at: drop, msFromKill: drop === null ? null : drop - killAt, how: 'socket EOF' },
    '2_reconnected': { at: resubscribeAck, msFromKill: resubscribeAck === null ? null : resubscribeAck - killAt },
    '3_resubscribed': { at: resubscribeAck, msFromKill: resubscribeAck === null ? null : resubscribeAck - killAt },
    '4_snapshotReacquired': {
      at: snapshotApplied,
      msFromKill: snapshotApplied === null ? null : snapshotApplied - killAt,
    },
    '5_livePushResumed': { at: pushSeenAt, msFromKill: pushSeenAt === null ? null : pushSeenAt - killAt },
  },
  totalRecoveryMs: recovered.at - killAt,
  underFifteenSeconds: recovered.at - killAt <= 15000,
  humanIntervention: false,
  failedAttemptsWhileDown: failures.length,
  errorCodesWhileDown: [...new Set(failures.map((entry) => entry.code))],
  retryDelaysMs: retries.map((entry) => entry.delayMs),
  workspacesBefore: before.state.workspaces.map((row) => row.workspaceId),
  workspacesAfter: after.state.workspaces.map((row) => row.workspaceId),
  listRestored: JSON.stringify(before.state.workspaces.map((row) => row.workspaceId)) ===
    JSON.stringify(after.state.workspaces.filter((row) => row.workspaceId !== workspaceId).map((row) => row.workspaceId)),
  timeline: entries
    .filter((entry) => entry.at >= killAt - 200)
    .filter((entry) =>
      ['link.dropped', 'link.phase', 'link.retry.scheduled', 'boot.failed', 'boot.subscribe.ack', 'boot.snapshot.applied', 'boot.converged', 'push.applied'].includes(
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
