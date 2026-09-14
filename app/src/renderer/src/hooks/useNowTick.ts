// 경과 시간 칸이 얼지 않게 하는 시계 (LIFE-366 D1).
//
// 경과 시간은 `지금 - 마지막 활동 시각` 이라 **지금이 안 움직이면 화면도 안 움직인다.**
// 상태 emit 은 데이터가 바뀔 때만 오므로, 아무 일도 안 일어나는 세션의 `3m` 은 emit 이
// 다시 올 때까지 `3m` 인 채로 있게 된다 — 그건 얼어붙은 숫자다.
//
// 한 곳에서만 돌린다(사이드바 조립부) — 행마다 타이머를 두면 세션 수만큼 타이머가 생긴다.
// 주기는 30초: 표시 단위가 분이라 그보다 촘촘할 이유가 없고, 그보다 성기면 `59m → 1h` 가
// 눈에 띄게 늦는다.

import { useEffect, useState } from 'react'

export const NOW_TICK_MS = 30_000

export function useNowTick(everyMs: number = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
