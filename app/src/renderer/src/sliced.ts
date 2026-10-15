// 긴 계산을 나눠 돌린다 (LIFE-593 수정 r1 R1-C-10) — 20만 목록의 색인·검색·필터 트리를 한 번에 돌리면 렌더러 긴 작업(>100 ms)이 된다.
// 계산은 생성기로 쓰고 일정 단위마다 `yield` 한다. `drain` 은 한 번에 끝까지(시험·작은 목록), `drainSliced` 는 한 덩이 예산을 넘기면 다음 매크로태스크로 넘겨
// 그 사이 입력·그리기가 끼어들게 한다. `signal.aborted` 가 서면 멈추고 null(새 질의가 앞 계산을 버린다).

export type Steps<T> = Generator<void, T, void>

export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}

/** 다음 매크로태스크 — MessageChannel(setTimeout 의 중첩 4 ms 지연 없음). */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

/** 첫 덩이는 지금 바로 돈다(작은 목록은 기다림 없이 끝난다). */
export async function drainSliced<T>(input: { steps: Steps<T>; signal: { readonly aborted: boolean }; budgetMs?: number }): Promise<T | null> {
  const budget = input.budgetMs ?? 12
  for (;;) {
    const sliceStart = performance.now()
    for (;;) {
      if (input.signal.aborted) return null
      const next = input.steps.next()
      if (next.done === true) return next.value
      if (performance.now() - sliceStart >= budget) break
    }
    await nextTask()
  }
}
