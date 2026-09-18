// 분할 방향 아이콘 (LIFE-387 B2 · design-handoff.md §2 SplitIcon, 열린 질문 Q4 A안 채택).
//
// corral 은 SVG·아이콘 라이브러리가 0 이다(전부 유니코드 텍스트 글리프) — 이번에도 라이브러리를
// 안 들이려고 CSS 픽토그램으로 그린다. 14×11 박스 + 위쪽 3px "탭바 띠"가 **영역**(렌더러 소유)과
// **pane**(herdr 소유) 두 층을 한 아이콘 안에서 가른다:
//   - pane 분할: 경계선이 띠 **아래**에서 시작한다(탭바 밑, pane 은 탭 안이라서).
//   - 영역 분할: 경계선이 띠를 **관통**한다(PaneGrid.tsx 의 실제 규칙 — 영역 경계는 탭바를 지난다).
//   - 영역 ↓ 는 아래 절반에 띠가 하나 더 생긴다(새 탭바가 생기는 것을 그대로 그린다).
// 색은 부모 `color` 를 물려받는다 — 헤더 액션·메뉴 항목이 이미 `--fg-muted`/hover `--fg` 를 쓰고
// 있으므로 이 컴포넌트는 색을 직접 정하지 않는다.

export type SplitIconKind = 'pane-right' | 'pane-down' | 'group-right' | 'group-down'

const STRIP = { position: 'absolute' as const, left: 0, top: 0, width: '100%', height: 'var(--split-icon-strip)', opacity: 0.45, background: 'currentColor' }

function bars(kind: SplitIconKind): React.CSSProperties[] {
  switch (kind) {
    case 'pane-right':
      return [
        STRIP,
        { position: 'absolute', left: '50%', top: 'var(--split-icon-strip)', width: '1px', height: 'calc(100% - var(--split-icon-strip))', background: 'currentColor' },
      ]
    case 'pane-down':
      return [STRIP, { position: 'absolute', left: 0, top: '50%', width: '100%', height: '1px', background: 'currentColor' }]
    case 'group-right':
      return [STRIP, { position: 'absolute', left: '50%', top: 0, width: '1px', height: '100%', background: 'currentColor' }]
    case 'group-down':
      return [
        STRIP,
        { position: 'absolute', left: 0, top: '50%', width: '100%', height: '1px', background: 'currentColor' },
        { position: 'absolute', left: 0, top: 'calc(50% + 1px)', width: '100%', height: 'var(--split-icon-strip)', opacity: 0.45, background: 'currentColor' },
      ]
  }
}

export function SplitIcon({ kind }: { kind: SplitIconKind }): React.JSX.Element {
  return (
    <span
      className="split-icon"
      data-split-icon={kind}
      style={{
        display: 'block',
        position: 'relative',
        width: 'var(--split-icon-w)',
        height: 'var(--split-icon-h)',
        border: '1px solid currentColor',
        borderRadius: '2px',
        flexShrink: 0,
      }}
    >
      {bars(kind).map((style, index) => (
        // 정적 배열(항상 같은 길이·순서) — index 를 key 로 써도 재조정 버그가 안 난다.
        <span key={index} style={style} />
      ))}
    </span>
  )
}
