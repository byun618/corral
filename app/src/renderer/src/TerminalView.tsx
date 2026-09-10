// 터미널 표면 — xterm.js 인스턴스 **하나**를 들고 main 이 만든 프레임을 그대로 쓴다.
//
// 렌더러가 하는 일은 셋뿐이다:
//   ① 격자를 herdr 가 말한 cols×rows 로 맞추고, 그 격자가 창에 들어가도록 글자 크기를 고른다
//   ② 프레임 바이트를 `term.write()` 한다 (바이트를 만드는 곳은 main — 로그에 그대로 남는다)
//   ③ 사용자의 키를 main 으로 되돌려 보낸다. **로컬 에코는 하지 않는다** —
//      herdr 를 돌아온 스냅샷에 그 글자가 실려야 화면에 뜬다 (I1 이 재는 것이 그 왕복이다)
//
// 인스턴스 수명 (Q8): **pane 을 오가는 동안에는 인스턴스 하나를 재사용한다.**
//   - pane A → pane B 는 이 컴포넌트가 붙어 있는 채로 일어나므로 `term.reset()` + 재칠하기다.
//     WebGL 컨텍스트가 쌓이지 않는다 (분석 ⓖ8: 도메인당 한도 8~16, 넘으면 조용히 검은 화면)
//   - 선택을 **비우면** 컴포넌트가 통째로 언마운트되고 인스턴스도 dispose 된다. 아무것도 안 보는
//     동안 컨텍스트를 물고 있을 이유가 없다. 대신 다시 붙으면 새 인스턴스라 **모드는 DOM 에**
//     들고 있어야 한다 (dataset) — 실측에서 T7 세 모드가 전부 11 로 나온 원인이 이것이었다

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalFrame, TerminalState } from '../../shared/types'
import '@xterm/xterm/css/xterm.css'

/**
 * 커서를 그리지 않는다 (T6 결정).
 *
 * `PaneReadResult` 에 커서가 없다 — 스키마 계약이다 (분석 §4-ⓐ). 위치를 모르는 커서를
 * "마지막 글자 뒤" 같은 추측으로 그리면 alt-screen TUI 에서는 거의 항상 틀린 자리에 깜빡인다.
 * 없는 것보다 나쁘다는 것이 기준의 문구다. 그래서 `?25l` 로 끄고, 대신 **입력 포커스**를
 * 테두리로 보인다 — 사용자가 알아야 하는 것은 "내 키가 어디로 가나" 이고 그건 알려줄 수 있다.
 */
const HIDE_CURSOR = '\x1b[?25l'

/** 실측으로 `pane.send_keys` 가 받는 것이 확인된 이름만 쓴다 (`Home`·`PageUp` 은 거부됐다). */
const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Tab: 'Tab',
}

/**
 * 유니코드 폭 모드. **셋 중 하나만 활성일 수 있다** — `activeVersion` 은 하나뿐이고
 * unicode11 과 graphemes 를 동시에 켜는 선택지는 없다 (분석 ⓖ5).
 *
 *   '6'          기본. 이모지가 단일 폭이라 CJK 화면이 밀린다
 *   '11'         CJK·이모지를 2칸으로. 다만 ZWJ 합성은 구성 문자 각각을 세어 넓어진다
 *   'graphemes'  ZWJ 클러스터를 하나로 묶어 2칸. 애드온 스스로 experimental 표기
 *
 * 무엇을 켤지는 T7 실측으로 정했다 — `03-result-claude.md` §T7.
 * 계측이 `window.__corralUnicode(mode)` 로 갈아 끼우고 다시 칠해 비교한다.
 */
export type UnicodeMode = '6' | '11' | 'graphemes'

/**
 * **실측으로 고른 값이다** (T7, `raw/claude/11-t7-width.json`).
 *
 * herdr 가 각 글자를 몇 칸으로 세는지 재고(스냅샷의 공백 수로 역산) xterm 세 모드와 맞춰 봤다:
 *
 *   표본 7종 중 어긋난 개수 — '6': 3건 · '11': 2건 · **'graphemes': 0건**
 *   특히 ZWJ 가족(👨‍👩‍👧)은 herdr 2칸인데 '11' 은 6칸으로 그려 **뒤 내용이 4칸 밀린다**.
 *   VS16 하트(❤️)도 '6'·'11' 에서 1칸 밀린다. graphemes 는 둘 다 herdr 와 같은 2칸이다.
 *
 * 애드온 스스로 experimental 표기를 달고 있다는 점은 안다 (분석 §2-⑤). 그래도 켠다 —
 * 재생 정합성이 걸린 문제이고(ⓖ6), 실험 딱지보다 **밀림 0건**이라는 실측이 앞선다.
 * 화면 근거는 모드별 스크린샷 `shots/width/t7-*.png` 에 있다 (관문 ④).
 */
const DEFAULT_UNICODE: UnicodeMode = 'graphemes'

type Props = { state: TerminalState; title: string; subtitle: string }

export function TerminalView({ state, title, subtitle }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const generationRef = useRef(-1)
  const gridRef = useRef<{ cols: number; rows: number } | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)

  // --- 인스턴스 1개 ------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      cursorBlink: false,
      // 커서를 안 그리므로 깜빡임도 없다. 아래에서 `?25l` 로 실제로 끈다.
      theme: { background: '#0d0f14', foreground: '#d7dce5' },
      // 6.0.0 신설 (분석 ㉢). ED2 를 스크롤백으로 밀지 않는다 — 재생 프레임은 ED2 를 쓰지
      // 않지만 pane 안 프로그램이 보낸 ED2 가 스냅샷에 실려 올 수 있다.
      scrollOnEraseInDisplay: false,
    })
    const loaded = new Set<UnicodeMode>()
    const applyUnicode = (mode: UnicodeMode): string => {
      if (mode === '11' && !loaded.has('11')) {
        term.loadAddon(new Unicode11Addon())
        loaded.add('11')
      }
      if (mode === 'graphemes' && !loaded.has('graphemes')) {
        term.loadAddon(new UnicodeGraphemesAddon())
        loaded.add('graphemes')
      }
      term.unicode.activeVersion = mode === 'graphemes' ? '15-graphemes' : mode
      return term.unicode.activeVersion
    }
    applyUnicode(readUnicodeMode())
    window.__corralUnicode = applyUnicode
    term.open(host)
    term.write(HIDE_CURSOR)
    termRef.current = term

    // 사용자 키 → main. 로컬 에코 없음.
    const onData = term.onData((data) => {
      void window.corral.sendPaneText(data)
    })
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.metaKey || event.ctrlKey || event.altKey) return true
      const named = NAMED_KEYS[event.key]
      if (named === undefined) return true
      // 이름으로 보낸다 — 이 터미널의 모드가 아니라 **pane 의 모드**가 바이트를 정해야 한다.
      void window.corral.sendPaneKeys([named])
      return false
    })

    // 계측용 — 판정자가 렌더러의 **진짜 버퍼**를 셀 단위로 뜰 수 있게 문을 하나 연다 (T1·T3).
    // 헤드리스 인스턴스를 따로 돌려 재는 것은 "화면을 잰 것" 이 아니다 (관문 ④).
    window.__corralTerm = term

    return () => {
      onData.dispose()
      webglRef.current?.dispose()
      webglRef.current = null
      delete window.__corralTerm
      delete window.__corralUnicode
      term.dispose()
      termRef.current = null
    }
  }, [])

  // --- 프레임 수신 -------------------------------------------------------
  useEffect(() => {
    return window.corral.onTerminalFrame((frame: TerminalFrame) => {
      const term = termRef.current
      if (term === null) return
      // 세대가 바뀌었으면 화면을 비우고 새로 세운다. main 도 세대를 검사하지만(R4),
      // 렌더러가 한 번 더 보는 편이 싸다 — 이미 큐에 든 프레임은 main 이 못 거둔다.
      if (frame.generation !== generationRef.current) {
        if (frame.kind !== 'attach') return
        generationRef.current = frame.generation
        term.reset()
        term.write(HIDE_CURSOR)
        gridRef.current = null
      }
      const grid = gridRef.current
      if (grid === null || grid.cols !== frame.grid.cols || grid.rows !== frame.grid.rows) {
        gridRef.current = { cols: frame.grid.cols, rows: frame.grid.rows }
        term.resize(frame.grid.cols, frame.grid.rows)
        fit(boxRef.current, hostRef.current, term)
      }
      const startedAt = performance.now()
      term.write(frame.bytes, () => {
        // 파싱이 실제로 끝난 시점을 main 로그로 되돌린다 — I1 의 "화면에 나타나기까지" 가
        // 여기서 끝난다. 상태만 보고 적으면 그건 주장이지 관측이 아니다.
        window.corral.reportProbe('term.painted', {
          seq: String(frame.seq),
          generation: String(frame.generation),
          kind: frame.kind,
          reason: frame.reason,
          frameAt: String(frame.at),
          paintMs: (performance.now() - startedAt).toFixed(2),
          baseY: String(term.buffer.active.baseY),
          length: String(frame.bytes.length),
        })
      })
    })
  }, [])

  // --- 창 크기 변화 ------------------------------------------------------
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const observer = new ResizeObserver(() => fit(box, hostRef.current, termRef.current))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // --- WebGL 은 **실측 뒤에** 켠다 (P1) ----------------------------------
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const want = state.paneId !== null && shouldUseWebgl()
    if (!want && webglRef.current !== null) {
      webglRef.current.dispose()
      webglRef.current = null
      window.corral.reportProbe('term.webgl', { event: 'disposed' })
      return
    }
    if (want && webglRef.current === null) {
      try {
        const addon = new WebglAddon()
        // 컨텍스트를 잃으면 즉시 뗀다 — 안 떼면 검은 화면으로 남는다 (분석 ⓖ8).
        addon.onContextLoss(() => {
          addon.dispose()
          webglRef.current = null
          window.corral.reportProbe('term.webgl', { event: 'context_loss' })
        })
        term.loadAddon(addon)
        webglRef.current = addon
        window.corral.reportProbe('term.webgl', { event: 'loaded' })
      } catch (error) {
        window.corral.reportProbe('term.webgl', { event: 'failed', error: String(error) })
      }
    }
  }, [state.paneId])

  const dead = state.paneId !== null && !state.alive

  return (
    <div className="term-wrap">
      <div className="term-head">
        <span className="term-title">{title}</span>
        <span className="term-sub">{subtitle}</span>
        {state.grid !== null && (
          <span className="term-grid">
            {state.grid.cols}×{state.grid.rows}
            <em className="tag">{state.grid.source}</em>
          </span>
        )}
        {state.seededLines !== null && <span className="term-grid">history {state.seededLines}</span>}
        {dead && <em className="tag tag-stopped">{state.deadReason}</em>}
      </div>
      {/* 죽은 pane 은 마지막 화면을 그대로 두되 흐리게 덮는다 — 지우면 무엇이 죽었는지 못 본다 */}
      <div ref={boxRef} className={dead ? 'term-box term-box-dead' : 'term-box'}>
        <div ref={hostRef} className="term-host" />
        {dead && <div className="term-dead-veil">{state.deadReason}</div>}
      </div>
      {state.inputBlocked !== null && <div className="term-foot warn">입력 막힘 · {state.inputBlocked}</div>}
    </div>
  )
}

/**
 * **안 켠다.** P1 실측이 켤 이유를 못 준다 (`raw/claude/50-agent-cost.json` → `p1`).
 *
 * 두 팔을 **번갈아 3라운드** 돌리고 팔당 45표본을 모았다. 라운드마다 두 팔의 프레임 수가
 * 60장·읽기 99회로 똑같아, 같은 부하를 잰 값이다.
 *
 *   |        | 유휴 CPU p50/p95 | 부하 CPU p50/p95 | RSS p50 (유휴/부하) |
 *   | DOM    | 1.7% / 4.4%      | 2.5% / 4.7%      | **480 / 483 MB**    |
 *   | WebGL  | 1.5% / 3.5%      | 2.7% / 4.4%      | 510 / 511 MB        |
 *
 * CPU 는 **두 렌더러를 가르지 못한다.** 합계 p50 차이가 0.2%p 안이고, 라운드별로 방향이
 * 뒤집힌다 (부하 p50: DOM 2.9·2.7·1.1 대 WebGL 2.7·2.5·3.0). 일관되게 나오는 차이는
 * **RSS 30MB** 하나뿐이고 그건 DOM 이 유리하다.
 *
 * 왜 이렇게 나오나 — GPU 경로의 이점은 초당 수십 프레임을 그릴 때 나온다. 이 설계의 프레임
 * 상한은 심장박동이 정하는 **4Hz** 다 (§2.5). 그 영역에서는 캔버스 유지 비용이 이득보다 크다.
 * 게다가 WebGL 은 컨텍스트 손실이라는 실패 모드를 하나 더 들여온다 (분석 ⓖ8).
 *
 * (1차 측정은 WebGL 이 크게 유리하다고 나왔었는데 — 유휴 0.2% 대 1.3% — 앞 팔의 티커가
 * 살아남아 두 팔이 다른 부하를 잰 결과였다. 하네스를 고치니 그 차이가 사라졌다.)
 *
 * `data-corral-webgl="1"` 로 켤 수 있고 그 경로는 살려 둔다 (컨텍스트 손실 시 즉시 dispose).
 * 프레임률을 올리는 변경이 오면 이 표를 다시 재는 자리다.
 */
function shouldUseWebgl(): boolean {
  return document.documentElement.dataset['corralWebgl'] === '1'
}

function readUnicodeMode(): UnicodeMode {
  const wanted = document.documentElement.dataset['corralUnicode']
  if (wanted === '6' || wanted === '11' || wanted === 'graphemes') return wanted
  return DEFAULT_UNICODE
}

/**
 * 격자는 herdr 것이라 **corral 이 글자 크기를 바꿔 맞춘다.** 통상의 FitAddon 경로(창 크기 →
 * cols·rows)가 여기선 거꾸로다: `pane.resize` 가 목표 cols×rows 를 못 받기 때문이다 (분석 §4-ⓓ).
 *
 * 두 단계다. ① 셀 크기를 재서 글자 크기를 고른다 (정수라 딱 안 맞는다) ② 남는 오차는 CSS
 * 배율로 마저 줄인다. 배율이 1 보다 크지 않게 잡아 확대로 흐려지는 일은 없게 한다.
 */
function fit(box: HTMLDivElement | null, host: HTMLDivElement | null, term: Terminal | null): void {
  if (box === null || host === null || term === null) return
  const width = box.clientWidth
  const height = box.clientHeight
  if (width === 0 || height === 0) return

  host.style.transform = 'scale(1)'
  const before = host.getBoundingClientRect()
  if (before.width === 0 || before.height === 0) return
  const cellW = before.width / term.cols
  const cellH = before.height / term.rows
  if (cellW === 0 || cellH === 0) return

  const ratio = Math.min(width / before.width, height / before.height)
  const current = term.options.fontSize ?? 13
  const next = Math.max(6, Math.min(22, Math.floor(current * ratio)))
  if (next !== current) term.options.fontSize = next
  const after = host.getBoundingClientRect()
  const residual = Math.min(1, width / after.width, height / after.height)
  host.style.transformOrigin = 'top left'
  host.style.transform = `scale(${residual.toFixed(4)})`
}
