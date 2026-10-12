/** @type {import('tailwindcss').Config} */
// 색·치수는 specs/design-tokens-mobile.css(LIFE-579) 값 그대로 — 새 색 0. 틴트(color-mix)는 RN 이 받지 못해 src/ui/tokens.ts 의 rgba 로.
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        surface: '#0a0a0a',
        window: '#171717',
        chip: '#262626',
        'bg-accent': '#404040',
        fg: { DEFAULT: '#fafafa', muted: '#a1a1a1', dim: '#737373', faint: '#525252' },
        line: { DEFAULT: 'rgba(255,255,255,0.07)', strong: 'rgba(255,255,255,0.15)' },
        accent: '#c7b28a',
        // 완료·성공·연결 자리 — LIFE-594 D1 로 accent 에서 뗀 상태 토큰(--st-ok, 옛 accent 초록).
        'st-ok': '#7dd3a0',
        error: '#e06c5f',
        scrim: 'rgba(6,7,8,0.62)',
        // 상태 점·에이전트 — design-tokens-mobile.css(데스크톱 oklch → hex). LIFE-580.
        dot: { working: '#f0b100', done: '#00bc7d', unverifiable: '#fe9a00', question: '#ff6900', alert: '#fb2c36', idle: 'rgba(115,115,115,0.4)' },
        agent: { claude: '#d97757', grok: '#8fa7c4' },
      },
      // 번들 글꼴(LIFE-580 J7) — 파일 이름 = Android 글꼴 이름. 굵기는 이름으로 고른다.
      fontFamily: {
        g400: ['Geist_400Regular'],
        g500: ['Geist_500Medium'],
        g600: ['Geist_600SemiBold'],
        m400: ['JetBrainsMono_400Regular'],
        m500: ['JetBrainsMono_500Medium'],
      },
      fontSize: {
        meta: ['11.5px', '16px'],
        small: ['12.5px', '18px'],
        preview: ['13.5px', '20px'],
        body: ['15px', '22px'],
        input: ['16px', '22px'],
        title: ['16px', '22px'],
        screen: ['21px', '28px'],
      },
      borderRadius: { card: '12px', option: '10px', sheet: '24px', pill: '999px' },
      spacing: { hit: '44px', band: '40px', padx: '18px', row: '62px', task: '48px', repo: '38px' },
    },
  },
  plugins: [],
}
