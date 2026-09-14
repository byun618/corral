// StatusBar 의 메모리 표시 — Chromium `performance.memory`(렌더러 JS 힙)를 1초 간격으로 읽는다.
// **실제 프로세스 RSS 가 아니다** — Node 없이 sandboxed 렌더러에서 잴 수 있는 값은 이것뿐이라
// 근사치임을 밝힌다(가짜 숫자를 보이지 않는다는 원칙, C9′ 결과 문서에 명시).

import { useEffect, useState } from 'react'

type PerformanceMemory = { usedJSHeapSize: number }
function readMemory(): PerformanceMemory | null {
  const memory: unknown = Reflect.get(performance, 'memory')
  if (memory === null || typeof memory !== 'object') return null
  const used = Reflect.get(memory, 'usedJSHeapSize')
  return typeof used === 'number' ? { usedJSHeapSize: used } : null
}

export function useMemoryLabel(): string | null {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    const tick = (): void => {
      const memory = readMemory()
      setLabel(memory === null ? null : `${(memory.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [])

  return label
}
