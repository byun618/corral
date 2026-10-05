// 터미널 외관 적용 (LIFE-512 K2·K3·K4) — 라이브 pane(`TerminalPane`)과 설정 미리보기(`TerminalSettingsPreview`)가 **이 두 함수**로
// xterm 옵션을 만들고 쓴다(K3ⓔ 드리프트 금지 — Orca `applyTerminalAppearance`·`TerminalSettingsPreview` 가 헬퍼를 공유하는 것과 같은 결).
//
// 값 비교 후 쓰기(Orca B14·`terminal-appearance.ts:164`): `options.theme` 를 쓰면 xterm 이 팔레트를 새로 만들어 앱이 OSC 4/10/11/12 로
// 바꾼 색을 날린다. 같은 값이면 쓰지 않는다. `minimumContrastRatio` 도 쓰면 대비 캐시가 지워진다 — 같으면 쓰지 않는다.
// 글꼴 옵션을 써도 xterm 은 cols·rows 를 바꾸지 않는다(W1) — 격자는 셀 재측정 → `useTermGroupSync` → herdr 프레임이 정한다(U3).
import type { ITheme, Terminal } from '@xterm/xterm'
import {
  ACTIVE_PANE_OPACITY,
  PANE_OPACITY_TRANSITION_MS,
  resolveMinimumContrastRatio,
  resolveTerminalTheme,
  terminalCursorOptions,
  terminalFontOptions,
  terminalThemesEqual,
  type Settings,
  type TerminalCursorStyle,
} from '../../shared/terminal-settings.js'

export type TerminalAppearanceOptions = {
  fontSize: number
  fontFamily: string
  fontWeight: number
  fontWeightBold: number
  lineHeight: number
  cursorStyle: TerminalCursorStyle
  cursorInactiveStyle: TerminalCursorStyle | 'outline'
  cursorBlink: boolean
  theme: ITheme
  minimumContrastRatio: number
}

/** 설정 → xterm 옵션. 생성자에 그대로 펼쳐 넣을 수 있는 모양이다. */
export function terminalAppearanceOptions(settings: Settings): TerminalAppearanceOptions {
  const theme = resolveTerminalTheme({ themeName: settings.terminalThemeDark })
  return {
    ...terminalFontOptions(settings),
    ...terminalCursorOptions(settings),
    theme,
    minimumContrastRatio: resolveMinimumContrastRatio(theme.background),
  }
}

type ScalarKey = Exclude<keyof TerminalAppearanceOptions, 'theme'>
const SCALAR_KEYS: readonly ScalarKey[] = ['fontSize', 'fontFamily', 'fontWeight', 'fontWeightBold', 'lineHeight', 'cursorStyle', 'cursorInactiveStyle', 'cursorBlink', 'minimumContrastRatio']

/**
 * 살아 있는 xterm 에 옵션을 **바뀐 것만** 쓴다. 쓴 옵션 이름을 돌려준다(진단·테스트가 「테마를 다시 쓰지 않았다」 를 본다).
 * 이 함수는 버퍼를 건드리지 않는다 — 테마를 바꿔도 내용을 다시 불러오거나 두 번 그리지 않는다(Orca #11517 회피, K3ⓕ).
 */
export function applyTerminalAppearance({ term, next }: { term: Terminal; next: TerminalAppearanceOptions }): string[] {
  const written: string[] = []
  for (const key of SCALAR_KEYS) {
    if (term.options[key] === next[key]) continue
    Object.assign(term.options, { [key]: next[key] })
    written.push(key)
  }
  if (!terminalThemesEqual({ a: term.options.theme, b: next.theme })) {
    term.options.theme = next.theme
    written.push('theme')
  }
  return written
}

/**
 * 설정 → CSS 변수 (K3ⓖ·K4ⓒⓓ). xterm 밖 표면(pane 상자 배경·비활성 투명도·디바이더)이 읽는다. **토큰이 아니라 설정 값**이라
 * design-tokens.css 가 아니라 여기서 문서 루트에 쓴다(K5ⓔ — 테마 데이터·터미널 배경은 설정 값이다).
 */
export function terminalCssVars(settings: Settings): Record<string, string> {
  const theme = resolveTerminalTheme({ themeName: settings.terminalThemeDark })
  return {
    '--term-bg': theme.background ?? '#000000',
    '--term-inactive-opacity': String(settings.terminalInactivePaneOpacity),
    '--term-active-opacity': String(ACTIVE_PANE_OPACITY),
    '--term-opacity-transition': `${PANE_OPACITY_TRANSITION_MS}ms`,
    '--term-divider-color': settings.terminalDividerColorDark,
    '--term-divider-w': `${settings.terminalDividerThicknessPx}px`,
  }
}
