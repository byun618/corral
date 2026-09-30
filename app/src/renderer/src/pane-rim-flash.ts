// 사이드바 행 클릭 뒤 **pane 테두리를 한 번 번쩍인다** (LIFE-467 D11) — Orca 1.4.198
// `components/terminal-pane/focused-pane-rim-flash.ts` + `terminal.css:163-206` 이식.
//
// 에이전트가 여럿인 화면에서 "지금 어느 pane 으로 갔나" 를 눈으로 찾게 해 준다. 클래스를 붙였다가 1.5s 뒤 뗀다 —
// 모양·시간은 CSS(`styles.css` `.term-pane.pane-rim-flash`)가 쥐고, reduced-motion 이면 CSS 가 애니메이션을 끈다.
//
// 행 클릭이 worktree 를 바꾸면 그 pane 상자는 **다음 렌더**에야 생긴다(`App.tsx` `pendingRevealRef` 와 같은 사정).
// 그래서 상자가 뜰 때까지 몇 프레임 기다린다 — 끝내 안 뜨면(줌에 가려졌거나 이미 닫힘) 조용히 그만둔다.

export const PANE_RIM_FLASH_MS = 1500
const FLASH_CLASS = 'pane-rim-flash'
const MAX_WAIT_FRAMES = 30

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function flashPaneRim(paneId: string): void {
  let frames = 0
  const attempt = (): void => {
    const box = document.querySelector(`[data-term-pane-box="${CSS.escape(paneId)}"]`)
    if (box === null) {
      frames += 1
      if (frames < MAX_WAIT_FRAMES) requestAnimationFrame(attempt)
      return
    }
    // 연달아 누르면 처음부터 다시 번쩍인다 — 클래스를 뗐다가 한 프레임 뒤 다시 단다.
    const previous = timers.get(paneId)
    if (previous !== undefined) clearTimeout(previous)
    box.classList.remove(FLASH_CLASS)
    requestAnimationFrame(() => {
      box.classList.add(FLASH_CLASS)
      timers.set(
        paneId,
        setTimeout(() => {
          box.classList.remove(FLASH_CLASS)
          timers.delete(paneId)
        }, PANE_RIM_FLASH_MS),
      )
    })
  }
  attempt()
}
