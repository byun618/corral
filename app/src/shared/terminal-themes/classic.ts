// 이식: Orca v1.4.198 (e0826956) `src/renderer/src/lib/terminal-themes/` — 값·이름·구조 그대로(LIFE-512 K3ⓑ).
// 바꾼 것은 import 경로의 `.js` 꼬리와 이 머리 주석뿐이다. Orca 는 MIT(Copyright (c) 2026 Lovecast Inc.) — 전문과
// 테마 색 저작권 고지는 같은 폴더 NOTICE.md. 테마 색의 저작권은 각 테마 작성자에게 있다.
import type { TerminalThemeMap } from './types.js'

export const CLASSIC_TERMINAL_THEMES: TerminalThemeMap = {
  'Tango Dark': {
    background: '#000000',
    foreground: '#d3d7cf',
    cursor: '#d3d7cf',
    cursorAccent: '#000000',
    selectionBackground: '#555753',
    selectionForeground: '#eeeeec',
    black: '#2e3436',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec'
  },

  Homebrew: {
    background: '#000000',
    foreground: '#00ff00',
    cursor: '#00ff00',
    cursorAccent: '#000000',
    selectionBackground: '#005500',
    selectionForeground: '#00ff00',
    black: '#000000',
    red: '#990000',
    green: '#00a600',
    yellow: '#999900',
    blue: '#0000b2',
    magenta: '#b200b2',
    cyan: '#00a6b2',
    white: '#bfbfbf',
    brightBlack: '#666666',
    brightRed: '#e50000',
    brightGreen: '#00d900',
    brightYellow: '#e5e500',
    brightBlue: '#0000ff',
    brightMagenta: '#e500e5',
    brightCyan: '#00e5e5',
    brightWhite: '#e5e5e5'
  },

  Snazzy: {
    background: '#282a36',
    foreground: '#eff0eb',
    cursor: '#97979b',
    cursorAccent: '#282a36',
    selectionBackground: '#3e404a',
    selectionForeground: '#eff0eb',
    black: '#282a36',
    red: '#ff5c57',
    green: '#5af78e',
    yellow: '#f3f99d',
    blue: '#57c7ff',
    magenta: '#ff6ac1',
    cyan: '#9aedfe',
    white: '#f1f1f0',
    brightBlack: '#686868',
    brightRed: '#ff5c57',
    brightGreen: '#5af78e',
    brightYellow: '#f3f99d',
    brightBlue: '#57c7ff',
    brightMagenta: '#ff6ac1',
    brightCyan: '#9aedfe',
    brightWhite: '#f1f1f0'
  }
}
