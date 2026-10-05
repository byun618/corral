# 내장 터미널 테마 — 출처와 고지 (LIFE-512 K3ⓒ)

## 출처

이 폴더의 테마 데이터 30개(`defaults.ts`·`popular-dark-core.ts`·`popular-dark-extended.ts`·`popular-light.ts`·`classic.ts`)와
묶음 파일(`types.ts`·`shared.ts`·`index.ts`·`popular-dark.ts`)은 **Orca v1.4.198** (커밋 `e0826956`)
`src/renderer/src/lib/terminal-themes/` 에서 값·이름·구조를 그대로 옮겼다. 바꾼 것은 import 경로의 `.js` 꼬리와 각 파일 머리 주석뿐이다.
값이 원본과 같은지는 `app/scripts/l512/theme-parity.mjs` 가 원본 파일을 읽어 기계 대조한다.

- 기본 다크 `Ghostty Default Style Dark` 는 Ghostty 기본 색에서 왔다. Orca 가 선택 배경만 Ghostty 원본 `#3e4451` 에서
  `#5a7898` 로 올렸다(원본 주석 `defaults.ts` 그대로 유지).
- 라이트 기본 `Builtin Tango Light` 의 ANSI 값 조정 주석도 원본 그대로 유지했다.
- 나머지 28개 테마의 출처는 Orca 원본에도 적혀 있지 않다.

## 테마 색의 저작권

**각 테마 색의 저작권은 그 테마의 작성자에게 있다.** 아래 MIT 고지는 Orca 저장소(코드와 이 데이터 파일의 배열)에 대한 것이다.
개별 테마의 라이선스는 전수 확인하지 않았다 — 외부 서치(LIFE-512 `raw/coordinator/c2-grok-research.md` W5)에서 Dracula·Catppuccin 은 MIT 로
확인됐고, Gruvbox 는 확인하지 못했으며, 나머지는 확인하지 않았다. 확인하지 않은 테마를 MIT 라고 적지 않는다.

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
