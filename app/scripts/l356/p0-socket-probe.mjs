// P0 — 앱 코드를 쓰기 **전의** 원시 소켓 프로브 (advisor 지시 순서).
//
// 확인하는 미지수:
//   ① worktree.open 이 **주 체크아웃 경로**에도 먹나 (L8 의 「열기」 문이 성립하는가)
//   ② worktree.create 를 어떤 파라미터로 불러야 primary 의 linked 그룹 멤버가 되나
//   ③ L9 거절 2종이 **소켓 error payload 로** 실제 오나 — 원문 줄 실물 채집
//      ⓐ confirm_close(기본 true) + 그룹을 닫게 되는 tab.close → confirmation_required
//      ⓑ 그룹 열린 primary 의 close_group 없는 workspace.close → workspace_group_close_required
//   ④ tab.create → 즉시 agent.start 1회 (이름 규칙·agent_pane_busy 봉투 실물)
//   ⑤ worktree.open 의 path/branch XOR · cwd 동반 가능 여부
//
// 소켓이 거절을 안 주면(③) 여기서 멈추고 보고한다 — 킥오프의 정지 지점.
// 전부 격리 세션 life356-claude + 스크래치 레포에서만 돈다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SESSION, herdrCall, makeScratchRepo, sleep, until, writeRaw } from './lib.mjs'

const out = {
  session: SESSION,
  at: new Date().toISOString(),
  herdrVersion: execFileSync('herdr', ['--version'], { encoding: 'utf8' }).trim(),
  confirmClose: null,
  steps: [],
}

/** 걸음 하나를 기록한다 — 원문 줄(rawLine)을 그대로 싣는 것이 요점이다. */
function record(label, response, note = null) {
  const entry = { label, note, ...response }
  out.steps.push(entry)
  const shape = response.error ? `error ${response.error.code}` : 'ok'
  console.log(`[${label}] ${shape} (${response.ms}ms)`)
  return response
}

// --- confirm_close 증거: 사용자 config 에 해당 줄 없음 + 기본값 줄 원문 -------------

const configPath = path.join(os.homedir(), '.config', 'herdr', 'config.toml')
const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
const defaultConfig = execFileSync('herdr', ['--default-config'], { encoding: 'utf8' })
out.confirmClose = {
  configPath,
  configHasConfirmCloseLine: configText === null ? null : /^\s*confirm_close\s*=/m.test(configText),
  defaultConfigLines: defaultConfig
    .split('\n')
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((item) => item.text.includes('confirm_close')),
  note: 'config.toml 에 confirm_close 줄이 없으면 기본값이 적용된다 — 기본값은 아래 defaultConfigLines 원문',
}

// --- 스크래치 레포 ---------------------------------------------------------------

const repo = makeScratchRepo('probe')
out.repo = { root: repo.root }
console.log('scratch repo:', repo.root)

const baseline = record('worktree.list.baseline', await herdrCall('worktree.list', { cwd: repo.root }))

// --- ① 주 체크아웃 열기 -----------------------------------------------------------

const openPrimary = record(
  'worktree.open.primary-path',
  await herdrCall('worktree.open', { path: repo.root, focus: false }),
  '미지수 ①: 주 체크아웃 경로로 worktree.open',
)

let primaryWs = null
if (!openPrimary.error) {
  primaryWs = openPrimary.result?.workspace?.workspace_id ?? null
} else {
  // 폴백 문: workspace.create {cwd}
  const created = record(
    'workspace.create.fallback',
    await herdrCall('workspace.create', { cwd: repo.root, focus: false }),
    'worktree.open 이 주 체크아웃을 거절 — workspace.create 폴백 확인',
  )
  primaryWs = created.result?.workspace?.workspace_id ?? null
}
out.primaryWorkspaceId = primaryWs
if (primaryWs === null) {
  writeRaw('p0-socket-probe.json', out)
  throw new Error('primary workspace 를 못 열었다 — 프로브 중단, 결과 기록됨')
}

record('worktree.list.after-primary', await herdrCall('worktree.list', { cwd: repo.root }))

// --- ② linked worktree 그룹 만들기 --------------------------------------------------

const wtPath = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt1')
const createWt = record(
  'worktree.create.linked',
  await herdrCall('worktree.create', {
    workspace_id: primaryWs,
    branch: 'l356-probe-wt1',
    path: wtPath,
    focus: false,
  }),
  '미지수 ②: workspace_id 로 그룹 연결이 되나',
)
const linkedWs = createWt.result?.workspace?.workspace_id ?? null
const linkedTab = createWt.result?.tab?.tab_id ?? null
const linkedPane = createWt.result?.root_pane?.pane_id ?? null
out.linked = { workspaceId: linkedWs, tabId: linkedTab, paneId: linkedPane, path: wtPath }

const afterCreate = record('worktree.list.after-create', await herdrCall('worktree.list', { cwd: repo.root }))
out.gitWorktreeList = execFileSync('git', ['-C', repo.root, 'worktree', 'list', '--porcelain'], {
  encoding: 'utf8',
})

// --- ③ L9 거절 2종 ---------------------------------------------------------------

if (linkedTab !== null) {
  // 셸이 프롬프트에 오를 때까지 잠깐 — 거절 판정에 셸 준비는 무관하지만 상태를 안정시킨다.
  await sleep(1500)
  const procInfo = record(
    'pane.process_info.linked',
    await herdrCall('pane.process_info', { pane_id: linkedPane }),
    '④ process_info 모양 채집 겸 셸 확인',
  )
  out.linkedProcessInfo = procInfo.result ?? null

  record(
    'L9a.tab.close.last-tab-of-group',
    await herdrCall('tab.close', { tab_id: linkedTab }),
    'ⓐ worktree 그룹을 닫게 되는 마지막 탭 tab.close — confirmation_required 를 기대',
  )
  record(
    'L9b.workspace.close.primary-no-close_group',
    await herdrCall('workspace.close', { workspace_id: primaryWs }),
    'ⓑ 그룹 열린 primary 의 close_group 없는 workspace.close — workspace_group_close_required 기대',
  )
} else {
  out.steps.push({ label: 'L9.skipped', note: 'linked worktree 생성 실패 — L9 재현 불가' })
}

// --- ④ tab.create → 즉시 agent.start ----------------------------------------------

const tabCreate = record(
  'tab.create.primary',
  await herdrCall('tab.create', { workspace_id: primaryWs, focus: false }),
)
const newPane = tabCreate.result?.root_pane?.pane_id ?? null
const newTab = tabCreate.result?.tab?.tab_id ?? null
out.newRow = { tabId: newTab, paneId: newPane }
if (newPane !== null) {
  const agentName = `corral-${newPane.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
  const immediate = record(
    'agent.start.immediate',
    await herdrCall('agent.start', { name: agentName, kind: 'claude', pane_id: newPane }),
    '생성 직후 즉시 — agent_pane_busy 봉투 실물을 기대',
  )
  if (immediate.error?.code === 'agent_pane_busy') {
    // 재시도가 결국 성공하는지 1회 확인 (busy 흡수 전략의 재료)
    const retry = await until(
      async () => {
        const attempt = await herdrCall('agent.start', { name: agentName, kind: 'claude', pane_id: newPane })
        out.steps.push({ label: 'agent.start.retry', ...attempt })
        return attempt.error === null ? attempt : attempt.error.code === 'agent_pane_busy' ? null : attempt
      },
      { timeoutMs: 20000, everyMs: 300, what: 'agent.start busy 흡수' },
    )
    out.busyRetry = { ok: retry.ok, ms: retry.ms }
  }
  await sleep(2000)
  const info = record('pane.process_info.after-start', await herdrCall('pane.process_info', { pane_id: newPane }))
  out.afterStartProcessInfo = info.result ?? null
}

// --- ⑤ XOR·cwd 동반 ---------------------------------------------------------------

record(
  'worktree.open.path-and-branch',
  await herdrCall('worktree.open', { path: wtPath, branch: 'l356-probe-wt1', focus: false }),
  '⑤ path 와 branch 를 같이 주면?',
)
record(
  'worktree.open.path-with-cwd',
  await herdrCall('worktree.open', { path: wtPath, cwd: repo.root, focus: false }),
  '⑤ path + cwd 동반 — 이미 열린 worktree 라 already_open 류를 기대',
)

// --- 뒷정리 (하네스 정리 — corral 제품 경로 아님) -----------------------------------

record(
  'cleanup.workspace.close.group',
  await herdrCall('workspace.close', { workspace_id: primaryWs, close_group: true }),
  '하네스 뒷정리: 프로브가 만든 그룹을 통째로 닫는다 (제품 코드가 아니라 하네스다)',
)
record('worktree.list.after-cleanup', await herdrCall('worktree.list', { cwd: repo.root }))

writeRaw('p0-socket-probe.json', out)
console.log('\n프로브 완료 — L9 거절 채널 요약:')
for (const step of out.steps) {
  if (step.label.startsWith('L9')) {
    console.log(` ${step.label}: ${step.error ? `${step.error.code} — ${step.error.message}` : 'error 없음(!)'}`)
  }
}
