// 탭 스트립 기하 (LIFE-494 T2) — Orca v1.4.219 `tab-strip-slot-geometry.ts`·`tab-strip-scroll-anchor.ts` 를 corral DOM 에 옮긴다.
// 칸(slot) = 스트립의 직계 자식 탭 `[data-main-tab]`. 활성 탭 칸은 `[data-active-tab-dock]` 이고 sticky 라 지나치는 가장자리에 붙는다(#24010).
// 붙은 탭은 화면에 보이지만 **제자리가 아니다** — 스크롤·reveal 계산은 그 탭의 실제 순서 위치로 한다(떼면 dock 이 계산을 속인다).
import type { TabStripDockSide } from './tab-strip-metrics.js'

const SLOT_SELECTOR = '[data-main-tab]'
const DOCK_SELECTOR = '[data-active-tab-dock]'

function slots(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>(`:scope > ${SLOT_SELECTOR}`)]
}

function slotId(slot: HTMLElement): string {
  return slot.dataset.mainTab ?? ''
}

function dockSlot(strip: HTMLElement): HTMLElement | null {
  return strip.querySelector<HTMLElement>(`:scope > ${DOCK_SELECTOR}`)
}

export function findTabStripSlot(input: { strip: HTMLElement; tabId: string }): HTMLElement | undefined {
  return slots(input.strip).find((slot) => slotId(slot) === input.tabId)
}

export function readTabStripSlotIds(strip: HTMLElement): ReadonlySet<string> {
  return new Set(slots(strip).map(slotId))
}

/** 칸의 **순서상 자리**가 차지하는 화면 x 구간 — 붙은 활성 탭만 다른 데 그려진다. */
function naturalSpan(input: { strip: HTMLElement; slot: HTMLElement }): [number, number] {
  const rect = input.slot.getBoundingClientRect()
  if (!input.slot.matches(DOCK_SELECTOR)) return [rect.left, rect.right]
  let prev = input.slot.previousElementSibling
  while (prev !== null && !prev.matches(SLOT_SELECTOR)) prev = prev.previousElementSibling
  const left = prev !== null ? prev.getBoundingClientRect().right : input.strip.getBoundingClientRect().left + input.strip.clientLeft - input.strip.scrollLeft
  return [left, left + rect.width]
}

/** 칸의 순서상 자리가 어느 가장자리 밖인가 — 화면 안이면 null. */
function offscreenSide(input: { strip: HTMLElement; slot: HTMLElement }): TabStripDockSide | null {
  const viewLeft = input.strip.getBoundingClientRect().left + input.strip.clientLeft
  const [left, right] = naturalSpan(input)
  if (left < viewLeft - 1) return 'start'
  if (right > viewLeft + input.strip.clientWidth + 1) return 'end'
  return null
}

export function tabStripDockSide(strip: HTMLElement): TabStripDockSide | null {
  const dock = dockSlot(strip)
  return dock === null ? null : offscreenSide({ strip, slot: dock })
}

/** 활성 탭에 속하고, 제자리가 아니라 가장자리에 붙어 그려지는가. */
function isDocked(input: { strip: HTMLElement; el: Element }): boolean {
  const dock = dockSlot(input.strip)
  return dock !== null && dock.contains(input.el) && offscreenSide({ strip: input.strip, slot: dock }) !== null
}

/** `knownIds` 에 없는(새로 열린) 칸 중 순서상 자리가 화면 밖인 첫 칸. */
export function findOffscreenOpenedSlot(input: { strip: HTMLElement; knownIds: ReadonlySet<string> }): HTMLElement | undefined {
  return slots(input.strip).find((slot) => !input.knownIds.has(slotId(slot)) && offscreenSide({ strip: input.strip, slot }) !== null)
}

/**
 * `slot` 을 제자리에 보이게 하는 최소 이동. scrollIntoView 를 안 쓰는 이유: 붙은 탭은 이미 보이는 것으로 쳐서 안 움직인다.
 * 붙은 활성 탭도 함께 들어가면 같이 보이게, 안 들어가면 그 탭이 `slot` 옆에 붙을 자리를 남긴다(덮지 않게).
 */
export function revealTabStripSlot(input: { strip: HTMLElement; slot: HTMLElement }): void {
  const { strip, slot } = input
  let [left, right] = naturalSpan({ strip, slot })
  const dock = dockSlot(strip)
  if (dock !== null && dock !== slot) {
    const [dockLeft, dockRight] = naturalSpan({ strip, slot: dock })
    if (Math.max(right, dockRight) - Math.min(left, dockLeft) <= strip.clientWidth) {
      left = Math.min(left, dockLeft)
      right = Math.max(right, dockRight)
    } else if (dockRight <= left) {
      left -= dockRight - dockLeft
    } else if (dockLeft >= right) {
      right += dockRight - dockLeft
    }
  }
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
  if (left < viewLeft) strip.scrollLeft -= viewLeft - left
  else if (right > viewLeft + strip.clientWidth) strip.scrollLeft += Math.min(left - viewLeft, right - viewLeft - strip.clientWidth)
}

/** 탭이 앞뒤로 끼어들기 전에 적어 둔, 한 탭의 스트립 안 화면 x (#23462). */
export type TabStripScrollAnchor = { tabId: string; offset: number }

/** 보이는 활성 탭, 없으면 보이는 첫 탭. 붙은 활성 탭은 세지 않는다 — 주변이 움직여도 제 x 를 지킨다. */
export function captureTabStripScrollAnchor(input: { strip: HTMLElement; activeTabId: string | null }): TabStripScrollAnchor | null {
  const { strip } = input
  const stripRect = strip.getBoundingClientRect()
  const visible = (slot: HTMLElement): boolean => {
    const rect = slot.getBoundingClientRect()
    return rect.width > 0 && rect.right > stripRect.left && rect.left < stripRect.right && !isDocked({ strip, el: slot })
  }
  const active = input.activeTabId === null ? undefined : findTabStripSlot({ strip, tabId: input.activeTabId })
  const anchor = active !== undefined && visible(active) ? active : slots(strip).find(visible)
  if (anchor === undefined) return null
  return { tabId: slotId(anchor), offset: anchor.getBoundingClientRect().left - stripRect.left }
}

/** 앵커 탭을 적어 둔 x 로 돌려놓는다. 그 탭이 없어졌으면 false. */
export function restoreTabStripScrollAnchor(input: { strip: HTMLElement; anchor: TabStripScrollAnchor }): boolean {
  const slot = findTabStripSlot({ strip: input.strip, tabId: input.anchor.tabId })
  if (slot === undefined) return false
  const drift = slot.getBoundingClientRect().left - input.strip.getBoundingClientRect().left - input.anchor.offset
  if (drift !== 0) input.strip.scrollLeft += drift
  return true
}

export function isLastTabStripSlot(input: { strip: HTMLElement; tabId: string | null }): boolean {
  return input.tabId !== null && slots(input.strip).at(-1)?.dataset.mainTab === input.tabId
}
