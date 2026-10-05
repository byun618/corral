// 라이프사이클 쓰기 경로 (R3) — herdr control 소켓으로 행·worktree 를 만들고 닫는다.
//
// R1·R2 의 herdr 접촉은 전부 읽기였다. 여기가 **쓰기의 유일한 자리**다. 그래서:
//   · 나가는 값은 전부 corral 타입(`shared/types.ts`) — herdr 봉투는 이 파일 안에서 끝난다
//   · 실측으로 확정한 호출만 있다 (raw/claude/00-probe-findings.md). 추측 호출 없음
//   · 거절(rejection)은 승격하지 않고 **그대로 돌려준다** — corral 이 close_group/force 로 임의
//     승격 금지 (기준 L9). 승격 판단은 사람의 몫이라 화면까지 올려 보낸다
//
// busy 재시도(L2)만 여기서 흡수한다: `agent.start` 는 셸이 프롬프트에 못 오르면 `agent_pane_busy`
// 를 주는데 소켓은 재시도를 안 해 준다(승계 팩트). 시간으로 못 막으므로(레이스) 코드로 되건다.

import { readNumber, readRecord, readString } from '../../../shared/json.js'
import type { AgentKind } from '../../../shared/types.js'
import { log } from '../../log.js'
import { request } from './request.js'

/**
 * busy 흡수 — 300ms 간격으로 이 시간까지 되건다. LIFE-346: herdr CLI 도 최대 2초 되건다.
 *
 * LIFE-417 N4: 같은 규약을 CLI 경로(`terminal create --agent` = `worker-start` 기동)도 쓴다.
 * 값은 여기 한 곳에만 둔다 — terminal-backend.ts 가 이 둘을 import 해 기본값으로 쓴다.
 */
export const BUSY_RETRY_TIMEOUT_MS = 15_000
export const BUSY_RETRY_INTERVAL_MS = 300

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 에이전트 이름 규칙 — **소문자·영숫자·대시만** (LIFE-346: pane id 대문자/콜론이 섞이면
 * `invalid_agent_name` 으로 전 회차 기동 실패). pane id(`w6:p2`)에서 파생해 pane 마다 유일하다.
 */
function agentNameFor(paneId: string): string {
  return `corral-${paneId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

/** herdr kind 문자열. `shell` 은 agent.start 를 안 부르므로 여기 없다. */
function herdrKind(kind: AgentKind): string {
  return kind // 값이 겹치지만 옮김은 여기서 — 렌더러는 herdr kind 를 모른다
}

export type CreateRowOutcome = {
  ok: boolean
  paneId: string | null
  tabId: string | null
  retries: number
  error: string | null
}

/**
 * 행 하나를 만든다: `tab.create` → (셸이 아니면) `agent.start` (busy 되걸기).
 *
 * 성공은 "걸었다"(launch_pending)까지다. 기동 판정(process_info cmdline)은 이 함수가 하지
 * 않는다 — store 의 상태 칩이 구독으로 뒤따르고, 측정은 process_info 를 따로 떠서 L1 을 잰다.
 */
export async function createRow(
  socketPath: string,
  input: { workspaceId: string; kind: AgentKind; cwd?: string; label?: string },
): Promise<CreateRowOutcome> {
  // LIFE-495 K6 — 닫은 탭 다시 열기는 같은 시작 디렉터리·사용자 이름으로 새 셸을 연다(herdr `tab.create` 의 `cwd`·`label`).
  const params = {
    workspace_id: input.workspaceId,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.label === undefined ? {} : { label: input.label }),
  }
  const created = await request(socketPath, 'tab.create', params, { reason: 'create-row' })
  if (created.error) {
    return { ok: false, paneId: null, tabId: null, retries: 0, error: `${created.error.code}: ${created.error.message}` }
  }
  const result = readRecord(created.result as Record<string, unknown>, 'root_pane')
  const tab = readRecord(created.result as Record<string, unknown>, 'tab')
  const paneId = result === null ? null : readString(result, 'pane_id')
  const tabId = tab === null ? null : readString(tab, 'tab_id')
  log('lifecycle.tab_created', { workspaceId: input.workspaceId, paneId, tabId })
  if (paneId === null) {
    return { ok: false, paneId, tabId, retries: 0, error: 'tab.create 응답에 root_pane.pane_id 가 없다' }
  }
  if (input.kind === 'shell') {
    return { ok: true, paneId, tabId, retries: 0, error: null }
  }

  const name = agentNameFor(paneId)
  const startedAt = Date.now()
  let retries = 0
  for (;;) {
    const started = await request(
      socketPath,
      'agent.start',
      { name, kind: herdrKind(input.kind), pane_id: paneId },
      { reason: 'create-row' },
    )
    if (!started.error) {
      log('lifecycle.agent_started', { paneId, kind: input.kind, retries })
      return { ok: true, paneId, tabId, retries, error: null }
    }
    // busy 만 되건다 — 다른 실패(미지원 kind·이름 규칙)는 되걸어도 같은 결과다.
    if (started.error.code !== 'agent_pane_busy' || Date.now() - startedAt > BUSY_RETRY_TIMEOUT_MS) {
      log('lifecycle.agent_start_failed', { paneId, code: started.error.code, retries })
      return { ok: false, paneId, tabId, retries, error: `${started.error.code}: ${started.error.message}` }
    }
    retries += 1
    log('lifecycle.agent_busy_retry', { paneId, retries, elapsedMs: Date.now() - startedAt })
    await sleep(BUSY_RETRY_INTERVAL_MS)
  }
}

export type ForegroundProbe = {
  ok: boolean
  /** 셸 프로세스 pid. */
  shellPid: number | null
  /** 지금 전경 프로세스 그룹 id. shellPid 와 같으면 셸만 있는 것(잃을 게 없다). */
  foregroundGroupId: number | null
  /** 전경 프로세스 이름·cmdline — 확인 모달에 보인다. */
  foreground: Array<{ name: string; cmdline: string | null }>
  error: string | null
}

/**
 * 종료 게이트 판별자 — herdr `pane.process_info` (관문 ⑤: 재는 대상 자신의 출력이 아니다).
 * 값 판정(같은가)은 부르는 쪽이 한다 — 이 함수는 herdr 값을 corral 모양으로 옮기기만 한다.
 */
export async function probeForeground(socketPath: string, paneId: string): Promise<ForegroundProbe> {
  const response = await request(socketPath, 'pane.process_info', { pane_id: paneId }, { reason: 'close-gate' })
  if (response.error) {
    return { ok: false, shellPid: null, foregroundGroupId: null, foreground: [], error: `${response.error.code}: ${response.error.message}` }
  }
  const info = readRecord(response.result as Record<string, unknown>, 'process_info')
  if (info === null) {
    return { ok: false, shellPid: null, foregroundGroupId: null, foreground: [], error: 'process_info 없음' }
  }
  const rawList = info['foreground_processes']
  const foreground = Array.isArray(rawList)
    ? rawList
        .map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({ name: readString(item, 'name') ?? '?', cmdline: readString(item, 'cmdline') }))
    : []
  return {
    ok: true,
    shellPid: readNumber(info, 'shell_pid'),
    foregroundGroupId: readNumber(info, 'foreground_process_group_id'),
    foreground,
    error: null,
  }
}

/**
 * **요청 바이트가 실제로 나갔는가** 를 호출부에 돌려주는 훅 (R3-F1).
 *
 * 닫기 결과를 「확정 거절」과 「결과 불명」으로 가르는 축은 둘이다 — herdr 가 낸 코드와,
 * 애초에 요청이 나갔는가. 두 번째는 **여기서만 알 수 있다**: `request()` 가 소켓에 쓰기
 * 직전에 이 훅을 부른다(`request.ts`). 호출부가 추측하지 않고 이 값을 그대로 쓴다.
 */
export interface CloseHooks { onSent?: () => void }

export type CloseTabOutcome =
  | { outcome: 'closed' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/**
 * 탭을 닫는다. herdr 가 그룹 닫기를 거절하면(`confirmation_required` — L9a) 그 거절을
 * **그대로 돌려준다**. corral 이 close_group/force 로 승격하지 않는다 (기준).
 */
export async function closeTab(socketPath: string, tabId: string, hooks: CloseHooks = {}): Promise<CloseTabOutcome> {
  const response = await request(socketPath, 'tab.close', { tab_id: tabId }, { reason: 'close-row', onSent: hooks.onSent })
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log('lifecycle.tab_close_rejected', { tabId, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  log('lifecycle.tab_closed', { tabId })
  return { outcome: 'closed' }
}

/**
 * 탭 이름을 바꾼다 (LIFE-357 I-7). herdr `tab.rename` 한 번이 전부다 — 이름은 herdr 가 들고
 * 있고 `tab_renamed` 이벤트로 되돌아온다(`store.ts` 가 이미 받는다). **corral 쪽 영속 계층은
 * 없다** — 만들면 herdr 의 것과 두 벌이 된다.
 *
 * `closeTab` 과 같은 모양이다: **herdr 가 거절하면 그대로 돌려준다.** corral 이 승격하지 않는다(기준).
 *
 * ⚠ 정정(L-h): 옛 주석은 *"빈 이름이든 판단은 herdr 것"* 이라 적어 herdr 가 빈 라벨을 거절할
 * 것처럼 읽혔는데, **herdr 는 빈 라벨도 그냥 저장한다**(fix3 리뷰 grok 의 소켓 실측).
 * 실제로 오는 거절은 `tab_not_found` 나 필드 누락 쪽이다. 화면의 "공백만이면 취소"는 herdr
 * 거동이 아니라 **UI 규칙**이고(I-7 ③), 그래서 그 판정은 `MainTabBar` 에 있다.
 */
export type RenameTabOutcome =
  | { outcome: 'renamed' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

export async function renameTab(socketPath: string, tabId: string, label: string): Promise<RenameTabOutcome> {
  const response = await request(socketPath, 'tab.rename', { tab_id: tabId, label }, { reason: 'rename-row' })
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log('lifecycle.tab_rename_rejected', { tabId, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  log('lifecycle.tab_renamed', { tabId, label })
  return { outcome: 'renamed' }
}

/**
 * workspace 를 닫는다 (L9b). linked worktree 그룹이 열린 primary 를 close_group 없이 닫으면
 * herdr 가 `workspace_group_close_required` 로 거절한다 — **그대로 돌려준다**.
 * corral 이 close_group:true 로 승격하지 않는다 (기준). 승격은 사람이 정한다.
 */
export async function closeWorkspace(socketPath: string, workspaceId: string, hooks: CloseHooks = {}): Promise<CloseTabOutcome> {
  const response = await request(socketPath, 'workspace.close', { workspace_id: workspaceId }, { reason: 'close-worktree', onSent: hooks.onSent })
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log('lifecycle.workspace_close_rejected', { workspaceId, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  log('lifecycle.workspace_closed', { workspaceId })
  return { outcome: 'closed' }
}

export type WorktreeOutcome = {
  ok: boolean
  workspaceId: string | null
  rejection: { code: string; message: string } | null
  error: string | null
}

function toWorktreeOutcome(response: { result?: unknown; error?: { code?: string; message?: string } }, tag: string): WorktreeOutcome {
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log(`lifecycle.${tag}_rejected`, rejection)
    return { ok: false, workspaceId: null, rejection, error: null }
  }
  const workspace = readRecord(response.result as Record<string, unknown>, 'workspace')
  const workspaceId = workspace === null ? null : readString(workspace, 'workspace_id')
  log(`lifecycle.${tag}`, { workspaceId })
  return { ok: true, workspaceId, rejection: null, error: null }
}

/** 주 체크아웃을 연다 (L8 빈 상태 복구의 문). worktree.open 은 주 체크아웃을 거절한다. */
export async function openWorkspace(socketPath: string, cwd: string): Promise<WorktreeOutcome> {
  const response = await request(socketPath, 'workspace.create', { cwd, focus: false }, { reason: 'open-workspace' })
  return toWorktreeOutcome(response, 'workspace_opened')
}

/** 닫힌 linked worktree 를 연다 (L6). parent workspace 가 열려 있어야 하고 그 id 를 준다. */
export async function openWorktree(
  socketPath: string,
  input: { parentWorkspaceId: string; path: string },
): Promise<WorktreeOutcome> {
  const response = await request(
    socketPath,
    'worktree.open',
    { workspace_id: input.parentWorkspaceId, path: input.path, focus: false },
    { reason: 'open-worktree' },
  )
  return toWorktreeOutcome(response, 'worktree_opened')
}

/** 새 linked worktree 를 만든다 (L7). parent workspace 를 확보한 뒤 그 id 로 부른다. */
export async function createWorktree(
  socketPath: string,
  input: { parentWorkspaceId: string; branch: string; path: string },
): Promise<WorktreeOutcome> {
  const response = await request(
    socketPath,
    'worktree.create',
    { workspace_id: input.parentWorkspaceId, branch: input.branch, path: input.path, focus: false },
    { reason: 'create-worktree' },
  )
  return toWorktreeOutcome(response, 'worktree_created')
}
