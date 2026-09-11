// M10 — 1차 리뷰 M3(grok M1): **마지막 탭의 마지막 pane 을 사용자가 `exit` 로 끝내는 문.**
//
// N7 ⓒ 는 `tab.close` 로 마지막 탭을 닫는 경로만 쟀고, A5 는 **다른 탭이 남아 있는** workspace
// 에서만 쟀다. 그 사이에 안 닫힌 문이 하나 있다: workspace 에 탭이 하나뿐인데 그 탭의 pane 에
// 사용자가 `exit` 를 치면? G2 는 "마지막 pane 이면 탭도 지운다" 까지만 하고 workspace 는
// `workspace_closed` 가 지운다. 그 이벤트가 이 경로에서 안 오면 corral 에만 남는 유령
// workspace 행이 된다.
//
// **재는 것이 먼저다** (verdict §5-4). herdr 가 `workspace_closed` 를 내면 코드 변경 없음,
// 안 내면 G2 가 workspace 까지 지워야 한다. 어느 쪽이든 이 파일이 근거다.

import {
  alive,
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
const app = await startApp({ name: 'm10-lasttab' })

// 이 workspace 에 탭이 **하나뿐**이어야 한다 — 그게 이 측정의 전제다.
const tabs = (await request('tab.list', {})).tabs
if (tabs.length !== 1) throw new Error(`탭이 ${tabs.length}개다 — 마지막 탭 경로를 잴 수 없다`)
const tabId = tabs[0].tab_id
const workspaceId = tabs[0].workspace_id
const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
const processes = await paneProcesses(paneId)

// corral 이 그 workspace 를 들고 있는 상태에서 시작한다.
await until(async () => corralIds(await app.state()).workspaces.includes(workspaceId), { what: '목록 반영', everyMs: 60 })
await app.shot('m3-before-exit')

const sub = new Sub()
await sub.connect(LIFECYCLE_SUBS)
sub.drain()

const markedAt = Date.now()
await request('pane.send_text', { pane_id: paneId, text: 'exit\n' })
const dead = await until(() => !alive(processes.shellPid), { what: '셸 사멸', timeoutMs: 20000, everyMs: 25 })
await sleep(3000) // 늦게 오는 workspace_closed 까지 받는다
const events = sub.drain()
sub.close()

const [state, truth] = await Promise.all([app.state(), herdrTruth()])
const mine = corralIds(state)
await app.shot('m3-after-exit')

const out = {
  at: new Date().toISOString(),
  질문: '마지막 탭의 마지막 pane 을 exit 로 끝내면 herdr 는 workspace_closed 를 내는가',
  workspaceId,
  tabId,
  paneId,
  shellPid: processes.shellPid,
  셸사멸ms: dead.ok ? dead.ms : null,
  받은이벤트: events.map((item) => ({
    sinceExitMs: item.at - markedAt,
    event: item.event,
    id: item.data?.pane_id ?? item.data?.tab_id ?? item.data?.workspace_id ?? null,
  })),
  herdr: truth,
  corral: mine,
  herdr에workspace남음: truth.workspaces.includes(workspaceId),
  corral에workspace남음: mine.workspaces.includes(workspaceId),
  corral에탭남음: mine.tabs.includes(tabId),
  corral적용note: app
    .entries()
    .filter((entry) => entry.tag === 'push.applied' && entry.at >= markedAt)
    .map((entry) => ({ event: entry.event, changed: entry.changed, note: entry.note })),
}
out.판정 = {
  'workspace_closed 왔나': out.받은이벤트.some((item) => item.event === 'workspace_closed'),
  '유령 workspace 행': out.corral에workspace남음 && !out.herdr에workspace남음,
  '유령 탭 행': out.corral에탭남음 && !truth.tabs.includes(tabId),
}
console.log(JSON.stringify({ 받은이벤트: out.받은이벤트, 판정: out.판정 }, null, 2))

writeRaw('m3-lasttab-exit.json', out)
await app.stop()
await tidySession()
