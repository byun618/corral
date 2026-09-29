// pane 분할·리사이즈·줌·닫기·인접 이동 (LIFE-373 ②) — herdr control 소켓의 `pane.*` 쓰기 경로.
//
// **분할 트리는 herdr 것이다** (01-criteria §0-1): corral 은 클라이언트 트리를 발명하지 않고
// `pane.split`/`pane.resize` 를 부른 뒤, 그 결과가 endpoint 서피스의 rect 로 돌아오는 것을 그린다.
// 그래서 이 파일은 **명령만** 보내고 레이아웃을 읽지 않는다 — 읽는 길은 서피스 하나뿐이어야
// 진실이 둘로 갈라지지 않는다 (A6: 모든 `pane.*` 응답이 layout 을 통째로 주지만 쓰지 않는다).
//
// 스키마에서 확인한 것 (`herdr api schema --json`, protocol 22):
//   · `pane.split` 의 `direction` 은 **`right`·`down` 둘뿐**이다 (좌/상 분할은 없다).
//     `target_pane_id` 를 실을 수 있다 — CLI 에는 없는 인자라 세션 포커스와 무관하게 쏜다
//   · `pane.resize` 의 `amount` 는 **비율 델타**다 (분석 A3 실측: 0.5 →+0.05→ 0.55). 셀이 아니다
//   · `pane.zoom` 은 `mode: toggle|on|off` + `pane_id`. 서버는 **플래그만** 바꾸고 rect 는 그대로다
//     (A5 + 프리플라이트 ②: 서피스에도 안 비친다) — 그리는 건 클라이언트다
//   · `pane.neighbor`/`pane.focus_direction` 은 `{direction, pane_id?}`. **인접 계산은 서버가 한다**
//
// `layout.set_split_ratio`(절대 비율 세터)도 있지만 인자가 분할 트리의 **boolean 경로**라
// 서피스가 주는 정보만으로는 못 만든다. F2-2 가 못 박은 대로 `pane.resize` 델타로 간다.

import { isRecord, readRecord, readString } from '../../../shared/json.js'
import type { PaneDirection, PaneSplitDirection } from '../../../shared/types.js'
import { log } from '../../log.js'
import { request } from './request.js'

/** herdr 가 거절하면 **그대로 돌려준다** — corral 이 force 로 승격하지 않는다 (기준 L9). */
export type PaneOutcome = { outcome: 'ok' } | { outcome: 'rejected'; rejection: { code: string; message: string } }

function outcomeOf(input: {
  response: Awaited<ReturnType<typeof request>>
  event: string
  detail: Record<string, string | number | boolean>
}): PaneOutcome {
  if (input.response.error) {
    const rejection = {
      code: input.response.error.code ?? 'error',
      message: input.response.error.message ?? '',
    }
    log(`${input.event}_rejected`, { ...input.detail, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  log(input.event, input.detail)
  return { outcome: 'ok' }
}

/**
 * pane 을 우/하로 나눈다 (F2-1) — **새 pane 의 id 를 같이 돌려준다** (F2-7).
 *
 * `focus: false` — 분할 직후 herdr 세션 포커스를 옮기지 않는다. 포커스는 corral 이 자기 상태로
 * 들고 있고, 옮길 때는 endpoint 연결의 `pane.focus` 로 쏜다 (S2: 클릭·명시 동작에서만).
 * 그 "자기 상태"를 새 pane 으로 옮기려면 **누가 새 pane 인지**를 알아야 하는데, 서피스만 보면
 * 분할 전 목록과 대조하는 추리가 되고 그 사이 다른 pane 이 생기면 틀린다.
 *
 * `pane.split` 응답은 **`{ type: 'pane_info', pane: { pane_id } }` 하나다** (실측 — 이 파일
 * 머리말의 "모든 `pane.*` 응답이 layout 을 통째로 준다"는 분할에는 해당하지 않는다).
 * **여기서 읽는 것은 기하가 아니라 신원 하나**라 A6("배치는 서피스로만 읽는다")는 그대로다 —
 * rect·트리는 계속 안 읽는다. 이웃 이동(`pane.neighbor`)이 id 만 받아 오는 것과 같은 모양이다.
 */
export async function splitPane(input: {
  socketPath: string
  paneId: string
  direction: PaneSplitDirection
  ratio?: number
}): Promise<{ outcome: 'ok'; paneId: string | null } | { outcome: 'rejected'; rejection: { code: string; message: string } }> {
  const response = await request(
    input.socketPath,
    'pane.split',
    {
      direction: input.direction,
      target_pane_id: input.paneId,
      focus: false,
      ...(input.ratio === undefined ? {} : { ratio: input.ratio }),
    },
    { reason: 'pane-split' },
  )
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log('pane.split_rejected', { paneId: input.paneId, direction: input.direction, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  const created = readCreatedPaneId(response.result)
  log('pane.split', { paneId: input.paneId, direction: input.direction, created: created ?? '' })
  return { outcome: 'ok', paneId: created }
}

/** `{ type: 'pane_info', pane: { pane_id } }` — 봉투는 여기서 끝난다 (`readNeighborPaneId` 와 같은 결). */
function readCreatedPaneId(result: unknown): string | null {
  if (!isRecord(result)) return null
  const pane = readRecord(result, 'pane')
  if (pane === null) return null
  const paneId = readString(pane, 'pane_id')
  return paneId !== null && paneId.length > 0 ? paneId : null
}

/**
 * 경계를 민다 (F2-2). `amount` 는 **비율 델타**이므로 드래그는 `목표비 − 현재비` 한 번이면 된다 —
 * 드래그 중에는 부르지 않고 mouseup 에 1회만 부른다(그 판단은 렌더러에 있다).
 */
export async function resizePane(input: {
  socketPath: string
  paneId: string
  direction: PaneDirection
  amount: number
}): Promise<PaneOutcome> {
  const response = await request(
    input.socketPath,
    'pane.resize',
    { pane_id: input.paneId, direction: input.direction, amount: input.amount },
    { reason: 'pane-resize' },
  )
  return outcomeOf({
    response,
    event: 'pane.resize',
    detail: { paneId: input.paneId, direction: input.direction, amount: input.amount },
  })
}

/** 줌 플래그를 서버에 남긴다 (F2-3). 그림은 클라이언트가 그린다 — 서버 rect 는 안 바뀐다. */
export async function zoomPane(input: {
  socketPath: string
  paneId: string
  on: boolean
}): Promise<PaneOutcome> {
  const response = await request(
    input.socketPath,
    'pane.zoom',
    { pane_id: input.paneId, mode: input.on ? 'on' : 'off' },
    { reason: 'pane-zoom' },
  )
  return outcomeOf({ response, event: 'pane.zoom', detail: { paneId: input.paneId, on: input.on } })
}

/** pane 을 닫는다 (F2-5). 마지막 pane 이면 herdr 가 탭째 닫는다 — corral 이 따로 판정하지 않는다. */
export async function closePane(input: { socketPath: string; paneId: string; onSent?: () => void }): Promise<PaneOutcome> {
  // R3-F1 — `onSent` 는 「바이트가 나갔다」를 호출부에 그대로 넘긴다 (`lifecycle.ts` 의 `CloseHooks` 와 같은 뜻).
  const response = await request(input.socketPath, 'pane.close', { pane_id: input.paneId }, { reason: 'pane-close', onSent: input.onSent })
  return outcomeOf({ response, event: 'pane.close', detail: { paneId: input.paneId } })
}

/**
 * 방향으로 이웃 pane 을 묻는다 (F2-4) — **인접 판정은 서버가 한다**.
 *
 * `pane.focus_direction` 이 아니라 `pane.neighbor` 를 쓴다: focus_direction 은 herdr **세션 전역**
 * 포커스를 움직여 사용자의 TUI 클라이언트까지 끌고 간다. corral 이 원하는 것은 "누가 이웃인가"
 * 하나이고, 포커스는 그 다음에 자기 연결의 `pane.focus` 로 옮긴다 (S2).
 * 이웃이 없으면 `paneId: null` — 화면은 아무것도 하지 않는다.
 */
export async function neighborPane(input: {
  socketPath: string
  paneId: string
  direction: PaneDirection
}): Promise<{ outcome: 'ok'; paneId: string | null } | { outcome: 'rejected'; rejection: { code: string; message: string } }> {
  const response = await request(
    input.socketPath,
    'pane.neighbor',
    { pane_id: input.paneId, direction: input.direction },
    { reason: 'pane-neighbor' },
  )
  if (response.error) {
    const rejection = { code: response.error.code ?? 'error', message: response.error.message ?? '' }
    log('pane.neighbor_rejected', { paneId: input.paneId, direction: input.direction, ...rejection })
    return { outcome: 'rejected', rejection }
  }
  const neighbor = readNeighborPaneId(response.result)
  log('pane.neighbor', { paneId: input.paneId, direction: input.direction, neighbor: neighbor ?? '' })
  return { outcome: 'ok', paneId: neighbor }
}

/** `{ type: 'pane_neighbor', neighbor: { neighbor_pane_id } }` — herdr 봉투는 여기서 끝난다. */
function readNeighborPaneId(result: unknown): string | null {
  if (!isRecord(result)) return null
  const neighbor = readRecord(result, 'neighbor')
  if (neighbor === null) return null
  const paneId = readString(neighbor, 'neighbor_pane_id')
  return paneId !== null && paneId.length > 0 ? paneId : null
}
