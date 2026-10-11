// 실제 시계 — 전역 setTimeout 을 `Clock` 모양으로. 핸들은 번호로 들고 실제 타이머는 이 안에만 둔다.
import type { Clock } from './connection'

export function createTimerClock(): Clock {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let seq = 0
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      seq += 1
      const id = seq
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms))
      return { id }
    },
    clearTimeout: (handle) => {
      for (const [id, timer] of timers) {
        if (id !== handle.id) continue
        clearTimeout(timer)
        timers.delete(id)
      }
    },
  }
}
