// 에이전트 제목의 스피너 장식 (LIFE-366 C12) — 렌더러 `pane-title-frames.ts` 에서 옮겼다(LIFE-637 F2: main 의 Resource Manager 패널 제목도 같은 정규화를 거친다).

/** 스피너 글리프 — 점자 + 사분원. Orca `isSpinnerFrameGlyph` 그대로다. */
export function isSpinnerFrameGlyph(code: number): boolean {
  return (code >= 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
}

/** Orca `isDecorativeTitleWhitespace` — 좁은 공백·제로폭까지 본다(스피너 뒤에 자주 붙는다). */
function isDecorativeTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

/** 앞쪽 스피너·공백을 떼고 가운데 공백을 한 칸으로 줄인다 (Orca `normalizeDecorativeAgentTitleText`). */
export function normalizeDecorativeTitle(title: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index)
    if (normalized.length === 0 && (isDecorativeTitleWhitespace(code) || isSpinnerFrameGlyph(code))) continue
    if (isDecorativeTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += title.charAt(index)
  }
  return normalized
}
