// 세션 전환 일관성 — 헤더·선택이 가리키는 세션과 화면의 트리가 같은 세션인가.
//
// 사용자가 실행 중인 앱에서 발견한 증상: 헤더가 `live @default` 이고 default 행이 선택돼 있는데
// 트리에는 life344-probe 의 workspace 가 떠 있었다. Step 2 ② 에서 치명적이다 — 화면은 A 세션인데
// 입력이 B 세션 pane 으로 들어간다.
//
// 여기서는 전환 순간을 20ms 간격으로 훑어 **어긋난 상태가 실제로 존재하는지** 잰다.
// 판정 기준은 하나다: `selectedSession` 이 가리키는 세션의 workspace 가 아닌 것이 목록에 있으면
// 그 순간은 어긋난 것이다.

import { request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'
import net from 'node:net'

const PROBE = 'life344-probe'
socketPath(PROBE) // 격리 가드 — 쓰기는 probe 에만 한다

// --- 두 세션의 실제 workspace id 를 미리 알아 둔다 (default 는 읽기만) ---
await tidySession()
const madeInProbe = []
for (let i = 0; i < 3; i++) {
  const created = await request('workspace.create')
  madeInProbe.push(created.result?.workspace?.workspace_id)
}
const probeIds = (await request('session.snapshot')).result.snapshot.workspaces.map((w) => w.workspace_id)
const defaultIds = (await snapshotDefault()).snapshot.workspaces.map((w) => w.workspace_id)

// 첫 부트스트랩만 3초 느리게 한다 — "먼저 나간 시도가 뒤늦게 돌아오는" 상황을 만들기 위해서다.
// 실제 사용자 환경에서는 느린 서버·재기동 중인 세션이 같은 역할을 한다.
const SLOW_MS = 3000
const app = await startApp({
  name: 'switch',
  env: { CORRAL_SESSION: PROBE, CORRAL_INJECT_BOOT_DELAY_MS: String(SLOW_MS) },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'boot.injected_delay'),
})

// --- 1막: 느린 부트스트랩이 도는 중에 default 로 바꾼다 --------------------
const slowAt = Date.now()
const slowSwitch = app.selectSession('default')
const slowSamples = []
while (Date.now() - slowAt < SLOW_MS + 3000) {
  const now = await app.state()
  slowSamples.push({
    msAfterSwitch: Date.now() - slowAt,
    selectedSession: now.state.selectedSession,
    linkSession: now.state.link.sessionName,
    phase: now.state.link.phase,
    selectedPaneId: now.state.selectedPaneId,
    panes: now.state.workspaces.flatMap((row) => row.panes.map((pane) => pane.paneId)),
    workspaces: now.state.workspaces.map((row) => row.workspaceId),
    labels: now.state.workspaces.map((row) => row.label),
  })
  await sleep(25)
}
await slowSwitch
await app.shot('switch-0-slow-stale')
const afterSlow = await app.state()
const slowWrong = afterSlow.state.workspaces.filter((row) => !defaultIds.includes(row.workspaceId))
const slowMismatched = slowSamples.filter(
  (sample) => sample.selectedSession === 'default' && sample.workspaces.some((id) => !defaultIds.includes(id)),
)

await app.selectSession(PROBE)
await sleep(800)
await sleep(600)
await app.shot('switch-1-probe')
const onProbe = await app.state()

// --- default 로 전환하고 그 순간을 훑는다 --------------------------------
const switchedAt = Date.now()
const selectPromise = app.selectSession('default')
const samples = []
const deadline = Date.now() + 6000
while (Date.now() < deadline) {
  const now = await app.state()
  samples.push({
    msAfterSwitch: Date.now() - switchedAt,
    selectedSession: now.state.selectedSession,
    linkSession: now.state.link.sessionName,
    phase: now.state.link.phase,
    selectedPaneId: now.state.selectedPaneId,
    panes: now.state.workspaces.flatMap((row) => row.panes.map((pane) => pane.paneId)),
    workspaces: now.state.workspaces.map((row) => row.workspaceId),
    labels: now.state.workspaces.map((row) => row.label),
  })
  if (now.state.link.phase === 'live' && now.state.link.sessionName === 'default' && Date.now() - switchedAt > 1500) break
  await sleep(20)
}
await selectPromise
await sleep(400)
await app.shot('switch-2-default')
const onDefault = await app.state()

// 어긋남 = 선택한 세션이 default 인데 목록에 default 것이 아닌 workspace 가 섞인 순간.
const mismatched = samples.filter(
  (sample) =>
    sample.selectedSession === 'default' && sample.workspaces.some((id) => !defaultIds.includes(id)),
)
// 헤더(link.sessionName)와 선택(selectedSession)이 다른 순간.
const headerLag = samples.filter((sample) => sample.selectedSession !== sample.linkSession)

// --- 2막: 부트스트랩이 **도는 중에** 다시 바꾼다 ---------------------------
// 전환은 비동기다 (구독 → ack → 스냅샷). 그 사이에 또 바꾸면 먼저 나간 시도가 뒤늦게 돌아와
// **옛 세션의 스냅샷을 새 세션의 화면에** 부을 수 있다. 사용자가 본 증상이 이 모양이다.
await app.selectSession(PROBE)
await sleep(1200)
const raceAt = Date.now()
// 기다리지 않고 연달아 던진다 — 두 번째가 첫 번째의 부트스트랩 도중에 들어가게.
const first = app.selectSession('default')
await sleep(40)
const second = app.selectSession(PROBE)
await sleep(40)
const third = app.selectSession('default')
const raceSamples = []
const raceDeadline = Date.now() + 8000
while (Date.now() < raceDeadline) {
  const now = await app.state()
  raceSamples.push({
    msAfterRace: Date.now() - raceAt,
    selectedSession: now.state.selectedSession,
    linkSession: now.state.link.sessionName,
    phase: now.state.link.phase,
    selectedPaneId: now.state.selectedPaneId,
    panes: now.state.workspaces.flatMap((row) => row.panes.map((pane) => pane.paneId)),
    workspaces: now.state.workspaces.map((row) => row.workspaceId),
    labels: now.state.workspaces.map((row) => row.label),
  })
  await sleep(20)
}
await Promise.allSettled([first, second, third])
await app.shot('switch-3-after-race')
const afterRace = await app.state()
// 마지막 선택은 default 다. default 것이 아닌 workspace 가 목록에 있으면 어긋난 것이다.
const raceMismatched = raceSamples.filter(
  (sample) => sample.selectedSession === 'default' && sample.workspaces.some((id) => !defaultIds.includes(id)),
)
const settledWrong = afterRace.state.workspaces.filter((row) => !defaultIds.includes(row.workspaceId))

// L4 연계 — 선택된 pane 이 **목록에 없는 pane** 을 가리킨 순간이 있는가.
// 있으면 Step 2 ② 에서 화면에 없는 pane 으로 입력이 들어간다.
const allSamples = [...slowSamples, ...samples, ...raceSamples]
const danglingSelection = allSamples.filter(
  (sample) => sample.selectedPaneId !== null && !sample.panes.includes(sample.selectedPaneId),
)

const result = {
  measuredAt: new Date().toISOString(),
  question: '세션을 바꾸는 동안 헤더·선택이 가리키는 세션과 목록의 세션이 어긋나는가',
  probeSession: PROBE,
  probeWorkspaceIds: probeIds,
  defaultWorkspaceIds: defaultIds,
  before: { selected: onProbe.state.selectedSession, workspaces: onProbe.state.workspaces.map((r) => r.workspaceId) },
  after: { selected: onDefault.state.selectedSession, workspaces: onDefault.state.workspaces.map((r) => r.workspaceId) },
  samples: samples.length,
  mismatched: {
    count: mismatched.length,
    maxMsAfterSwitch: mismatched.reduce((max, item) => Math.max(max, item.msAfterSwitch), 0),
    first: mismatched.slice(0, 5),
  },
  headerLag: { count: headerLag.length, first: headerLag.slice(0, 5) },
  conclusion:
    mismatched.length === 0
      ? '어긋나는 순간이 없었다 — 선택을 바꾸면 목록이 그 즉시 그 세션 것만 보인다.'
      : `어긋난 순간이 ${mismatched.length}회 있었다 (최대 ${mismatched.reduce((m, i) => Math.max(m, i.msAfterSwitch), 0)}ms). ` +
        '선택은 새 세션인데 목록은 옛 세션 것이다.',
  timeline: samples.filter((sample, index) => index % 5 === 0 || sample.selectedSession !== sample.linkSession).slice(0, 60),
  selection: {
    question: '전환 중에 선택된 pane 이 목록에 없는 것을 가리킨 순간이 있는가 (L4)',
    samplesChecked: allSamples.length,
    danglingCount: danglingSelection.length,
    first: danglingSelection.slice(0, 5),
    note: 'pickSession 이 전환 때 선택을 비우고, currentState() 가 목록에 없는 선택을 지운다.',
  },
  slowStale: {
    what: `첫 부트스트랩을 ${SLOW_MS}ms 느리게 만들고, 그 도중에 default 로 바꾼다.`,
    samples: slowSamples.length,
    mismatched: {
      count: slowMismatched.length,
      maxMsAfterSwitch: slowMismatched.reduce((max, item) => Math.max(max, item.msAfterSwitch), 0),
      first: slowMismatched.slice(0, 5),
    },
    settled: {
      selected: afterSlow.state.selectedSession,
      linkSession: afterSlow.state.link.sessionName,
      phase: afterSlow.state.link.phase,
      labels: afterSlow.state.workspaces.map((row) => row.label),
      notFromSelectedSession: slowWrong.map((row) => `${row.workspaceId}:${row.label}`),
    },
    conclusion:
      slowWrong.length > 0
        ? '**재현됐다.** 헤더·선택은 default 인데 목록은 옛 세션 것이다 — 먼저 나간 시도가 뒤늦게 ' +
          '돌아와 새 세션의 저장소에 옛 세션 스냅샷을 부었다. 사용자가 본 화면이 이것이다.'
        : '느린 부트스트랩 도중에 바꿔도 어긋나지 않았다.',
    timeline: slowSamples.filter((sample, index) => index % 4 === 0).slice(0, 80),
  },
  race: {
    what: '부트스트랩 도중(40ms 간격)에 세션을 세 번 연달아 바꾼다. 마지막 선택은 default.',
    samples: raceSamples.length,
    mismatched: {
      count: raceMismatched.length,
      maxMsAfterRace: raceMismatched.reduce((max, item) => Math.max(max, item.msAfterRace), 0),
      first: raceMismatched.slice(0, 5),
    },
    settled: {
      selected: afterRace.state.selectedSession,
      linkSession: afterRace.state.link.sessionName,
      phase: afterRace.state.link.phase,
      workspaces: afterRace.state.workspaces.map((row) => row.workspaceId),
      labels: afterRace.state.workspaces.map((row) => row.label),
      notFromSelectedSession: settledWrong.map((row) => `${row.workspaceId}:${row.label}`),
    },
    conclusion:
      settledWrong.length > 0
        ? '**가라앉은 뒤에도 어긋나 있다.** 헤더·선택은 default 인데 목록은 다른 세션 것이다 — ' +
          '먼저 나간 시도가 뒤늦게 돌아와 새 세션의 저장소에 옛 세션 스냅샷을 부었다.'
        : raceMismatched.length > 0
          ? `전환 도중 ${raceMismatched.length}회 어긋났지만 가라앉은 뒤에는 맞았다 (최대 ${raceMismatched.reduce((m, i) => Math.max(m, i.msAfterRace), 0)}ms).`
          : '연달아 바꿔도 어긋나는 순간이 없었다.',
    timeline: raceSamples.filter((sample, index) => index % 4 === 0).slice(0, 80),
  },
}

writeRaw('33-session-switch.json', result)
console.log(
  JSON.stringify(
    {
      danglingSelection: danglingSelection.length,
      slowStaleMismatched: slowMismatched.length,
      slowStaleSettledWrong: slowWrong.length,
      slowStaleLabels: afterSlow.state.workspaces.map((row) => row.label),
      mismatchedDuringClean: mismatched.length,
      mismatchedDuringRace: raceMismatched.length,
      settledWrong: settledWrong.length,
      settledLabels: result.race.settled.labels,
      raceConclusion: result.race.conclusion,
    },
    null,
    2,
  ),
)
await app.stop()
for (const id of madeInProbe) await request('workspace.close', { workspace_id: id }).catch(() => {})
await tidySession()

/** 사용자의 default 세션 — **읽기 한 번**. 앱과 같은 메서드만 쓴다. */
function snapshotDefault() {
  const target = `${process.env.HOME}/.config/herdr/herdr.sock`
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'r1', method: 'session.snapshot', params: {} }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      const line = buffer.slice(0, index)
      socket.end()
      socket.destroy()
      resolve(JSON.parse(line).result)
    })
  })
}
