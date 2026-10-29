// 시험 하네스 (LIFE-682) — App 처럼 오른쪽 패널의 작업 상세 자리(`.right-panel-detail`)를 곁에 두고 `TasksPage` 를 그린다.
// 상세는 그 자리로 portal 된다(작업 페이지 안 aside 가 아니다). 패널은 처음에 상세 보기로 열려 있다(`panelShown`) — 옛 「선택 = 열린 상세」 시험이
// 같은 장면을 보게. 패널 숨기기(✕·같은 카드·Esc)는 그 자리를 비운다. 시험 전용이다 — 제품 경로는 App 이 `detailPanel` 을 준다.
import { createElement, Fragment, useState } from 'react'
import { TasksPage, type TasksPageProps } from './TasksPage.js'

export function TasksPageInPanel(props: Omit<TasksPageProps, 'detailPanel'> & { panelShown?: boolean; onOpenPage?: () => void }): React.JSX.Element {
  const { panelShown = true, onOpenPage, ...rest } = props
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(panelShown)
  return createElement(
    Fragment,
    null,
    createElement(TasksPage, { ...rest, detailPanel: { slot, shown, show: () => setShown(true), hide: () => setShown(false), openPage: () => onOpenPage?.() } }),
    createElement('div', { className: 'right-panel-detail', 'data-right-panel-detail': '', 'data-panel-shown': shown ? 'true' : 'false', ref: setSlot }),
  )
}
