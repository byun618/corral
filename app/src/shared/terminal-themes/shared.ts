// 이식: Orca v1.4.198 (e0826956) `src/renderer/src/lib/terminal-themes/` — 값·이름·구조 그대로(LIFE-512 K3ⓑ).
// 바꾼 것은 import 경로의 `.js` 꼬리와 이 머리 주석뿐이다. Orca 는 MIT(Copyright (c) 2026 Lovecast Inc.) — 전문과
// 테마 색 저작권 고지는 같은 폴더 NOTICE.md. 테마 색의 저작권은 각 테마 작성자에게 있다.
import type { TerminalThemeMap } from './types.js'

export function mergeTerminalThemeCatalogs(
  ...catalogs: readonly TerminalThemeMap[]
): TerminalThemeMap {
  const merged: TerminalThemeMap = {}

  for (const catalog of catalogs) {
    for (const [name, theme] of Object.entries(catalog)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`Duplicate terminal theme name: ${name}`)
      }
      merged[name] = theme
    }
  }

  return merged
}
