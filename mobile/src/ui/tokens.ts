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
  agentClaude: '#d97757',
  agentGrok: '#8fa7c4',
  /** 상태 점 — design-tokens-mobile.css 의 데스크톱 oklch → hex 값(목업 임시값 아님, L5ⓕ). */
  dotWorking: '#f0b100',
  dotDone: '#00bc7d',
  dotUnverifiable: '#fe9a00',
  dotQuestion: '#ff6900',
  dotAlert: '#fb2c36',
  dotIdle: 'rgba(115,115,115,0.4)',
  /** --agent-dot-question 8% · 40% */
  questionTint8: 'rgba(255,105,0,0.08)',
  questionTint40: 'rgba(255,105,0,0.4)',
  /** --accent 8% */
  accentTint8: 'rgba(125,211,160,0.08)',
} as const

/** 번들 글꼴(LIFE-580 J7) — Android 는 굵기마다 파일이 따로라 fontWeight 대신 이름으로 고른다. 번들이 없는 실행(개발 서버 등)은 시스템 글꼴로 떨어진다. */
export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const

export const mono = Platform.select({ android: font.mono, ios: 'Menlo', default: 'monospace' })

export function hhmm(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
