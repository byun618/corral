// LIFE-573 — 링크 hover 행 캐시를 행 내용 변경 뒤 다시 묻게 한다.
//
// xterm 6.0.0 `Linkifier` 는 provider 응답을 **행 번호**(`_activeLine`)로 캐시하고, 행 이동·resize 때만 버린다. 내용이 바뀌어
// 다시 묻는 경로는 **링크가 이미 잡혀 있을 때**(상류 #4298, `_handleNewLink` 의 onRenderedViewportChange)뿐이다. 그래서
// ① 링크가 없던 자리에 멈춘 포인터 아래로 링크가 와도 영영 안 잡히고(C1) ② 같은 행 안 이동은 낡은 캐시를 보고(C2·C3)
// ③ 터미널 밖에 나갔다 같은 칸으로 돌아오면 `_lastBufferCell` 이 같아 hover 자체를 건너뛴다(C6).
// 상류 이슈 #4323(열림)·PR #6141(미머지)의 동작을 밖에서 재현한다 — 코드는 복사하지 않았다. 공개 API 가 없어 비공개 필드를 쓴다.
//
// 하는 일 (렌더 = `term.onRender`, 링크가 잡혀 있으면 아무것도 안 한다 — #4298 경로와 겹치지 않게, 제약 4):
//   · 포인터가 안에 있고 캐시된 행이 다시 그려졌다 → 캐시를 **즉시 잊는다**(질의 0, 다음 mousemove 가 다시 묻는다 — C2·C3)
//     + 정지 포인터 재평가를 `LINK_REFRESH_INTERVAL_MS` 뒤 1회 예약한다(C1). 예약 중 렌더는 예약을 미루지 않는다 —
//     꼬리 디바운스는 스트리밍이 이어지는 동안 영영 안 울린다. 그래서 상한은 간격당 1회다(C5ⓑ)
//   · 포인터가 밖이다 → 아무것도 안 한다(질의 0, C5ⓐ)
//   · `mouseleave` → 마지막 칸·캐시 행을 잊는다(질의 0) — 돌아오는 첫 mousemove 가 같은 칸이어도 다시 묻는다(C6)
// 재평가는 Linkifier 의 mousemove 처리기를 **저장된 마지막 이벤트로 직접** 부른다. DOM 이벤트를 만들지 않으므로
// xterm 의 마우스 리포트 경로(pane 으로 가는 SGR)를 타지 않는다(제약 3).
import type { IDisposable, Terminal } from '@xterm/xterm'

/** 정지 포인터 재평가 간격 — 상류 #4323(Tyriar)·#6141 의 50ms. 렌더가 계속돼도 이 간격마다 최대 1회. */
export const LINK_REFRESH_INTERVAL_MS = 50

/** 이 모듈이 터미널에서 쓰는 공개 면. 테스트가 가짜로 대신한다. */
export type LinkRefreshTerminal = Pick<Terminal, 'onRender' | 'rows'> & { buffer: { active: { viewportY: number } } }

/** 비공개 Linkifier 위에서 하는 일. 모양 검사를 통과한 뒤에만 만든다. */
type Linkifier = {
  element: HTMLElement
  /** 포인터가 터미널 밖이거나 링크가 이미 잡혀 있으면 null, 아니면 캐시된 행(1 기반, 없으면 -1). */
  idleActiveLine(): number | null
  /** 마지막 칸·캐시 행을 잊는다 — 다음 hover 가 provider 를 다시 묻는다. 질의 없음. */
  forget(): void
  /** 저장된 마지막 mousemove 로 hover 를 다시 돈다 — provider 질의. 저장 좌표가 터미널 사각형 밖이면 건너뛴다. */
  rehover(): void
}

function isCell(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === 'object')
}

/**
 * 비공개 `_core.linkifier` — xterm 6.0.0 고정 전제(`package.json` 정확 고정, 번들이 필드 이름을 보존한다).
 * 비공개 접근은 이 함수 하나로 가둔다(term-metrics.readCellSize 와 같은 방식). 모양이 하나라도 다르면 null 이고,
 * 호출자는 아무것도 하지 않는다 — 현재 동작(캐시 그대로)으로 떨어진다(제약 2). 쓰기 직전에도 다시 검사한다.
 */
function readLinkifier(term: object): Linkifier | null {
  const core: unknown = Reflect.get(term, '_core')
  if (core === null || typeof core !== 'object') return null
  const linkifier: unknown = Reflect.get(core, 'linkifier')
  if (linkifier === null || typeof linkifier !== 'object') return null
  const element: unknown = Reflect.get(linkifier, '_element')
  const handleMouseMove: unknown = Reflect.get(linkifier, '_handleMouseMove')
  if (!(element instanceof HTMLElement) || typeof handleMouseMove !== 'function') return null
  const shapeOk = (): boolean =>
    typeof Reflect.get(linkifier, '_activeLine') === 'number' &&
    typeof Reflect.get(linkifier, '_isMouseOut') === 'boolean' &&
    isCell(Reflect.get(linkifier, '_lastBufferCell')) &&
    isCell(Reflect.get(linkifier, '_currentLink')) &&
    isCell(Reflect.get(linkifier, '_lastMouseEvent'))
  if (!shapeOk()) return null
  return {
    element,
    idleActiveLine: () => {
      if (!shapeOk()) return null
      if (Reflect.get(linkifier, '_isMouseOut') === true) return null
      if (Reflect.get(linkifier, '_currentLink') !== undefined) return null
      const line: unknown = Reflect.get(linkifier, '_activeLine')
      return typeof line === 'number' ? line : null
    },
    forget: () => {
      if (!shapeOk()) return
      Reflect.set(linkifier, '_activeLine', -1)
      Reflect.set(linkifier, '_lastBufferCell', undefined)
    },
    rehover: () => {
      if (!shapeOk()) return
      const event: unknown = Reflect.get(linkifier, '_lastMouseEvent')
      if (event === null || typeof event !== 'object') return
      // 레이아웃이 바뀌어(사이드바 등) 저장 좌표가 터미널 밖인데 mouseleave 가 안 왔으면, getCoords 클램프가 가장자리 칸을
      // hover 한다(fix r2 L4-4). 그때는 건너뛴다 — 캐시는 이미 잊어 질의 0. 모양이 다르면 현재 동작(아무것도 안 함).
      const x: unknown = Reflect.get(event, 'clientX')
      const y: unknown = Reflect.get(event, 'clientY')
      if (typeof x !== 'number' || typeof y !== 'number') return
      // 반열림 사각형(왼쪽·위 포함, 오른쪽·아래 제외) — 맞닿은 이웃 요소와 경계 픽셀을 겹쳐 갖지 않는다.
      const rect = element.getBoundingClientRect()
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return
      Reflect.apply(handleMouseMove, linkifier, [event])
    },
  }
}

/**
 * 터미널에 링크 캐시 갱신을 붙인다. `term.open` 뒤에 부른다(그 전엔 Linkifier 가 없다).
 * 반환값을 터미널과 함께 dispose 한다 — 타이머·리스너를 함께 거둔다. `active` 는 비공개 모양이 맞아 실제로 붙었는지.
 */
export function attachLinkRefresh(input: { term: LinkRefreshTerminal }): IDisposable & { active: boolean } {
  const { term } = input
  const linkifier = readLinkifier(term)
  if (linkifier === null) return { active: false, dispose: () => {} }

  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    timer = null
    // 예약 뒤 포인터가 나갔거나 링크가 잡혔으면 그만둔다. 그 사이 mousemove 가 이미 다시 물었으면(행이 다시 정해짐) 그만둔다.
    if (linkifier.idleActiveLine() !== -1) return
    linkifier.rehover()
  }

  const render = term.onRender(({ start, end }) => {
    const line = linkifier.idleActiveLine()
    if (line === null) return
    // 캐시된 행이 화면 안이고 이번 렌더 범위 밖이면 그 행 내용은 그대로다(커서 깜빡임 등). -1 은 이미 잊은 상태 — 예약만 확인한다.
    // 스크롤로 캐시된 행이 화면 밖으로 밀렸으면 포인터 아래 행이 아니라 낡은 캐시다 — 범위와 무관하게 잊는다(fix r1 F4).
    const viewportY = term.buffer.active.viewportY
    const onScreen = line >= viewportY + 1 && line <= viewportY + term.rows
    const top = viewportY + start + 1
    const bottom = viewportY + end + 1
    if (line !== -1 && onScreen && (line < top || line > bottom)) return
    linkifier.forget()
    if (timer === null) timer = setTimeout(fire, LINK_REFRESH_INTERVAL_MS)
  })

  const leave = (): void => linkifier.forget()
  linkifier.element.addEventListener('mouseleave', leave)

  return {
    active: true,
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      render.dispose()
      linkifier.element.removeEventListener('mouseleave', leave)
    },
  }
}
