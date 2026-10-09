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
        accent: '#7dd3a0',
        error: '#e06c5f',
        scrim: 'rgba(6,7,8,0.62)',
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
      spacing: { hit: '44px', band: '40px', padx: '18px' },
    },
  },
  plugins: [],
}
