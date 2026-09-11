// M7 — A5(사용자가 `exit` 를 친 경로). **통과선 없음 — 측정 자체가 항목이다.**
//
// N7 은 API 로 닫는 경로만 덮는다. 사용자가 셸을 직접 끝내면 프로세스가 **먼저** 죽으므로
// herdr 가 다른 이벤트를 보낼 수 있다 (분석 §4: `pane_exited` 가 실제로 오는 경로는 이쪽뿐이다).
//
// **1회차가 유령 행을 찾아냈다.** herdr 는 `pane_exited` 한 건만 보내고 그 시점에 이미
// `pane.list`·`tab.list` 에서 그 pane 과 탭을 뺀다. 그런데 store 는 `pane_exited` 를
// "pane 은 남는다" 로 읽고 있었다 — G1·G2 와 같은 구멍이 다른 문에 있었던 것이다.
// 측정 자체가 항목이라 판정을 바꾸지는 않지만, 찾은 구멍은 메웠다 (store.ts `pane_exited`).
// 이 파일은 그 전후를 같은 방법으로 잰다.
//
// 두 갈래를 본다: ① 셸 행에서 `exit`  ② claude 행에서 claude 를 끝내고(`/exit`) 셸에서 `exit`
// ②는 corral 이 만든 행의 현실적인 종료 경로라 같이 잰다.

import {
  alive,
  createRowByUi,
  firstWorkspaceId,
  corralIds,
  herdrTruth,
  LIFECYCLE_SUBS,
  paneProcesses,
  request,
  sleep,
  startApp,
  Sub,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

await tidySession()
const app = await startApp({ name: 'm7-exit' })
const workspaceId = await firstWorkspaceId(app)
const out = { at: new Date().toISOString(), cases: [] }

// 우리도 같은 이벤트를 듣는다 — corral 이 무엇을 받았는지 대조할 근거가 필요하다.
const sub = new Sub()
await sub.connect(LIFECYCLE_SUBS)

for (const kind of ['shell', 'claude']) {
  const before = new Set((await herdrTruth()).tabs)
  await createRowByUi(app, workspaceId, kind)
  const tabId = (
    await until(async () => (await herdrTruth()).tabs.find((id) => !before.has(id)) ?? null, { what: '새 탭', everyMs: 60 })
  ).value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null

  // 셸이 프롬프트에 오거나 에이전트가 뜰 때까지 — **관측으로** 기다린다.
  const expected = kind === 'shell' ? ['zsh', 'bash', 'sh'] : [kind]
  const up = await until(
    async () => {
      const foreground = (await paneProcesses(paneId)).foreground
      if (kind === 'shell') return foreground.length === 1 ? foreground[0] : null
      return foreground.find((item) => expected.includes((item.argv0 ?? '').replace(/^-/, ''))) ?? null
    },
    { what: `${kind} 준비`, timeoutMs: 60000, everyMs: 300 },
  )
  const processes = await paneProcesses(paneId)
  await until(async () => (await app.state()).workspaces.some((row) => row.tabs.some((tab) => tab.tabId === tabId)), {
    what: '목록 반영',
    everyMs: 40,
  })

  // ── 사용자가 직접 끝낸다 (corral UI 가 아니라 **셸에 친다**) ──────────────
  sub.drain()
  const markedAt = Date.now()
  let agentQuit = null
  if (kind === 'claude') {
    // TUI 를 먼저 빠져나온다. `/exit` → 그래도 안 되면 C-c 두 번.
    await request('pane.send_text', { pane_id: paneId, text: '/exit\n' })
    agentQuit = await until(
      async () => (await paneProcesses(paneId)).foreground.every((item) => (item.argv0 ?? '') !== 'claude'),
      { what: 'claude 종료', timeoutMs: 20000, everyMs: 300 },
    )
    if (!agentQuit.ok) {
      await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
      await sleep(500)
      await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
      agentQuit = await until(
        async () => (await paneProcesses(paneId)).foreground.every((item) => (item.argv0 ?? '') !== 'claude'),
        { what: 'claude 종료(C-c)', timeoutMs: 20000, everyMs: 300 },
      )
    }
    // **에이전트가 안 끝났으면 그 회차는 재는 것이 아니다.** 조용히 넘기면 `exit` 가 claude 의
    // 입력창으로 들어가고, 아무 일도 안 일어난 것을 "이벤트 0건" 으로 적게 된다 (1회차가 그랬다).
    if (!agentQuit.ok) throw new Error('claude 를 못 끝냈다 — A5 claude 갈래를 잴 수 없다')
    await sleep(800)
  }
  await request('pane.send_text', { pane_id: paneId, text: 'exit\n' })

  const dead = await until(() => !alive(processes.shellPid), { what: '셸 사멸', timeoutMs: 20000, everyMs: 25 })
  await sleep(2500) // 늦게 오는 이벤트까지 받는다
  const events = sub.drain()
  const [state, truth] = await Promise.all([app.state(), herdrTruth()])
  const mine = corralIds(state)

  out.cases.push({
    kind,
    tabId,
    paneId,
    shellPid: processes.shellPid,
    agentPid: kind === 'claude' ? (up.value?.pid ?? null) : null,
    에이전트종료ms: agentQuit === null ? null : agentQuit.ms,
    셸사멸ms: dead.ok ? dead.ms : null,
    셸살아있음: alive(processes.shellPid),
    /** ← A5 가 묻는 것 ①: 무엇이 오나 */
    받은이벤트: events.map((item) => ({ sinceExitMs: item.at - markedAt, event: item.event, id: item.data?.pane_id ?? item.data?.tab_id ?? item.data?.workspace_id ?? null })),
    /** ← A5 가 묻는 것 ②: 목록이 어떻게 되나 */
    corral: mine,
    herdr: truth,
    corral에탭남음: mine.tabs.includes(tabId),
    herdr에탭남음: truth.tabs.includes(tabId),
    corral에pane남음: mine.panes.includes(paneId),
    herdr에pane남음: truth.panes.includes(paneId),
    corral적용note: app
      .entries()
      .filter((entry) => entry.tag === 'push.applied' && entry.at >= markedAt)
      .map((entry) => ({ event: entry.event, changed: entry.changed, note: entry.note })),
  })
  console.log(kind, '→ 이벤트', out.cases.at(-1).받은이벤트.map((item) => item.event).join(','), '| 유령탭', out.cases.at(-1).corral에탭남음 && !out.cases.at(-1).herdr에탭남음)
  await app.shot(`a5-${kind}-after-exit`)
}

sub.close()
out.결론 = out.cases.map((item) => ({
  kind: item.kind,
  이벤트: [...new Set(item.받은이벤트.map((event) => event.event))],
  유령행: item.corral에탭남음 && !item.herdr에탭남음,
  양쪽에남음: item.corral에탭남음 && item.herdr에탭남음,
}))
console.log(JSON.stringify(out.결론, null, 2))

writeRaw('a5-user-exit.json', out)
await app.stop()
await tidySession()
