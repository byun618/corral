// LIFE-834 fix1 G2 — 마운트된 터미널 pane 의 선택 풀기를 pane id 로 부른다. ⌘V(`TerminalPane` sendGenerated)는 보내기 직전에 선택을 푼다 —
// 선택이 남으면 flush 가 프레임을 보류해 들어간 글자의 에코가 안 그려진다(LIFE-505 fix1 F1). 받아쓰기 넣기도 같은 단계를 거친다.
// 그 pane 이 화면에 없으면(다른 탭) 풀 선택도 없다 — 아무것도 하지 않는다.
const clearers = new Map<string, () => void>()

export function registerSelectionClearer(input: { paneId: string; clear: () => void }): () => void {
  clearers.set(input.paneId, input.clear)
  return () => {
    if (clearers.get(input.paneId) === input.clear) clearers.delete(input.paneId)
  }
}

export function clearTerminalSelection(paneId: string): void {
  clearers.get(paneId)?.()
}
