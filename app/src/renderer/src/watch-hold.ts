// 열린 파일 감시 push 붙잡기 (LIFE-592 E4ⓒ · 수정 r1 R1-D) — 순수 모델. App `fileWatchState` 가 쓴다.
// 탐색기가 옮기는(또는 되살리는) 경로의 push 는 조작이 끝나고 잠시 뒤까지 화면에 반영하지 않는다(앱이 한 이동의 옛 경로 「삭제됨」 깜빡임 0).
// 다만 **버리지 않는다** — 붙잡은 동안 온 경로별 마지막 push 를 들고 있다가 풀 때 돌려준다. main 감시는 이미 본 stamp 를 다시 보내지 않으므로
// (`file-watch.ts` — 바뀐 것만 민다), 붙잡는 동안 온 실제 외부 변경(에이전트·외부 편집기)을 버리면 그 변경은 화면에 영영 안 온다(리뷰 r1 R1-D).
import { isAtOrUnder } from '../../shared/explorer-ops.js'

export type WatchPush = { root: string; rel: string; exists: boolean; stamp: string | null }
type Hold = { root: string; prefixes: readonly string[]; pending: Map<string, WatchPush> }

export type WatchHold = {
  /** 붙잡기 시작 — 돌려준 함수가 풀고, 붙잡은 동안 온 경로별 마지막 push 를 돌려준다(다른 붙잡기가 아직 그 경로를 쥐고 있으면 그쪽으로 넘긴다). */
  hold: (input: { root: string; prefixes: readonly string[] }) => () => WatchPush[]
  /** push 가 붙잡힌 경로면 들고 true(화면에 반영하지 않는다). */
  intercept: (push: WatchPush) => boolean
}

export function createWatchHold(): WatchHold {
  let holds: Hold[] = []
  const holderOf = (push: WatchPush): Hold | undefined => [...holds].reverse().find((held) => held.root === push.root && held.prefixes.some((prefix) => isAtOrUnder(push.rel, prefix)))
  return {
    hold: (input) => {
      const entry: Hold = { root: input.root, prefixes: input.prefixes, pending: new Map() }
      holds = [...holds, entry]
      return () => {
        holds = holds.filter((held) => held !== entry)
        const released: WatchPush[] = []
        for (const push of entry.pending.values()) {
          const other = holderOf(push)
          if (other === undefined) released.push(push)
          else other.pending.set(push.rel, push)
        }
        return released
      }
    },
    intercept: (push) => {
      const holder = holderOf(push)
      if (holder === undefined) return false
      holder.pending.set(push.rel, push)
      return true
    },
  }
}
