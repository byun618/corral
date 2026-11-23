// 에이전트 pane 에 넣는 지시 본문 규칙 — 폰 지시(`main/mobile/keys.ts`)와 diff 메모 보내기(LIFE-832)가 같이 쓴다.
// 렌더러가 확인 단계에 보이는 본문과 main 허브가 넣는 본문이 같은 함수로 정리되게 shared 에 둔다(electron·node 없음).

/** 지시 본문 상한(UTF-8 바이트) — `terminal prompt` 의 `MAX_INPUT` 과 같다(P7). */
export const MAX_INPUT_BYTES = 65536

/**
 * 지시 본문 정리(P8 Z9ⓔ) — 본문은 herdr 가 붙여 넣기(bracketed paste)로 넣는다. 본문 안 제어 문자가 키로 작동하지 않게
 * **탭·줄바꿈 말고는 지운다**: C0(ESC `\x1b`·`\x03` 등)·DEL·C1(0x80–0x9f). `\r\n`·`\r` 은 `\n` 으로. 나머지 글자(한글·이모지·앞뒤 공백)는 그대로 —
 * 앞뒤 공백은 기록 대조가 쓰는 `normalizeBody` 가 잘라서 비교한다.
 */
export function cleanBody(text: string): string {
  return dropControls({ text: text.replace(/\r\n?/g, '\n'), keep: KEEP_IN_BODY })
}

const KEEP_IN_BODY: ReadonlySet<number> = new Set([0x09, 0x0a])

/** C0(0x00–0x1f)·DEL·C1(0x7f–0x9f) 중 `keep` 밖을 지운다. */
export function dropControls(input: { text: string; keep: ReadonlySet<number> }): string {
  let out = ''
  for (const char of input.text) {
    const code = char.codePointAt(0) ?? 0
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    if (!control || input.keep.has(code)) out += char
  }
  return out
}

/** UTF-8 바이트 수 — 렌더러에 Buffer 가 없어 TextEncoder 로 잰다. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
