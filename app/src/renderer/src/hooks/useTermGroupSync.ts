// 영역 구성을 main 에 **선언**한다 (LIFE-373 ①·R13).
//
// 화면이 아는 것: 어떤 영역이 어떤 탭을 보고 있고, 그 영역 상자가 몇 px 인가.
// main 이 하는 것: 그 선언대로 연결을 열고·닫고·탭을 옮기고·격자를 맞춘다.
// 그래서 여기서는 **명령을 쏘지 않는다** — 바뀐 선언을 통째로 다시 보낼 뿐이다.
// 부팅 복원·재접속·worktree 전환이 전부 같은 길로 들어와 attach 순서(S2-b)가 한 곳에서 지켜진다.
//
// 디바운스 120ms 는 LIFE-353 의 fit 디바운스와 같은 값이다 — 창 드래그 한 번이 resize 이벤트
// 수십 개를 내므로(§7-3 의 분모), 뭉쳐야 **드래그 1회당 연결당 1회**(S3·R13-b)가 된다.

import { useCallback, useEffect, useRef } from 'react'
import type { TerminalGroupRequest } from '../../../shared/types.js'
import { contentBoxOf, gridForBox, type CellSize } from '../term-metrics.js'

const DEBOUNCE_MS = 120

export type GroupDeclaration = {
  groupId: string
  tabId: string
  /** 이 영역의 활성 pane — attach 의 `pane.focus` 대상이자 S2-b 의 순서 기준. */
  activePaneId: string
  active: boolean
}

export type TermGroupSync = {
  /** 영역 상자에 다는 ref 콜백 — 이 상자의 content box 가 격자의 분모다. */
  boxRef: (groupId: string) => (element: HTMLDivElement | null) => void
}

export function useTermGroupSync(input: { groups: GroupDeclaration[]; cell: CellSize }): TermGroupSync {
  const boxes = useRef(new Map<string, HTMLDivElement>())
  const observer = useRef<ResizeObserver | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSent = useRef('')
  /** effect 밖(ResizeObserver 콜백)에서도 최신 선언을 봐야 한다. */
  const latest = useRef(input)
  latest.current = input

  const send = useCallback((): void => {
    const { groups, cell } = latest.current
    const requests: TerminalGroupRequest[] = []
    for (const group of groups) {
      const box = boxes.current.get(group.groupId)
      if (box === undefined) continue
      const grid = gridForBox({ box: contentBoxOf(box), cell })
      requests.push({
        groupId: group.groupId,
        tabId: group.tabId,
        activePaneId: group.activePaneId,
        cols: grid.cols,
        rows: grid.rows,
        active: group.active,
      })
    }
    // 상자가 아직 안 붙은 영역이 있으면 보내지 않는다 — 반쪽 선언은 그 영역의 연결을 닫는다.
    if (requests.length !== groups.length) return
    const serialized = JSON.stringify(requests)
    if (serialized === lastSent.current) return
    lastSent.current = serialized
    window.corral.syncTermGroups(requests)
  }, [])

  const schedule = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      send()
    }, DEBOUNCE_MS)
  }, [send])

  /**
   * ref 콜백은 영역마다 **같은 함수 객체를 돌려준다**. 렌더마다 새로 만들면 React 가 매번
   * 떼었다 붙이고(null → element), 그때마다 observe/unobserve 와 선언 전송이 따라 돈다.
   */
  const refs = useRef(new Map<string, (element: HTMLDivElement | null) => void>())
  const boxRef = useCallback(
    (groupId: string) => {
      const existing = refs.current.get(groupId)
      if (existing !== undefined) return existing
      const created = (element: HTMLDivElement | null): void => {
        const previous = boxes.current.get(groupId)
        if (previous !== undefined && previous !== element) observer.current?.unobserve(previous)
        if (element === null) {
          boxes.current.delete(groupId)
          return
        }
        boxes.current.set(groupId, element)
        observer.current?.observe(element)
        // 첫 마운트는 기다리지 않는다 — 부팅 화면이 120ms 늦게 붙을 이유가 없다.
        send()
      }
      refs.current.set(groupId, created)
      return created
    },
    [send],
  )

  useEffect(() => {
    const resize = new ResizeObserver(() => schedule())
    observer.current = resize
    for (const box of boxes.current.values()) resize.observe(box)
    return () => {
      resize.disconnect()
      observer.current = null
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [schedule])

  // 선언(탭·활성 pane·활성 영역)이나 셀 크기가 바뀌면 곧바로 보낸다 — 이건 드래그가 아니다.
  useEffect(() => {
    send()
  }, [send, input.groups, input.cell])

  return { boxRef }
}
