// 파일 탭을 그 줄:열로 (LIFE-803 C5·C6) — 「열기 요청」 하나를 들고, 편집기가 준비된 때 **그 요청이 아직 현재일 때만** 한 번 적용한다.
//
// 상태 표(01-criteria C6) 한 규칙:
// · 결과 행 클릭 → `request` — 앞 요청을 대체한다(나중 요청만 산다).
// · 사용자가 다른 탭·다른 그룹을 활성화 → `activated` — 대기 요청의 탭이 아니면 적용 권리를 지운다.
// · 편집기 준비(이미 마운트 — App 이 연 뒤 한 프레임에 / 첫 마운트 — FileView 가 보기 상태 복원 **다음**에) → `take` — 저장소·탭이 요청과 같을 때만 꺼내고 지운다.
//   FileView 는 그룹의 활성 탭만 그리므로 편집기가 붙어 있다 = 그 탭이 그 그룹의 활성 탭이다.
// · 포커스(r1 보강) — 커서·보이기는 늘 적용하되 포커스는 요청이 든 `mayFocus` 가 참일 때만(요청 뒤 포커스가 옮겨 갔으면 거짓 — App 의 포커스 순번 규칙과 같은 판정).
// · 그 탭이 편집기를 붙이지 않는 상태(마크다운 미리보기·읽기 실패·바이너리·상한 초과·이미지) → `discard` — 요청을 남기지 않는다(나중에 원문으로 바꿔도 적용 0).
// 위치 인자는 일반형(줄·UTF-16 열, 둘 다 1부터 — Monaco 와 같다) — 뒤 일감(⌘P `:line`·터미널 경로)이 같은 길을 쓸 수 있다.

export type RevealTarget = { line: number; column: number }
/** `store` = worktree 별 보기 상태 저장소(FileView `ViewStateStore`) — worktree 가 다르면 같은 탭 id 라도 다른 요청이다. */
export type RevealRequest = { store: object; tabId: string; target: RevealTarget; mayFocus: () => boolean }
export type RevealTaken = { target: RevealTarget; mayFocus: () => boolean }

export class RevealSlot {
  private pending: RevealRequest | null = null

  get current(): RevealRequest | null {
    return this.pending
  }

  request(next: RevealRequest): void {
    this.pending = next
  }

  /** 활성 탭이 바뀌었다(지금 worktree 저장소·활성 탭 id) — 대기 요청의 탭이 아니면 지운다. */
  activated(input: { store: object | null; tabId: string | null }): void {
    if (this.pending === null) return
    if (this.pending.store !== input.store || this.pending.tabId !== input.tabId) this.pending = null
  }

  /** 편집기 준비 — 이 저장소·탭의 요청이면 꺼내고 지운다(한 번만 적용). */
  take(input: { store: object; tabId: string }): RevealTaken | null {
    const pending = this.pending
    if (pending === null || pending.store !== input.store || pending.tabId !== input.tabId) return null
    this.pending = null
    return { target: pending.target, mayFocus: pending.mayFocus }
  }

  /** 그 탭이 편집기를 붙이지 않는다 — 그 탭의 요청이면 버린다. */
  discard(input: { store: object; tabId: string }): void {
    this.take(input)
  }
}

/** 앱 하나에 하나 — 열기 요청은 창 전체에서 마지막 것만 산다. */
export const revealSlot = new RevealSlot()

export type RevealEditor = {
  setPosition: (position: { lineNumber: number; column: number }) => void
  revealPositionInCenterIfOutsideViewport: (position: { lineNumber: number; column: number }) => void
  focus: () => void
}

/** 커서를 그 자리로, 그 줄이 보이게(뷰 밖이면 가운데로), 포커스는 `mayFocus` 가 참일 때만. */
export function applyReveal(editor: RevealEditor, taken: RevealTaken): void {
  const position = { lineNumber: taken.target.line, column: taken.target.column }
  editor.setPosition(position)
  editor.revealPositionInCenterIfOutsideViewport(position)
  if (taken.mayFocus()) editor.focus()
}

/**
 * 요청 뒤 포커스가 옮겨 갔는가 — 요청 때 활성 요소(`from` — 누른 결과 행)에서 사용자가 다른 곳(검색 입력칸·다른 pane 등)으로 갔으면 참.
 * 그대로이거나, 아무 데도 아니거나(body·null — 누른 행이 다시 그려져 빠진 경우), 편집기 안이면 옮겨 가지 않은 것으로 본다.
 */
export function focusMovedAway(input: { from: Element | null; now: Element | null; body: Element | null }): boolean {
  const now = input.now
  if (now === null || now === input.body || now === input.from) return false
  return now.closest('[data-file-editor], [data-file-view]') === null
}
