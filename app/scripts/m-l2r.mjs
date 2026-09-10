// L2r — workspace 를 repo 로 묶어 보여 주는가. 그리고 L1/L2 의 "실물다운" 화면 근거.
//
// 격리 규칙: 이 스크립트는 사용자의 `default` 세션에 **읽기로만** 붙는다.
// 앱이 보낼 수 있는 메서드는 화이트리스트(`ping`·`session.snapshot`·`worktree.list`)뿐이라
// 쓰기 경로가 코드에 존재하지 않는다 — 흔들기(create/close)는 이 스크립트에 없다.
//
// 왜 default 에 붙나: 격리 세션에는 workspace 가 1개뿐이라 "그룹이 보이는 화면"이 안 나온다.
// default 에는 repo 가 다른 workspace 가 여럿 있다 (brain · life-assistant · cpm-macro · ~).

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { sleep, startApp, writeRaw } from './lib.mjs'

const DEFAULT_SOCKET = path.join(os.homedir(), '.config', 'herdr', 'herdr.sock')

/** 읽기 전용 요청 — 이 스크립트가 default 소켓에 보내는 것은 이 두 메서드뿐이다. */
function readOnlyRequest(method) {
  if (method !== 'session.snapshot' && method !== 'worktree.list') {
    throw new Error(`거부: default 세션에는 읽기만 보낸다 (${method})`)
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DEFAULT_SOCKET)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'ro', method, params: {} }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      const line = buffer.slice(0, index)
      socket.end()
      socket.destroy()
      resolve(JSON.parse(line))
    })
  })
}

const app = await startApp({ name: 'l2r', env: { CORRAL_SESSION: 'default' } })
await sleep(2500) // repo 조회(worktree.list)가 workspace 마다 한 번씩 나갈 시간
const state = await app.state()
const shot = await app.shot('l2r-repo-groups')

// 첫 pane 을 골라 선택 상태도 화면에 남긴다 (선택 대상 = pane)
const firstPane = state.state.workspaces.flatMap((row) => row.panes)[0] ?? null
if (firstPane) {
  await app.selectPane(firstPane.paneId)
  await sleep(500)
}
const shotSelected = await app.shot('l2-pane-selected')
const stateSelected = await app.state()

const snapshot = await readOnlyRequest('session.snapshot')
const worktrees = await readOnlyRequest('worktree.list')
const repoLogs = app.entries().filter((entry) => entry.tag === 'repo.resolved' || entry.tag === 'repo.resolve_failed')

const rows = state.state.workspaces
const snapshotWorkspaces = snapshot.result?.snapshot?.workspaces ?? []
const result = {
  measuredAt: new Date().toISOString(),
  session: 'default (읽기 전용)',
  isolation: {
    appAllowedMethods: ['ping', 'session.snapshot', 'worktree.list'],
    harnessSentToDefault: ['session.snapshot', 'worktree.list'],
    wroteAnything: false,
  },
  // 개정 지시의 핵심 — 스냅샷의 workspace.worktree 는 대부분 비어 있다
  snapshotWorktreeCoverage: {
    workspaces: snapshotWorkspaces.length,
    withWorktreeField: snapshotWorkspaces.filter((workspace) => workspace.worktree).length,
    labels: snapshotWorkspaces.map((workspace) => ({ label: workspace.label, hasWorktree: Boolean(workspace.worktree) })),
  },
  resolvedByApp: rows.map((row) => ({
    workspaceId: row.workspaceId,
    label: row.label,
    repoName: row.repoName,
    repoRoot: row.repoRoot,
    branch: row.branch,
    isLinkedWorktree: row.isLinkedWorktree,
    repoSource: row.repoSource,
    paneCount: row.paneCount,
    panes: row.panes.map((pane) => ({ paneId: pane.paneId, title: pane.title, agentStatus: pane.agentStatus })),
  })),
  repoGroups: [...new Set(rows.map((row) => row.repoName ?? '(repo 없음)'))],
  everyWorkspaceGrouped: rows.every((row) => row.repoName !== null),
  everyWorkspaceHasPanes: rows.every((row) => row.panes.length > 0),
  selectedPaneId: stateSelected.state.selectedPaneId,
  repoResolveLog: repoLogs,
  worktreeListRaw: worktrees.result,
  shots: [shot.file, shotSelected.file],
}

writeRaw('31-l2r-repo-groups.json', result)
writeRaw('31-l2-default-snapshot.json', snapshot.result)
console.log(
  JSON.stringify(
    {
      repoGroups: result.repoGroups,
      everyWorkspaceGrouped: result.everyWorkspaceGrouped,
      everyWorkspaceHasPanes: result.everyWorkspaceHasPanes,
      snapshotWorktreeCoverage: `${result.snapshotWorktreeCoverage.withWorktreeField}/${result.snapshotWorktreeCoverage.workspaces}`,
      selectedPaneId: result.selectedPaneId,
    },
    null,
    2,
  ),
)

await app.stop()
