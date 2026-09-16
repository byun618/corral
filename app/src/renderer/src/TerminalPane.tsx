// 터미널 뷰 (R2) — xterm 6.0.0 안정판 (00-analysis §4-4 권고 그대로).
//
// 렌더러 결정과 근거:
//   · **DOM 렌더러** (기본값) — WebGL 은 Electron 에서 context loss 로 영구 블랙스크린 위험이
//     외부 확인됨 (LIFE-345 P1 결론 유지, grok 서치 §2)
//   · **scrollback 0** — endpoint 프레임은 항상 뷰포트 전체 리페인트이고 스크롤은 서버측이다
//     (00-analysis §2-2). xterm 은 순수 뷰포트다. 가짜 히스토리를 만들지 않는다
//   · 커서는 스트림이 그린다 (절대 CUP + DECSCUSR + show/hide) — xterm 커서 표시 그대로 사용
//
// 프레임 제시(coalesce)는 Studio 웹의 TerminalEndpointPresentation 을 **참고해 얇게 재작성**
// (벤더 아님 — 코디네이터 지시). 프레임은 자기완결 리페인트라 쓰기 중 새 프레임이 오면
// **최신 것만** 남긴다 — 밀린 프레임을 순서대로 다 그리는 것은 낭비이자 지연이다.
//
// **LIFE-373 에서 크기의 주인이 바뀌었다** (§10-R13): 이 컴포넌트는 더 이상 자기 상자를 재서
// `fit()`→`termResize` 로 서버에 크기를 요구하지 않는다. 격자는 **영역**이 한 번 요청하고,
// 서버가 준 pane `innerRect` 가 프레임의 cols·rows 로 내려온다 — xterm 은 그 값으로 resize 된다.
// 왕복이 사라져 요청이 연결당 1회로 수렴하고(S3), 픽셀→cols 역산이 한 군데로 줄었다.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import type { TerminalFrame } from '../../shared/types.js'
import { measureCellSize, readCellSize } from './term-metrics.js'

const decoder = new TextDecoder()

/** S2·S1·S3 프로브가 읽는 쓰기 완료 기록. 최근 것만 남긴다. */
type WriteRecord = { paneId: string; seq: number; at: number }
const WRITE_RING_MAX = 400

/**
 * xterm 의 비공개 코어에서 커서 숨김 상태를 읽는다 (S3 프로브 전용).
 *
 * 공개 API 에 커서 가시성이 없다 — DECTCEM(\x1b[?25l/h)의 결과는 core 의 coreService 에만
 * 남는다. 재는 대상(스트림이 쓴 시퀀스)을 다시 읽는 게 아니라 **xterm 이 실제로 도달한 상태**를
 * 읽어야 하므로 비공개 필드를 쓴다. 비공개 접근은 이 함수 하나로 가둔다 (6.0.0 고정 전제,
 * 원자료에 비공개 API 사용을 명시한다).
 */
function readCursorHidden(term: Terminal): boolean | null {
  const core: unknown = Reflect.get(term, '_core')
  if (core === null || typeof core !== 'object') return null
  const service: unknown = Reflect.get(core, 'coreService')
  if (service === null || typeof service !== 'object') return null
  const hidden: unknown = Reflect.get(service, 'isCursorHidden')
  return typeof hidden === 'boolean' ? hidden : null
}

/** design-tokens.css 의 변수 하나를 런타임에 읽는다 (xterm 처럼 CSS 를 못 쓰는 소비자용). */
function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

export function TerminalPane({
  paneId,
  diagnostics,
  focusToken = 0,
}: {
  paneId: string
  diagnostics: boolean
  /**
   * 사용자가 이 pane 을 **다시 골랐다**는 신호 (값이 바뀔 때마다 xterm 에 포커스를 준다).
   *
   * 탭바·사이드바에서 탭을 누르면 DOM 포커스는 눌린 그 요소로 간다 — 그대로 두면 다음 타건이
   * 터미널이 아니라 탭으로 들어간다. 마운트 때 한 번 주는 포커스로는 **이미 떠 있는 pane 을
   * 다시 고른 경우**를 못 잡는다 (LIFE-353 은 pane 을 고를 때마다 새로 마운트돼서 안 보였다).
   */
  focusToken?: number
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const term = new Terminal({
      scrollback: 0,
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'SF Mono, Menlo, Monaco, monospace',
      // --bg-surface(design-tokens.css) — xterm 은 CSS 변수를 못 읽으므로(캔버스/DOM 렌더러
      // 자체 설정) **런타임에 읽어 넘긴다**. 리터럴로 복사해 두면 토큰이 바뀔 때 따라오지 않는다
      // — 게이트 ① 수정 라운드에서 배경 서열이 원안으로 되돌아가며 실제로 어긋났던 자리다.
      theme: { background: readToken('--bg-surface', '#141718') },
      // unicode-graphemes 애드온이 unicode.register(proposed API)를 쓴다 — 명시 활성 필요.
      allowProposedApi: true,
    })
    /**
     * 이모지·CJK 폭을 herdr 격자와 맞춘다 (S1·S7ⓔ — 폭 재판 방지).
     *
     * xterm 기본 폭 표는 🙂·🚀 류 이모지를 **1칸**으로 그리는데, herdr 격자(Rust unicode-width)는
     * **2칸**으로 깐다. 그러면 frame-to-ansi 의 열 앵커가 안 채워진 칸을 남겨 셀이 어긋난다
     * (S1 미달). 이 애드온은 Unicode 15 그래핌+wcwidth 로 xterm 폭을 herdr 쪽과 일치시킨다.
     * 6.0.0 안정판이라 #5893(DOM 이모지 회귀, 6.1 beta 전용)은 해당 없다 (00-analysis §4-4).
     */
    const graphemes = new UnicodeGraphemesAddon()
    term.loadAddon(graphemes)
    term.unicode.activeVersion = '15-graphemes'
    term.open(container)
    termRef.current = term

    // --- 프레임 제시: 최신 프레임만, 쓰기 하나만 비행, 선택 중에는 보류 -------------
    let pending: TerminalFrame | null = null
    let writing = false
    let disposed = false
    let appliedMouseReporting: boolean | null = null
    let lastSeq = 0
    const writes: WriteRecord[] = []
    /**
     * DECRQM 프로브가 켜지면 onData 를 **삼킨다** (수정 1회차 L2). xterm 이 DECRQM 질의에
     * 답하는 DECRPM 리포트는 onData 로 나오는데, 그걸 pane 으로 흘리면 셸에 잡음이 찍힌다 —
     * 프로브 창 동안엔 forward 하지 않고 여기 모은다. 평시엔 항상 null 이라 입력 경로 불변.
     */
    let decrqmCapture: { buf: string } | null = null

    // --- 크기: **서버가 준 프레임 크기를 그대로 따른다** (R13) ----------------------
    // 프레임은 전체 리페인트라 resize 와 write 사이에 찢어질 창이 없다 — 먼저 맞추고 그 위에 쓴다.
    const sizeTo = (cols: number, rows: number): void => {
      if (term.cols === cols && term.rows === rows) return
      term.resize(cols, rows)
    }

    const flush = (): void => {
      if (disposed || writing || term.hasSelection()) return
      const frame = pending
      pending = null
      let prefix = ''
      if (frame !== null && appliedMouseReporting !== frame.mouseReporting) {
        // pane 앱이 마우스를 받는 동안만 xterm 이 SGR 리포트를 만들게 한다 — 이 시퀀스는
        // 서버가 아니라 **corral 이 xterm 에게** 하는 말이다 (Studio 웹과 같은 수법).
        prefix = frame.mouseReporting ? '\x1b[?1006h\x1b[?1002h' : '\x1b[?1002l\x1b[?1006l'
        appliedMouseReporting = frame.mouseReporting
      }
      if (frame === null && prefix === '') return
      // 서버 격자에 맞춘 뒤 쓴다 (R13) — 프레임이 그 크기를 전제로 만들어졌다.
      if (frame !== null) sizeTo(frame.cols, frame.rows)
      writing = true
      term.write(prefix + (frame === null ? '' : decoder.decode(frame.data)), () => {
        writing = false
        if (disposed) return
        if (frame !== null) {
          lastSeq = frame.seq
          // 쓰기 **완료** 시각 — S2 의 renderer 쪽 끝점. 프로브(term-read)가 읽어 간다.
          // 진단(계측) 실행에서만 링에 쌓는다 (수정 1회차 L7) — 평시엔 이 링을 안 만든다.
          if (diagnostics) {
            writes.push({ paneId: frame.paneId, seq: frame.seq, at: Date.now() })
            if (writes.length > WRITE_RING_MAX) writes.splice(0, writes.length - WRITE_RING_MAX)
          }
        }
        flush()
      })
    }

    const offFrame = window.corral.onTermFrame((frame) => {
      // 이전 pane 의 늦은 프레임은 버린다 — 전환(S6) 때 A 잔상이 B 화면에 섞이면 안 된다.
      if (frame.paneId !== paneId) return
      pending = frame
      flush()
    })

    // 선택이 풀리는 순간 보류분을 흘린다 (선택 중 프레임을 쓰면 선택이 지워진다).
    const selectionListener = term.onSelectionChange(() => {
      if (!term.hasSelection()) flush()
    })

    // --- 입력: xterm 이 만드는 VT 바이트 그대로 main 으로 ---------------------------
    // S2 계측: onData 발화 시각을 렌더러 시계로 링에 남긴다 (진단 실행에서만) — S2 는 이제
    // 주입시각(main)을 기준으로 잰다(수정 1회차 C3). onData 시각은 그 드리프트를 원자료에
    // 드러내는 참고값으로 남긴다.
    const inputs: Array<{ data: string; at: number }> = []
    const dataListener = term.onData((data) => {
      // DECRQM 프로브 창이면 xterm 의 응답을 삼킨다 — pane 으로 흘리지 않는다 (L2).
      if (decrqmCapture !== null) {
        decrqmCapture.buf += data
        return
      }
      if (diagnostics) {
        inputs.push({ data, at: Date.now() })
        if (inputs.length > WRITE_RING_MAX) inputs.splice(0, inputs.length - WRITE_RING_MAX)
      }
      window.corral.termInput({ paneId, data })
    })

    // --- wheel: 가로채서 서버 스크롤로 (캡처 + preventDefault) ----------------------
    // xterm 에 스크롤백이 없고(0), mouseReporting 이 켜져 있으면 xterm 자신도 wheel 을
    // SGR 리포트로 바꾼다 — 두 길이 같이 살면 두 번 스크롤된다. 캡처 단계에서 끊어
    // **corral 의 한 길**(termScroll → 벤더 session.scroll)로만 보낸다.
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const screen = container.querySelector('.xterm-screen')
      if (screen === null) return
      const rect = screen.getBoundingClientRect()
      const cellWidth = rect.width / term.cols
      const cellHeight = rect.height / term.rows
      if (cellHeight <= 0) return
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / cellHeight))
      const column = Math.min(term.cols - 1, Math.max(0, Math.floor((event.clientX - rect.left) / cellWidth)))
      const row = Math.min(term.rows - 1, Math.max(0, Math.floor((event.clientY - rect.top) / cellHeight)))
      window.corral.termScroll({
        paneId,
        direction: event.deltaY < 0 ? 'up' : 'down',
        lines,
        column,
        row,
      })
    }
    container.addEventListener('wheel', onWheel, { capture: true, passive: false })

    // --- 계측 프로브 (S1·S2·S3 의 xterm 쪽 실물) ------------------------------------
    // 대조 대상이 "xterm 버퍼 실물(buffer.getLine)" 이라고 기준이 지정한다. 화면 상태를
    // 읽기만 하는 훅이고, 쓰는 길은 없다. **진단(계측) 실행에서만 노출**한다 (수정 1회차 L7) —
    // 평시 앱에는 window.corralTermProbe 가 아예 없다 (control 채널도 없어 부를 길도 없다).
    if (diagnostics) {
      window.corralTermProbe = {
        // S7ⓔ — xterm 이 실제 렌더에 쓰는 폭 계산. graphemes 애드온이 활성이면 그 값이다.
        // 재는 대상(스트림 바이트)이 아니라 xterm 의 독립 폭 판정이라 폭 오라클의 한 축이 된다.
        // _core 비공개 접근은 readCursorHidden 주석의 6.0.0 고정 전제를 그대로 따른다 (L5).
        cellWidth: (text) => {
          const core: unknown = Reflect.get(term, '_core')
          const svc: unknown = core && typeof core === 'object' ? Reflect.get(core, 'unicodeService') : null
          const fn = svc && typeof svc === 'object' ? Reflect.get(svc, 'getStringCellWidth') : null
          return typeof fn === 'function' ? (fn.call(svc, text) as number) : null
        },
        /**
         * S7ⓕ/L2 — DECRQM 질의(`\x1b[?<mode>$p`)를 xterm 에 먹이고 그 DECRPM 응답을 그대로
         * 돌려준다. #5800(프로덕션 재-minify 가 DECRQM CSI 핸들러를 깨뜨림) 우회가 살아 있으면
         * `\x1b[?2026;<value>$y` 가 오고, 깨졌으면 빈 문자열이다 — 우회의 **직접 관측**이다.
         * 응답은 onData 로 나오므로 decrqmCapture 로 삼켜 pane 을 더럽히지 않는다.
         */
        decrqm: (mode) =>
          new Promise<string>((resolve) => {
            const cap = { buf: '' }
            decrqmCapture = cap
            term.write(`\x1b[?${mode}$p`, () => {
              setTimeout(() => {
                decrqmCapture = null
                resolve(cap.buf)
              }, 60)
            })
          }),
        /**
         * R13-a — 이 xterm 이 실제로 쓰는 셀 px 과 **오프스크린 측정치**를 나란히 준다.
         * 둘이 다르면 영역이 요청하는 격자가 통째로 어긋난다 (전 pane 동시 오차).
         */
        cell: () => ({ live: readCellSize(term), measured: measureCellSize() }),
        read: () => {
          const buffer = term.buffer.active
          const lines: string[] = []
          for (let y = 0; y < term.rows; y++) {
            lines.push(buffer.getLine(y)?.translateToString(false) ?? '')
          }
          return {
            paneId,
            cols: term.cols,
            rows: term.rows,
            cursorX: buffer.cursorX,
            cursorY: buffer.cursorY,
            cursorHidden: readCursorHidden(term),
            lastSeq,
            lines,
            writes: [...writes],
            inputs: [...inputs],
            at: Date.now(),
          }
        },
      }
    }

    // 크기는 영역이 요청하고 서버가 정한다 — 여기서는 포커스만 알린다 (S2: 마운트=사용자 선택).
    void window.corral.selectPane({ paneId })
    term.focus()

    return () => {
      disposed = true
      if (diagnostics) delete window.corralTermProbe
      container.removeEventListener('wheel', onWheel, { capture: true })
      offFrame()
      selectionListener.dispose()
      dataListener.dispose()
      termRef.current = null
      term.dispose()
    }
  }, [paneId, diagnostics])

  // 다시 고른 순간 터미널로 포커스를 돌린다 (위 focusToken 주석).
  useEffect(() => {
    termRef.current?.focus()
  }, [focusToken])

  return <div className="term-host" data-term-pane={paneId} ref={containerRef} />
}
