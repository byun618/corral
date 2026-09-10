// 재생 프레임 빌더 — `pane.read(ansi)` 스냅샷 한 장을 xterm.js 에 **주기적으로 다시 그릴 수 있는**
// 바이트열로 바꾼다. 순수 함수다 (main 에서 만들고 렌더러는 그대로 write 한다).
//
// 왜 통째로 다시 그리나: herdr 는 델타를 주지 않는다. 스냅샷이 진실이고 이벤트는 근사 신호다
// (LIFE-342 §5 조건 2 · LIFE-344 R2-3). 그래서 매 갱신이 **전면 재그림**이고, 전면 재그림을
// 초당 여러 번 하면서도 히스토리를 더럽히지 않는 것이 이 파일의 전부다.
//
// 물려받은 제약 (LIFE-342 §5 조건 1, 헤드리스 실측):
//   naive (그냥 이어쓰기) → 가짜 히스토리 +34줄
//   reset (RIS)          → 진짜 히스토리 81줄 파괴
//   home                 → 0줄. **이걸 쓴다**
//
// 외부 서치가 독립적으로 같은 답을 냈고(분석 ⓖ3) 두 가지를 더 붙였다:
//   ① 전체를 **BSU/ESU**(`CSI ?2026 h/l`)로 감싼다 — 프레임 중간 상태가 화면에 안 뜬다.
//      xterm.js 6.0.0 이 DEC 2026 을 실제로 구현한다 (분석 ㉡, 번들 문자열 확인)
//   ② **마지막 행에 LF 를 붙이지 않는다** — 바닥 개행 한 번이 스크롤백을 1줄 늘린다
//
// 여기에 하나 더 얹는다 (이 구현의 몫):
//   ③ 칠하는 동안 **autowrap 을 끈다**(`CSI ?7l`). 행마다 CUP 로 자리를 잡으므로 wrap 이 필요 없고,
//      cols 를 herdr 보다 작게 잡았거나 ZWJ 폭이 어긋나(분석 ⓖ6) 행이 넘칠 때 그것이 **스크롤이
//      아니라 그 행의 잘림**이 된다. T3 의 "스크롤백 증가 0줄" 을 폭 오차와 분리하는 장치다.
//
// ED2(`\x1b[2J`)는 쓰지 않는다 — 분석 ⓖ2(xterm.js #5801)가 BSU 안의 ED2 가 viewportY 를 바닥으로
// 끌어내린다고 보고했고, LIFE-342 의 조건 1 과 방향이 같다.

/** 스냅샷 텍스트를 행 배열로 자른다. herdr 는 `\r\n` 으로 준다 (실측). */
export function splitRows(snapshot: string): string[] {
  return snapshot.split(/\r?\n/)
}

export type ScreenFrameInput = {
  /** `pane.read({source:'visible', format:'ansi', strip_ansi:false})` 의 text 그대로 */
  snapshot: string
  /** 격자 행 수 — `PaneInfo.scroll.viewport_rows` */
  rows: number
}

/**
 * 화면 한 장을 다시 그리는 바이트열.
 *
 * 행 수가 모자라면 빈 행으로 채우고, 남으면 **뒤에서부터** 자른다 (뷰포트는 화면 바닥이다).
 * 각 행은 `CUP → 내용 → SGR 리셋 → EL` 순서다. EL 을 내용 **뒤에** 두는 이유:
 * 앞에 두면 이전 프레임이 남긴 배경색으로 행을 지우게 되고, 색이 있는 화면에서 잔상이 남는다.
 */
export function buildScreenFrame({ snapshot, rows }: ScreenFrameInput): string {
  const lines = splitRows(snapshot)
  // 마지막 원소가 빈 문자열이면 그건 끝 개행이지 행이 아니다.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const view = lines.length > rows ? lines.slice(lines.length - rows) : lines

  const out: string[] = ['\x1b[?2026h', '\x1b[?7l']
  for (let y = 0; y < rows; y++) {
    out.push(`\x1b[${y + 1};1H`)
    out.push(view[y] ?? '')
    out.push('\x1b[0m\x1b[K')
  }
  // 마지막 행 뒤에 LF 를 붙이지 않는다 (분석 ⓖ3). 커서는 마지막 행에 남고,
  // ED0 로 그 아래(있다면)를 턴다.
  out.push('\x1b[0m\x1b[J')
  out.push('\x1b[?7h', '\x1b[?2026l')
  return out.join('')
}

/**
 * 스크롤백 씨앗 (T5). `recent_unwrapped` 로 회수한 **화면 위쪽 과거**를 히스토리로 밀어 넣는다.
 *
 * 여기서는 autowrap 을 **켠 채로** 줄마다 LF 를 붙인다 — 스크롤백은 스크롤로 만드는 것이 맞고,
 * 논리 줄이 격자보다 길면 herdr 가 그랬듯 접혀야 한다.
 *
 * 알트스크린 판은 host 히스토리가 0줄이다 (LIFE-342 §5-4a). 그때 `lines` 는 빈 배열이 되고
 * 이 함수는 빈 문자열을 돌려준다 — **가짜 히스토리를 만들지 않는다**.
 */
export function buildScrollbackSeed(lines: readonly string[], rows: number): string {
  if (lines.length === 0 || rows <= 0) return ''
  const out: string[] = ['\x1b[?2026h', '\x1b[?7h', '\x1b[H']
  for (const line of lines) out.push(line, '\x1b[0m\r\n')
  // **여기가 씨앗의 핵심이다.** 위에서 쓴 H 줄은 아직 화면 위쪽에 앉아 있을 뿐 히스토리가 아니다 —
  // 뷰포트를 벗어나야 스크롤백이 된다. 커서는 지금 행 H 에 있으므로 개행 `rows-1` 번이면
  // 정확히 H 줄이 위로 밀려 올라가고(baseY = H) 화면은 다시 빈 격자가 된다. 그 위에 프레임을 칠한다.
  // 개행 수를 넘기면 가짜 빈 줄이 히스토리에 섞이고, 모자라면 화면이 씨앗을 덮어 히스토리가 사라진다.
  out.push('\n'.repeat(rows - 1))
  out.push('\x1b[?2026l')
  return out.join('')
}

/**
 * 스냅샷의 화면 부분과 `recent_unwrapped` 결과가 겹치는 만큼을 잘라내 **과거만** 남긴다.
 *
 * `recent_unwrapped` 는 논리 줄이고 `visible` 은 접힌 줄이라 길이가 안 맞는다. 그래서 개수로
 * 자르지 않고 **꼬리 일치**로 자른다: visible 의 비어 있지 않은 마지막 줄들이 recent 의 꼬리와
 * 같은 지점을 찾아 거기서 끊는다. 못 찾으면 보수적으로 화면 행 수만큼을 잘라낸다
 * (덜 보여주는 쪽이 없는 과거를 지어내는 쪽보다 낫다).
 */
export function historyAbove(recent: readonly string[], visible: readonly string[], rows: number): string[] {
  const norm = (line: string): string => line.replace(/\s+$/, '')
  const screen = visible.map(norm).filter((line) => line !== '')
  const tail = recent.map(norm)
  // 꼬리에 붙은 빈 줄은 비교에서 뺀다.
  let end = tail.length
  while (end > 0 && tail[end - 1] === '') end -= 1

  for (let k = Math.min(screen.length, end); k >= 1; k--) {
    let same = true
    for (let i = 0; i < k; i++) {
      if (tail[end - k + i] !== screen[screen.length - k + i]) {
        same = false
        break
      }
    }
    if (same) return recent.slice(0, end - k)
  }
  return recent.slice(0, Math.max(0, end - rows))
}
