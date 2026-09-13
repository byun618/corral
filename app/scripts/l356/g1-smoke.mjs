// 게이트 ① 수동 스모크 (측정 아님) — 빈 탭 생성이 실제로 도는지 한 바퀴. 격리 세션 life356-claude.
//   ① `+ 빈 탭` 클릭 → tab.create 만(agent.start 없음) → herdr 에 pane 등장, 포그라운드=셸
//   ② ⌘T → 같은 workspace 에 빈 탭 하나 더 (선택/최근 workspace 대상)
// data-* 는 불변이라 기존 하네스 그대로 좌표 클릭한다.

import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'g1-smoke' })
const out = { at: new Date().toISOString(), ready: app.ready, steps: [] }
const step = (label, v) => { out.steps.push({ label, ...v }); console.log(`[${label}]`, JSON.stringify(v)) }

async function panesInWs(ws) {
  return (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === ws)
}
async function fg(paneId) {
  const info = (await herdrRequest('pane.process_info', { pane_id: paneId })).process_info ?? {}
  return {
    shellPid: info.shell_pid ?? null,
    foregroundGroupId: info.foreground_process_group_id ?? null,
    names: (info.foreground_processes ?? []).map((p) => p.name),
  }
}

try {
  const repo = makeScratchRepo('g1')
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const ws = (await until(async () => {
    const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    return wt?.workspace?.workspaceId ?? null
  }, { what: 'primary ws', timeoutMs: 15000 })).value

  // ① + 빈 탭
  const before1 = new Set((await panesInWs(ws)).map((p) => p.pane_id))
  const plusClick = await app.click(`[data-create-row="${ws}"][data-kind="shell"]`)
  const pane1 = (await until(async () => {
    for (const p of await panesInWs(ws)) if (!before1.has(p.pane_id)) return p
    return null
  }, { what: 'empty tab pane', timeoutMs: 15000 })).value
  await sleep(1300) // 셸 프롬프트 정착
  const info1 = await fg(pane1.pane_id)
  // 이 pane 에 agent.start 로그가 없어야 한다 (tab.create 만)
  const agentStarted = app.entries().some((e) => (e.tag === 'lifecycle.agent_started' || e.tag === 'lifecycle.agent_busy_retry') && e.paneId === pane1.pane_id)
  const tabCreated = app.entries().some((e) => e.tag === 'lifecycle.tab_created' && e.paneId === pane1.pane_id)
  step('plus-empty-tab', {
    clickHit: plusClick.hit, paneId: pane1.pane_id, tabId: pane1.tab_id,
    tabCreatedLog: tabCreated, agentStartLog: agentStarted,
    foregroundIsShell: info1.shellPid !== null && info1.shellPid === info1.foregroundGroupId,
    foreground: info1.names,
  })

  // ② ⌘T (선택/최근 workspace = 방금 상호작용한 ws)
  const before2 = new Set((await panesInWs(ws)).map((p) => p.pane_id))
  await app.key('t', ['meta'])
  const grew2 = await until(async () => {
    const now = (await panesInWs(ws)).map((p) => p.pane_id).filter((id) => !before2.has(id))
    return now.length > 0 ? now[0] : null
  }, { what: 'cmd-t tab', timeoutMs: 15000 })
  step('cmd-t-empty-tab', { created: grew2.ok, newPaneId: grew2.value ?? null })

  out.result = {
    plusCreatesEmptyTab: out.steps[0].tabCreatedLog && !out.steps[0].agentStartLog && out.steps[0].foregroundIsShell,
    cmdTCreatesTab: grew2.ok,
  }
  out.verdict = out.result.plusCreatesEmptyTab && out.result.cmdTCreatesTab ? 'PASS' : 'FAIL'

  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('g1-smoke.json', out)
console.log('\nG1-smoke:', out.verdict, JSON.stringify(out.result ?? {}))
if (out.verdict !== 'PASS') process.exitCode = 1
