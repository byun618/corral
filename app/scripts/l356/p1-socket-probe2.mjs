// P1 — 재프로브. P0 이 배운 것을 반영한 L9 시퀀스 교정판.
//
// P0 의 배움 (p0-socket-probe.json):
//   · worktree.open 은 주 체크아웃을 거절한다 (linked_worktree_source) — primary 문은 workspace.create
//   · linked worktree 를 열면 primary 가 **자동으로 같이 열린다** (w4·w5 동시 등장)
//   · workspace.close {close_group:true} 는 그룹 전체를 닫는다
//   · P0 의 L9ⓐ는 **linked 쪽** 탭을 닫아서 ok 가 나왔다 — "그룹을 닫게 되는 탭" 은
//     linked 멤버가 열려 있는 **primary 의 마지막 탭**이라는 가설로 교정한다
//   · P0 의 L9ⓑ는 ⓐ가 이미 linked 를 닫은 뒤라 그룹이 없어 ok — 순서를 ⓑ 먼저로 교정
//
// 이번 순서: 그룹 세우기 → ⓑ workspace.close(무 close_group, 거절이면 비파괴) →
//            ⓐ primary 마지막 탭 tab.close (거절이면 비파괴) → ④ tab.create→agent.start →
//            linked 닫기→재열기(문 확인) → 뒷정리

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SESSION, herdrCall, makeScratchRepo, sleep, until, writeRaw } from './lib.mjs'

const out = { session: SESSION, at: new Date().toISOString(), steps: [] }

function record(label, response, note = null) {
  out.steps.push({ label, note, ...response })
  console.log(`[${label}] ${response.error ? `error ${response.error.code}` : 'ok'} (${response.ms}ms)`)
  return response
}

const repo = makeScratchRepo('probe2')
out.repo = { root: repo.root }
console.log('scratch repo:', repo.root)

// --- 그룹 세우기 -------------------------------------------------------------------

const primary = record('workspace.create.primary', await herdrCall('workspace.create', { cwd: repo.root, focus: false }))
const primaryWs = primary.result?.workspace?.workspace_id
const primaryTab = primary.result?.workspace?.active_tab_id ?? primary.result?.tab?.tab_id ?? null
out.primary = { workspaceId: primaryWs, tabId: primaryTab, resultKeys: Object.keys(primary.result ?? {}) }

const wtPath = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt1')
const createWt = record(
  'worktree.create.linked',
  await herdrCall('worktree.create', { workspace_id: primaryWs, branch: 'l356-p2-wt1', path: wtPath, focus: false }),
)
const linkedWs = createWt.result?.workspace?.workspace_id
const linkedTab = createWt.result?.tab?.tab_id
out.linked = { workspaceId: linkedWs, tabId: linkedTab, path: wtPath }

record('worktree.list.group-open', await herdrCall('worktree.list', { cwd: repo.root }))

// --- L9 거절 2종 (교정 순서: ⓑ 먼저 — 거절이면 비파괴) --------------------------------

record(
  'L9b.workspace.close.primary-no-close_group',
  await herdrCall('workspace.close', { workspace_id: primaryWs }),
  'ⓑ linked 그룹이 열린 primary, close_group 없음 — workspace_group_close_required 기대',
)
record(
  'L9a.tab.close.primary-last-tab',
  await herdrCall('tab.close', { tab_id: primaryTab }),
  'ⓐ linked 그룹이 열린 primary 의 마지막 탭 — confirmation_required 기대',
)
// 상태가 그대로인지 (거절이 비파괴였는지) 확인
record('worktree.list.after-L9', await herdrCall('worktree.list', { cwd: repo.root }))
record('workspace.list.after-L9', await herdrCall('workspace.list', {}))

// --- ④ tab.create → 즉시 agent.start -----------------------------------------------

const tabCreate = record('tab.create.primary', await herdrCall('tab.create', { workspace_id: primaryWs, focus: false }))
const newPane = tabCreate.result?.root_pane?.pane_id ?? null
const newTab = tabCreate.result?.tab?.tab_id ?? null
out.newRow = { tabId: newTab, paneId: newPane }
if (newPane !== null) {
  const agentName = `corral-${newPane.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
  out.agentName = agentName
  const immediate = record(
    'agent.start.immediate',
    await herdrCall('agent.start', { name: agentName, kind: 'claude', pane_id: newPane }),
    '생성 직후 즉시 — agent_pane_busy 실물 기대',
  )
  if (immediate.error?.code === 'agent_pane_busy') {
    const retry = await until(
      async () => {
        const attempt = await herdrCall('agent.start', { name: agentName, kind: 'claude', pane_id: newPane })
        out.steps.push({ label: 'agent.start.retry', ...attempt })
        return attempt.error === null ? attempt : attempt.error.code === 'agent_pane_busy' ? null : attempt
      },
      { timeoutMs: 20000, everyMs: 300, what: 'busy 흡수' },
    )
    out.busyRetry = { ok: retry.ok, ms: retry.ms, finalError: retry.value?.error ?? null }
  }
  // 기동 관측: 포그라운드 cmdline 에 claude 가 보일 때까지
  const launched = await until(
    async () => {
      const info = await herdrCall('pane.process_info', { pane_id: newPane })
      const fg = info.result?.process_info?.foreground_processes ?? []
      return fg.some((p) => /claude/.test(p.cmdline ?? p.name ?? '')) ? info : null
    },
    { timeoutMs: 30000, everyMs: 500, what: 'claude 포그라운드 관측' },
  )
  out.launchObserved = { ok: launched.ok, ms: launched.ms }
  if (launched.ok) out.steps.push({ label: 'pane.process_info.launched', ...launched.value })
}

// --- linked 닫기 → 닫힘 확인 → 재열기 (L6 문 확인) ------------------------------------

record('tab.close.linked-last-tab', await herdrCall('tab.close', { tab_id: linkedTab }), 'linked 쪽 마지막 탭 — P0 에서 ok 였다 (그룹 전체가 아니라 멤버 하나)')
await sleep(300)
record('worktree.list.linked-closed', await herdrCall('worktree.list', { cwd: repo.root }))
record(
  'worktree.open.linked-bare-path',
  await herdrCall('worktree.open', { path: wtPath, focus: false }),
  'L6 문: cwd 없이 path 만 — 앱이 부를 모양',
)
record('worktree.list.linked-reopened', await herdrCall('worktree.list', { cwd: repo.root }))

// --- 뒷정리 (하네스) ----------------------------------------------------------------

record('cleanup.close_group', await herdrCall('workspace.close', { workspace_id: primaryWs, close_group: true }))
record('workspace.list.final', await herdrCall('workspace.list', {}))

writeRaw('p1-socket-probe2.json', out)
console.log('\nL9 채널 요약:')
for (const step of out.steps) {
  if (step.label.startsWith('L9')) {
    console.log(` ${step.label}: ${step.error ? `${step.error.code} — ${step.error.message}` : 'error 없음(!)'}`)
    if (step.error) console.log(`   raw: ${step.rawLine}`)
  }
}
