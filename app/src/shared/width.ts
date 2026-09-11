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
 *
 * 폭 표 자체는 1차에서 손대지 않아 **BMP wide 기호가 과소**였다 (2회차 리뷰 G4). 지금은
 * UAX #11 의 W·F 전 구간을 `unicodedata` 에서 뽑아 쓴다 (`WIDE_RANGES`). 렌더러의 xterm 은
 * 자기 유니코드 판(15)의 표를 쓰므로 **같은 자가 아니라 같은 규격(UAX #11)** 이다 —
 * 두 판이 갈리는 자리는 대조 말뭉치가 잡는다 (`m8-width-oracle.mjs` 의 `WIDE_SYMBOLS`).
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
  // 지역표시자는 **쌍일 때만** 국기 한 글자다. 홀로 있는 한 짝은 UAX #11 로 N(1칸)이고
  // **렌더러(xterm.js)도 1칸에 그린다** — 쌍으로 가정하면 빈 열이 하나 생긴다.
  //
  // 여기서 따르는 것은 오라클이 아니라 **렌더러**다. `wcwidth` 는 이 자리에서 2 를 준다
  // (`13-m1-width.json` → `explainedDisagreements` 의 `🇰` oracle 2 / shipping 1,
  // `11-t7-width.json` → `herdrWidths.loneRI` 2). 폭 표의 쓸모는 "우리가 그리는 칸 수"를
  // 맞히는 것이고, 오라클과 렌더러가 갈리면 렌더러가 이긴다.
  // (2회차 리뷰 grok 지적 · 주석의 `wcwidth` 오기는 3회차 리뷰 N5 에서 정정)
  if (isRegionalIndicator(first)) return countRegionalIndicators(cluster) >= 2 ? 2 : 1
  return isWide(first) ? 2 : 1
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff
}

function countRegionalIndicators(cluster: string): number {
  let count = 0
  for (const char of cluster) {
    const code = char.codePointAt(0)
    if (code !== undefined && isRegionalIndicator(code)) count += 1
  }
  return count
}

/**
 * **UAX #11 의 Wide·Fullwidth 구간 전체.** 손으로 적은 성긴 범위표를 갈아치웠다 (2회차 리뷰 G4).
 *
 * 옛 표는 `0x2e80`~`0xa4cf` 같은 넓은 덩어리로 CJK 를 잡고 `0x1f300` 위의 이모지를 잡았다.
 * 그 사이에 있는 **BMP wide 기호 21종**(⌚⏰⏳☔☕⚡⚽⛄⛔✅✊✨❌❗➕⬛⭐⭕ …)이 통째로 빠져
 * 1칸으로 셌다 — CI 로그·에이전트 TUI 에 흔한 글자이고, **과소는 그 행에서 글자를 자른다**.
 * 반대로 🌡🖥🕹🗺🛠 처럼 실제로는 1칸인 글자를 2칸으로 세던 자리(빈 열)도 같이 닫힌다.
 *
 * 표는 손으로 고치지 않는다 — `scripts/l345/gen-width-table.py` 가 `unicodedata` 에서 뽑는다.
 * 대조는 `raw/claude/13-m1-width.json` (제3 오라클 `wcwidth` + 렌더러 엔진 xterm graphemes).
 */
// unicodedata 16.0.0 · 구간 122개
const WIDE_RANGES: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec,
  0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f,
  0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd,
  0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797,
  0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5,
  0x2ff0, 0x303e, 0x3041, 0x3096, 0x3099, 0x30ff, 0x3105, 0x312f,
  0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247,
  0x3250, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3,
  0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe52, 0xfe54, 0xfe66,
  0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4,
  0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18cff, 0x18d08,
  0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122,
  0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155, 0x1b164, 0x1b167,
  0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360, 0x1d376, 0x1f004, 0x1f004,
  0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202,
  0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265,
  0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393,
  0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4,
  0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d,
  0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596,
  0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc,
  0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec,
  0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a,
  0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa89,
  0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf, 0x1fae9, 0x1faf0, 0x1faf8,
  0x20000, 0x2fffd, 0x30000, 0x3fffd,
]

function isWide(code: number): boolean {
  // 구간이 122개라 이분 탐색으로 찾는다. 표는 시작·끝이 번갈아 든 평평한 배열이다.
  let low = 0
  let high = WIDE_RANGES.length / 2 - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const from = WIDE_RANGES[mid * 2]
    const to = WIDE_RANGES[mid * 2 + 1]
    if (from === undefined || to === undefined) return false
    if (code < from) high = mid - 1
    else if (code > to) low = mid + 1
    else return true
  }
  return false
}
