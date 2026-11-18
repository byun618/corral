// 탐색기 아이콘 (LIFE-589 E2ⓕ) — 트리 UI = codicons(@vscode/codicons 글꼴, `assets/codicons/`), 파일 = Seti(`seti-icons.ts`).
// 글꼴 두 개는 `explorer.css` 의 @font-face 로 같은 출처에서 읽는다(CSP `default-src 'self'` 안 — data: 인라인 금지 `assetsInlineLimit: 0`).
import { setiGlyph } from '../seti-icons.js'

/** VS Code `codiconsLibrary.ts` 의 코드 포인트 — 쓰는 것만. */
export const CODICON = {
  'chevron-down': 0xeab4,
  refresh: 0xeb37,
  'collapse-all': 0xeac5,
  ellipsis: 0xea7c,
  check: 0xeab2,
  'layout-sidebar-right': 0xebf4,
  'circle-filled': 0xea71,
  'new-file': 0xea7f,
  'new-folder': 0xea80,
  // LIFE-593 — 이름 필터 단추·닫기.
  filter: 0xeaf1,
  close: 0xea76,
  // LIFE-683 — 소스 제어 보기(activity bar·머리 동작·diff 탭 머리).
  'source-control': 0xea68,
  'list-flat': 0xeb84,
  'list-tree': 0xeb86,
  'go-to-file': 0xea94,
  'chevron-right': 0xeab6,
  // LIFE-812 — 터미널 검색 막대 이전·다음.
  'arrow-up': 0xeaa1,
  'arrow-down': 0xea9a,
} as const

export type CodiconName = keyof typeof CODICON

export function Codicon({ name, className = '' }: { name: CodiconName; className?: string }): React.JSX.Element {
  return (
    <span className={`codicon ${className}`} data-codicon={name} aria-hidden>
      {String.fromCodePoint(CODICON[name])}
    </span>
  )
}

/** Seti 파일 아이콘 — 폭 16px + 오른쪽 6px(VS Code `.monaco-icon-label::before`). 폴더는 아이콘 없음(Seti 와 같다). */
export function FileIcon({ name }: { name: string }): React.JSX.Element {
  const glyph = setiGlyph(name)
  return (
    <span className="explorer-file-icon" data-seti-icon="" style={glyph?.color === null || glyph === null ? undefined : { color: glyph.color }} aria-hidden>
      {glyph?.char ?? ''}
    </span>
  )
}
