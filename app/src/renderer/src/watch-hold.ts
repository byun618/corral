// 열린 파일 감시 push 붙잡기 (LIFE-592 E4ⓒ · 수정 r1 R1-D) — 순수 모델. App `fileWatchState` 가 쓴다.
// 탐색기가 옮기는(또는 되살리는) 경로의 push 는 조작이 끝나고 잠시 뒤까지 화면에 반영하지 않는다(앱이 한 이동의 옛 경로 「삭제됨」 깜빡임 0).
// 다만 **버리지 않는다** — 붙잡은 동안 온 경로별 마지막 push 를 들고 있다가 풀 때 돌려준다. main 감시는 이미 본 stamp 를 다시 보내지 않으므로
// (`file-watch.ts` — 바뀐 것만 민다), 붙잡는 동안 온 실제 외부 변경(에이전트·외부 편집기)을 버리면 그 변경은 화면에 영영 안 온다(리뷰 r1 R1-D).
// 겹친 붙잡기(이름 변경 직후 다시 이름 변경 등)는 받은 차례로 견준다 — 오래된 붙잡기를 먼저 풀어도 옛 push 가 최신을 덮지 않는다(수정 r2 R2-I).
import { isAtOrUnder } from '../../shared/explorer-ops.js'

export type WatchPush = { root: string; rel: string; exists: boolean; stamp: string | null }
/** 받은 차례(`seq`)를 단 push — 겹친 붙잡기를 어느 순서로 풀어도 경로별로 가장 늦게 받은 것이 이긴다(수정 r2 R2-I). */
type Held = { push: WatchPush; seq: number }
type Hold = { root: string; prefixes: readonly string[]; pending: Map<string, Held> }

export type WatchHold = {
  /** 붙잡기 시작 — 돌려준 함수가 풀고, 붙잡은 동안 온 경로별 마지막 push 를 돌려준다(다른 붙잡기가 아직 그 경로를 쥐고 있으면 그쪽으로 넘긴다). */
  hold: (input: { root: string; prefixes: readonly string[] }) => () => WatchPush[]
  /** push 가 붙잡힌 경로면 들고 true(화면에 반영하지 않는다). false 면 부르는 쪽이 바로 반영한다. */
  intercept: (push: WatchPush) => boolean
}

export function createWatchHold(): WatchHold {
  let holds: Hold[] = []
  let seq = 0
  /** 경로별로 화면에 반영한(돌려준) 가장 늦은 차례 — 이보다 이른 push 는 다시 내지 않는다. */
  const applied = new Map<string, number>()
  const keyOf = (push: WatchPush): string => `${push.root}\0${push.rel}`
  const holderOf = (push: WatchPush): Hold | undefined => [...holds].reverse().find((held) => held.root === push.root && held.prefixes.some((prefix) => isAtOrUnder(push.rel, prefix)))
  /** 더 늦게 받은 것만 남긴다 — 넘겨받는 쪽이 이미 더 최신을 들고 있으면 옛것으로 덮지 않는다. */
  const keep = (hold: Hold, held: Held): void => {
    const current = hold.pending.get(held.push.rel)
    if (current === undefined || current.seq < held.seq) hold.pending.set(held.push.rel, held)
  }
  return {
    hold: (input) => {
      const entry: Hold = { root: input.root, prefixes: input.prefixes, pending: new Map() }
      holds = [...holds, entry]
      return () => {
        holds = holds.filter((held) => held !== entry)
        const released: WatchPush[] = []
        for (const held of entry.pending.values()) {
          const other = holderOf(held.push)
          if (other !== undefined) keep(other, held)
          else if (held.seq > (applied.get(keyOf(held.push)) ?? 0)) {
            applied.set(keyOf(held.push), held.seq)
            released.push(held.push)
          }
        }
        return released
      }
    },
    intercept: (push) => {
      seq += 1
      const holder = holderOf(push)
      if (holder === undefined) {
        applied.set(keyOf(push), seq)
        return false
      }
      keep(holder, { push, seq })
      return true
    },
  }
}
