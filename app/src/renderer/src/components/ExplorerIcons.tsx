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
  // LIFE-830 — 소스 제어 비교 기준 전환(작업 트리 / base 대비).
  'git-compare': 0xeafd,
  // LIFE-811 — PR 보기(activity bar·GitHub 열기).
  'git-pull-request': 0xea64,
  'link-external': 0xeb14,
  // LIFE-812 — 터미널 검색 막대 이전·다음.
  'arrow-up': 0xeaa1,
  'arrow-down': 0xea9a,
  // LIFE-803 — 검색 보기(activity bar·토글 3개).
  search: 0xea6d,
  'case-sensitive': 0xeab1,
  'whole-word': 0xeb7e,
  regex: 0xeb38,
  // LIFE-829 — 소스 제어 쓰기(행·그룹 inline 단추).
  add: 0xea60,
  remove: 0xeb3b,
  discard: 0xeae2,
  // LIFE-831 — 소스 제어 원격(가져오기·끌어오기·밀어넣기·브랜치 게시·진행·취소).
  'repo-fetch': 0xec1d,
  'repo-pull': 0xeb40,
  'repo-push': 0xeb41,
  'cloud-upload': 0xeac3,
  loading: 0xeb19,
  'stop-circle': 0xeba5,
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
