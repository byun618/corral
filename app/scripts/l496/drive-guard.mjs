// LIFE-496 fix2 R2-03 — l496 드라이버의 입력 안전장치 (t4-drive.mjs · t2-smoke.mjs 공용).
//
// 네이티브 회차는 사용자 herdr `default` 세션 위에서 돈다. 화면이 사용자 워크스페이스로 넘어가면 전역 입력(`key`·`type` —
// 포커스된 요소로 간다)이 사용자 pane 에 갈 수 있다. 그래서:
//   · 경계 위반(fixture 밖 탭이 탭바에 보임)은 `BoundaryError` 로 던지고, 시간 초과와 섞어 삼키지 않는다(`orNull`)
//   · 전역 입력은 보내기 직전에 확인한다 — 화면이 fixture 탭만 보이고 포커스가 fixture 영역·`+` 메뉴 안이어야 보낸다(`guardedSender`)
// 기록(record)의 ok:false 는 나중의 판정일 뿐 입력 허가가 아니다.
export class BoundaryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoundaryError'
  }
}

/** 기다림이 시간 초과면 null. **경계 위반은 그대로 던진다.** */
export async function orNull(promise) {
  try {
    return await promise
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    return null
  }
}

/**
 * 전역 입력(key·type) 보내기 — `check()` 가 `{ ok: true }` 일 때만 보낸다. `check` 가 경계 위반을 던지면 그대로 전파한다.
 * `{ ok: false, reason }` 이면 `BoundaryError` 로 멈춘다(목적지를 모르는 채 타건하지 않는다).
 */
export function guardedSender({ check, send }) {
  return async (request) => {
    const verdict = await check()
    if (!verdict.ok) throw new BoundaryError(`입력 대상 확인 실패 — ${verdict.reason ?? '이유 없음'} (${JSON.stringify(request).slice(0, 80)})`)
    return send(request)
  }
}

/** 렌더러에서 돈다 — 지금 포커스가 영역(`[data-tab-group]`) 안 또는 `+` 메뉴 안인가. 영역은 `read()` 가 fixture 탭만 보인다고 확인한 뒤라 fixture 영역이다. */
export function focusProbe() {
  const active = document.activeElement
  const inArea = active?.closest?.('[data-tab-group]') != null || active?.closest?.('[data-tab-create-menu]') != null
  return { inArea, tag: active?.tagName ?? null, className: String(active?.className ?? '').slice(0, 40) }
}
