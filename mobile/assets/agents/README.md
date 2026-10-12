# 에이전트 로고 (LIFE-594 핸드오프 §B)

| 파일 | 크기 | 받은 이름 (`specs/LIFE-594-design-apply/design-assets/png/`) |
| --- | --- | --- |
| `claude.png` · `claude@2x.png` · `claude@3x.png` | 20 · 40 · 60 px | `claude.png` · `claude-2x.png` · `claude-3x.png` |
| `codex.png` · `codex@2x.png` · `codex@3x.png` | 20 · 40 · 60 px | `codex.png` · `codex-2x.png` · `codex-3x.png` |
| `grok.png` · `grok@2x.png` · `grok@3x.png` | 20 · 40 · 60 px | `grok.png` · `grok-2x.png` · `grok-3x.png` |

- Claude Design 이 준 PNG 를 **바이트 그대로** 두고 이름만 RN 밀도 규칙(`@2x`·`@3x`)으로 바꿨다. sha256 대응은 `specs/LIFE-594-design-apply/raw/claude/k3-sha256.txt`.
- 색이 박힌 고정 이미지다 — claude `#d97757` · codex `#a1a1a1` · grok 원색. 아바타 칸 38·34·32·22 에 20·18·16·13 으로 줄여 그린다(`src/ui/StatusGlyph.tsx` `Avatar`).

## 출처 · 라이선스

로고 모양은 데스크톱 `app/src/renderer/src/components/AgentIcon.tsx` 와 같은 경로다 — claude·codex 패스와 grok PNG 는 **Orca 에서 이식**했다
(`orca/src/renderer/src/components/status-bar/icons.tsx` `ClaudeIcon`·`OpenAIIcon`, `orca/src/shared/agent-icons/grok.png`).

    MIT License — Copyright (c) 2026 Lovecast Inc.

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

브랜드 마크의 **상표권은 MIT 와 별건**이다 — Anthropic·OpenAI·xAI 의 상표는 각 에이전트를 가리키는 지시적 용법(nominative use)으로만 쓴다.
