// xterm.js 헤드리스 인스턴스 2개를 나란히 놓고 셀 단위로 비교한다.
//
// 기준선(A) = 픽스처 원본 바이트, 대상(B) = herdr pane.read(ansi) 스냅샷.
// 판정은 serialize 문자열이 아니라 **버퍼 셀을 직접 걸어서** 낸다 —
// serialize 는 xterm→xterm 복원용이라 판정에 쓰면 addon 의 결함이 수치에 섞인다
// (01-criteria.md §2 사전 경고).

// 둘 다 CommonJS 라 default import 로 받는다.
import headless from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'

const { Terminal } = headless
const { Unicode11Addon } = unicode11

/** 원본과 같은 격자 크기로 만든다. 크기가 어긋나면 wrap·커서·SGR 이 전부 밀린다. */
export function makeTerm(cols, rows, { scrollback = 5000 } = {}) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback })
  // xterm.js 기본 유니코드는 6 — 이모지가 단일 폭이다. 11 로 올린다.
  const u11 = new Unicode11Addon()
  t.loadAddon(u11)
  t.unicode.activeVersion = '11'
  return t
}

/** write() 는 비동기다. 콜백을 기다리지 않고 buffer 를 읽으면 이전 상태가 나온다. */
export function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve))
}

/**
 * 화면(뷰포트) 격자를 셀 배열로 뜬다.
 * wide char 의 뒤따르는 spacer 셀은 width 0 으로 온다 — 문자로 세지 않고 표시만 남긴다.
 */
export function grid(term) {
  const buf = term.buffer.active
  const rows = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    const cells = []
    if (!line) {
      rows.push(cells)
      continue
    }
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x)
      if (!c) {
        cells.push(null)
        continue
      }
      cells.push({
        ch: c.getChars(), // '' = spacer 또는 빈 칸
        w: c.getWidth(),
        fg: c.isFgDefault() ? 'default' : `${c.isFgPalette() ? 'p' : 'rgb'}${c.getFgColor()}`,
        bg: c.isBgDefault() ? 'default' : `${c.isBgPalette() ? 'p' : 'rgb'}${c.getBgColor()}`,
        bold: !!c.isBold(),
        inverse: !!c.isInverse(),
        underline: !!c.isUnderline(),
      })
    }
    rows.push(cells)
  }
  return rows
}

export function cursor(term) {
  const buf = term.buffer.active
  return { x: buf.cursorX, y: buf.cursorY, baseY: buf.baseY, viewportY: buf.viewportY }
}

/**
 * 사람이 읽을 행 문자열. wide char 뒤의 spacer(w=0)는 건너뛰고,
 * 안 쓴 칸은 공백으로 채운다 — 안 그러면 열 위치가 눈에 안 보인다.
 * (판정은 compare 의 셀 단위 비교로 하고, 이건 원자료 가독성용이다)
 */
export function rowText(cells) {
  return cells.map((c) => (!c ? ' ' : c.w === 0 ? '' : c.ch || ' ')).join('').replace(/\s+$/, '')
}

/**
 * 셀 비교. rows 범위를 좁혀 프롬프트 같은 잡음을 뺀다.
 * 반환: 전체 셀 수 대비 텍스트/스타일 일치 수 + 어긋난 셀 목록(앞부분).
 */
export function compare(a, b, { rows } = {}) {
  const n = rows ?? Math.min(a.length, b.length)
  let cells = 0
  let textOk = 0
  let styleOk = 0
  const textDiff = []
  const styleDiff = []
  // 안 쓴 칸('')과 공백을 찍어둔 칸(' ')은 화면에서 구분되지 않는다. 둘을 같게 본다.
  // observe 스트림은 행 끝까지 공백을 찍고, pane.read 스냅샷은 안 찍는다 —
  // 정규화하지 않으면 같은 화면이 서로 다르다고 나온다.
  const blank = (t) => (t === '' || t === ' ' ? '' : t)
  for (let y = 0; y < n; y++) {
    const ra = a[y] ?? []
    const rb = b[y] ?? []
    const w = Math.max(ra.length, rb.length)
    for (let x = 0; x < w; x++) {
      const ca = ra[x] ?? null
      const cb = rb[x] ?? null
      cells++
      const ta = blank(ca?.ch ?? '')
      const tb = blank(cb?.ch ?? '')
      if (ta === tb) textOk++
      else if (textDiff.length < 40) textDiff.push({ y, x, a: ca?.ch ?? '', b: cb?.ch ?? '' })
      // 스타일은 글자가 있는 칸에서만 의미가 있다. 빈 칸의 색은 비교하지 않는다.
      //
      // 한계 (리뷰 지적 ⑫): 빈 칸 쌍을 styleOk 로 세면서 cells(분모)에도 남긴다.
      // 그래서 styleMatch 의 분모에 빈 칸이 들어간다. 213열 격자처럼 내용 칸 비율이
      // 낮은 화면에서는 이 비율이 실제보다 후하게 나오고, B2 의 95% 통과선이 헐거워진다.
      // 이번 3종 픽스처는 styleDiff 가 빈 배열(불일치 0건)이라 내용 칸만 세도 100% 여서
      // 판정이 안 바뀌었을 뿐이다. 내용이 적은 화면에 이 함수를 그대로 쓰면 안 된다 —
      // 그때는 분모를 "글자가 있는 칸"으로 좁혀야 한다.
      if (ta === '' && tb === '') {
        styleOk++
        continue
      }
      const sa = ca ? `${ca.fg}|${ca.bg}|${ca.bold ? 'B' : ''}${ca.inverse ? 'I' : ''}` : ''
      const sb = cb ? `${cb.fg}|${cb.bg}|${cb.bold ? 'B' : ''}${cb.inverse ? 'I' : ''}` : ''
      if (sa === sb) styleOk++
      else if (styleDiff.length < 40) styleDiff.push({ y, x, ch: ta, a: sa, b: sb })
    }
  }
  return {
    cells,
    textMatch: cells ? textOk / cells : 0,
    styleMatch: cells ? styleOk / cells : 0,
    textDiff,
    styleDiff,
  }
}

/** wide char 가 차지한 시작 열 목록 — 행 밀림을 보려면 이걸 맞춰봐야 한다 (B3). */
export function wideStarts(cells) {
  const out = []
  cells.forEach((c, x) => {
    if (c && c.w === 2) out.push({ x, ch: c.ch })
  })
  return out
}
