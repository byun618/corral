// M5 — L10. R1 N5(목록 정합) 회귀. R3 변경(lifecycle.ts·request 허용목록·로그)이 R1 목록
// 정합을 깨지 않았나. **밖에서** herdr 를 흔들고 corral 목록이 이벤트 경로로 따라오나 본다.
//
// l351/m5-consistency.mjs 를 life356 세션·스크래치 레포·l356 raw 로 옮겼다 (킥오프: LIFE-351
// raw 는 건드리지 않는다). 5 경로 × 5 회 = 25 회, 불일치 0 이 통과선.
//   ⓐ tab.create  ⓑ tab.close  ⓒ pane exit(send_text)  ⓓ 마지막 탭 닫기→workspace 연쇄  ⓔ tab.move
//
// **스냅샷/재동기로 덮어 맞춘 것은 통과가 아니다** — 회차 구간에 boot.snapshot.applied·
// resync.applied 가 0 이어야 한다 (CORRAL_RESYNC_MS 를 1시간으로 민다). 대조는 corral AppState
// (제어 채널) vs herdr tab.list·pane.list·workspace.list (제3 오라클), 자리(order)까지 본다.

import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const TIMES = 5
const app = await startApp({ name: 'm5-consistency', env: { CORRAL_RESYNC_MS: '3600000' } })
const out = { at: new Date().toISOString(), ready: app.ready, resyncMs: 3600000, cases: { a: [], b: [], c: [], d: [] , e: [] } }

const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

async function herdrTruth() {
  const [wl, tl, pl] = await Promise.all([
    herdrRequest('workspace.list', {}),
    herdrRequest('tab.list', {}),
    herdrRequest('pane.list', {}),
  ])
  const tabsByWs = {}
  for (const t of tl.tabs) (tabsByWs[t.workspace_id] ??= []).push(t.tab_id)
  return {
    workspaces: wl.workspaces.map((w) => w.workspace_id),
    tabs: tl.tabs.map((t) => t.tab_id),
    panes: pl.panes.map((p) => p.pane_id),
    tabsByWs,
  }
}
function corralView(state) {
  const workspaces = [], tabs = [], panes = [], tabsByWs = {}
  for (const repo of state.repos)
    for (const wt of repo.worktrees) {
      const ws = wt.workspace
      if (!ws) continue
      workspaces.push(ws.workspaceId)
      const ordered = [...ws.tabs].sort((a, b) => a.order - b.order)
      tabsByWs[ws.workspaceId] = ordered.map((t) => t.tabId)
      for (const t of ordered) {
        tabs.push(t.tabId)
        for (const p of t.panes) panes.push(p.paneId)
      }
    }
  return { workspaces, tabs, panes, tabsByWs }
}
async function look() {
  const [state, truth] = await Promise.all([app.state(), herdrTruth()])
  const corral = corralView(state)
  const wsMatch = sameSet(corral.workspaces, truth.workspaces)
  const tabMatch = sameSet(corral.tabs, truth.tabs)
  const paneMatch = sameSet(corral.panes, truth.panes)
  let orderMatch = true
  for (const ws of corral.workspaces) {
    const c = (corral.tabsByWs[ws] ?? []).join(',')
    const h = (truth.tabsByWs[ws] ?? []).join(',')
    if (c !== h) orderMatch = false
  }
  const 일치 = wsMatch && tabMatch && paneMatch && orderMatch
  return { 일치, 차이: 일치 ? null : { wsMatch, tabMatch, paneMatch, orderMatch }, corral, herdr: truth }
}
function snapshotsSince(mark) {
  return app.entries().filter((e) => (e.tag === 'boot.snapshot.applied' || e.tag === 'resync.applied') && e.at >= mark).length
}
async function paneInfo(paneId) {
  const r = await herdrRequest('pane.process_info', { pane_id: paneId }).catch((e) => (String(e).includes('pane_not_found') ? null : Promise.reject(e)))
  return r?.process_info ?? null
}
async function waitPrompt(paneId) {
  return until(async () => {
    const info = await paneInfo(paneId)
    if (info === null) return 'gone'
    return info.foreground_processes?.length === 1 && info.shell_pid === info.foreground_process_group_id ? true : null
  }, { what: 'prompt', timeoutMs: 30000, everyMs: 200 })
}
async function converge(mark, done) {
  const confirmed = await until(async () => (done(await herdrTruth()) ? true : null), { what: 'herdr confirm', timeoutMs: 15000, everyMs: 60 })
  const conv = await until(async () => ((await look()).일치 ? true : null), { what: 'corral converge', timeoutMs: 10000, everyMs: 40 })
  const final = await look()
  return { herdrConfirmed: confirmed.ok, converged: conv.ok, convergeMs: conv.ms, final, snapshots: snapshotsSince(mark) }
}
async function firstWorkspaceId() {
  return (await herdrRequest('workspace.list', {})).workspaces[0]?.workspace_id ?? null
}
async function createTab(workspaceId, cwd) {
  const r = await herdrRequest('tab.create', { workspace_id: workspaceId, cwd })
  return { tabId: r.tab?.tab_id ?? null, paneId: r.root_pane?.pane_id ?? null }
}

try {
  const repo = makeScratchRepo('m5')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const primaryWs = (await until(async () => {
    const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    return wt?.workspace?.workspaceId ?? null
  }, { what: 'primary ws', timeoutMs: 15000 })).value
  await until(async () => (await look()).일치, { what: 'start converge', timeoutMs: 10000 })

  // ⓐ tab.create
  for (let round = 1; round <= TIMES; round++) {
    const mark = Date.now()
    const { tabId, paneId } = await createTab(primaryWs, repo.root)
    const c = await converge(mark, (t) => t.tabs.includes(tabId))
    out.cases.a.push({ round, tabId, 일치: c.final.일치, 차이: c.final.차이, convergeMs: c.convergeMs, snapshots: c.snapshots, 게이트: c.herdrConfirmed && c.converged })
    console.log(`a#${round} ${c.final.일치 ? 'OK' : JSON.stringify(c.final.차이)} snap=${c.snapshots}`)
    void paneId
  }

  // ⓑ tab.close
  for (let round = 1; round <= TIMES; round++) {
    const { tabId, paneId } = await createTab(primaryWs, repo.root)
    await until(async () => (await look()).일치, { what: 'prep', timeoutMs: 10000 })
    await waitPrompt(paneId)
    const mark = Date.now()
    await herdrRequest('tab.close', { tab_id: tabId })
    const c = await converge(mark, (t) => !t.tabs.includes(tabId))
    out.cases.b.push({ round, tabId, 일치: c.final.일치, 차이: c.final.차이, convergeMs: c.convergeMs, snapshots: c.snapshots, 게이트: c.herdrConfirmed && c.converged })
    console.log(`b#${round} ${c.final.일치 ? 'OK' : JSON.stringify(c.final.차이)} snap=${c.snapshots}`)
  }

  // ⓒ pane exit (send_text 'exit')
  for (let round = 1; round <= TIMES; round++) {
    const { tabId, paneId } = await createTab(primaryWs, repo.root)
    await until(async () => (await look()).일치, { what: 'prep', timeoutMs: 10000 })
    await waitPrompt(paneId)
    const mark = Date.now()
    let sent = 0
    const dead = async () => {
      const t = await herdrTruth()
      return !t.panes.includes(paneId) && !t.tabs.includes(tabId)
    }
    for (let i = 0; i < 3 && !(await dead()); i++) {
      const p = await waitPrompt(paneId)
      if (p.value === 'gone' || (await dead())) break
      await herdrRequest('pane.send_text', { pane_id: paneId, text: 'exit\n' })
      sent++
      await until(async () => ((await dead()) ? true : null), { what: 'exit', timeoutMs: 12000, everyMs: 100 })
    }
    const c = await converge(mark, (t) => !t.panes.includes(paneId) && !t.tabs.includes(tabId))
    out.cases.c.push({ round, tabId, paneId, exitSent: sent, 일치: c.final.일치, 차이: c.final.차이, convergeMs: c.convergeMs, snapshots: c.snapshots, 게이트: c.herdrConfirmed && c.converged })
    console.log(`c#${round} ${c.final.일치 ? 'OK' : JSON.stringify(c.final.차이)} sent=${sent} snap=${c.snapshots}`)
  }

  // ⓓ 마지막 탭 닫기 → workspace 연쇄 (linked 멤버로 격리)
  for (let round = 1; round <= TIMES; round++) {
    const parent = repo.root.replace(/\/[^/]+$/, '')
    const base = repo.root.split('/').pop()
    const wtPath = `${parent}/${base}-l10d-${round}`
    const created = await herdrRequest('worktree.create', { workspace_id: primaryWs, branch: `l10d-${round}`, path: wtPath })
    const linkedWs = created.workspace?.workspace_id ?? null
    const rootTab = created.root_pane?.tab_id ?? (await herdrRequest('tab.list', {})).tabs.find((t) => t.workspace_id === linkedWs)?.tab_id
    await until(async () => (await look()).일치, { what: 'prep d', timeoutMs: 12000 })
    const mark = Date.now()
    await herdrRequest('tab.close', { tab_id: rootTab })
    const c = await converge(mark, (t) => !t.workspaces.includes(linkedWs))
    out.cases.d.push({ round, linkedWs, rootTab, 일치: c.final.일치, 차이: c.final.차이, convergeMs: c.convergeMs, snapshots: c.snapshots, 게이트: c.herdrConfirmed && c.converged })
    console.log(`d#${round} ${c.final.일치 ? 'OK' : JSON.stringify(c.final.차이)} snap=${c.snapshots}`)
  }

  // ⓔ tab.move (자리 비교)
  for (let round = 1; round <= TIMES; round++) {
    // 탭 2개를 더 만들어 최소 3개 상태에서 마지막을 0 으로 옮긴다
    const t1 = await createTab(primaryWs, repo.root)
    const t2 = await createTab(primaryWs, repo.root)
    await until(async () => (await look()).일치, { what: 'prep e', timeoutMs: 10000 })
    const mark = Date.now()
    await herdrRequest('tab.move', { tab_id: t2.tabId, insert_index: 0 })
    const c = await converge(mark, (t) => (t.tabsByWs[primaryWs] ?? [])[0] === t2.tabId)
    out.cases.e.push({ round, moved: t2.tabId, 일치: c.final.일치, 차이: c.final.차이, herdrOrder: c.final.herdr.tabsByWs[primaryWs], corralOrder: c.final.corral.tabsByWs[primaryWs], convergeMs: c.convergeMs, snapshots: c.snapshots, 게이트: c.herdrConfirmed && c.converged })
    console.log(`e#${round} ${c.final.일치 ? 'OK' : JSON.stringify(c.final.차이)} snap=${c.snapshots}`)
    // 정리: 만든 두 탭 닫기 (다음 회차 깔끔하게)
    await waitPrompt(t1.paneId).catch(() => {})
    await herdrRequest('tab.close', { tab_id: t1.tabId }).catch(() => {})
    await herdrRequest('tab.close', { tab_id: t2.tabId }).catch(() => {})
    await until(async () => (await look()).일치, { what: 'cleanup e', timeoutMs: 10000 }).catch(() => {})
  }

  const all = [...out.cases.a, ...out.cases.b, ...out.cases.c, ...out.cases.d, ...out.cases.e]
  out.summary = {
    rounds: all.length,
    mismatches: all.filter((r) => !r.일치).length,
    snapshotContaminated: all.filter((r) => r.snapshots > 0).length,
    gatesOk: all.every((r) => r.게이트),
  }
  out.verdict = out.summary.rounds === 25 && out.summary.mismatches === 0 && out.summary.snapshotContaminated === 0 ? 'PASS' : 'FAIL'

  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m5-consistency.json', out)
console.log('\nM5:', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
