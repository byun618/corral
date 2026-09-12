// 터미널 뷰 (R2) — xterm 6.0.0 안정판 + addon-fit 0.11.0 (00-analysis §4-4 권고 그대로).
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

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import type { TerminalFrame } from '../../shared/types.js'

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

export function TerminalPane({ paneId }: { paneId: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const term = new Terminal({
      scrollback: 0,
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'SF Mono, Menlo, Monaco, monospace',
      theme: { background: '#12141a' },
      // unicode-graphemes 애드온이 unicode.register(proposed API)를 쓴다 — 명시 활성 필요.
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
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

    // --- 프레임 제시: 최신 프레임만, 쓰기 하나만 비행, 선택 중에는 보류 -------------
    let pending: TerminalFrame | null = null
    let writing = false
    let disposed = false
    let appliedMouseReporting: boolean | null = null
    let lastSeq = 0
    const writes: WriteRecord[] = []

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
      writing = true
      term.write(prefix + (frame === null ? '' : decoder.decode(frame.data)), () => {
        writing = false
        if (disposed) return
        if (frame !== null) {
          lastSeq = frame.seq
          // 쓰기 **완료** 시각 — S2 의 renderer 쪽 끝점. 프로브(term-read)가 읽어 간다.
          writes.push({ paneId: frame.paneId, seq: frame.seq, at: Date.now() })
          if (writes.length > WRITE_RING_MAX) writes.splice(0, writes.length - WRITE_RING_MAX)
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
    // S2 계측: onData 발화 시각을 렌더러 시계로 링에 남긴다 — write 완료도 같은 시계라
    // 교차 프로세스 클럭 스큐 없이 입력→화면을 잰다.
    const inputs: Array<{ data: string; at: number }> = []
    const dataListener = term.onData((data) => {
      inputs.push({ data, at: Date.now() })
      if (inputs.length > WRITE_RING_MAX) inputs.splice(0, inputs.length - WRITE_RING_MAX)
      window.corral.termInput(data)
    })

    // --- 크기: 컨테이너를 재서 fit → 변화가 있으면 main 에 알린다 -------------------
    // 마지막으로 서버에 보낸 크기 — 중복·왕복 진동을 끊는 방벽 (S5).
    let sentCols = 0
    let sentRows = 0
    const resizeListener = term.onResize(({ cols, rows }) => {
      if (cols === sentCols && rows === sentRows) return
      sentCols = cols
      sentRows = rows
      window.corral.termResize({ cols, rows })
    })
    /**
     * fit() 를 디바운스하고 **컨테이너 자체가 바뀐 경우에만** 반응한다 (S5).
     *
     * ResizeObserver 는 컨테이너를 보는데, fit() 이 그 안의 xterm 크기를 바꾸면 (스크롤바·반올림
     * 때문에 124↔126 처럼) 관측이 다시 튄다 → fit → termResize → 서버 프레임 → 또 관측… 무한 진동.
     * 컨테이너의 content-box 크기를 기억해 두고, **그 박스가 실제로 달라졌을 때만** fit 한다 —
     * fit 이 유발한 자식 변화(컨테이너 박스 불변)는 무시된다. 창 리사이즈만 통과한다. 디바운스로
     * 창 리사이즈 전이 중 중간 크기들을 한 번으로 뭉친다. onResize 의 중복 방벽이 마지막 보루다.
     */
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let boxW = 0
    let boxH = 0
    const runFit = (): void => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (box) {
        const w = Math.round(box.width)
        const h = Math.round(box.height)
        if (w === boxW && h === boxH) return // 컨테이너는 그대로 — fit 자기 유발
        boxW = w
        boxH = h
      }
      if (fitTimer !== null) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        runFit()
      }, 120)
    })
    observer.observe(container)

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
        direction: event.deltaY < 0 ? 'up' : 'down',
        lines,
        column,
        row,
      })
    }
    container.addEventListener('wheel', onWheel, { capture: true, passive: false })

    // --- 계측 프로브 (S1·S2·S3 의 xterm 쪽 실물) ------------------------------------
    // 대조 대상이 "xterm 버퍼 실물(buffer.getLine)" 이라고 기준이 지정한다. 화면 상태를
    // 읽기만 하는 훅이고, 쓰는 길은 없다.
    window.corralTermProbe = {
      // S7ⓔ — xterm 이 실제 렌더에 쓰는 폭 계산. graphemes 애드온이 활성이면 그 값이다.
      // 재는 대상(스트림 바이트)이 아니라 xterm 의 독립 폭 판정이라 폭 오라클의 한 축이 된다.
      cellWidth: (text) => {
        const core: unknown = Reflect.get(term, '_core')
        const svc: unknown = core && typeof core === 'object' ? Reflect.get(core, 'unicodeService') : null
        const fn = svc && typeof svc === 'object' ? Reflect.get(svc, 'getStringCellWidth') : null
        return typeof fn === 'function' ? (fn.call(svc, text) as number) : null
      },
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

    // 첫 fit 이 끝난 크기로 스트림을 연다 — 첫 연결부터 맞는 크기를 요청하게.
    runFit()
    void window.corral.selectPane({ paneId, cols: term.cols, rows: term.rows })
    term.focus()

    return () => {
      disposed = true
      delete window.corralTermProbe
      if (fitTimer !== null) clearTimeout(fitTimer)
      observer.disconnect()
      container.removeEventListener('wheel', onWheel, { capture: true })
      offFrame()
      selectionListener.dispose()
      dataListener.dispose()
      resizeListener.dispose()
      term.dispose()
    }
  }, [paneId])

  return <div className="term-host" data-term-pane={paneId} ref={containerRef} />
}
