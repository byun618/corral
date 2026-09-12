// M-shapes — 이 구현이 기대는 **herdr 응답 모양**을 실물로 남긴다.
//
// 왜 따로 재나: 소스 주석이 "실측" 이라고 적은 것들이 실제로 파일로 있어야 근거다 (관문 ①).
// 여기서 확인하는 것 넷:
//   ① `worktree.list {cwd}` 가 그 레포 **전체** worktree 를 주고, 열린 줄에만 `open_workspace_id`
//   ② 그 레포가 이 세션에 하나도 안 열려 있어도 응답이 정상이다 (열림 표시가 없을 뿐)
//   ③ git 이 아닌 경로는 `not_git_worktree` 로 거절한다
//   ④ `pane.report_agent` 가 받는 상태는 idle·working·blocked·unknown 이고 **done 은 거절한다**
//      (N8 의 공백이 어디서 왔는지 여기가 근거다)

import os from 'node:os'
import path from 'node:path'
import { REPO_DIR, request, socketPath, writeRaw } from './lib.mjs'

const OPEN_REPO = path.resolve(REPO_DIR, '../../..')
const CLOSED_REPO = process.env.LIFE351_SECOND_REPO ?? path.join(os.homedir(), 'repos/byun618/home-coffing')

const ask = async (method, params = {}) => {
  try {
    return { ok: true, result: await request(method, params) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

const out = {
  at: new Date().toISOString(),
  세션: { 소켓: socketPath(), bytes: Buffer.byteLength(socketPath(), 'utf8'), 한계: 104 },
  ping: await ask('ping'),
  'session.snapshot': await ask('session.snapshot'),
  'worktree.list (열린 레포)': await ask('worktree.list', { cwd: OPEN_REPO }),
  'worktree.list (안 열린 레포)': await ask('worktree.list', { cwd: CLOSED_REPO }),
  'worktree.list (git 아님)': await ask('worktree.list', { cwd: '/tmp' }),
  'tab.list': await ask('tab.list'),
  'pane.list': await ask('pane.list'),
  'workspace.list': await ask('workspace.list'),
}

const paneId = out['pane.list'].result?.panes?.[0]?.pane_id ?? null
const reportStates = {}
if (paneId !== null) {
  for (const state of ['idle', 'working', 'blocked', 'unknown', 'done']) {
    reportStates[state] = await ask('pane.report_agent', {
      pane_id: paneId,
      source: 'l351-shapes',
      agent: 'claude',
      state,
    })
  }
  await ask('pane.release_agent', { pane_id: paneId, source: 'l351-shapes', agent: 'claude' })
  out['pane.process_info'] = await ask('pane.process_info', { pane_id: paneId })
}
out['pane.report_agent 가 받는 state'] = reportStates

out.읽은것 = {
  '① worktree.list 는 레포 전체를 준다': (out['worktree.list (열린 레포)'].result?.worktrees ?? []).length > 1,
  '① 열린 줄에만 open_workspace_id': (out['worktree.list (열린 레포)'].result?.worktrees ?? []).filter(
    (item) => item.open_workspace_id !== undefined,
  ).length,
  '② 안 열린 레포도 정상 응답': out['worktree.list (안 열린 레포)'].ok,
  '② 그 레포에 열린 줄 수': (out['worktree.list (안 열린 레포)'].result?.worktrees ?? []).filter(
    (item) => item.open_workspace_id !== undefined,
  ).length,
  '③ git 아니면 거절': out['worktree.list (git 아님)'].ok === false,
  '④ report_agent 가 받는 state': Object.entries(reportStates)
    .filter(([, value]) => value.ok)
    .map(([key]) => key),
  '④ 거절하는 state': Object.entries(reportStates)
    .filter(([, value]) => !value.ok)
    .map(([key]) => key),
}
console.log(JSON.stringify(out.읽은것, null, 2))
writeRaw('00-shapes.json', out)
