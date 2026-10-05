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
그 의미를 따랐다. Ghostty 아이콘(`resources/ghostty.svg`)은 옮기지 않았다.

`src/main/ghostty/ghostty-grammar.ts`(fix3)는 아래 파서를 TypeScript 로 옮긴 것이다(수용/거절 판단 부분):

| corral 함수 | 원본 |
| --- | --- |
| `ghosttyColor`·`ghosttyTerminalColor`·`ghosttyPaletteEntry`·`ghosttyTheme` | Ghostty v1.3.1 `src/config/Config.zig` `Color.parseCLI`·`fromHex`·`TerminalColor.parseCLI`·`Palette.parseCLI`·`Theme.parseCLI` |
| `ghosttyTheme`(쌍 문법) | Ghostty v1.3.1 `src/cli/args.zig` `parseAutoStruct` · `src/cli/CommaSplitter.zig` |
| `ghosttyMetricModifier` | Ghostty v1.3.1 `src/font/Metrics.zig` `Modifier.parse` |
| `ghosttyBool` | Ghostty v1.3.1 `src/cli/args.zig` `parseBool` |
| `zigParseInt` | Zig 0.15.2 `lib/std/fmt.zig` `parseInt`·`parseIntWithSign`·`charToDigit` |
| `zigParseFloat` | Zig 0.15.2 `lib/std/fmt/parse_float.zig`·`parse_float/parse.zig`(`parsePartialNumberBase`·`parseInfOrNan`·`validUnderscores`)·`FloatStream.zig` |

`src/main/ghostty/x11-color-names.ts`(fix2)는 Ghostty v1.3.1 `src/terminal/res/rgb.txt`(X.Org `xorg/app/rgb`, sha256 `f8e3a7be…b6f0`)에서
색 **이름 열만** 소문자로 옮긴 목록이다 — 「Ghostty 가 받는 색 이름인가」 판단에만 쓴다. 그 라이선스 전문은 아래 「X.Org rgb 라이선스」.

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

## X.Org rgb 라이선스 (전문 — https://gitlab.freedesktop.org/xorg/app/rgb `COPYING`)

```
Copyright 1985, 1989, 1998  The Open Group

Permission to use, copy, modify, distribute, and sell this software and its
documentation for any purpose is hereby granted without fee, provided that
the above copyright notice appear in all copies and that both that
copyright notice and this permission notice appear in supporting
documentation.

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE OPEN GROUP BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

Except as contained in this notice, the name of The Open Group shall
not be used in advertising or otherwise to promote the sale, use or
other dealings in this Software without prior written authorization
from The Open Group.

Copyright (c) 1994, 2008, Oracle and/or its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## Ghostty 라이선스 (전문 — https://github.com/ghostty-org/ghostty v1.3.1 `LICENSE`)

```
MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

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

## Zig 라이선스 (전문 — https://github.com/ziglang/zig 0.15.2 `LICENSE`)

```
The MIT License (Expat)

Copyright (c) Zig contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
