// 탭 메뉴 아이콘 (LIFE-495 K1ⓐ) — Orca 220 탭 메뉴의 lucide 아이콘과 같은 모양을 corral 의 인라인 SVG 로 그린다(탭 닫기 ×·벨과 같은
// 방식 — 아이콘 라이브러리를 들이지 않는다). 14px(220 `size-3.5`), 색은 부모 `currentColor`. 경로 = lucide 원본(ISC).

export type TabMenuIconKind =
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-down'
  | 'arrow-up'
  | 'split-right'
  | 'split-down'
  | 'pin'
  | 'pin-off'
  | 'x'
  | 'list-x'
  | 'panel-right-close'
  | 'panel-left-close'
  | 'pencil'
  | 'eraser'
  | 'maximize'
  | 'minimize'
  | 'columns'

const PATHS: Record<TabMenuIconKind, string[]> = {
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  // LIFE-825 — Maximize2 / Minimize2 / Columns3 (영역 최대화·해제·균등화).
  maximize: ['M15 3h6v6', 'M9 21H3v-6', 'm21 3-7 7', 'm3 21 7-7'],
  minimize: ['m14 10 7-7', 'M20 10h-6V4', 'm3 21 7-7', 'M4 14h6v6'],
  columns: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18', 'M15 3v18'],
  'arrow-left': ['m12 19-7-7 7-7', 'M19 12H5'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  // PanelRightClose / PanelBottomClose — 220 「Split terminal right / down」.
  'split-right': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18', 'm8 9 3 3-3 3'],
  'split-down': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M3 15h18', 'm15 8-3 3-3-3'],
  pin: [
    'M12 17v5',
    'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  ],
  'pin-off': [
    'M12 17v5',
    'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89',
    'm2 2 20 20',
    'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11',
  ],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'list-x': ['M11 12H3', 'M16 6H3', 'M16 18H3', 'm19 10-4 4', 'm15 10 4 4'],
  'panel-right-close': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18', 'm8 9 3 3-3 3'],
  'panel-left-close': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18', 'm16 15-3-3 3-3'],
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
  eraser: ['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9'],
}

export function TabMenuIcon({ kind, size = 14, className }: { kind: TabMenuIconKind; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      data-tab-menu-icon={kind}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
