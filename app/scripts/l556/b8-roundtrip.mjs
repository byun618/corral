// LIFE-556 B8 왕복 (fix1 M1) — 최종 관문 드라이버와 격리 설치본 드라이버가 함께 쓰는 한 단계.
//
// 설치본 runtime 이 만든 본문으로 dispatch 1건 → pane 안의 fixture 워커가 그 본문에 적힌 명령으로 `worker_done` →
// sender 검사 통과(응답 `sessionVerified`) → attempt `completed` → GUI 계보(`orchestrationLineage`)에 그 워커가 나온다.
// 워커 에이전트는 shell fixture(`fixture/claude.c` + `report.py`)다 — 실제 provider 를 띄우지 않는다.
// 판정은 던지기(assert)로 한다. 호출자가 잡아 종료코드로 낸다.
//
// 입력: cli(args) → 응답 JSON(실패면 던짐) · state() → GUI 상태 · repo · fixtureOut(본문·보고 파일 경로) ·
//       expectCli(본문 안 CLI 경로가 이것으로 시작해야 한다 — B8 의 shim 절대경로) · until · scrub · record
//       cliRaw(args, extraEnv) → { exit, body } (판정 없음) · foreignSocket(다른 herdr 서버의 소켓 — fix2 M1 음성)
//
// fix2 M1 음성: fixture 가 보고하기 전에, 워커 pane 과 **같은 pane id**·이름 없음·**다른 herdr 서버 소켓**의 pane env 로
// 같은 `worker_done` 을 친다 → `sender_mismatch` 이고 시도는 그대로여야 한다. 그 뒤 진짜 pane 의 보고(양성)가 통과해야 한다.
// corral CLI 가 호출자 pane 으로 읽는 것은 env(`HERDR_PANE_ID`·`HERDR_SESSION`·`HERDR_SOCKET_PATH`)뿐이라, 그 env 를 그대로 준다.
import assert from 'node:assert/strict'
import fs from 'node:fs'

export async function b8RoundTrip({ cli, cliRaw, state, repo, fixtureOut, foreignSocket, expectCli, until, scrub, record }) {
  const out = {}
  record.b8 = out
  cli(['orchestration', 'run-create', '--objective', 'LIFE-556 B8 round trip'])
  const task = cli(['orchestration', 'task-create', '--spec', 'fixture: report worker_done from the pane', '--title', 'l556-b8']).result.task.id
  const started = cli(['orchestration', 'worker-start', '--task', task, '--agent', 'claude', '--worktree', repo, '--timeout-ms', '90000'], { timeout: 120000 })
  out.workerStart = { state: started.result.state ?? null, stage: started.result.stage ?? null, stages: started.result.stages ?? null }
  const dispatchId = started.result.dispatchId
  assert.ok(dispatchId, 'worker-start gave no dispatchId')
  assert.equal(started.result.state, 'ready', `worker-start did not deliver: ${JSON.stringify(out.workerStart)}`)
  // fix2 M1 음성 — fixture 보고(지연 L556_FIXTURE_REPORT_DELAY) 전에 친다.
  const handle = started.result.stages?.terminal?.handle ?? ''
  const paneId = JSON.parse(Buffer.from(handle.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}').paneId
  assert.ok(paneId, 'worker pane id unknown')
  const reportedEarly = () => fs.existsSync(`${fixtureOut}.report`) && /EXIT \d+/.test(fs.readFileSync(`${fixtureOut}.report`, 'utf8'))
  assert.ok(!reportedEarly(), 'fixture reported before the negative could run')
  const foreign = cliRaw(['orchestration', 'send', '--type', 'worker_done', '--subject', 'foreign', '--body', 'negative: same pane id, another herdr server',
    '--task-id', task, '--dispatch-id', dispatchId, '--outcome', 'succeeded'], { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: foreignSocket })
  const afterForeign = cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
  out.foreign = { paneId, exit: foreign.exit, code: foreign.body?.error?.code ?? null, dispatchStatusAfter: afterForeign.result?.dispatch?.status ?? afterForeign.result?.status ?? null, reportedBefore: reportedEarly() }
  assert.notEqual(foreign.exit, 0, 'a report from another herdr server was accepted')
  assert.equal(out.foreign.code, 'sender_mismatch', 'foreign-socket report was not sender_mismatch')
  // fix2 M2 — 진행 중에도 GUI 는 default 그대로다(다른 세션이 돌고 있다).
  out.selectedDuring = (await state()).selectedSession
  assert.equal(out.selectedDuring, 'default', 'GUI left default while the worker was running')
  // 본문은 fixture 가 pane 안에서 받은 바이트 그대로다 — 설치본 runtime 이 만든 것.
  const report = await until(() => fs.existsSync(`${fixtureOut}.report`) && /EXIT \d+/.test(fs.readFileSync(`${fixtureOut}.report`, 'utf8')) ? fs.readFileSync(`${fixtureOut}.report`, 'utf8') : null, 'fixture report', 60000)
  const body = fs.readFileSync(fixtureOut, 'utf8')
  const cmdLine = /^CORRAL_CMD (.*)$/m.exec(report)?.[1] ?? ''
  out.preambleCli = scrub(cmdLine)
  out.bodyHasTask = body.includes('=== TASK ===') && body.includes(dispatchId)
  out.reportExit = Number(/EXIT (\d+)/.exec(report)?.[1] ?? -1)
  out.report = scrub(report).slice(0, 3000)
  assert.ok(cmdLine.replace(/^'|'$/g, '').startsWith(expectCli) || cmdLine.startsWith(`'${expectCli}'`), `preamble CLI is not the shim: ${scrub(cmdLine)}`)
  assert.ok(out.bodyHasTask, 'body lacks TASK block or dispatch id')
  assert.equal(out.reportExit, 0, 'worker_done from the pane failed')
  const reply = JSON.parse(report.slice(report.indexOf('{'), report.lastIndexOf('}') + 1))
  out.sessionVerified = reply.result?.sessionVerified ?? reply.result?.dispatch?.sessionVerified ?? null
  out.dispatchStatus = reply.result?.dispatch?.status ?? null
  assert.equal(out.dispatchStatus, 'completed', 'attempt did not settle')
  assert.equal(out.sessionVerified, true, 'default-session report was not session-verified (H1)')
  // 계보 — GUI 가 이 runtime 의 문서와 같은 backend 를 보고 그 워커를 표시하는가.
  const lineage = await until(async () => {
    const seen = (await state()).orchestrationLineage
    return seen.state === 'ready' && seen.entries.some(entry => entry.dispatchId === dispatchId) ? seen : null
  }, 'lineage shows the worker', 20000).catch(async error => { out.lineageObserved = (await state()).orchestrationLineage; throw error })
  out.lineage = lineage.entries.filter(entry => entry.dispatchId === dispatchId)
  // 정리 — 끝난 attempt 의 pane 을 돌려받는다.
  const released = cli(['orchestration', 'worker-release', '--dispatch', dispatchId])
  out.release = released.result?.release ?? released.result ?? null
  return out
}
