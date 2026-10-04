// LIFE-496 fix2 R2-03 — l496 드라이버의 입력 안전장치 (t4-drive.mjs · t2-smoke.mjs 공용).
// (이 판은 수정 전 동작을 그대로 옮긴 것 — 테스트가 실패를 먼저 보이기 위한 단계)
export class BoundaryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoundaryError'
  }
}

/** 기다림이 시간 초과면 null. */
export async function orNull(promise) {
  try {
    return await promise
  } catch {
    return null
  }
}

/** 전역 입력(key·type) 보내기. */
export function guardedSender({ send }) {
  return async (request) => send(request)
}
