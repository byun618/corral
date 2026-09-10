// L2r — workspace 를 repo 로 묶고, 그 repo 의 **worktree 를 전부** 보여 주는가.
//
// 개정(수정 2회차): 1회차는 `worktree.list` 응답에서 cwd 접두가 맞는 하나만 쓰고 나머지를 버렸다.
// 그래서 herdr 에 workspace 가 안 열린 worktree 가 화면에서 사라졌다. 통과 확인은 두 가지로 한다 —
//   ① `cpm-macro` 의 `issue/LIFE-341` (열린 workspace 없음)
//   ② `corral` 의 worktree 3개 (main · LIFE-344-bootstrap · LIFE-344-bootstrap-claude)
// 사용자가 default 세션에 corral workspace 를 열어 둬서 ② 를 검증할 수 있다. **닫지 않는다.**
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
function readOnlyRequest(method, params = {}) {
  if (method !== 'session.snapshot' && method !== 'worktree.list') {
    throw new Error(`거부: default 세션에는 읽기만 보낸다 (${method})`)
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DEFAULT_SOCKET)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'ro', method, params }) + '\n'))
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

// 창을 높게 연다 — repo 5개 · worktree 7줄이 한 장에 담겨야 근거 사진이 된다 (계측용 knob).
const app = await startApp({ name: 'l2r', env: { CORRAL_SESSION: 'default', CORRAL_WINDOW: '1180x1500' } })
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
// 통과 확인용 두 repo 의 응답 원문 — 앱이 무엇을 받았는지 그대로 남긴다.
const cpmMacro = await readOnlyRequest('worktree.list', { cwd: '/Users/byun/repos/byun618/cpm-macro' })
const corral = await readOnlyRequest('worktree.list', { cwd: '/Users/byun/repos/byun618/corral' })
const repoLogs = app.entries().filter((entry) => entry.tag === 'repo.resolved' || entry.tag === 'repo.resolve_failed')

const rows = stateSelected.state.workspaces
const groups = stateSelected.state.repos
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
  repoGroups: groups.map((group) => ({
    repoName: group.repoName,
    repoRoot: group.repoRoot,
    worktrees: group.worktrees.map((worktree) => ({
      branch: worktree.branch,
      path: worktree.path,
      isLinkedWorktree: worktree.isLinkedWorktree,
      open: worktree.openWorkspaceId !== null,
      openWorkspaceId: worktree.openWorkspaceId,
    })),
    workspaces: group.workspaces.map((workspace) => workspace.workspaceId),
  })),
  // 개정된 통과선 — 이 둘이 화면에 떠야 한다.
  passChecks: {
    cpmMacroIssue341: (() => {
      const group = groups.find((item) => item.repoName === 'cpm-macro') ?? null
      const row = group?.worktrees.find((worktree) => worktree.branch === 'issue/LIFE-341') ?? null
      return { found: row !== null, open: row?.openWorkspaceId !== null && row?.openWorkspaceId !== undefined, row }
    })(),
    corralThreeWorktrees: (() => {
      const group = groups.find((item) => item.repoName === 'corral') ?? null
      const branches = (group?.worktrees ?? []).map((worktree) => worktree.branch)
      return {
        found: group !== null,
        count: branches.length,
        branches,
        openCount: (group?.worktrees ?? []).filter((worktree) => worktree.openWorkspaceId !== null).length,
      }
    })(),
  },
  renderedRows: app.entries().filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'tree').pop() ?? null,
  everyWorkspaceGrouped: rows.every((row) => row.repoName !== null),
  everyWorkspaceHasPanes: rows.every((row) => row.panes.length > 0),
  selectedPaneId: stateSelected.state.selectedPaneId,
  repoResolveLog: repoLogs,
  worktreeListRaw: worktrees.result,
  worktreeListCpmMacro: cpmMacro.result,
  worktreeListCorral: corral.result,
  shots: [shot.file, shotSelected.file],
}

result.pass =
  result.passChecks.cpmMacroIssue341.found &&
  !result.passChecks.cpmMacroIssue341.open &&
  result.passChecks.corralThreeWorktrees.count === 3
result.conclusion = result.pass
  ? `cpm-macro 의 issue/LIFE-341 이 **닫힘**으로 떴고, corral 의 worktree 3개(${result.passChecks.corralThreeWorktrees.branches.join(' · ')})가 ` +
    `전부 떴다 (그중 ${result.passChecks.corralThreeWorktrees.openCount}개 열림).`
  : '개정된 통과선을 못 넘었다. 원자료를 그대로 두고 결과 문서에 미달로 적을 것.'

writeRaw('31-l2r-repo-groups.json', result)
writeRaw('31-l2-default-snapshot.json', snapshot.result)
console.log(
  JSON.stringify(
    {
      repoGroups: result.repoGroups.map((group) => `${group.repoName ?? '(repo 없음)'} worktree ${group.worktrees.length}`),
      cpmMacroIssue341: result.passChecks.cpmMacroIssue341,
      corral: result.passChecks.corralThreeWorktrees,
      renderedRows: result.renderedRows,
      snapshotWorktreeCoverage: `${result.snapshotWorktreeCoverage.withWorktreeField}/${result.snapshotWorktreeCoverage.workspaces}`,
      pass: result.pass,
    },
    null,
    2,
  ),
)

await app.stop()
