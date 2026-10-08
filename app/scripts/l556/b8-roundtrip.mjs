// LIFE-556 B8 왕복 (fix1 M1) — 최종 관문 드라이버와 격리 설치본 드라이버가 함께 쓰는 한 단계.
//
// 설치본 runtime 이 만든 본문으로 dispatch 1건 → pane 안의 fixture 워커가 그 본문에 적힌 명령으로 `worker_done` →
// sender 검사 통과(응답 `sessionVerified`) → attempt `completed` → GUI 계보(`orchestrationLineage`)에 그 워커가 나온다.
// 워커 에이전트는 shell fixture(`fixture/claude.c` + `report.py`)다 — 실제 provider 를 띄우지 않는다.
// 판정은 던지기(assert)로 한다. 호출자가 잡아 종료코드로 낸다.
//
// 입력: cli(args) → 응답 JSON(실패면 던짐) · state() → GUI 상태 · repo · fixtureOut(본문·보고 파일 경로) ·
//       expectCli(본문 안 CLI 경로가 이것으로 시작해야 한다 — B8 의 shim 절대경로) · until · scrub · record
import assert from 'node:assert/strict'
import fs from 'node:fs'

export async function b8RoundTrip({ cli, state, repo, fixtureOut, expectCli, until, scrub, record }) {
  const out = {}
  record.b8 = out
  cli(['orchestration', 'run-create', '--objective', 'LIFE-556 B8 round trip'])
  const task = cli(['orchestration', 'task-create', '--spec', 'fixture: report worker_done from the pane', '--title', 'l556-b8']).result.task.id
  const started = cli(['orchestration', 'worker-start', '--task', task, '--agent', 'claude', '--worktree', repo, '--timeout-ms', '90000'], { timeout: 120000 })
  out.workerStart = { state: started.result.state ?? null, stage: started.result.stage ?? null, stages: started.result.stages ?? null }
  const dispatchId = started.result.dispatchId
  assert.ok(dispatchId, 'worker-start gave no dispatchId')
  assert.equal(started.result.state, 'ready', `worker-start did not deliver: ${JSON.stringify(out.workerStart)}`)
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
