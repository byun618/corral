// 탐색기 허브 구독 참조 셈 (LIFE-683 S8) — 탐색기 보기와 소스 제어 보기가 같은 루트의 감시·git 조회 한 벌을 나눠 쓴다.
// 첫 구독이 main 에 `explorerWatch on`, 마지막 해제가 `off` 를 보낸다 — 그 사이 보기 전환(해제 → 구독)이 허브 구독을 끊었다 다시 맺지 않게
// 해제는 같은 작업 틱 끝으로 미룬다(React 는 한 커밋에서 옛 효과 정리 → 새 효과를 차례로 돈다). 이미 구독된 루트에 새로 붙은 보기는
// 최신 git 상태를 받도록 다시 읽기를 한 번 요청한다(허브가 한 번 뭉쳐 push — 새 git 프로세스는 기존 예산 안). 해제를 취소한 재구독은 요청하지 않는다(F2-04).
const counts = new Map<string, number>()
const pendingOff = new Set<string>()

export function acquireExplorerWatch(root: string): () => void {
  const count = counts.get(root) ?? 0
  counts.set(root, count + 1)
  // F2-04 — 같은 틱 해제를 취소한 재구독(`pendingOff`)은 허브 구독이 끊긴 적 없어 상태가 낡지 않았다 — 다시 읽기는 진짜 두 번째 구독자만.
  const resumed = pendingOff.delete(root)
  if (count > 0) window.corral.explorerRefreshGit(root)
  else if (!resumed) void window.corral.explorerWatch({ root, on: true }).catch(() => null)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (counts.get(root) ?? 1) - 1
    if (left > 0) {
      counts.set(root, left)
      return
    }
    counts.delete(root)
    pendingOff.add(root)
    queueMicrotask(() => {
      if (!pendingOff.delete(root)) return
      void window.corral.explorerWatch({ root, on: false })
    })
  }
}
