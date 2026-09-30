// 사이드바 행 클릭 뒤 **pane 테두리를 한 번 번쩍인다** (LIFE-467 D11) — Orca 1.4.198
// `components/terminal-pane/focused-pane-rim-flash.ts` + `terminal.css:163-206` 이식.
//
// 에이전트가 여럿인 화면에서 "지금 어느 pane 으로 갔나" 를 눈으로 찾게 해 준다. 클래스를 붙였다가 1.5s 뒤 뗀다 —
// 모양·시간은 CSS(`styles.css` `.term-pane.pane-rim-flash`)가 쥔다. reduced-motion 이면 CSS 가 번쩍임(애니메이션)만
// 끄고 **정적인 테두리가 1.5s 남는다** — 표시가 없어지는 것이 아니다.
//
// 행 클릭이 worktree 를 바꾸면 그 pane 상자는 **다음 렌더**에야 생긴다(`App.tsx` `pendingRevealRef` 와 같은 사정).
// 그래서 상자가 뜰 때까지 몇 프레임 기다린다 — 끝내 안 뜨면(줌에 가려졌거나 이미 닫힘) 조용히 그만둔다.
//
// ## 요청 세대 (LIFE-467 R8)
//
// 연달아 누르면 **마지막 요청만** 번쩍임을 소유한다. 전에는 타이머 취소를 RAF 예약 **전에** 해서, 같은 프레임에 두 요청이
// 풀리면 앞 요청의 타이머가 살아남아 뒤 요청의 번쩍임을 일찍 지우고 뒤 요청의 표 항목까지 지웠다. 이제 pane 마다 세대를 세고,
// 프레임·타이머 콜백은 자기 세대가 아직 최신일 때만 손을 댄다.

export const PANE_RIM_FLASH_MS = 1500
const FLASH_CLASS = 'pane-rim-flash'
const MAX_WAIT_FRAMES = 30

const generations = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function flashPaneRim(paneId: string): void {
  const generation = (generations.get(paneId) ?? 0) + 1
  generations.set(paneId, generation)
  const current = (): boolean => generations.get(paneId) === generation
  let frames = 0
  const attempt = (): void => {
    if (!current()) return
    const box = document.querySelector(`[data-term-pane-box="${CSS.escape(paneId)}"]`)
    if (box === null) {
      frames += 1
      if (frames < MAX_WAIT_FRAMES) requestAnimationFrame(attempt)
      return
    }
    // 처음부터 다시 번쩍인다 — 클래스를 뗐다가 한 프레임 뒤 다시 단다.
    box.classList.remove(FLASH_CLASS)
    requestAnimationFrame(() => {
      if (!current()) return
      const previous = timers.get(paneId)
      if (previous !== undefined) clearTimeout(previous)
      box.classList.add(FLASH_CLASS)
      timers.set(
        paneId,
        setTimeout(() => {
          if (!current()) return
          box.classList.remove(FLASH_CLASS)
          timers.delete(paneId)
        }, PANE_RIM_FLASH_MS),
      )
    })
  }
  attempt()
}
