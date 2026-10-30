// 작업 페이지 상태·자료 (LIFE-601) — 화면(TasksPage)은 그리기만, 여기서 출처 요청·영속·낙관적 반영을 한다.
//
// - 요청은 `window.corral.workRequest` 하나(T1 계약). 요청 id 는 `LatestGate` 가 매기고, 같은 열쇠의 마지막 요청 응답만 받는다(C7 늦은 응답 폐기):
//   `load`(스페이스 자료) · `more`(다음 쪽) · `find`(키 검색) · `item:<연결>::<id>`(작업 하나의 쓰기) · `transitions`(끄는 작업의 허용 전이).
// - 작업 정체는 `(연결, 작업 id)`(R1-L) — 작업 id 는 연결 안에서만 유일하다.
// - 끌기 = 즉시 반영 → 요청 → 성공이면 되돌리기 토스트(6초) / 실패면 그 카드만 옮기기 전으로 + 오류 토스트 + 서버 재조회.
//   **경합 표면을 줄인다(수정 r2)**: 한 카드에 잠금 중인(30초 안) 쓰기는 하나뿐이다 — 그동안 그 카드의 끌기·되돌리기는 잠긴다(「확인하는 중」).
//   단 30초를 넘기면 「확인 지연」 으로 잠금이 풀려(R4-A) 같은 카드에 답이 안 온 쓰기가 겹칠 수 있다 — 그때 「옮기기 전 값」 은 겹친 미확인 의도일 수 있어
//   정합화 단위·되돌리기 기준 검사(아래 LIFE-622 · `beginWrite`/`unsureBase`)가 맡는다. 겹침이 없으면 옮기기 전 값은 출처가 마지막으로 인정한 값이다.
//   실패·버린 응답이면 그 카드 하나만 옮기기 전 자리로 돌리고(다른 카드의 순서는 건드리지 않는다) 서버를 다시 읽어 수렴한다.
//   목록 응답이 오면 확인 안 된 쓰기(시작 시점과 무관하게)와 그 요청 뒤에 화면에 쓴 변경을 그 위에 다시 적용한다(R1-F·R2-C).
// - **수렴 규칙(수정 r3) — 서버가 정본이다.** 순서 쓰기는 성공해도 의도를 다시 적용하지 않는다: 같은 스페이스의 순서 쓰기가 모두 끝나면
//   목록을 서버에서 다시 읽어 확정 순서로 맞춘다(그동안 화면은 낙관적 순서 그대로 — 깜빡이지 않는다, R3-A). 성공한 쓰기는 작업 중 조회의
//   그 키 응답을 무효화하고 서버 값을 쓴다 — 완료 분류를 넘나들면 작업 중·키 조회를 전부 다시 받는다(종속 막힘, R3-B·C).
// - 쓰기·잠금·화면 변경은 **연결 세대**에 귀속한다(R3-D) — 세대가 바뀌면 이전 세대의 확인 안 된 쓰기는 잠금을 풀고, 새 자료에 다시 적용하지도
//   원복하지도 않는다(늦게 온 그 응답은 버린다).
// - 출처 요청은 `ask` 하나로 — preload Promise 의 reject 는 `network` 실패 응답으로 바꾼다(R3-E). 30초 안에 답이 없으면 **확정 실패가 아니라 「늦음」** 이다(R4-A):
//   읽기는 시간 초과 오류(다시 시도)로, 쓰기는 「확인 지연」 — 잠금만 풀고 낙관적 값은 둔 채, 원래 요청이 끝나면(성공·실패 무관) 서버를 다시 읽어 맞춘다.
// - **카드 하나의 정합화 단위(LIFE-622 R5-A)** — 늦음으로 잠금이 풀린 뒤 같은 카드에 새 쓰기가 나가면, 답이 안 온 그 카드의 쓰기들(보드·상세)을 한 단위로 본다:
//   ① 재조회 위에는 그 카드·그 갈래(연산 — 상태·배치·순서…)의 **가장 나중에 시작한** 미확인 쓰기만 다시 적용한다 — 같은 갈래에 뒤에 나간 쓰기가 있으면
//   옛 의도는 버린다(답이 어떤 순서로 와도 옛 의도가 새 의도를 덮지 않는다) ② 단위의 마지막 답이 오면 서버를 다시 읽어 맞춘다(응답 순서 ≠ 서버 적용 순서라
//   마지막 응답 값을 믿지 않는다).
// - **늦은 성공(R5-B · R4-B)** — 30초를 넘겨 성공한 상태·배치 쓰기도 되돌리기를 주고, 열린 상세에는 확정 경로(`settledWrite` — LIFE-623 `sent` 순서 가드·미확인 막힘)로
//   서버 값을 보낸다. 되돌리기는 그 카드·그 갈래·그 쓰기에 묶인다: 같은 카드의 같은 갈래에 그 뒤 쓰기가 시작됐으면(진행 중이든 끝났든) 옛 쓰기의 되돌리기는
//   내지 않고, 이미 낸 것은 눌러도 보내지 않는다 — 되돌리기가 후행 쓰기를 덮는 길이 없다. 다른 갈래(상태 뒤 배치·코멘트)는 덮지 않으므로 그대로(R4-E). 세대가 바뀌면 없다.
// - 스페이스 목록 조회(연결별 · 세대별)는 시도·실패를 보존한다 — 실패하면 「다시 시도」 까지 다시 보내지 않는다(R1-C).
// - 스페이스 선택(R1-D): 첫 선택(이 실행에서 처음 열 때 — 레포 기본 → 마지막 → 첫 스페이스, 목록을 받는 중이면 기다림) · 재열기는 그대로 ·
//   설정이 바뀌어 고른 스페이스가 없어지면(숨김·연결 제거) 다시 고른다.
// - 키 검색은 검색어·연결 세대·키 모양이 바뀔 때만 조회한다 — 상태 push(새 settings 객체)는 조회를 다시 부르지 않는다. 닫힌 동안은 조회하지 않는다(R1-B).
// - 영속(C3): 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본 → ui-prefs `tasksPage`. 검색어·스크롤은 페이지가 마운트를 유지해 같은 실행 안에서 남고,
//   다시 열 때의 조용한 새로고침은 **더 받아 둔 쪽 수만큼** 다시 받는다(R1-N).
// - **상세 쓰기(LIFE-602 D3)** — `writeItem` 은 끌기(`move`)와 **같은 잠금**(`pendingWrites`, 작업 uid 마다 하나)·같은 세대 귀속·같은 30초
//   「확인 지연」 을 쓴다. 상세에서 저장 중인 작업은 보드에서 끌 수 없고, 끄는 중(확인 전)인 작업은 상세에서 저장하지 않는다(`busy`).
//   성공한 쓰기는 보드 자료에 서버 값을 쓰고, `settled` 로 알려 열린 상세가 같은 값을 받는다(보드 끌기 결과도 상세에 들어간다).
//   상세 단건 읽기(첫 읽기·재조회·새로 불러오기)가 진행 중인 작업도 보드에서 끌거나 되돌릴 수 없다(`reading`, R6-D — 같은 작업 직렬화).
//   보드 쓰기가 시작되면 `startedWrite` 로 알려 열린 상세의 되돌리기 토스트가 곧바로 사라진다(R6-B).
//   선택(열린 상세)·상세 크기는 ui-prefs 에 남긴다(C1 — 닫았다 다시 열거나 재시작해도 복원).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import { WORK_SEARCH_SPACES_MAX, type WorkCall, type WorkError, type WorkItem, type WorkResolutionChoice, type WorkResponse, type WorkResult, type WorkSettingsState, type WorkStatus } from '../../../shared/work.js'
import {
  DEFAULT_TASKS_PREFS,
  LatestGate,
  applyIntent,
  compareRank,
  initialSpace,
  itemUid,
  parseUid,
  readTasksPrefs,
  picksResolution,
  restorableResolution,
  rowUid,
  rowsOf,
  sameSpace,
  searchKey,
  spaceGroups,
  spaceId,
  spaceStillValid,
  UNRESTORABLE_RESOLUTION,
  type DragIntent,
  type SpaceData,
  type TasksPrefs,
  type TasksRow,
  type TasksSpace,
} from '../tasks-model.js'
import { linkedTrees, workingFromLinks } from '../work-links-model.js'
import { nextWorkStamp } from '../work-clock.js'

export type TasksBanner = { kind: 'auth' | 'forbidden' | 'offline' | 'error'; message: string }

export type TasksLoad = { spaceId: string | null; phase: 'idle' | 'loading' | 'ready' | 'error'; data: SpaceData[]; error: WorkError | null; loadingMore: boolean }

export type SearchHit = { connectionId: string; item: WorkItem; spaceName: string; via: 'key' | 'query' }
/** 작업 중 항목의 조회 결과 — 찾는 중 · 찾음 · 출처에 없음 · 실패. */
export type WorkingLookup = { state: 'loading' } | { state: 'found'; item: WorkItem; spaceName: string } | { state: 'missing' } | { state: 'error'; message: string }
type StoredLookup = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error'; message: string }

/** 끄는 작업의 허용 전이(`allowed` 모드) — 받는 중 · 받음 · 실패. 받기 전·실패면 다른 칸은 흐림(fail-closed, C7). */
export type TasksTransitions = { uid: string; state: 'loading' } | { uid: string; state: 'ready'; keys: string[]; blocked: { statusKey: string; reason: string }[] } | { uid: string; state: 'error'; message: string } | null

export type MoveRequest = { row: TasksRow; intent: DragIntent }
/** `undo` 는 받아들였으면 true — 그 카드가 잠겨 있으면 false 이고 버튼은 남는다(R4-E). */
/** `bind` — 토스트를 띄운 쪽이 지우는 손잡이를 받는다(LIFE-602 수정 5: 상세 되돌리기는 다음 쓰기·판 변화에 곧바로 사라진다). 보드 되돌리기는 쓰지 않는다. */
export type MoveNotice = { kind: 'moved'; label: string; undo: () => boolean; bind?: (dismiss: () => void) => void } | { kind: 'undone'; label: string } | { kind: 'failed'; message: string } | { kind: 'delayed'; message: string }
  /** 되돌릴 수 없는 변경(LIFE-602 수정 1 R1-G — 원래 완료 갈래를 복원할 수 없음) — 되돌리기 버튼 없이 그 사실을 보인다. */
  | { kind: 'final'; label: string }

/**
 * 상세의 쓰기 하나(LIFE-602) — 잠금 열쇠는 `(연결, itemId)`. `optimistic` 이 있으면 보드 자료에 먼저 쓰고, 실패하면 그 작업만 쓰기 전 값으로 돌린다.
 * 자식 만들기는 부모의 잠금을 쓴다(`itemId` = 부모).
 */
export type ItemWrite = { connectionId: string; spaceKey: string; itemId: string; call: WorkCall; optimistic: ((item: WorkItem) => WorkItem) | null }
/** 결과 — 성공 · 출처 실패(충돌 포함) · 잠김(앞 쓰기 확인 중 — 보내지 않았다) · 늦음(확인 지연, 실패 아님) · 버림(세대가 바뀜·더 새 요청). */
export type ItemWriteOutcome = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'late'; settled: Promise<LateSettled> } | { kind: 'stale' }
/** 확인 지연 뒤 끝난 결과(LIFE-602 수정 1 R1-C) — 상세가 서버 정본으로 돌아가거나 초안을 남기는 데 쓴다. 세대가 바뀌었으면 stale. */
export type LateSettled = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'stale' }
/**
 * 만들기(LIFE-604) — 진입 하나(빠른 생성 모달 · 인라인 입력 하나)가 `lockKey` 를 갖고, 그 열쇠의 만들기는 **끝날 때까지 하나**다(C9 — 출처에 멱등이 없다, F6).
 * `late`(30초 확인 지연)는 실패가 아니다 — 잠금은 답이 올 때까지 남고(다시 보내지 못함), `settled` 가 확정을 준다. 자동 재전송은 없다.
 * `stale` = 연결 세대가 바뀐 뒤 온 답 — 화면에 덧씌우지 않는다.
 */
export type CreateRequest = { lockKey: string; connectionId: string; call: Extract<WorkCall, { op: 'createItem' }> }
export type CreateSettled = { kind: 'ok'; item: WorkItem } | { kind: 'failed'; error: WorkError } | { kind: 'stale' }
export type CreateOutcome = CreateSettled | { kind: 'late'; settled: Promise<CreateSettled> }

/** 성공한 쓰기의 서버 값 — 열린 상세가 받는다. `seq` 는 같은 값이 다시 와도 알 수 있게. */
/**
 * 확정된 쓰기 결과. `sent` = 그 쓰기를 보낸 시각(`work-clock` — 상세 「확정 시각」 과 같은 시계, LIFE-623 R2-A). 늦게 도착한 옛 쓰기를 상세가 가려낸다.
 * `call` = 보낸 쓰기 — 상세가 「이 쓰기가 바꾼 칸」 을 알아 열린 초안의 기준을 자기 쓰기 때문에 묶어 두지 않는다(LIFE-632 C5 ①).
 */
export type SettledWrite = { uid: string; item: WorkItem; seq: number; sent: number; call: WorkCall }
/** 「적용됐을 수 있음」(`maybeApplied`) 으로 끝난 쓰기(상세·보드, 즉시·늦게) — 열린 상세가 받아 미확인으로 두고 단건을 다시 읽는다(LIFE-623 R4-A). */
export type UnsureWrite = { uid: string; seq: number }

type SpaceResult = { ok: true; data: SpaceData; pages: number } | { ok: false; error: WorkError }
type SpaceFetch = { state: 'pending' } | { state: 'done' } | { state: 'failed'; error: WorkError }
/** 키 조회 결과 — 그 결과를 낸 검색어에 귀속한다. 검색어가 바뀌면 새 응답 전까지 옛 결과를 보이지 않는다(R3-I). */
/** `via` = 키 일치(`findByKey`) 또는 출처 질의(`searchItems` — LIFE-605 C5). `notes` = 출처가 준 검색 안내(질의를 거부하고 텍스트로 찾은 사유 등). */
type KeySearch = { query: string; hits: { connectionId: string; item: WorkItem; via: 'key' | 'query' }[]; errors: { connectionId: string; error: WorkError }[]; notes: { connectionId: string; text: string }[] }
/** 화면에 쓴 변경 하나 — 그보다 먼저 시작한 목록 응답에 다시 적용한다(R1-F). 확인 안 된 쓰기도 이 모양으로 남긴다(R2-C). */
type Override = { seq: number; connectionId: string; generation: number; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }

const EMPTY_LOAD: TasksLoad = { spaceId: null, phase: 'idle', data: [], error: null, loadingMore: false }
const NO_SEARCH: KeySearch = { query: '', hits: [], errors: [], notes: [] }

/**
 * 렌더러 쪽 기다림 한도 — **출처 연산 전체의 시간 제한이 아니다**(R4-A). main 의 MCP 15초(`mcp-http.ts`)는 RPC 한 번의 한도이고, 연산 하나가
 * RPC 여러 번이다(LA `setPlacement` = `issue_update` 뒤 대상·체크포인트·프로젝트 `issue_get` 을 차례로) — 그래서 정상 연산도 30초를 넘을 수 있다.
 * 이 한도는 「영원히 안 오는 응답에 잠금·불러오는 중이 갇히지 않게」 만 쓴다: 넘으면 「늦음」 이고 원래 요청은 계속 기다린다.
 */
const REQUEST_TIMEOUT_MS = 30_000
/** 상세가 그 작업을 다시 받는 중 — 보드 잠금 이유·막힘 알림(R6-D). */
export const DETAIL_READING = '상세를 받는 중'

/** 요청 하나의 결과 — 한도 안에 답함 · 늦음(원래 답은 `answer` 로 계속 온다). */
type Asked = { kind: 'answered'; response: WorkResponse } | { kind: 'late'; answer: Promise<WorkResponse> }

/** 출처 요청 하나 — reject 도 `ok:false` 응답으로(R3-E). 잠금·원복 경로가 예외로 건너뛰어지지 않는다. */
async function ask({ requestId, connectionId, call }: { requestId: string; connectionId: string; call: WorkCall }): Promise<Asked> {
  const answer = window.corral.workRequest({ requestId, connectionId, call }).catch((error: unknown): WorkResponse => ({
    requestId, connectionId, ok: false, error: { kind: 'network', message: `요청이 끊겼습니다 — ${error instanceof Error ? error.message : String(error)}`, status: null },
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Asked>((resolve) => { timer = setTimeout(() => resolve({ kind: 'late', answer }), REQUEST_TIMEOUT_MS) })
  try {
    return await Promise.race([answer.then((response): Asked => ({ kind: 'answered', response })), late])
  } finally {
    clearTimeout(timer)
  }
}

/** 읽기 요청 — 늦으면 시간 초과 오류다(「다시 시도」 로 다시 받는다). 늦게 온 원래 답은 버린다. */
export async function request({ requestId, connectionId, call }: { requestId: string; connectionId: string; call: WorkCall }): Promise<WorkResponse> {
  const asked = await ask({ requestId, connectionId, call })
  return asked.kind === 'answered' ? asked.response : { requestId, connectionId, ok: false, error: { kind: 'network', message: '응답이 없습니다 — 시간이 지났습니다.', status: null } }
}

function bannerOf(error: WorkError): TasksBanner {
  switch (error.kind) {
    case 'auth': return { kind: 'auth', message: error.message }
    case 'forbidden': return { kind: 'forbidden', message: error.message }
    case 'network': return { kind: 'offline', message: error.message }
    default: return { kind: 'error', message: error.message }
  }
}

/** 끌기 의도 → 출처 연산. 판(`ifVersion`)은 싣지 않는다 — 보드 끌기는 충돌 배너가 없는 자리다(Q7: 보드는 조용히 새 값으로). */
function callOf({ item, intent, restore }: { item: WorkItem; intent: DragIntent; restore: WorkResolutionChoice | null }): WorkCall | null {
  switch (intent.kind) {
    // 되돌리기가 완료함·취소함으로 돌아갈 때만 그 갈래를 싣는다(R1-G) — 그 밖에는 지금처럼 갈래 없이(출처 기본).
    case 'status': return restore === null ? { op: 'changeStatus', itemId: item.id, statusKey: intent.statusKey, ifVersion: null } : { op: 'changeStatus', itemId: item.id, statusKey: intent.statusKey, ifVersion: null, resolution: restore }
    case 'reorder': return { op: 'reorder', itemId: item.id, afterId: intent.afterId }
    case 'placement': return { op: 'setPlacement', itemId: item.id, placement: intent.placement, ifVersion: null }
    case 'none': return null
  }
}

/** 되돌리기 의도 — 옮기기 전 값으로. 순서는 옮기기 전 바로 앞 작업 뒤로. */
function inverseOf({ item, intent, items }: { item: WorkItem; intent: DragIntent; items: WorkItem[] }): DragIntent {
  switch (intent.kind) {
    case 'status': return { kind: 'status', statusKey: item.statusKey }
    case 'placement': return { kind: 'placement', placement: item.placement ?? 'board' }
    case 'reorder': {
      const ordered = [...items].sort(compareRank)
      const index = ordered.findIndex((entry) => entry.id === item.id)
      return { kind: 'reorder', afterId: index > 0 ? (ordered[index - 1]?.id ?? null) : null }
    }
    case 'none': return intent
  }
}

function describe({ item, intent, statuses }: { item: WorkItem; intent: DragIntent; statuses: WorkStatus[] }): string {
  switch (intent.kind) {
    case 'status': return `${item.key} → ${statuses.find((status) => status.key === intent.statusKey)?.label ?? '다른 상태'}`
    case 'placement': return `${item.key} → ${intent.placement === 'board' ? '보드' : '백로그'}`
    case 'reorder': return `${item.key} 순서를 옮겼습니다`
    case 'none': return item.key
  }
}

/** 정합화·되돌리기 수명의 갈래(LIFE-622) — 카드 하나 안에서 연산마다. */
function laneOf({ uid, op }: { uid: string; op: WorkCall['op'] }): string {
  return `${uid}|${op}`
}

/** 작업 하나의 상태·분류·배치·완료 시각을 그 값으로(순서 값은 둔다). doneAt 은 보드 숨김 판정이 기댄다(LIFE-702 F1). */
function setFields({ item }: { item: WorkItem }): (items: WorkItem[]) => WorkItem[] {
  return (items) => items.map((entry) => (entry.id === item.id ? { ...entry, statusKey: item.statusKey, category: item.category, placement: item.placement, doneAt: item.doneAt } : entry))
}

/** 목록 자료의 작업을 서버 값으로 — 목록은 가벼운 모양(본문·연결 null)을 지킨다. */
function replaceItem({ item }: { item: WorkItem }): (items: WorkItem[]) => WorkItem[] {
  return (items) => items.map((entry) => (entry.id === item.id ? { ...item, body: entry.body, relations: entry.relations } : entry))
}

/** 목록 끝에 붙들어 두는 만든 작업 수 상한(R1-B). */
const CREATED_CAP = 20

/**
 * 만든 작업을 목록 끝에 — 받은 쪽에 이미 있으면 그 값(서버 목록)을 쓰고 기록을 지운다. 다 받았는데(다음 쪽 없음 · 상한에 잘리지 않음) 없으면
 * 기록만 지운다(다른 곳으로 옮겨졌거나 지워졌다 — 화면에 남기지 않는다). 아직 받지 않은 쪽이 있거나 목록이 상한에 잘렸으면(`truncated`, R4-D —
 * LA 부모당 200) 다 받은 목록이 아니므로 서버가 돌려준 값으로 끝에 둔다(LIFE-604).
 */
function withCreated({ data, created }: { data: SpaceData; created: Map<string, { connectionId: string; spaceKey: string; item: WorkItem }> }): WorkItem[] {
  const extra: WorkItem[] = []
  for (const [uid, entry] of created) {
    if (entry.connectionId !== data.connectionId || entry.spaceKey !== data.spaceKey) continue
    if (data.items.some((item) => item.id === entry.item.id) || (data.nextCursor === null && !data.truncated)) { created.delete(uid); continue }
    extra.push({ ...entry.item, body: null, relations: null })
  }
  return extra.length === 0 ? data.items : [...data.items, ...extra]
}

/** 완료 분류를 넘나들었나 — 그 작업이 막던 작업의 막힘 표시가 바뀐다(R2-J). */
function crossesDone({ from, to }: { from: WorkItem; to: WorkItem }): boolean {
  return (from.category === 'done') !== (to.category === 'done')
}

function patternOf({ settings, sourceId }: { settings: WorkSettingsState; sourceId: string }): string | null {
  return settings.sources.find((source) => source.id === sourceId)?.keyPattern ?? null
}

/** 출처 질의 모양(LIFE-605 C5) — descriptor `queryPattern` 이 있고 능력 `querySearch` 가 켜진 연결만. 아니면 null(글로 거른다). */
function queryPatternOf({ settings, connectionId }: { settings: WorkSettingsState; connectionId: string }): string | null {
  const connection = settings.connections.find((entry) => entry.id === connectionId)
  if (connection === undefined || connection.capabilities?.querySearch.state !== 'on') return null
  return settings.sources.find((source) => source.id === connection.sourceId)?.queryPattern ?? null
}

/** 질의 검색을 보내기 전 입력이 멈춰야 하는 시간(R1-D). */
export const SEARCH_DEBOUNCE_MS = 300

/** 질의 검색 스페이스를 계약 상한(`WORK_SEARCH_SPACES_MAX`)씩 나눈다(R1-D) — 넘으면 출처가 invalid_request 로 거절한다. 다른 호출은 그대로. */
export function splitSearchCalls(calls: { connectionId: string; call: WorkCall }[]): { connectionId: string; call: WorkCall }[] {
  return calls.flatMap(({ connectionId, call }) => {
    if (call.op !== 'searchItems') return [{ connectionId, call }]
    const out: { connectionId: string; call: WorkCall }[] = []
    for (let index = 0; index < call.spaceKeys.length; index += WORK_SEARCH_SPACES_MAX) out.push({ connectionId, call: { ...call, spaceKeys: call.spaceKeys.slice(index, index + WORK_SEARCH_SPACES_MAX) } })
    return out
  })
}

/** 검색어가 출처 질의 모양인가 — 모양 글이 잘못된 정규식이면 질의로 보지 않는다(글로 거른다). */
export function looksLikeQuery({ query, pattern }: { query: string; pattern: string | null }): boolean {
  if (pattern === null || query.trim().length === 0) return false
  try {
    return new RegExp(pattern, 'i').test(query)
  } catch {
    return false
  }
}

const NO_UNREAD: ReadonlySet<string> = new Set()

export function useTasksPage({ open, repos, activeRepoRoot, notify, unreadPanes = NO_UNREAD }: {
  open: boolean
  repos: RepoRow[]
  activeRepoRoot: string | null
  /** 사이드바와 같은 안 읽음 pane 집합(`useUnread`) — 링크된 worktree 의 점이 사이드바와 같게(LIFE-603 C10). */
  unreadPanes?: ReadonlySet<string>
  notify: (notice: MoveNotice) => void
}) {
  const gate = useRef(new LatestGate()).current
  const [prefs, setPrefsState] = useState<TasksPrefs>(DEFAULT_TASKS_PREFS)
  const [prefsReady, setPrefsReady] = useState(false)
  const [settings, setSettings] = useState<WorkSettingsState | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [space, setSpace] = useState<TasksSpace | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 성공한 쓰기의 서버 값 — 열린 상세가 받는다(LIFE-602). */
  const [settledWrite, setSettledWrite] = useState<SettledWrite | null>(null)
  const settledSeq = useRef(0)
  /** 적용됐을 수 있는 실패 — 서버 값이 쓰기 전 base 와 다를 수 있다. 열린 상세가 정본을 다시 받을 때까지 쓰기를 막는다(LIFE-623 R4-A). */
  const [unsureWrite, setUnsureWrite] = useState<UnsureWrite | null>(null)
  const unsureSeq = useRef(0)
  const markUnsure = useCallback(({ uid, error }: { uid: string; error: WorkError }): void => {
    if (error.maybeApplied !== true) return
    unsureSeq.current += 1
    setUnsureWrite({ uid, seq: unsureSeq.current })
  }, [])
  const [load, setLoad] = useState<TasksLoad>(EMPTY_LOAD)
  /** 스페이스 자료를 다시 읽은 횟수(LIFE-745) — 부모 보충 결과가 이 값이 바뀔 때까지 재사용된다. */
  const [readSeq, setReadSeq] = useState(0)
  const [search, setSearch] = useState<KeySearch>(NO_SEARCH)
  const [working, setWorking] = useState<Map<string, StoredLookup>>(new Map())
  const [transitions, setTransitions] = useState<TasksTransitions>(null)
  const [spaceFetch, setSpaceFetch] = useState<ReadonlyMap<string, SpaceFetch>>(new Map())
  const loadRef = useRef(load)
  loadRef.current = load
  const overrides = useRef<Override[]>([])
  const writeSeq = useRef(0)
  /** 확인 안 된 쓰기 — 카드(uid)마다 하나. 있으면 그 카드의 끌기·되돌리기는 잠긴다(R2-A). */
  const pendingWrites = useRef(new Map<string, Override>())
  /** 확인 안 된 쓰기 중 순서 쓰기 — 같은 스페이스의 순서 쓰기가 다 끝나면 서버에서 다시 읽는다(R3-A). */
  const reorders = useRef(new WeakSet<Override>())
  /** 확인이 늦은 쓰기(R4-A) — 잠금은 풀었지만 답이 올 때까지 목록 응답에 다시 적용한다(낙관적 값 유지). */
  const lagging = useRef(new Set<Override>())
  /** 다시 적용할 기록이 없는 확정(순서 성공·늦은 답) 수 — 목록 요청 뒤 이 값이 바뀌었으면 그 응답은 버리고 다시 읽는다(R4-C). */
  const settles = useRef(0)
  /** 정합화 단위(LIFE-622 R5-A) — 카드(uid)마다 답이 안 온 쓰기(보드·상세, 잠금 중·늦음). */
  const outstanding = useRef(new Map<string, Set<Override>>())
  /** 단위 안에서 쓰기가 겹친 카드 — 마지막 답이 오면 서버를 다시 읽는다. */
  const overlapped = useRef(new Set<string>())
  /** 카드·갈래(`uid|연산`)마다 가장 나중에 시작한 쓰기 — 재조회 재적용·되돌리기 수명이 이것과 견준다(R5-A·B). */
  const latestWrite = useRef(new Map<string, Override>())
  const writeLane = useRef(new WeakMap<Override, string>())
  /**
   * 실패한 쓰기가 남긴 「화면이 아직 서버가 아닐 수 있는」 갈래(LIFE-622 수정 1 R1-B) — 값 = 실패 시각(`doubtClock`). 그 실패 **뒤에 시작한** 재조회가 화면에 쓰이면 지운다.
   * 그동안 같은 갈래에서 시작한 쓰기는 「옮기기 전 값」 이 확인된 값이라고 할 수 없다.
   */
  const doubt = useRef(new Map<string, number>())
  const doubtClock = useRef(0)
  /** 성공이 확정된 쓰기 — 겹친 앞 쓰기가 모두 성공했으면 뒤 쓰기의 「옮기기 전 값」 은 확인된 값이다(R1-B). */
  const succeeded = useRef(new WeakSet<Override>())
  /** 쓰기 실패·완료 분류 변경 뒤 서버 재조회 — `reload` 는 아래에서 정의된다. */
  const reloadRef = useRef<(options: { quiet: boolean }) => Promise<string[]>>(async () => [])
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  /**
   * 답이 안 온 쓰기가 있는 카드(uid) — 잠금 중이든 30초 늦음이든(정합화 단위 `outstanding` 그대로, LIFE-632 C5). 열린 상세는 이 카드의 쓰기를 막고 기다린다:
   * 앞 쓰기의 새 판을 모르는 쓰기가 나가 자기 충돌 배너가 되지 않게. 앞 쓰기의 답(성공·실패·버림)·세대 교체로 빠진다 — 출처 호출은 시간 초과가 있어 유한하다.
   */
  const [unanswered, setUnanswered] = useState<ReadonlySet<string>>(new Set())
  /** 상세 단건 읽기가 진행 중인 카드(uid → 수) — 보드 쓰기(끌기·되돌리기)도 막는다(LIFE-602 R6-D). */
  const detailReads = useRef(new Map<string, number>())
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  /** 보드 쓰기 시작 — 열린 상세가 받아 같은 작업의 되돌리기 토스트를 지운다(R6-B). */
  const [startedWrite, setStartedWrite] = useState<{ uid: string; seq: number } | null>(null)
  /**
   * 만든 작업(LIFE-604) — 서버가 돌려준 값(정본). 커서 페이지 출처는 새 작업이 아직 받지 않은 쪽에 있을 수 있어,
   * 받은 쪽에 나올 때까지(또는 다 받았는데 없으면 버림) 목록 끝에 둔다. 같은 id 는 한 장만.
   */
  const createdRef = useRef(new Map<string, { connectionId: string; spaceKey: string; item: WorkItem }>())
  /**
   * 만든 작업의 서버 값이 새로 오면(쓰기 확정·늦은 답) 기록도 그 값으로(R1-B) — 옛 스냅샷이 재조회 뒤 서버가 바꾼 값을 덮지 않는다.
   * 다른 스페이스로 옮겨졌으면 그 스페이스 몫이 된다(이 스페이스 목록에는 남지 않는다).
   */
  const keepCreated = useCallback(({ connectionId, item }: { connectionId: string; item: WorkItem }) => {
    const uid = itemUid({ connectionId, itemId: item.id })
    if (createdRef.current.has(uid)) createdRef.current.set(uid, { connectionId, spaceKey: item.spaceKey, item })
  }, [])
  /** 스페이스 자료(연결·스페이스)마다 받아 둔 쪽 수 — 다시 열 때 그만큼 다시 받는다(R1-N). */
  const pagesRef = useRef(new Map<string, number>())

  // --- 영속 ---
  useEffect(() => {
    let alive = true
    void window.corral.getUiPrefs().then((value) => {
      if (!alive) return
      setPrefsState(readTasksPrefs(value.tasksPage))
      setPrefsReady(true)
    }).catch(() => setPrefsReady(true))
    return () => { alive = false }
  }, [])
  const setPrefs = useCallback((patch: Partial<TasksPrefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch }
      window.corral.setUiPrefs({ tasksPage: next })
      return next
    })
  }, [])
  // 열린 상세(LIFE-602 C1) — 불러온 뒤 한 번 복원하고, 그 뒤 선택이 바뀌면 남긴다.
  const detailRestored = useRef(false)
  useEffect(() => {
    if (!prefsReady || detailRestored.current) return
    detailRestored.current = true
    if (prefs.detail !== null) setSelectedId(itemUid(prefs.detail))
  }, [prefsReady, prefs.detail])
  useEffect(() => {
    if (!detailRestored.current) return
    const next = selectedId === null ? null : parseUid(selectedId)
    const same = next === null ? prefs.detail === null : prefs.detail !== null && prefs.detail.connectionId === next.connectionId && prefs.detail.itemId === next.itemId
    if (!same) setPrefs({ detail: next })
  }, [selectedId, prefs.detail, setPrefs])

  // --- 연결·스페이스 ---
  useEffect(() => {
    let alive = true
    void window.corral.getWorkSettings().then((value) => { if (alive && value !== null) setSettings(value) })
    const off = window.corral.onWorkSettings((value) => setSettings(value))
    return () => { alive = false; off() }
  }, [])
  const groups = useMemo(() => (settings === null ? [] : spaceGroups({ settings, repoRoot: activeRepoRoot })), [settings, activeRepoRoot])

  const send = useCallback(async ({ key, connectionId, call }: { key: string; connectionId: string; call: WorkCall }): Promise<{ accepted: boolean; response: WorkResponse }> => {
    const requestId = gate.issue(key)
    const response = await request({ requestId, connectionId, call })
    return { accepted: response.requestId === requestId && gate.accepts({ key, requestId }), response }
  }, [gate])

  // 스페이스 목록을 아직 못 받은 연결은 열 때 **연결 세대마다 한 번** 받는다(R1-C). 실패는 보존하고 「다시 시도」 까지 다시 보내지 않는다 —
  // 실패도 main 이 상태를 push 하므로, push 마다 다시 보내면 끝없이 돈다.
  useEffect(() => {
    if (!open || settings === null) return
    for (const connection of settings.connections) {
      if (connection.spaces !== null || connection.status === 'testing') continue
      const key = `${connection.id}#${connection.generation}`
      if (spaceFetch.has(key)) continue
      setSpaceFetch((current) => new Map(current).set(key, { state: 'pending' }))
      void send({ key: `spaces:${key}`, connectionId: connection.id, call: { op: 'listSpaces' } }).then(({ response }) => {
        setSpaceFetch((current) => new Map(current).set(key, response.ok ? { state: 'done' } : { state: 'failed', error: response.error }))
      })
    }
  }, [open, settings, spaceFetch, send])
  const spaceErrors = useMemo(() => (settings === null ? [] : settings.connections.flatMap((connection) => {
    const fetched = spaceFetch.get(`${connection.id}#${connection.generation}`)
    return connection.spaces === null && fetched?.state === 'failed' ? [{ connectionId: connection.id, error: fetched.error }] : []
  })), [settings, spaceFetch])
  const failedSpaces = useMemo(() => new Set(spaceErrors.map((entry) => entry.connectionId)), [spaceErrors])

  // 스페이스 선택(C2·R1-D) — 첫 선택은 이 실행에서 한 번, 그 뒤엔 유효성만 본다(재열기에 레포 기본이 사용자 선택을 덮지 않는다).
  const decided = useRef(false)
  useEffect(() => {
    if (!open || !prefsReady || settings === null) return
    if (decided.current) {
      if (space !== null && spaceStillValid({ groups, settings, space, failed: failedSpaces })) return
      const pick = initialSpace({ groups, settings, repoRoot: activeRepoRoot, last: null, failed: failedSpaces })
      if (pick.kind === 'wait' || sameSpace(pick.space, space)) return
      setSpace(pick.space)
      setSelectedId(null)
      if (pick.space !== null) setPrefs({ space: pick.space })
      return
    }
    const pick = initialSpace({ groups, settings, repoRoot: activeRepoRoot, last: prefs.space, failed: failedSpaces })
    if (pick.kind === 'wait') return
    decided.current = true
    setSpace(pick.space)
    // 자동으로 고른 스페이스도 「마지막으로 본 스페이스」 다 — 재시작 뒤 첫 진입 규칙(C2)의 두 번째 갈래가 이 값을 본다.
    if (pick.space !== null && !sameSpace(pick.space, prefs.space)) setPrefs({ space: pick.space })
  }, [open, prefsReady, settings, groups, activeRepoRoot, space, prefs.space, setPrefs, failedSpaces])

  const chooseSpace = useCallback((next: TasksSpace) => {
    decided.current = true
    setSpace(next)
    setSelectedId(null)
    setPrefs({ space: next })
  }, [setPrefs])

  // --- 불러오기 ---
  const targets = useMemo((): { connectionId: string; spaceKey: string; spaceName: string; color: string | null; colorIndex: number }[] => {
    if (space === null || settings === null) return []
    const rows = groups.flatMap((group) => group.rows)
    if (space.kind === 'all') return rows.map((row) => ({ connectionId: row.connectionId, spaceKey: row.key, spaceName: row.name, color: row.color, colorIndex: row.colorIndex }))
    const row = rows.find((entry) => entry.connectionId === space.connectionId && entry.key === space.spaceKey)
    if (row === undefined && !spaceStillValid({ groups, settings, space, failed: failedSpaces })) return []
    return [{ connectionId: space.connectionId, spaceKey: space.spaceKey, spaceName: row?.name ?? space.spaceKey, color: row?.color ?? null, colorIndex: row?.colorIndex ?? 1 }]
  }, [space, groups, settings, failedSpaces])
  // 연결 세대를 넣는다(R2-E) — 같은 스페이스 id 로 토큰(계정)이 바뀌어도 다시 받는다.
  const generationOf = (connectionId: string): number => settings?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0
  /** 지금(응답을 받는 시점) 연결 세대 — await 를 넘어 읽으므로 ref 로(R3-D). */
  const currentGeneration = useCallback((connectionId: string): number => settingsRef.current?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0, [])
  // 세대가 바뀌면 이전 세대의 확인 안 된 쓰기는 잠금을 풀고 버린다 — 새 자료에 다시 적용하지 않는다(R3-D). 그 응답은 move 가 버린다.
  const generationsId = settings === null ? '' : settings.connections.map((connection) => `${connection.id}#${connection.generation}`).join('|')
  useEffect(() => {
    const stale = [...pendingWrites.current].filter(([, entry]) => entry.generation !== currentGeneration(entry.connectionId))
    overrides.current = overrides.current.filter((entry) => entry.generation === currentGeneration(entry.connectionId))
    for (const entry of lagging.current) if (entry.generation !== currentGeneration(entry.connectionId)) lagging.current.delete(entry)
    for (const [uid, open] of outstanding.current) {
      for (const entry of open) if (entry.generation !== currentGeneration(entry.connectionId)) open.delete(entry)
      if (open.size === 0) { outstanding.current.delete(uid); overlapped.current.delete(uid) }
    }
    setUnanswered(new Set(outstanding.current.keys()))
    // 옛 세대의 마지막 쓰기 기록은 쓸 데가 없다(그 되돌리기는 세대 검사가 막는다) — 놓아 준다(R1-F).
    for (const [lane, entry] of latestWrite.current) if (entry.generation !== currentGeneration(entry.connectionId)) latestWrite.current.delete(lane)
    if (stale.length === 0) return
    for (const [uid] of stale) pendingWrites.current.delete(uid)
    setBusy(new Set(pendingWrites.current.keys()))
  }, [generationsId, currentGeneration])
  const targetsId = targets.map((target) => `${target.connectionId}#${generationOf(target.connectionId)}::${target.spaceKey}`).join('|')

  /** 화면 자료에 변경 하나를 쓰고, 순번을 달아 남긴다(R1-F). */
  /**
   * 목록 끝에 붙들어 둔 만든 작업(받은 쪽 밖)을 단건으로 다시 읽는다(R1-B) — 출처에서 바뀌었으면 그 값으로, 다른 스페이스로 옮겨졌으면 이 목록에서 빼고,
   * 없어졌으면(거절) 기록을 버린다. 확인 안 된 쓰기가 있는 작업·그사이 새 값이 들어온 기록·세대가 바뀐 연결은 건드리지 않는다.
   */
  const refreshCreated = useCallback(async (data: SpaceData[]) => {
    // 남은 기록 = 받은 쪽 밖이라 `withCreated` 가 끝에 붙인 것(받은 쪽에 나왔거나 다 받았으면 거기서 지워졌다).
    const held = [...createdRef.current.entries()].filter(([, entry]) => data.some((space) => space.connectionId === entry.connectionId && space.spaceKey === entry.spaceKey))
    await Promise.all(held.map(async ([uid, entry]) => {
      const generation = currentGeneration(entry.connectionId)
      const response = await request({ requestId: `created:${uid}`, connectionId: entry.connectionId, call: { op: 'getItem', itemId: entry.item.id } })
      if (createdRef.current.get(uid) !== entry || pendingWrites.current.has(uid) || generation !== currentGeneration(entry.connectionId)) return
      if (!response.ok) {
        if (response.error.kind !== 'rejected') return
        createdRef.current.delete(uid)
        setLoad((value) => ({ ...value, data: value.data.map((space) => (space.connectionId === entry.connectionId && space.spaceKey === entry.spaceKey ? { ...space, items: space.items.filter((item) => item.id !== entry.item.id) } : space)) }))
        return
      }
      if (response.result.op !== 'getItem') return
      const fresh = response.result.item
      createdRef.current.set(uid, { connectionId: entry.connectionId, spaceKey: fresh.spaceKey, item: fresh })
      const shown = { ...fresh, body: null, relations: null }
      setLoad((value) => ({
        ...value,
        data: value.data.map((space) => {
          if (space.connectionId !== entry.connectionId || !space.items.some((item) => item.id === fresh.id)) return space
          return { ...space, items: space.spaceKey === fresh.spaceKey ? space.items.map((item) => (item.id === fresh.id ? shown : item)) : space.items.filter((item) => item.id !== fresh.id) }
        }),
      }))
    }))
  }, [currentGeneration])

  /** 그 카드의 가장 나중 쓰기인가(카드에 묶이지 않은 변경은 늘 참). */
  const isLatest = (entry: Override): boolean => {
    const lane = writeLane.current.get(entry)
    return lane === undefined || latestWrite.current.get(lane) === entry
  }
  /**
   * 쓰기 시작 — 정합화 단위에 넣는다. 이미 답이 안 온 쓰기가 있으면 겹침으로 적는다. 갈래 = 연산 이름.
   * 돌려주는 값 = 이 쓰기의 「옮기기 전 값」 이 확인된 값인지 나중에(확정 때) 묻는 함수(R1-B). 확인된 값이 아닐 수 있는 경우:
   * 시작할 때 같은 갈래에 답이 안 온 앞 쓰기가 있었고(30초 늦음으로 잠금이 풀린 카드) 그중 하나라도 아직 성공으로 확정되지 않았다 ·
   * 실패한 쓰기 뒤 아직 서버를 다시 받지 못한 갈래에서 시작했다. 앞 쓰기가 모두 성공했으면 옮기기 전 값 = 마지막 앞 의도 = 서버가 인정한 값이다.
   */
  const beginWrite = useCallback(({ uid, written, op }: { uid: string; written: Override; op: WorkCall['op'] }): (() => boolean) => {
    const open = outstanding.current.get(uid) ?? new Set<Override>()
    const lane = laneOf({ uid, op })
    const doubted = doubt.current.has(lane)
    const before = [...open].filter((entry) => writeLane.current.get(entry) === lane)
    const unsure = (): boolean => doubted || before.some((entry) => !succeeded.current.has(entry))
    if (open.size > 0) overlapped.current.add(uid)
    open.add(written)
    outstanding.current.set(uid, open)
    setUnanswered(new Set(outstanding.current.keys()))
    latestWrite.current.set(lane, written)
    writeLane.current.set(written, lane)
    return unsure
  }, [])
  /** 쓰기 실패 — 그 갈래의 화면은 서버를 다시 받을 때까지 미확인이다(R1-B). */
  const doubtLane = useCallback(({ written }: { written: Override }): void => {
    const lane = writeLane.current.get(written)
    if (lane === undefined) return
    doubtClock.current += 1
    doubt.current.set(lane, doubtClock.current)
  }, [])
  /** 쓰기의 답(즉시·늦게·버림) — 단위에서 뺀다. 단위의 마지막 답이고 겹쳤으면 true(부르는 쪽이 서버를 다시 읽는다). */
  const endWrite = useCallback(({ uid, written }: { uid: string; written: Override }): boolean => {
    const open = outstanding.current.get(uid)
    open?.delete(written)
    if (open !== undefined && open.size > 0) return false
    outstanding.current.delete(uid)
    setUnanswered(new Set(outstanding.current.keys()))
    return overlapped.current.delete(uid)
  }, [])
  /** 단위 정합화 — 서버 정본으로(목록·작업 중·키 조회). 이미 나간 목록 요청은 그 전 값일 수 있어 버린다(R4-C). */
  const reconcileUnit = useCallback((): void => {
    settles.current += 1
    void reloadRef.current({ quiet: true })
    setWorkingRound((value) => value + 1)
    setSearchRound((value) => value + 1)
  }, [])

  const patch = useCallback(({ connectionId, spaceKey, apply }: { connectionId: string; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }): Override => {
    writeSeq.current += 1
    const entry: Override = { seq: writeSeq.current, connectionId, generation: currentGeneration(connectionId), spaceKey, apply }
    overrides.current.push(entry)
    setLoad((value) => ({ ...value, data: value.data.map((data) => (data.connectionId === connectionId && data.spaceKey === spaceKey ? { ...data, items: apply(data.items) } : data)) }))
    return entry
  }, [])

  /**
   * 목록 다시 받기 — 돌려주는 값 = 이번에 **실제로 받아 화면에 쓴** (연결, 스페이스) 열쇠(`연결::스페이스`). 실패한 대상·버려진 응답(겹친 재조회·세대 바뀜)은 없다.
   * 「목록 다시 확인」(LIFE-604 R2-A)이 이걸로 확인 여부를 가른다.
   */
  const reload = useCallback(async ({ quiet }: { quiet: boolean }): Promise<string[]> => {
    if (space === null) { setLoad(EMPTY_LOAD); return [] }
    const id = spaceId(space)
    gate.invalidate('more')
    const token = gate.issue('load')
    const startSeq = writeSeq.current
    const startSettles = settles.current
    const startDoubt = doubtClock.current
    const same = loadRef.current.spaceId === id
    setLoad((current) => (quiet && current.spaceId === id
      ? { ...current, loadingMore: false }
      : { spaceId: id, phase: 'loading', data: current.spaceId === id ? current.data : [], error: null, loadingMore: false }))
    const generations = new Map(targets.map((target) => [target.connectionId, currentGeneration(target.connectionId)]))
    const results = await Promise.all(targets.map(async (target): Promise<SpaceResult> => {
      const at = `${token}/${target.connectionId}/${target.spaceKey}`
      const [statuses, first] = await Promise.all([
        request({ requestId: `${at}/st`, connectionId: target.connectionId, call: { op: 'listStatuses', spaceKey: target.spaceKey } }),
        request({ requestId: `${at}/it`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: null } }),
      ])
      if (!statuses.ok) return { ok: false, error: statuses.error }
      if (!first.ok) return { ok: false, error: first.error }
      if (statuses.result.op !== 'listStatuses' || first.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
      let { items, nextCursor, truncated } = first.result
      let pages = 1
      // 다시 열 때는 더 받아 둔 쪽 수만큼 다시 받는다 — 아래쪽 작업·스크롤이 사라지지 않게(R1-N).
      const wanted = same ? (pagesRef.current.get(`${target.connectionId}::${target.spaceKey}`) ?? 1) : 1
      while (pages < wanted && nextCursor !== null) {
        const next = await request({ requestId: `${at}/it${pages}`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: nextCursor } })
        // 덧 쪽 실패는 오류다(R2-F) — 짧은 목록을 성공으로 그리지 않는다. 표시 자료·받아 둔 쪽 수는 그대로 둔다(아래).
        if (!next.ok) return { ok: false, error: next.error }
        if (next.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
        const known = new Set(items.map((item) => item.id))
        items = [...items, ...next.result.items.filter((item) => !known.has(item.id))]
        nextCursor = next.result.nextCursor
        truncated = next.result.truncated
        pages += 1
      }
      const data: SpaceData = {
        connectionId: target.connectionId, spaceKey: target.spaceKey, spaceName: target.spaceName, color: target.color, colorIndex: target.colorIndex,
        statuses: statuses.result.statuses, kinds: statuses.result.kinds, items, nextCursor, truncated,
      }
      return { ok: true, data, pages }
    }))
    if (!gate.accepts({ key: 'load', requestId: token })) return []
    // 요청 뒤에 순서 쓰기가 성공했거나 늦은 답이 왔으면 이 응답은 그 전 값일 수 있다 — 버리고 다시 읽는다(R4-C). 화면은 지금 그대로라 옛 순서로 깜빡이지 않는다.
    if (settles.current !== startSettles) return reloadRef.current({ quiet })
    // 다시 적용할 변경 = 이 목록 요청 **전에** 시작해 아직 확인 안 된 쓰기(R2-C) + 요청 **뒤에** 화면에 쓴 변경(옮기기·원복·응답 반영, R1-F) — 순번 순.
    const later = overrides.current.filter((entry) => entry.seq > startSeq)
    overrides.current = later
    // 다른 세대의 변경은 새 자료에 다시 적용하지 않는다(R3-D).
    // 같은 카드에 뒤에 시작한 쓰기가 있으면 옛 미확인 의도는 다시 적용하지 않는다(LIFE-622 R5-A) — 그 카드의 의도는 마지막 쓰기 하나다.
    const unsettled = [...pendingWrites.current.values(), ...lagging.current]
      .filter((entry) => entry.seq <= startSeq && isLatest(entry))
      .sort((a, b) => a.seq - b.seq)
    const replay = [...unsettled, ...later]
      .filter((entry) => entry.generation === currentGeneration(entry.connectionId))
    if (!same) pagesRef.current = new Map()
    const error = results.flatMap((result) => (result.ok ? [] : [result.error]))[0] ?? null
    const shown = loadRef.current.spaceId === id ? loadRef.current.data : []
    const data = results.flatMap((result, index) => {
      if (!result.ok) {
        // 실패한 대상은 지금 보이던 자료를 그대로 둔다(R2-F) — 받아 둔 쪽 수도 그대로.
        const target = targets[index]
        return shown.filter((entry) => entry.connectionId === target?.connectionId && entry.spaceKey === target.spaceKey)
      }
      pagesRef.current.set(`${result.data.connectionId}::${result.data.spaceKey}`, result.pages)
      const replayed = replay
        .filter((entry) => entry.connectionId === result.data.connectionId && entry.spaceKey === result.data.spaceKey)
        .reduce((current, entry) => entry.apply(current), result.data.items)
      return [{ ...result.data, items: withCreated({ data: { ...result.data, items: replayed }, created: createdRef.current }) }]
    })
    setLoad({ spaceId: id, phase: error === null ? 'ready' : 'error', data, error, loadingMore: false })
    setReadSeq((value) => value + 1)
    // 실패 뒤에 시작한 재조회가 다 받아졌다 — 그 갈래의 화면은 이제 서버 값이다(R1-B).
    if (error === null) for (const [lane, mark] of doubt.current) if (mark <= startDoubt) doubt.current.delete(lane)
    void refreshCreated(data)
    return results.flatMap((result) => (result.ok && generations.get(result.data.connectionId) === currentGeneration(result.data.connectionId) ? [`${result.data.connectionId}::${result.data.spaceKey}`] : []))
  }, [space, targets, gate, currentGeneration, refreshCreated])
  reloadRef.current = reload

  // 스페이스가 바뀌면 다시 짓고, 다시 열면 조용히 새로 받는다(지금 그림은 둔 채).
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || space === null || targets.length === 0) {
      // 대상이 0 이 되면 진행 중 불러오기도 버린다(R2-D) — 늦게 온 응답이 사라진 스페이스의 자료·배너를 되살리지 않게.
      if (open && (space === null || targets.length === 0)) { gate.invalidate('load'); loadedFor.current = null; setLoad(EMPTY_LOAD) }
      return
    }
    const key = `${spaceId(space)}#${targetsId}`
    const quiet = loadedFor.current === key
    loadedFor.current = key
    void reload({ quiet })
  }, [open, space, targetsId])

  const loadMore = useCallback(async () => {
    const current = loadRef.current
    const target = current.data.find((entry) => entry.nextCursor !== null)
    if (target === undefined || target.nextCursor === null || current.loadingMore) return
    const spaceAt = current.spaceId
    setLoad((value) => ({ ...value, loadingMore: true }))
    const { accepted, response } = await send({ key: 'more', connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: target.nextCursor } })
    // 버린 요청(정렬·필터·스페이스가 바뀌었거나 새 요청이 나갔다)은 화면을 건드리지 않는다 — `loadingMore` 는 그 뒤 요청(또는 무효화)이 가진다(R1-M).
    if (!accepted || loadRef.current.spaceId !== spaceAt) return
    if (!response.ok || response.result.op !== 'listItems') {
      const error = response.ok ? null : response.error
      setLoad((value) => ({ ...value, loadingMore: false }))
      if (error !== null) notify({ kind: 'failed', message: `더 불러오지 못했습니다 — ${error.message}` })
      return
    }
    const { items, nextCursor, truncated } = response.result
    const pagesKey = `${target.connectionId}::${target.spaceKey}`
    pagesRef.current.set(pagesKey, (pagesRef.current.get(pagesKey) ?? 1) + 1)
    setLoad((value) => ({
      ...value,
      loadingMore: false,
      data: value.data.map((entry) => (entry.connectionId === target.connectionId && entry.spaceKey === target.spaceKey
        ? { ...entry, items: [...entry.items, ...items.filter((item) => !entry.items.some((known) => known.id === item.id))], nextCursor, truncated }
        : entry)),
    }))
  }, [send, notify])
  /** 정렬·필터가 바뀌면 이어 받던 쪽을 버린다(C9). */
  const invalidateMore = useCallback(() => {
    gate.invalidate('more')
    setLoad((value) => (value.loadingMore ? { ...value, loadingMore: false } : value))
  }, [gate])

  // --- 키 검색 (E2·E3) ---
  // 조회는 「검색어 · 연결(세대) · 키 모양」 이 바뀔 때만(R1-B). settings 객체는 상태 push 마다 새로 오므로 의존하지 않는다.
  // 질의 검색은 보이는 스페이스 안에서만 — 스페이스 열기·숨기기·고른 스페이스가 바뀌면 다시 찾는다.
  const scopeOf = (current: WorkSettingsState, connectionId: string): string[] => {
    if (space?.kind === 'space') return space.connectionId === connectionId ? [space.spaceKey] : []
    return (current.connections.find((entry) => entry.id === connectionId)?.spaces ?? []).filter((entry) => !entry.hidden).map((entry) => entry.key)
  }
  const patternsId = settings === null ? '' : settings.connections.map((connection) => `${connection.id}#${connection.generation}#${patternOf({ settings, sourceId: connection.sourceId }) ?? ''}#${queryPatternOf({ settings, connectionId: connection.id }) ?? ''}#${scopeOf(settings, connection.id).join(',')}`).join('|')
  /** 「다시 시도」 가 키 조회도 다시 보내게 하는 번호(R2-G). */
  const [searchRound, setSearchRound] = useState(0)
  /** 진행 중인 키 조회 — 그동안 쓰기가 성공하면 그 응답은 쓰기 전 값일 수 있어 다시 보낸다(R4-B). */
  const finding = useRef(false)
  const patterns = useMemo(() => {
    const current = settingsRef.current
    return current === null ? [] : current.connections.map((connection) => ({ connectionId: connection.id, pattern: patternOf({ settings: current, sourceId: connection.sourceId }), queryPattern: queryPatternOf({ settings: current, connectionId: connection.id }), spaceKeys: scopeOf(current, connection.id) }))
  }, [patternsId])
  useEffect(() => {
    if (!open) { gate.invalidate('find'); finding.current = false; return }
    // 키 모양이면 키 찾기, 출처 질의 모양이면(그 연결이 질의를 받을 때) 질의 검색 — 둘 다 아니면 글로만 거른다.
    const candidates = patterns.flatMap(({ connectionId, pattern, queryPattern, spaceKeys }): { connectionId: string; call: WorkCall }[] => {
      const key = searchKey({ query, pattern })
      if (key !== null) return [{ connectionId, call: { op: 'findByKey', key } }]
      if (spaceKeys.length > 0 && looksLikeQuery({ query, pattern: queryPattern })) return [{ connectionId, call: { op: 'searchItems', spaceKeys, query: query.trim() } }]
      return []
    })
    if (candidates.length === 0) { gate.invalidate('find'); finding.current = false; setSearch(NO_SEARCH); return }
    // 질의 검색은 입력이 멈춘 뒤에만 보낸다(R1-D) — 글자마다 원격 JQL 을 보내지 않는다. 늦게 온 옛 응답은 gate 가 버린다.
    // 스페이스가 계약 상한(50)을 넘으면 50개씩 나눠 보내고 결과를 합친다.
    const calls = splitSearchCalls(candidates)
    const queried = calls.some(({ call }) => call.op === 'searchItems')
    gate.invalidate('find')
    finding.current = false
    const send = (): void => {
      const token = gate.issue('find')
      finding.current = true
      void Promise.all(calls.map(({ connectionId, call }, index) =>
        request({ requestId: `${token}/${connectionId}/${index}`, connectionId, call }).then((response) => ({ connectionId, response })),
      )).then((answers) => {
        if (!gate.accepts({ key: 'find', requestId: token })) return
        finding.current = false
        // 조회 오류는 「결과 없음」 이 아니다 — 따로 모아 배너로(R1-K).
        setSearch({
          query,
          hits: answers.flatMap(({ connectionId, response }): KeySearch['hits'] => {
            if (!response.ok) return []
            if (response.result.op === 'findByKey') return response.result.item === null ? [] : [{ connectionId, item: response.result.item, via: 'key' }]
            if (response.result.op === 'searchItems') return response.result.items.map((item) => ({ connectionId, item, via: 'query' }))
            return []
          }),
          errors: answers.flatMap(({ connectionId, response }) => {
            if (!response.ok) return [{ connectionId, error: response.error }]
            return response.result.op === 'findByKey' || response.result.op === 'searchItems' ? [] : [{ connectionId, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }]
          }),
          notes: answers.flatMap(({ connectionId, response }) => {
            if (!response.ok || response.result.op !== 'searchItems') return []
            const truncated = response.result.truncated ? '결과가 많아 앞부분만 보입니다.' : null
            const text = [response.result.note, truncated].filter((part) => part !== null).join(' ')
            return text.length === 0 ? [] : [{ connectionId, text }]
          }).filter((note, index, all) => all.findIndex((other) => other.connectionId === note.connectionId && other.text === note.text) === index),
        })
      })
    }
    if (!queried) { send(); return }
    const timer = setTimeout(send, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, query, patterns, gate, searchRound])
  const spaceNameOf = useCallback(({ connectionId, spaceKey }: { connectionId: string; spaceKey: string }): string =>
    settings?.connections.find((connection) => connection.id === connectionId)?.spaces?.find((entry) => entry.key === spaceKey)?.name ?? spaceKey, [settings])
  // 지금 검색어의 결과만 보인다 — 새 검색어의 응답이 오기 전에는 옛 키 일치·오류를 보이지 않는다(R3-I).
  const shownSearch = search.query === query ? search : NO_SEARCH
  const hits = useMemo((): SearchHit[] => shownSearch.hits.map((hit) => ({ ...hit, spaceName: spaceNameOf({ connectionId: hit.connectionId, spaceKey: hit.item.spaceKey }) })), [shownSearch, spaceNameOf])
  const searchNotes = shownSearch.notes

  // --- 작업 중 (C11 · LIFE-603 C12) ---
  // 링크 모델(명시 + 자동 − 예외, main 이 해석해 싣는다)을 읽는다 — T2 의 키 감지 읽기는 이제 쓰지 않는다. 점은 사이드바와 같은 안 읽음 집합으로.
  const linked = useMemo(() => linkedTrees({ repos, unreadPanes }), [repos, unreadPanes])
  // 설정을 받기 전·설정에 없는 연결은 묻지 않는다 — 세대 번호를 모르는 채 보냈다가 설정이 오면 또 보내게 된다(T2 와 같이 연결 목록 기준).
  const connectionIds = settings === null ? '' : settings.connections.map((connection) => connection.id).join('|')
  const workingEntries = useMemo(() => {
    const known = new Set(connectionIds === '' ? [] : connectionIds.split('|'))
    return workingFromLinks(linked).filter((entry) => known.has(entry.connectionId))
  }, [linked, connectionIds])
  const workingIds = workingEntries.map((entry) => `${entry.connectionId}#${generationOf(entry.connectionId)}::${entry.key}`).join('|')
  /** 작업 중 조회를 전부 다시 받게 하는 번호 — 완료 분류를 넘나든 쓰기 뒤(종속 작업의 막힘이 바뀐다, R3-C). */
  const [workingRound, setWorkingRound] = useState(0)
  useEffect(() => {
    if (!open) return
    for (const entry of workingEntries) {
      const id = `${entry.connectionId}::${entry.key}`
      setWorking((current) => (current.has(id) ? current : new Map(current).set(id, { state: 'loading' })))
      void send({ key: `working:${id}`, connectionId: entry.connectionId, call: { op: 'findByKey', key: entry.key } }).then(({ accepted, response }) => {
        if (!accepted) return
        const lookup: StoredLookup = !response.ok
          ? { state: 'error', message: response.error.message }
          : response.result.op !== 'findByKey' ? { state: 'error', message: '출처 응답 모양이 다릅니다.' }
            : response.result.item === null ? { state: 'missing' } : { state: 'found', item: response.result.item }
        setWorking((current) => new Map(current).set(id, lookup))
      })
    }
  }, [open, workingIds, workingRound])
  const workingLookups = useMemo(() => {
    const map = new Map<string, WorkingLookup>()
    for (const [id, lookup] of working) {
      map.set(id, lookup.state === 'found' ? { state: 'found', item: lookup.item, spaceName: spaceNameOf({ connectionId: id.slice(0, id.indexOf('::')), spaceKey: lookup.item.spaceKey }) } : lookup)
    }
    return map
  }, [working, spaceNameOf])
  const workingKeys = useMemo(() => new Set(workingEntries.map((entry) => entry.key)), [workingEntries])

  // --- 쓰기 (C7) ---
  /** 성공한 쓰기를 작업 중 보기·키 조회 결과에도 쓴다(R2-I) — 같은 열림 동안 옛 상태가 남지 않게. */
  // 쓰기 직후엔 그 키의 진행 중 작업 중 조회 응답을 버린다(R3-B) — 쓰기 전에 잡은 옛 값이 늦게 와서 덮지 않게. 찾는 중·없음이던 항목도 서버 값으로.
  // 키 조회도 같다(R4-B) — 진행 중이면 그 응답을 버리고 다시 보낸다.
  const reflect = useCallback(({ connectionId, item }: { connectionId: string; item: WorkItem }) => {
    keepCreated({ connectionId, item })
    const id = `${connectionId}::${item.key}`
    gate.invalidate(`working:${id}`)
    if (finding.current) setSearchRound((value) => value + 1)
    setWorking((current) => {
      let changed = false
      const next = new Map(current)
      for (const [known, lookup] of current) {
        const same = known === id || (lookup.state === 'found' && lookup.item.id === item.id && known.startsWith(`${connectionId}::`))
        if (!same) continue
        next.set(known, { state: 'found', item: lookup.state === 'found' ? { ...lookup.item, ...item } : item })
        changed = true
      }
      return changed ? next : current
    })
    setSearch((current) => (current.hits.some((hit) => hit.connectionId === connectionId && hit.item.id === item.id)
      ? { ...current, hits: current.hits.map((hit) => (hit.connectionId === connectionId && hit.item.id === item.id ? { ...hit, item: { ...hit.item, ...item } } : hit)) }
      : current))
  }, [gate, keepCreated])

  const move = useCallback(async ({ row, intent, undo, restore }: MoveRequest & { undo: boolean; restore: WorkResolutionChoice | null }): Promise<void> => {
    const call = callOf({ item: row.item, intent, restore })
    if (call === null) return
    const { connectionId, spaceKey, statuses } = row.space
    const uid = rowUid(row)
    // 확인 안 된 쓰기가 있는 카드는 잠근다(R2-A) — 끌기 손잡이도 잠겨 있지만 되돌리기 버튼은 여기서 막는다.
    if (pendingWrites.current.has(uid)) {
      notify({ kind: 'failed', message: `${row.item.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 하세요.` })
      return
    }
    // 상세가 그 작업을 다시 받는 중이면 보내지 않는다(R6-D) — 기다렸다 보내는 길은 없다.
    if (detailReads.current.has(uid)) {
      notify({ kind: 'failed', message: `${row.item.key} — ${DETAIL_READING}입니다. 받은 뒤 다시 하세요.` })
      return
    }
    const before = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items ?? [row.item]
    // 겹친 쓰기가 없으면 이 카드의 지금 값은 출처가 마지막으로 인정한 값(또는 마지막 재조회 값)이다 — 되돌리기·원복은 이 값으로.
    // 30초 늦음으로 잠금이 풀린 뒤 겹친 쓰기면 미확인 의도일 수 있다 — 되돌리기는 확정 때 `unsureBase()` 가 걸러 낸다(R1-B).
    const original = before.find((item) => item.id === row.item.id) ?? row.item
    const reverse = inverseOf({ item: original, intent, items: before })
    const apply = (items: WorkItem[]): WorkItem[] => applyIntent({ items, itemId: row.item.id, intent, statuses })
    const written = patch({ connectionId, spaceKey, apply })
    pendingWrites.current.set(uid, written)
    // 옮기기 전 값(`original`·`reverse`)이 겹친 미확인 의도일 수 있으면 되돌리기를 내지 않는다(R1-B) — 확정 때 묻는다.
    const unsureBase = beginWrite({ uid, written, op: call.op })
    const lane = laneOf({ uid, op: call.op })
    if (intent.kind === 'reorder') reorders.current.add(written)
    setBusy(new Set(pendingWrites.current.keys()))
    setStartedWrite({ uid, seq: written.seq })
    const requestId = gate.issue(`item:${uid}`)
    const sent = nextWorkStamp()
    let asked: Asked | null = null
    try {
      asked = await ask({ requestId, connectionId, call })
    } finally {
      // 잠금은 어떤 경로로 끝나도 푼다(R3-E) — 단 세대가 바뀌어 이미 지운 뒤 같은 카드의 새 쓰기가 잡았으면 그 잠금은 둔다.
      if (pendingWrites.current.get(uid) === written) pendingWrites.current.delete(uid)
      setBusy(new Set(pendingWrites.current.keys()))
    }
    /**
     * 성공 확정 뒤(즉시·늦게) — 열린 상세에 서버 값(확정 경로, R4-B), 되돌리기 토스트(R5-B). 되돌리기는 이 쓰기가 그 카드의 마지막 쓰기일 때만 내고,
     * 누를 때 다시 본다 — 그 사이 같은 카드에 새 쓰기가 시작됐으면 보내지 않는다(후행 쓰기를 덮지 않는다).
     */
    const confirmed = (settled: WorkItem): void => {
      succeeded.current.add(written)
      settledSeq.current += 1
      setSettledWrite({ uid, item: settled, seq: settledSeq.current, sent, call })
      if (latestWrite.current.get(lane) !== written) return
      if (undo) { notify({ kind: 'undone', label: `${original.key} 를 되돌렸습니다` }); return }
      // 앞 변경이 확인되기 전에 시작한 쓰기 — 「옮기기 전 값」 이 서버가 인정한 적 없는 값일 수 있다. 되돌리기로 그 값을 저장하지 않는다(R1-B, R2-A 보장).
      if (unsureBase()) {
        notify({ kind: 'final', label: `${describe({ item: original, intent, statuses })} · 앞 변경이 확인되기 전에 옮겨 되돌리기를 드리지 않습니다` })
        return
      }
      // 원래 완료 갈래를 다시 쓸 수 없으면 되돌리기를 내지 않는다 — 완료함으로 바꿔 끼우지 않는다(R1-G).
      const restorable = intent.kind === 'status' ? restorableResolution({ item: original, picks: picksResolution(settingsRef.current?.connections.find((connection) => connection.id === connectionId)?.capabilities ?? null) }) : null
      if (restorable !== null && !restorable.restorable) {
        notify({ kind: 'final', label: `${describe({ item: original, intent, statuses })} · ${UNRESTORABLE_RESOLUTION}` })
        return
      }
      const back = restorable !== null && restorable.restorable ? restorable.resolution : null
      notify({
        kind: 'moved',
        label: describe({ item: original, intent, statuses }),
        // 되돌리기는 옮긴 맥락(연결·스페이스·작업·이전 값)을 들고 간다 — 다른 스페이스로 옮겨 가도 역요청을 보낸다(R1-E).
        // 보내는 값 = 이 쓰기 직전 값(`reverse`) — 위 `unsureBase()` 를 지난 되돌리기만 여기 오므로 그 값은 출처가 인정한 값이다(R2-A · LIFE-622 R1-B).
        // 이 카드에 확인 안 된 쓰기가 있으면 받지 않는다 — 버튼은 남아 잠금이 풀린 뒤 다시 누를 수 있다(R4-E).
        undo: () => {
          if (pendingWrites.current.has(uid)) {
            notify({ kind: 'failed', message: `${original.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 되돌리세요.` })
            return false
          }
          if (detailReads.current.has(uid)) {
            notify({ kind: 'failed', message: `${original.key} — ${DETAIL_READING}입니다. 받은 뒤 다시 되돌리세요.` })
            return false
          }
          // 이 쓰기 뒤 같은 카드·갈래에 새 쓰기가 있었거나 세대가 바뀌었다(LIFE-622 R5-B) — 되돌리면 그 쓰기를 덮는다. 보내지 않고 버튼을 거둔다.
          if (latestWrite.current.get(lane) !== written || written.generation !== currentGeneration(connectionId)) {
            notify({ kind: 'failed', message: `${original.key} — 그 뒤 바뀐 것이 있어 되돌리지 않습니다.` })
            return true
          }
          const now = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)
          const at = now ?? row.space
          const item = now?.items.find((entry) => entry.id === original.id) ?? settled
          void move({ row: { item, space: at, status: at.statuses.find((status) => status.key === item.statusKey) ?? null }, intent: reverse, undo: true, restore: back })
          return true
        },
      })
    }
    // 세대가 바뀐 뒤 온 응답은 버린다(R3-D) — 새 자료에 반영하지도 원복하지도 않는다.
    if (written.generation !== currentGeneration(connectionId)) { endWrite({ uid, written }); return }
    if (asked.kind === 'late') {
      // 늦음은 실패가 아니다(R4-A) — 원복·실패 토스트 없이 「확인 지연」 만 알리고 낙관적 값을 둔다. 답이 오면(성공·실패 무관) 서버를 다시 읽어 맞춘다.
      lagging.current.add(written)
      notify({ kind: 'delayed', message: `${original.key} — 출처 확인이 늦어지고 있습니다. 답이 오면 서버 값으로 맞춥니다.` })
      void asked.answer.then((late) => {
        lagging.current.delete(written)
        endWrite({ uid, written })
        if (written.generation !== currentGeneration(connectionId)) return
        // 늦게 온 실패는 알린다 — 화면은 아래 재조회가 서버 값으로 되돌린다(원복을 따로 쓰지 않는다).
        if (!late.ok) notify({ kind: 'failed', message: `${original.key} — ${late.error.message}` })
        if (!late.ok) markUnsure({ uid, error: late.error })
        if (!late.ok) doubtLane({ written })
        reconcileUnit()
        // 늦은 성공(R5-B · R4-B) — 화면 값은 재조회가 정한다(이 답이 옛 값일 수 있다). 상세 확정·되돌리기만 즉시 성공과 같은 규칙으로.
        const settled = late.ok && (late.result.op === 'changeStatus' || late.result.op === 'setPlacement' || late.result.op === 'reorder') && late.result.item.id === row.item.id ? late.result.item : null
        if (settled !== null) confirmed(settled)
      })
      return
    }
    const { response } = asked
    // 단위의 마지막 답이고 쓰기가 겹쳤으면 서버를 다시 읽어 맞춘다(R5-A) — 이 답이 마지막에 왔다고 서버의 마지막 값은 아니다.
    const lastOfUnit = endWrite({ uid, written })
    const accepted = response.requestId === requestId && gate.accepts({ key: `item:${uid}`, requestId })
    const settled = response.ok && (response.result.op === 'changeStatus' || response.result.op === 'setPlacement' || response.result.op === 'reorder') ? response.result.item : null
    if (!accepted || settled === null) {
      // 실패·버린 응답·모양이 다른 응답 = 그 카드 하나만 옮기기 전 자리로(순서는 그 카드만 되돌린다, R2-B), 그리고 서버를 다시 읽어 수렴한다.
      // 역방향 의도는 doneAt 을 낙관 규칙(null)으로 두므로 이동 전 값을 되살린다 — 재조회까지 실패해도 보드 숨김 판정이 서버와 같게(LIFE-702 G1).
      patch({ connectionId, spaceKey, apply: (items) => applyIntent({ items, itemId: row.item.id, intent: reverse, statuses }).map((entry) => (entry.id === row.item.id ? { ...entry, doneAt: original.doneAt } : entry)) })
      notify({ kind: 'failed', message: `${original.key} — ${response.ok ? '출처 응답을 확인하지 못했습니다.' : response.error.message}` })
      if (!response.ok) markUnsure({ uid, error: response.error })
      doubtLane({ written })
      if (lastOfUnit) reconcileUnit()
      else void reloadRef.current({ quiet: true })
      return
    }
    if (intent.kind === 'reorder') {
      // 순서는 성공 응답에서 의도를 다시 적용하지 않는다(R3-A) — 다른 카드의 순서 쓰기와 응답이 엇갈리면 서버와 다른 순서가 남는다.
      // 같은 스페이스의 순서 쓰기가 다 끝나면 서버에서 다시 읽어 확정 순서로 맞춘다. 그때까지 화면은 낙관적 순서 그대로다.
      // 다시 적용할 기록을 남기지 않으므로, 이미 나간 목록 요청은 이 성공 전 순서일 수 있다 — 그 응답은 버리고 다시 읽는다(R4-C).
      settles.current += 1
      const reordering = [...pendingWrites.current.values()].some((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey && reorders.current.has(entry))
      if (!reordering) void reloadRef.current({ quiet: true })
    } else {
      patch({ connectionId, spaceKey, apply: setFields({ item: settled }) })
    }
    reflect({ connectionId, item: settled })
    // 완료 분류를 넘나들면 이 작업이 막던 작업의 막힘 자료가 바뀐다 — 목록·작업 중·키 조회를 서버에서 다시 읽는다(R2-J·R3-C).
    if (lastOfUnit) reconcileUnit()
    else if (crossesDone({ from: original, to: settled })) {
      void reloadRef.current({ quiet: true })
      setWorkingRound((value) => value + 1)
      setSearchRound((value) => value + 1)
    }
    confirmed(settled)
  }, [patch, gate, notify, reflect, currentGeneration, markUnsure, beginWrite, endWrite, reconcileUnit, doubtLane])

  /** 상세 단건 읽기 하나를 그 카드의 진행 중 읽기로 센다 — 돌려준 함수로 뺀다(두 번 불러도 한 번만). */
  const holdRead = useCallback((uid: string): (() => void) => {
    detailReads.current.set(uid, (detailReads.current.get(uid) ?? 0) + 1)
    setReading(new Set(detailReads.current.keys()))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (detailReads.current.get(uid) ?? 1) - 1
      if (next <= 0) detailReads.current.delete(uid)
      else detailReads.current.set(uid, next)
      setReading(new Set(detailReads.current.keys()))
    }
  }, [])

  /**
   * 상세 쓰기(LIFE-602 D3) — 끌기와 같은 잠금·세대·확인 지연. 잠겨 있으면 보내지 않고 `busy`. 실패하면 그 작업만 쓰기 전 목록 값으로 돌리고
   * 서버를 다시 읽는다. 결과 처리(충돌 배너·되돌리기 토스트)는 부르는 쪽(상세)이 한다.
   */
  const writeItem = useCallback(async ({ connectionId, spaceKey, itemId, call, optimistic }: ItemWrite): Promise<ItemWriteOutcome> => {
    const uid = itemUid({ connectionId, itemId })
    if (pendingWrites.current.has(uid)) return { kind: 'busy' }
    const listed = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items.find((item) => item.id === itemId) ?? null
    let written: Override
    if (optimistic !== null && listed !== null) {
      written = patch({ connectionId, spaceKey, apply: (items) => items.map((item) => (item.id === itemId ? optimistic(item) : item)) })
    } else {
      // 목록에 없는 작업(다른 스페이스·검색 결과)도 같은 잠금을 잡는다 — 다시 적용할 변경은 없다.
      writeSeq.current += 1
      written = { seq: writeSeq.current, connectionId, generation: currentGeneration(connectionId), spaceKey, apply: (items) => items }
    }
    pendingWrites.current.set(uid, written)
    // 상세 쓰기도 그 카드의 정합화 단위에 든다(LIFE-622 R5-A) — 늦은 보드 쓰기 뒤의 상세 쓰기가 옛 보드 의도에 덮이지 않는다.
    beginWrite({ uid, written, op: call.op })
    setBusy(new Set(pendingWrites.current.keys()))
    const requestId = gate.issue(`item:${uid}`)
    const sent = nextWorkStamp()
    let asked: Asked | null = null
    try {
      asked = await ask({ requestId, connectionId, call })
    } finally {
      if (pendingWrites.current.get(uid) === written) pendingWrites.current.delete(uid)
      setBusy(new Set(pendingWrites.current.keys()))
    }
    const revert = (): void => {
      if (listed !== null && optimistic !== null) patch({ connectionId, spaceKey, apply: (items) => items.map((item) => (item.id === itemId ? listed : item)) })
    }
    if (written.generation !== currentGeneration(connectionId)) { endWrite({ uid, written }); return { kind: 'stale' } }
    if (asked.kind === 'late') {
      lagging.current.add(written)
      notify({ kind: 'delayed', message: `${listed?.key ?? '작업'} — 출처 확인이 늦어지고 있습니다. 답이 오면 서버 값으로 맞춥니다.` })
      const settledLate = asked.answer.then((late): LateSettled => {
        lagging.current.delete(written)
        endWrite({ uid, written })
        if (written.generation !== currentGeneration(connectionId)) return { kind: 'stale' }
        if (!late.ok) notify({ kind: 'failed', message: `${listed?.key ?? '작업'} — ${late.error.message}` })
        if (!late.ok) markUnsure({ uid, error: late.error })
        if (!late.ok) doubtLane({ written })
        settles.current += 1
        void reloadRef.current({ quiet: true })
        setWorkingRound((value) => value + 1)
        setSearchRound((value) => value + 1)
        if (!late.ok) return { kind: 'failed', error: late.error }
        succeeded.current.add(written)
        // 늦게 성공한 쓰기도 열린 상세가 서버 값을 받는다(R1-C).
        const item = 'item' in late.result && late.result.item !== null && late.result.item.id === itemId ? late.result.item : null
        if (item !== null) {
          keepCreated({ connectionId, item })
          settledSeq.current += 1
          setSettledWrite({ uid, item, seq: settledSeq.current, sent, call })
        }
        return { kind: 'ok', result: late.result }
      })
      return { kind: 'late', settled: settledLate }
    }
    const { response } = asked
    // 단위의 마지막 답이고 쓰기가 겹쳤으면 서버를 다시 읽는다(R5-A) — **이 답의 화면 반영(원복·성공 patch) 뒤에**. 재조회가 먼저 시작하면 그 뒤의 patch 가
    // 「요청 뒤 화면 변경」 으로 정본 위에 다시 덮인다(수정 1 R1-A).
    const lastOfUnit = endWrite({ uid, written })
    const resync = (): void => {
      if (lastOfUnit) reconcileUnit()
      else void reloadRef.current({ quiet: true })
    }
    if (response.requestId !== requestId || !gate.accepts({ key: `item:${uid}`, requestId })) {
      revert()
      doubtLane({ written })
      resync()
      return { kind: 'stale' }
    }
    if (!response.ok) {
      revert()
      markUnsure({ uid, error: response.error })
      doubtLane({ written })
      resync()
      return { kind: 'failed', error: response.error }
    }
    const { result } = response
    succeeded.current.add(written)
    const settled = 'item' in result && result.item !== null && result.item.id === itemId ? result.item : null
    if (settled !== null) {
      patch({ connectionId, spaceKey, apply: replaceItem({ item: settled }) })
      reflect({ connectionId, item: settled })
      settledSeq.current += 1
      setSettledWrite({ uid, item: settled, seq: settledSeq.current, sent, call })
      if (lastOfUnit) reconcileUnit()
      else if (listed !== null && crossesDone({ from: listed, to: settled })) {
        void reloadRef.current({ quiet: true })
        setWorkingRound((value) => value + 1)
        setSearchRound((value) => value + 1)
      }
    } else {
      // 연결·자식 — 다른 작업의 막힘 배지·새 카드가 생긴다. 서버에서 다시 읽는다.
      resync()
    }
    return { kind: 'ok', result }
  }, [patch, gate, notify, reflect, currentGeneration, keepCreated, markUnsure, beginWrite, endWrite, reconcileUnit, doubtLane])

  // --- 만들기 (LIFE-604) ---
  const creating = useRef(new Set<string>())
  const [createBusy, setCreateBusy] = useState<ReadonlySet<string>>(new Set())
  const createSeq = useRef(0)
  /**
   * 만들기 하나 — 잠금은 `lockKey`(진입마다). 성공하면 서버에서 다시 읽어 새 작업이 정본으로 들어온다(낙관 행을 만들지 않는다 — 둘로 보일 일이 없다).
   * 늦으면 잠금을 쥔 채 `late` 를 돌려주고, 원래 답이 오면 잠금을 풀고 확정한다.
   */
  const createItem = useCallback(async ({ lockKey, connectionId, call }: CreateRequest): Promise<CreateOutcome> => {
    // 같은 진입의 앞 만들기가 아직 확정 전이면 보내지 않는다 — 화면은 그동안 「확인 중」 이라 여기 닿지 않는다(마지막 칸막이).
    if (creating.current.has(lockKey)) return { kind: 'failed', error: { kind: 'invalid_request', message: '앞 만들기를 확인하는 중입니다 — 답이 온 뒤 다시 만드세요.', status: null } }
    creating.current.add(lockKey)
    setCreateBusy(new Set(creating.current))
    const generation = currentGeneration(connectionId)
    createSeq.current += 1
    const requestId = `create:${lockKey}:${createSeq.current}`
    const release = (): void => {
      creating.current.delete(lockKey)
      setCreateBusy(new Set(creating.current))
    }
    const finish = (response: WorkResponse): CreateSettled => {
      if (generation !== currentGeneration(connectionId)) return { kind: 'stale' }
      if (!response.ok) {
        // 만들어졌을 수 있다(R1-A) — 목록을 다시 받아 새 작업이 있으면 보이게 한다. 다시 보내지는 않는다.
        if (response.error.maybeApplied === true) void reloadRef.current({ quiet: true })
        return { kind: 'failed', error: response.error }
      }
      if (response.result.op !== 'createItem') return { kind: 'failed', error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
      const { item } = response.result
      createdRef.current.set(itemUid({ connectionId, itemId: item.id }), { connectionId, spaceKey: item.spaceKey, item })
      // 상한 — 오래된 것부터 버린다(받은 쪽에 나오면 어차피 지워진다).
      for (const uid of createdRef.current.keys()) {
        if (createdRef.current.size <= CREATED_CAP) break
        createdRef.current.delete(uid)
      }
      // 지금 목록에 붙이기만 한다 — `withCreated` 는 서버에서 막 받은 목록에만 쓴다(지금 목록에는 앞서 붙인 만든 작업이 섞여 있어 「받은 쪽에 나왔다」 로 오인한다).
      const shown = { ...item, body: null, relations: null }
      setLoad((value) => ({ ...value, data: value.data.map((data) => (data.connectionId === connectionId && data.spaceKey === item.spaceKey && !data.items.some((entry) => entry.id === item.id) ? { ...data, items: [...data.items, shown] } : data)) }))
      settles.current += 1
      void reloadRef.current({ quiet: true })
      reflect({ connectionId, item })
      return { kind: 'ok', item }
    }
    const asked = await ask({ requestId, connectionId, call })
    if (asked.kind === 'late') {
      const settled = asked.answer.then((late) => {
        release()
        return finish(late)
      })
      return { kind: 'late', settled }
    }
    release()
    return finish(asked.response)
  }, [currentGeneration, reflect])

  /** 끄기 시작 — 허용 전이만인 출처면 그 작업의 허용 전이를 받는다. 받기 전·실패면 칸은 흐림(fail-closed). */
  const beginDrag = useCallback(async (row: TasksRow, mode: 'any' | 'allowed') => {
    if (mode === 'any') { setTransitions(null); return }
    const uid = rowUid(row)
    setTransitions({ uid, state: 'loading' })
    const { accepted, response } = await send({ key: 'transitions', connectionId: row.space.connectionId, call: { op: 'listTransitions', itemId: row.item.id } })
    if (!accepted) return
    if (!response.ok) { setTransitions({ uid, state: 'error', message: response.error.message }); return }
    setTransitions(response.result.op === 'listTransitions' ? { uid, state: 'ready', keys: response.result.statusKeys, blocked: response.result.blocked } : { uid, state: 'error', message: '출처 응답 모양이 다릅니다.' })
  }, [send])
  const endDrag = useCallback(() => {
    gate.invalidate('transitions')
    setTransitions(null)
  }, [gate])

  /** 배너의 「다시 시도」 — 실패한 스페이스 목록 조회를 풀고(다시 보낸다) 자료·키 조회·작업 중 조회를 다시 받는다(R2-G·R4-D). */
  const retry = useCallback(() => {
    setSpaceFetch((current) => new Map([...current].filter(([, value]) => value.state !== 'failed')))
    setSearchRound((current) => current + 1)
    setWorkingRound((current) => current + 1)
    void reload({ quiet: false })
  }, [reload])

  const rows = useMemo(() => rowsOf(load.spaceId === (space === null ? null : spaceId(space)) ? load.data : []), [load, space])

  // 배너(C5) — 불러오기 오류 → 보이는 연결의 상태 오류 → 스페이스 목록 조회 실패(「전체」 포함) → 키 조회 오류 순.
  const scope = settings === null ? [] : settings.connections.filter((connection) => space === null || space.kind === 'all' || connection.id === space.connectionId)
  const broken = scope.find((connection) => connection.status === 'auth' || connection.status === 'forbidden' || connection.status === 'offline')
  const spaceError = spaceErrors.find((entry) => scope.some((connection) => connection.id === entry.connectionId))
  const keyError = shownSearch.errors[0]
  const banner: TasksBanner | null = load.error !== null
    ? bannerOf(load.error)
    : broken !== undefined && (broken.status === 'auth' || broken.status === 'forbidden' || broken.status === 'offline')
      ? { kind: broken.status, message: broken.error?.message ?? '' }
      : spaceError !== undefined
        ? { ...bannerOf(spaceError.error), message: `스페이스 목록 — ${spaceError.error.message}` }
        : keyError !== undefined ? { ...bannerOf(keyError.error), message: `키 조회 — ${keyError.error.message}` } : null
  const connectionStatus = space?.kind === 'space' ? settings?.connections.find((connection) => connection.id === space.connectionId)?.status ?? null : null
  /** 스페이스를 고르는 중(연결은 있는데 목록을 받는 중이라 아직 못 고름). */
  const choosing = settings !== null && settings.connections.length > 0 && space === null && spaceErrors.length === 0

  return {
    prefs, setPrefs, prefsReady,
    settings, groups, space, chooseSpace, choosing,
    query, setQuery, selectedId, setSelectedId,
    load, rows, banner, connectionStatus, readSeq,
    reload, retry, loadMore, invalidateMore,
    hits, searchNotes, workingEntries, working: workingLookups, workingKeys, linked,
    move: (request: MoveRequest) => move({ ...request, undo: false, restore: null }),
    writeItem, settledWrite, unsureWrite, startedWrite, holdRead,
    /** 만들기(LIFE-604) — 진입마다 잠금 하나. `createBusy` = 지금 확정을 기다리는 잠금 열쇠. */
    createItem, createBusy,
    /** 확인 안 된 쓰기가 있는 카드(uid) — 끌기 잠금·「확인하는 중」 표시(R2-A). */
    busy,
    /** 답이 안 온 쓰기(늦음 포함)가 있는 카드(uid) — 상세 쓰기 기다림(LIFE-632 C5). */
    unanswered,
    /** 상세 단건 읽기가 진행 중인 카드(uid) — 끌기 잠금(R6-D). */
    reading,
    beginDrag, endDrag, transitions,
  }
}

export type TasksPageModel = ReturnType<typeof useTasksPage>
