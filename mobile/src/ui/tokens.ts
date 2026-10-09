// specs/design-tokens-mobile.css 의 값 — style 에 직접 쓰는 것(틴트·글꼴)만. 클래스로 쓰는 색은 tailwind.config.js.
// 틴트는 원색 토큰 + 투명도(design-handoff §3 color-mix 를 rgba 로 옮김) — 새 색 0.
import { Platform } from 'react-native'

export const color = {
  surface: '#0a0a0a',
  window: '#171717',
  chip: '#262626',
  fg: '#fafafa',
  fgMuted: '#a1a1a1',
  fgDim: '#737373',
  fgFaint: '#525252',
  line: 'rgba(255,255,255,0.07)',
  lineStrong: 'rgba(255,255,255,0.15)',
  accent: '#7dd3a0',
  error: '#e06c5f',
  /** --st-error 12% */
  errorTint12: 'rgba(224,108,95,0.12)',
  /** --st-error 50% */
  errorTint50: 'rgba(224,108,95,0.5)',
  scrim: 'rgba(6,7,8,0.62)',
} as const

export const mono = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' })

export function hhmm(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
