// 사이드바 **안 읽음** 판정 (LIFE-471 S5) — 순수 함수. 화면·창 신호·영속은 `hooks/useUnread.ts` 가 묶는다.
//
// Orca 1.4.198 의 두 층을 옮긴다(게이트 ⓪ Q1):
//   · pane 안 읽음 (메모리) — 198 `unreadAgentCompletionPanes` + ack 장부. 행 굵기·행 점·카드 상태 칸이 이것 **하나**를 본다(#20940 따라 하지 않기).
//   · worktree 벨 (영속, ui-prefs `unreadWorktrees` 경로 키) — 198 `worktree.isUnread`. 카드 벨·메뉴 Mark Read/Unread.
//
// # 왜 herdr `done` 을 그대로 쓰지 않나 (00-analysis F1·F2·F5)
//
// herdr 0.9.0 은 API 클라이언트만 붙으면 활성 탭 pane 의 완료를 **늘 seen** 으로 친다(외부 포커스가 `None`) — 창을 숨긴 채 끝난
// 활성 탭 에이전트는 `done` 이 안 된다. API 로 그 값을 바꿀 길도 없다. 그래서 corral 이 완료 **전이**를 직접 보고, 그 순간
// 사용자가 그 pane 을 보고 있었는지를 자기 판정으로 정한다. herdr `done` 은 「처음 보는 pane 이 이미 끝나 있다」는 신호로만 쓴다.
//
// # 완료 (01-criteria 용어)
//
// working/blocked → idle/done 전이. main 이 전이마다 이력(`agentState.history`, 최대 20)을 남기므로, 화면은 마지막으로 살핀 시각
// 이후의 이력을 훑어 묶음 하나에 합쳐 온 전이(working→idle→working 등)도 센다(r1 L3). 완료 하나의 표식 = 그 상태에 들어선 시각.
//   · main 이 처음 본 pane 이 이미 `done` (이력 없음) → pane 안 읽음만(herdr 가 안 본 완료라고 말한다). **벨은 안 켠다**
//     (r1 M2 · 01-criteria 변경 기록 — 재시작마다 herdr 에 남은 done 이 벨을 다시 켜던 것. 198 도 완료 이벤트에서만 벨을 켠다)
//   · 처음 본 `idle` · 기동 직후 첫 idle(herdr 가 완료를 억제 → 직전이 working 이 아니다) → 완료 아님
//   · `done → idle`(herdr 가 조용히 seen 처리 — 재동기에서야 보인다) → 직전이 done 이라 새 완료 아님
//   · unknown → idle/done 은 세지 않는다 — herdr #4825 류(바뀌지 않은 에이전트를 다시 「새 활동」으로)를 안 읽음으로 세지 않게
//   · **기동 반짝임은 완료가 아니다 (LIFE-502)** — `unknown` 에서 곧장 들어선 working/blocked 구간이 idle/done 으로 끝났는데 그 pane 의
//     transcript 에 사람 발화가 아직 없다(`prompted === false`). codex 가 기동 중 MCP 부팅 스피너를 띄우면 herdr 는 정확히
//     `unknown → working → idle` 을 보고한다 — 프롬프트 0 인데 위 규칙이면 완료다. 198 은 provider hook(턴 종료)에서만 완료를 세서
//     이런 일이 없다. corral 은 hook 대신 「사람 턴이 있었나」를 transcript 지문(`digest.firstPrompt`·`lastPrompt`)으로 본다.
//     기동 인자 프롬프트(`claude "…"`)는 transcript 에 발화가 있으니 센다. 지문은 main 이 1.5초 주기로 읽어 상태보다 늦을 수 있다 —
//     그래서 버리지 않고 **보류**(`held`)했다가, 그 pane 이 같은 상태에 머무는 동안 발화가 보이면 그때 원래 시각으로 센다.
//     상태가 바뀌면 보류를 버린다. 판단할 수 없는 pane(`prompted === null` — 미지원 provider·세션 참조 없는 provider 없는 보고)은
//     이 규칙 밖이다(지금처럼 센다). 판정은 `hooks/useUnread.ts` `promptedOf`.
//     한계: 「codex」 라고 보고한 provider 없는 pane 이 `unknown` 에서 곧장 working → idle 이면 반짝임과 구별되지 않아 세지 않는다.
// 화면을 새로 띄운 첫 묶음(렌더러 재적재)에서는 이미 지나간 전이를 다시 세지 않는다 — `done` 인 것만 pane 안 읽음(벨 없음).
// 벨을 켜는 것은 실제 완료 전이와 Mark Unread 뿐이고, 재시작 뒤 벨은 저장값을 따른다.
//
// # 보고 있음 (watched)
//
// 창이 보이고 앱이 포커스이며 그 pane 이 활성 영역의 선택 pane 이다(198 `isVisibleForegroundPaneKey` 의 네 조건). 완료 시각 T 에
// 보고 있었나는 **시각으로** 판정한다 — 그 pane 을 보기 시작한 시각 `since` 가 T 이하면 보고 있던 중의 완료다. 처리가 늦게
// 돌아도(숨은 창의 렌더러 지연) 판정이 「처리한 순간」이 아니라 「끝난 순간」에 묶인다.

import type { AgentStatus } from '../../shared/types.js'

/** 문구 (K12 문구 표) — 198 `Mark read`/`Mark unread`(툴팁·메뉴 `Mark Read`/`Mark Unread`)를 한국어 UI 로. 벨 툴팁·aria·카드 메뉴가 같이 쓴다. */
export const UNREAD_ACTION_LABEL = { read: '읽음으로 표시', unread: '안 읽음으로 표시' } as const

export type PaneObservation = {
  paneId: string
  /** 그 pane 이 속한 worktree 경로 — 벨의 키. */
  worktreePath: string
  status: AgentStatus
  /** 지금 상태에 들어선 시각(main `agentState.observedAt`). 완료 하나의 표식이다. */
  enteredAt: number
  /** 지나온 상태들, **최신순**(main `agentState.history` — 그 상태에 들어선 시각). 비었으면 main 이 이 pane 을 처음 본 것이다. */
  history: readonly { status: AgentStatus; enteredAt: number }[]
  /**
   * 그 pane 의 transcript 에 사람 발화가 있나(LIFE-502) — `true` 있다 · `false` transcript provider 인데 아직 없다 ·
   * `null` 판단할 수 없다(transcript 를 읽지 않는 provider·셸). 기동 반짝임을 가르는 근거다.
   */
  prompted: boolean | null
}

/** 레포 하나의 이번 묶음 — 벨 정리가 스캔 실패(git·herdr 에러)를 「사라짐」으로 읽지 않게(r1 M1). */
export type RepoScan = { root: string; error: boolean; worktreePaths: readonly string[] }

export type PaneUnread = { worktreePath: string; at: number }

export type UnreadModel = {
  /** 첫 묶음을 받았나 — 렌더러 재적재 뒤 지나간 전이를 다시 세지 않는다. */
  initialized: boolean
  /** pane → 마지막으로 살핀 상태 진입 시각. 같으면 이미 처리한 상태다. */
  examined: ReadonlyMap<string, number>
  /** 확인 안 된 완료 — pane → 그 완료. 닫힌 탭(보존 행)의 것도 여기 남는다. */
  panes: ReadonlyMap<string, PaneUnread>
  /** 보류한 기동 반짝임 — pane → 그 완료(`at` = 그 idle/done 에 들어선 시각). 같은 상태에서 사람 발화가 보이면 센다(LIFE-502). */
  held: ReadonlyMap<string, PaneUnread>
  /** 벨 켜진 worktree 경로 (영속). */
  worktrees: ReadonlySet<string>
  /** 마지막으로 본 (null 아닌) 활성 worktree — 활성화(사용자 전환) 감지용. 닫힘 사이의 null 은 건너뛴다. */
  activeWorktree: string | null
  /** 이번 세션에 화면에 있었던 worktree 경로 → 그 레포 루트. 사라지면 그 벨을 지운다(삭제·레포 제거 유령 방지, K8ⓓ). */
  present: ReadonlyMap<string, string>
}

export const EMPTY_UNREAD: UnreadModel = {
  initialized: false,
  examined: new Map(),
  panes: new Map(),
  held: new Map(),
  worktrees: new Set(),
  activeWorktree: null,
  present: new Map(),
}

/** 지금 보고 있는 pane 과 그 시작 시각. 창이 숨었거나 앱이 포커스가 아니면 null. */
export type Watched = { paneId: string; since: number } | null

const FINISHED: readonly AgentStatus[] = ['idle', 'done']
const RUNNING: readonly AgentStatus[] = ['working', 'blocked']

/**
 * 새로 센 완료 하나 — 그 상태에 들어선 시각과, 벨을 켜는 실제 전이인가(처음 보는 done 은 아니다 — M2),
 * 기동 반짝임인가(`unknown` 에서 곧장 시작된 구간 + 사람 발화 없음 — LIFE-502. 세지 않는다).
 */
export type Completion = { at: number; bell: boolean; launch: boolean }

/**
 * 이 관측에서 새로 센 완료들(오래된 것부터). `since` = 이 pane 을 마지막으로 살폈을 때의 상태 진입 시각 — 그보다 뒤에 들어선
 * 상태만 새것이다. 같은 완료를 두 번 세지 않는다.
 */
export function completionsOf(input: { obs: PaneObservation; firstBatch: boolean; since: number | undefined }): Completion[] {
  const { obs, firstBatch, since } = input
  // 처음 보는 done — 첫 묶음, 이 세션에 처음 보는 pane(r2 F-E: 첫 묶음 뒤에 나타난 pane 의 옛 이력은 세지 않는다),
  // main 이 처음 본 pane. 굵기만, 벨 없음. (같은 상태를 다시 본 관측은 `ingest` 가 `since === enteredAt` 로 먼저 거른다 — r3 L-2)
  if (firstBatch || since === undefined || obs.history.length === 0) return obs.status === 'done' ? [{ at: obs.enteredAt, bell: false, launch: false }] : []
  const timeline = [...obs.history].reverse().concat([{ status: obs.status, enteredAt: obs.enteredAt }])
  const found: Completion[] = []
  // 지금 working/blocked 구간이 `unknown` 에서 곧장 시작됐나 — 구간의 첫 단계 바로 앞이 unknown 이다(이력 창 밖이면 모른다 → 아님).
  let fromUnknown = false
  for (let i = 1; i < timeline.length; i += 1) {
    const step = timeline[i]
    const before = timeline[i - 1]
    if (step === undefined || before === undefined) continue
    if (RUNNING.includes(step.status) && !RUNNING.includes(before.status)) fromUnknown = before.status === 'unknown'
    if (since !== undefined && step.enteredAt <= since) continue
    if (RUNNING.includes(before.status) && FINISHED.includes(step.status)) found.push({ at: step.enteredAt, bell: true, launch: fromUnknown && obs.prompted === false })
  }
  return found
}

/**
 * 상태 묶음 하나를 받아 장부를 갱신한다 — 완료 기록 → 사라진 것 정리 → 활성화 해제 → 보고 있는 pane 자동 확인 순.
 *
 * 묶음에 없고 `retainedPaneIds` 에도 없는 pane 의 안 읽음은 버린다. `repos` 는 지금 화면의 레포별 worktree 경로 —
 * 경로가 하나도 없으면(첫 적재 전) 벨 정리를 건너뛴다.
 */
export function ingest(model: UnreadModel, input: {
  panes: readonly PaneObservation[]
  retainedPaneIds: ReadonlySet<string>
  repos: readonly RepoScan[]
  activeWorktree: string | null
  /** 창이 보이고 앱이 포커스인가 — 활성화가 사용자의 것인지 가른다. */
  attentive: boolean
  watched: Watched
}): UnreadModel {
  const examined = new Map(model.examined)
  const panes = new Map(model.panes)
  const held = new Map(model.held)
  const worktrees = new Set(model.worktrees)
  const firstBatch = !model.initialized
  for (const obs of input.panes) {
    const since = examined.get(obs.paneId)
    const watching = input.watched !== null && input.watched.paneId === obs.paneId ? input.watched.since : null
    // 보류한 기동 반짝임 — 같은 상태에 머문 채 사람 발화가 보이면(지문이 늦게 온 기동 인자 프롬프트) 원래 시각으로 센다.
    // 상태가 바뀌었으면 그 반짝임은 사람 턴 없이 지나간 것이다 — 버린다.
    const pending = held.get(obs.paneId)
    if (pending !== undefined && (obs.enteredAt !== pending.at || obs.prompted !== false)) {
      held.delete(obs.paneId)
      if (obs.enteredAt === pending.at && obs.prompted === true && (watching === null || pending.at < watching)) {
        panes.set(obs.paneId, pending)
        worktrees.add(pending.worktreePath)
      }
    }
    if (since === obs.enteredAt) continue
    const all = completionsOf({ obs, firstBatch, since })
    examined.set(obs.paneId, obs.enteredAt)
    const lastLaunch = all.filter((completion) => completion.launch).at(-1)
    if (lastLaunch !== undefined && lastLaunch.at === obs.enteredAt) held.set(obs.paneId, { worktreePath: obs.worktreePath, at: lastLaunch.at })
    const found = all.filter((completion) => !completion.launch)
    // 보기 시작한 시각과 같은 ms 의 완료는 **본 것**으로 친다(`<` — 보기 시작한 순간의 완료는 본 것, r3 L-1).
    const unseen = found.filter((completion) => watching === null || completion.at < watching)
    const last = unseen.at(-1)
    if (last === undefined) continue
    panes.set(obs.paneId, { worktreePath: obs.worktreePath, at: last.at })
    if (unseen.some((completion) => completion.bell)) worktrees.add(obs.worktreePath)
  }
  // 사라진 worktree 의 벨 (K8ⓓ · r1 M1·L1).
  //   · 스캔이 실패한 레포(error)는 worktree 가 빈 목록으로 온다 — 그 레포에서 알던 경로는 「사라짐」이 아니라 「모름」이다(벨·present 유지).
  //   · 이번 세션에 본 적 없는 저장 벨(앱이 꺼진 사이 지운 worktree)은 **모든 레포가 에러 없이 적재된** 묶음에서만 지운다.
  //   · 경로가 하나도 없는 묶음(첫 적재 전)에서는 아무것도 지우지 않는다.
  const seen = new Set(input.repos.flatMap((repo) => repo.worktreePaths))
  const errored = new Set(input.repos.filter((repo) => repo.error).map((repo) => repo.root))
  const present = new Map(model.present)
  for (const repo of input.repos) for (const path of repo.worktreePaths) present.set(path, repo.root)
  // 입력에서 빠진 레포(레지스트리에서 제거)의 경로는 더 「모름」이 아니다 — 지운다. 그 레포의 pane·벨은 아래 정리 규칙을 따른다(r3 L-7).
  const roots = new Set(input.repos.map((repo) => repo.root))
  for (const [path, root] of [...present]) if (!roots.has(root)) present.delete(path)

  // 사라진 pane 의 안 읽음 — 에러 레포의 worktree 에 있던 pane 은 벨과 같은 규칙으로 남긴다(r2 F-A).
  const live = new Set(input.panes.map((obs) => obs.paneId))
  for (const paneId of [...held.keys()]) if (!live.has(paneId)) held.delete(paneId)
  for (const [paneId, entry] of panes) {
    if (live.has(paneId) || input.retainedPaneIds.has(paneId)) continue
    const root = present.get(entry.worktreePath)
    if (root !== undefined && errored.has(root)) continue
    panes.delete(paneId)
  }
  if (seen.size > 0) {
    const clean = errored.size === 0
    for (const path of [...worktrees]) {
      if (seen.has(path)) continue
      const root = present.get(path)
      if (clean || (root !== undefined && !errored.has(root))) worktrees.delete(path)
    }
    for (const [path, root] of [...present]) if (!seen.has(path) && !errored.has(root)) present.delete(path)
  }

  // worktree 활성화 (198 `set-active-worktree.ts:82,97`) — 보고 있는 중에 활성 worktree 가 **다른 것으로 바뀌면** 그 벨을 끈다.
  // 창이 숨은 채 바뀐 활성(CLI activate)·시작 복원(null → X)은 사용자의 활성화가 아니다(K3ⓑ).
  const activated = input.attentive && input.activeWorktree !== null && model.activeWorktree !== null && input.activeWorktree !== model.activeWorktree
  if (activated && input.activeWorktree !== null) worktrees.delete(input.activeWorktree)

  const next: UnreadModel = {
    // pane 이 하나도 없는 묶음(링크가 서기 전)은 첫 묶음으로 치지 않는다 — 그다음 묶음에서 지나간 전이를 다시 세게 된다.
    initialized: model.initialized || input.panes.length > 0,
    examined,
    panes,
    held,
    worktrees,
    activeWorktree: input.activeWorktree ?? model.activeWorktree,
    present,
  }
  return acknowledgeWatched(next, input.watched)
}

/**
 * 보고 있는 pane 의 안 읽음을 확인한다 (198 `useAutoAckViewedAgent`). 그 worktree 에 다른 안 읽음 pane 이 남아 있지 않을 때만 벨도 끈다
 * (198 `shouldClearViewedAgentWorktreeUnread`). 확인할 것이 없으면 벨은 그대로 — 수동 Mark Unread 가 바로 지워지지 않는 이유다.
 */
export function acknowledgeWatched(model: UnreadModel, watched: Watched): UnreadModel {
  if (watched === null) return model
  const entry = model.panes.get(watched.paneId)
  if (entry === undefined) return model
  const panes = new Map(model.panes)
  panes.delete(watched.paneId)
  const othersLeft = [...panes.values()].some((other) => other.worktreePath === entry.worktreePath)
  if (othersLeft) return { ...model, panes }
  const worktrees = new Set(model.worktrees)
  worktrees.delete(entry.worktreePath)
  return { ...model, panes, worktrees }
}

/** Mark Read (메뉴·벨) — 벨을 끄고 그 worktree 의 pane 안 읽음을 전부 확인한다(K6ⓒ). */
export function markRead(model: UnreadModel, worktreePath: string): UnreadModel {
  const panes = new Map([...model.panes].filter(([, entry]) => entry.worktreePath !== worktreePath))
  const worktrees = new Set(model.worktrees)
  worktrees.delete(worktreePath)
  return { ...model, panes, worktrees }
}

/** Mark Unread (메뉴·벨) — 벨만 켠다. 완료가 없는 worktree 에도 된다(198). */
export function markUnread(model: UnreadModel, worktreePath: string): UnreadModel {
  if (model.worktrees.has(worktreePath)) return model
  return { ...model, worktrees: new Set(model.worktrees).add(worktreePath) }
}

/** 터미널에 실제 입력이 들어갔다 (198 `terminal-keydown-fit.ts`) — 그 pane 을 확인하고 그 worktree 벨을 끈다. */
export function acknowledgeInput(model: UnreadModel, input: { paneId: string; worktreePath: string }): UnreadModel {
  if (!model.panes.has(input.paneId) && !model.held.has(input.paneId) && !model.worktrees.has(input.worktreePath)) return model
  const panes = new Map(model.panes)
  panes.delete(input.paneId)
  // 보류한 기동 반짝임도 확인한 것이다 — 사용자가 그 pane 에 친 발화가 늦게 보여 반짝임을 완료로 올리지 않게(LIFE-502).
  const held = new Map(model.held)
  held.delete(input.paneId)
  const worktrees = new Set(model.worktrees)
  worktrees.delete(input.worktreePath)
  return { ...model, panes, held, worktrees }
}
