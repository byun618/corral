# LIFE-513 Ghostty 가져오기 — 출처와 고지 (K12ⓓ)

## 출처

아래 파일은 **Orca v1.4.198** (커밋 `e0826956`, https://github.com/stablyai/orca) 의 코드를 옮겨 corral 에 맞게 고쳤다.
고친 내용은 각 파일 머리 주석과 `specs/LIFE-513-ghostty-import/raw/claude/RESULT.md` 「Orca 와 다르게 한 점」 에 있다.

| corral 파일 | Orca v1.4.198 원본 |
| --- | --- |
| `src/main/ghostty/parser.ts` | `src/main/ghostty/parser.ts` |
| `src/main/ghostty/discovery.ts` | `src/main/ghostty/discovery.ts` |
| `src/main/ghostty/theme-resolution.ts` | `src/main/ghostty/theme-resolution.ts` |
| `src/main/ghostty/mapper.ts` | `src/main/ghostty/mapper.ts` |
| `src/main/ghostty/index.ts` | `src/main/ghostty/index.ts` |
| `src/shared/ghostty-import.ts` | `src/shared/global-settings-types.ts` (`GhosttyImportPreview`) |
| `src/renderer/src/ghostty-import.ts` | `src/renderer/src/components/settings/useGhosttyImport.ts` · `GhosttyImportModal.tsx` · `setting-labels.ts` |
| `src/renderer/src/components/GhosttyImport.tsx` | `src/renderer/src/components/settings/useGhosttyImport.ts` · `GhosttyImportModal.tsx` (문구는 ko 로케일) |
| `src/renderer/src/components/TerminalAppearanceSection.tsx` 의 `themeSelectionPatch` | `TerminalThemeSections.tsx` (v1.4.210 #22069) |

Ghostty 동작 규칙(로드 순서·줄 문법·빈 파일·font-family)은 Ghostty v1.3.1 소스(https://github.com/ghostty-org/ghostty, MIT)를 읽고
그 의미를 따랐다 — Ghostty 코드를 옮기지는 않았다. Ghostty 아이콘(`resources/ghostty.svg`)은 옮기지 않았다.

## Orca 라이선스 (전문)

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
