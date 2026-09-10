// 표시 폭 — **자소 군집 하나가 화면에서 몇 칸을 먹나.**
//
// main 이 격자의 열 수를 정할 때 쓴다 (`pane-terminal.ts` 의 `resolveGrid`). 렌더러는 자기
// 폭 계산을 xterm.js 의 `@xterm/addon-unicode-graphemes` 로 하므로, **이 파일의 규칙이 그것과
// 어긋나면 그 차이만큼 행이 밀리거나 잘린다** (분석 ⓖ6 이 herdr↔xterm 사이에서 경고한 것이
// 실제로는 main↔렌더러 사이에서 났다 — 판정 M1, 3자 리뷰 전원 지적).
//
// 검증: `raw/claude/13-m1-width.json` — 제3 오라클(`wcwidth` 0.8.3, herdr 도 xterm 도 아니다)과
// 7종 표본에서 전부 일치하는 것을 확인하고 이 규칙을 박았다.

/**
 * ANSI 가 섞인 행의 **표시 폭**. SGR 을 걷어내고 **자소 군집(grapheme cluster)** 단위로 센다.
 *
 * 처음엔 코드포인트마다 세는 근사였다. 3자 리뷰가 전원 같은 자리를 짚었고(판정 M1) 실측이
 * 맞았다 — `👨‍👩‍👧` 는 6(실제 2), `❤️`(VS16)는 1(실제 2)로 나왔다.
 *
 * **과대는 빈 열을 만들고 과소는 글자를 자른다.** 프레임은 autowrap 을 끄고 그리므로
 * (`frame.ts`) 격자보다 넓은 줄은 접히지 않고 **그 행에서 잘린다**. 과소가 더 위험하다.
 *
 * 그래서 렌더러(`@xterm/addon-unicode-graphemes`)·herdr 와 같은 규칙으로 바꿨다:
 * `Intl.Segmenter` 로 군집을 자르고, **군집 하나는 최대 2칸**이다.
 *   - ZWJ(U+200D)·VS16(U+FE0F)·지역표시자 쌍이 들어간 군집 → 2 (합성 이모지는 한 글자다)
 *   - VS15(U+FE0E, 텍스트 표현) → 1
 *   - 그 밖엔 **첫 코드포인트**의 폭 (결합 문자는 폭을 더하지 않는다)
 * 7종 실측 대조표는 `raw/claude/13-m1-width.json` 에 있다 (제3 오라클 `wcwidth` 와 대조).
 */
const clusters = new Intl.Segmenter('en', { granularity: 'grapheme' })

export function displayWidth(line: string): number {
  // ANSI 제어열을 걷어낸다. 제어문자가 패턴에 들어가는 것이 이 함수의 목적이라 규칙을 끈다.
  // eslint-disable-next-line no-control-regex
  const csi = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g
  // eslint-disable-next-line no-control-regex
  const osc = /\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/g
  const plain = line.replace(csi, '').replace(osc, '')
  let width = 0
  for (const { segment } of clusters.segment(plain)) width += clusterWidth(segment)
  return width
}

/** 군집 하나의 폭. 0·1·2 만 나온다. */
export function clusterWidth(cluster: string): number {
  const first = cluster.codePointAt(0)
  if (first === undefined) return 0
  if (cluster.includes('\u{fe0e}')) return 1
  if (cluster.includes('\u{200d}') || cluster.includes('\u{fe0f}')) return 2
  if (isRegionalIndicator(first)) return 2
  return isWide(first) ? 2 : 1
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}
