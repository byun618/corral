// M2 — N3(생성 직후 레이스를 삼키지 않는다) · N5(종료: 프로세스가 진짜 죽는다) · A2(반영 지연)
//
// 한 회차 = 만들기 → 관측 → PID 기록 → 종료 → **OS 로** 사멸 확인. 20회 연속.
// N3 의 20/20 과 N5 의 10회 이상이 같은 회차에서 나온다 — 같은 행을 두 번 세지 않기 위해서다.
//
// 만드는 것은 **claude 행**이다. 셸 행은 `agent.start` 를 아예 안 부르므로 레이스가 없고,
// 그러면 N3 이 묻는 것을 측정하지 못한다.
//
// 관문 ⑤ — 사멸은 `kill(pid,0)` 로만 확인한다. herdr 의 `{type:'ok'}` 는 근거가 아니다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  alive,
  clickWhenVisible,
  createRowByUi,
  firstWorkspaceId,
  herdrTruth,
  paneProcesses,
  pct,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

const ROUNDS = Number(process.env.L346_ROUNDS ?? 20)
const KIND = 'claude'
/** 두 번째 팔 — 셸을 진짜로 느리게 만들어 레이스를 **일부러** 일으킨다 (lib 의 SLOW_ZDOTDIR). */
const FORCED = Number(process.env.L346_FORCED ?? 5)

const all = { at: new Date().toISOString(), arms: [] }
for (const arm of [
  { name: 'natural', rounds: ROUNDS, env: {} },
  { name: 'forced-race', rounds: FORCED, env: { CORRAL_INJECT_ZDOTDIR: slowZdotdir() } },
]) {
  all.arms.push(await runArm(arm))
}

async function runArm({ name, rounds: count, env }) {
  await tidySession()
  const app = await startApp({ name: `m2-${name}`, env })
  const workspaceId = await firstWorkspaceId(app)
  const rounds = []

  for (let round = 1; round <= count; round++) {
    const beforeHerdr = new Set((await herdrTruth()).tabs)
    const beforeCorral = new Set((await app.state()).workspaces.flatMap((row) => row.tabs.map((tab) => tab.tabId)))
    const clickedAt = Date.now()
    await createRowByUi(app, workspaceId, KIND)

    // A2 ① — **누른 시각부터** 목록에 나타나기까지. 두 관측을 나란히 돌린다 — herdr 쪽을
    // 먼저 기다린 뒤에 corral 을 재면 0ms 가 나오고, 그건 지연이 아니라 측정 순서다.
    const [grew, listed] = await Promise.all([
      until(async () => (await herdrTruth()).tabs.find((tabId) => !beforeHerdr.has(tabId)) ?? null, {
        what: '새 탭',
        timeoutMs: 20000,
        everyMs: 60,
      }),
      until(
        async () =>
          (await app.state()).workspaces
            .flatMap((row) => row.tabs.map((tab) => tab.tabId))
            .find((tabId) => !beforeCorral.has(tabId)) ?? null,
        { what: '목록 반영', timeoutMs: 20000, everyMs: 40 },
      ),
    ])
    const tabId = grew.value
    const paneId =
      tabId === null ? null : ((await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null)

    // ── N3 — 요청한 커맨드가 **결국 떴나**. 판정은 우리가 뜨는 포그라운드다 ────────────
    const launched = await until(
      async () => {
        const processes = await paneProcesses(paneId)
        return processes.foreground.find((item) => (item.argv0 ?? '').replace(/^-/, '') === KIND) ?? null
      },
      { what: `${KIND} 기동`, timeoutMs: 60000, everyMs: 300 },
    )

    // 앱이 이 회차에 레이스를 몇 번 받아 냈나 — 로그에서 그대로 읽는다 (삼키지 않았다는 증거).
    const attempts = app
      .entries()
      .filter((entry) => entry.tag === 'life.agent.start.attempt' && entry.paneId === paneId)
      .map((entry) => ({ attempt: entry.attempt, code: entry.code, ms: entry.ms }))
    const appPhase = (await app.state()).lifecycle.launches.find((item) => item.paneId === paneId)?.phase ?? 'turned'

    // ── N5 — 종료 전에 PID 두 개를 찍는다 ─────────────────────────────────────
    const beforeClose = await paneProcesses(paneId)
    const agentPid = launched.value?.pid ?? null
    const shellPid = beforeClose.shellPid

    await clickWhenVisible(app, `[data-close-tab="${tabId}"]`)
    // 에이전트가 도는 행이라 확인 모달이 뜬다 (N6). 여기서는 그 문을 통과하는 것이 목적이다.
    await clickWhenVisible(app, '[data-confirm="close"]')
    const closeAskedAt = Date.now()

    // **사멸은 OS 에게 묻는다** (관문 ⑤). A2 ② 와 나란히 재서 순서가 값을 만들지 않게 한다.
    const [dead, delisted] = await Promise.all([
      until(() => !alive(shellPid) && !alive(agentPid), { what: 'PID 사멸', timeoutMs: 20000, everyMs: 25 }),
      until(
        async () => !(await app.state()).workspaces.some((row) => row.tabs.some((tab) => tab.tabId === tabId)),
        { what: '목록에서 사라짐', timeoutMs: 20000, everyMs: 40 },
      ),
    ])

    rounds.push({
      round,
      tabId,
      paneId,
      createClickedAt: clickedAt,
      tabAppearedMs: grew.ms,
      listedMs: listed.ms,
      launchedMs: launched.ok ? launched.ms : null,
      launched: launched.ok,
      launchedCmdline: launched.value?.cmdline ?? null,
      /** N3 의 핵심 — `agent_pane_busy` 로 튕긴 횟수와 각 시도의 코드 */
      startAttempts: attempts,
      busyRetries: attempts.filter((item) => item.code === 'agent_pane_busy').length,
      appPhaseAtEnd: appPhase,
      shellPid,
      agentPid,
      closeAskedAt,
      /** N5 의 핵심 — 두 PID 가 실제로 죽기까지 */
      deathMs: dead.ok ? dead.ms : null,
      shellAliveAfter: alive(shellPid),
      agentAliveAfter: alive(agentPid),
      delistedMs: delisted.ms,
    })
    console.log(
      `#${round} 기동 ${launched.ok ? launched.ms + 'ms' : 'MISS'} · busy ${rounds.at(-1).busyRetries} · 사멸 ${dead.ok ? dead.ms + 'ms' : 'MISS'}`,
    )
    await sleep(200)
  }

  const ok = rounds.filter((item) => item.launched)
  const killed = rounds.filter((item) => item.shellAliveAfter === false && item.agentAliveAfter === false)
  const summary = {
    arm: name,
    rounds: rounds.length,
    n3: {
      통과선: '요청한 커맨드가 결국 뜬 비율 = 전부',
      뜬회차: ok.length,
      busy로튕긴회차: rounds.filter((item) => item.busyRetries > 0).length,
      busy재시도총합: rounds.reduce((sum, item) => sum + item.busyRetries, 0),
      기동시간ms: { p50: pct(ok.map((item) => item.launchedMs), 50), p95: pct(ok.map((item) => item.launchedMs), 95) },
    },
    n5: {
      통과선: '전 회차 셸 PID·에이전트 PID 둘 다 사망',
      두PID사망회차: killed.length,
      살아남은PID: rounds
        .filter((item) => item.shellAliveAfter || item.agentAliveAfter)
        .map((item) => ({ round: item.round, shell: item.shellPid, agent: item.agentPid })),
      사멸까지ms: {
        p50: pct(killed.map((item) => item.deathMs), 50),
        p95: pct(killed.map((item) => item.deathMs), 95),
        max: killed.length === 0 ? null : Math.max(...killed.map((item) => item.deathMs)),
      },
    },
    a2: {
      생성_목록반영ms: {
        p50: pct(rounds.map((item) => item.listedMs), 50),
        p95: pct(rounds.map((item) => item.listedMs), 95),
      },
      종료_목록제거ms: {
        p50: pct(rounds.map((item) => item.delistedMs), 50),
        p95: pct(rounds.map((item) => item.delistedMs), 95),
      },
    },
  }
  console.log(JSON.stringify(summary, null, 2))
  await app.stop()
  await tidySession()
  return { summary, rounds }
}

/** `sleep` 이 든 `.zshrc` 를 스크래치에 깔고 그 폴더를 돌려준다. 저장소에는 안 들어간다. */
function slowZdotdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l346-slowshell-'))
  fs.writeFileSync(
    path.join(dir, '.zshrc'),
    '# LIFE-346 N3 재현용 — 셸이 프롬프트에 늦게 오게 만든다 (agent_pane_busy 를 실제로 일으킨다)\nsleep 3\n',
  )
  return dir
}

writeRaw('n3-n5-rounds.json', all)
