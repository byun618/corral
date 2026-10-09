// 터미널 뷰 (R2) — xterm 6.0.0 안정판 (00-analysis §4-4 권고 그대로).
//
// 렌더러 결정과 근거:
//   · **DOM 렌더러** (기본값) — WebGL 은 Electron 에서 context loss 로 영구 블랙스크린 위험이
//     외부 확인됨 (LIFE-345 P1 결론 유지, grok 서치 §2)
//   · **scrollback 0** — endpoint 프레임은 항상 뷰포트 전체 리페인트이고 스크롤은 서버측이다
//     (00-analysis §2-2). xterm 은 순수 뷰포트다. 가짜 히스토리를 만들지 않는다
//   · 커서는 스트림이 그린다 (절대 CUP + DECSCUSR + show/hide) — xterm 커서 표시 그대로 사용.
//     herdr 는 앱이 커서 모양을 요청하지 않으면 매 프레임 `\e[0 q`(기본)를 보내고, xterm 은 0 이면 옵션 값(설정)을 쓴다.
//     앱이 `\e[5 q` 등을 요청하면 그 값이 이후 프레임에도 실려 앱이 이긴다(LIFE-512 U10 실측 `raw/claude/u9/`)
//   · 외관(글꼴·테마·커서·대비)은 사용자 설정이다 — `terminal-appearance.ts` 로 만들고 바뀐 것만 쓴다(LIFE-512)
//
// 프레임 제시(coalesce)는 Studio 웹의 TerminalEndpointPresentation 을 **참고해 얇게 재작성**
// (벤더 아님 — 코디네이터 지시). 프레임은 자기완결 리페인트라 쓰기 중 새 프레임이 오면
// **최신 것만** 남긴다 — 밀린 프레임을 순서대로 다 그리는 것은 낭비이자 지연이다.
//
// **LIFE-373 에서 크기의 주인이 바뀌었다** (§10-R13): 이 컴포넌트는 더 이상 자기 상자를 재서
// `fit()`→`termResize` 로 서버에 크기를 요구하지 않는다. 격자는 **영역**이 한 번 요청하고,
// 서버가 준 pane `innerRect` 가 프레임의 cols·rows 로 내려온다 — xterm 은 그 값으로 resize 된다.
// 왕복이 사라져 요청이 연결당 1회로 수렴하고(S3), 픽셀→cols 역산이 한 군데로 줄었다.

import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import type { TerminalFrame } from '../../shared/types.js'
import { measureCellSize, readCellSize } from './term-metrics.js'
import { useSettings } from './settings-store.js'
import { registerTerminalLinks, terminalLinkHandler } from './terminal-links.js'
import { applyTerminalAppearance, terminalAppearanceOptions, type TerminalAppearanceOptions } from './terminal-appearance.js'
import {
  CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS,
  clipboardImagePayload,
  clipboardTextPayloads,
  createOrderedSender,
  dropPathPayloads,
  settleWithin,
  shouldPasteClipboardImage,
} from '../../shared/terminal-paste.js'

const decoder = new TextDecoder()

/**
 * **xterm 밖을 눌렀을 때 터미널 포커스를 지킨다** (F2-8 ⓑ — 기준 §R33-2).
 *
 * pane 상자에는 장식 띠(패딩 약 15px)가 있다. 거기를 누르면 히트 요소가 `.term-pane` 인데 그것은
 * **포커스를 받을 수 없는 요소**라, 크로미움이 `mousedown` **기본 동작**으로 포커스를 가장 가까운
 * 포커스 가능 조상 — 없으니 `body` — 으로 옮긴다. 기본 동작은 우리 핸들러가 **다 끝난 뒤** 적용되
 * 므로, 선택이 옮겨가며 `term.focus()` 가 넣은 포커스를 그대로 덮는다.
 *
 * 실측 (`raw/claude/probe-focus-mech.json`, 빌드 `d74e801`): `mousedown(캡처) → focus()호출 →
 * focusin(대상 pane) → mousedown 버블끝(기본막힘 **false**) → focusout(대상 → null)`. 배지는
 * 옮겨가고 **키는 아무 데도 안 갔다.** `focusToken` 은 범인이 아니었다 — effect 는 돌았다.
 *
 * xterm **위**에서 이 일이 안 보인 이유는 xterm 이 자기 `mousedown` 에서 `preventDefault()` 를
 * 하기 때문이다(같은 실측: 기본막힘 **true**). 그래서 여기서 하는 일은 새 규칙이 아니라 **xterm 이
 * 자기 영역에서 이미 하는 것을 상자의 나머지에 맞추는 것**이다.
 *
 * xterm **안**이면 손대지 않는다 — 드래그 텍스트 선택이 그 기본 동작을 쓴다(xterm 이 스스로
 * 처리한다). `stopPropagation` 도 쓰지 않는다: 그러면 네이티브 이벤트가 문서까지 못 가서 문서
 * `mousedown` 으로 닫는 메뉴(RepoRowMenu·TabContextMenu)가 안 닫힌다.
 */
export function keepTerminalFocus(event: React.MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('[data-term-pane]') !== null) return
  event.preventDefault()
}

/**
 * **편집 중인 이름 입력칸이 포커스를 쥐고 있나** (LIFE-501).
 *
 * 탭을 누른 직후 더블클릭하면 이름 입력칸이 먼저 포커스를 잡고, 그 뒤에 도착한 마운트 effect·포커스 토큰의
 * `term.focus()` 가 그것을 빼앗아 편집을 끝냈다 — 이어 친 글자·Enter 가 셸로 샜다. 터미널 포커스를 주는 두 자리는
 * 이 함수가 참이면 양보한다(Orca 220 `pane-helpers.ts` 의 rename 가드와 같은 결).
 *
 * 범위는 **편집 중인** 이름 입력칸뿐이다(탭 `.main-tab-rename.is-editing` · 카드 `[data-inline-rename]` — 단축키 처리기가
 * 양보하는 그 입력칸들). 일반 입력칸(사이드바 검색 등)으로 넓히지 않는다: 그 위에서 탭을 누르면 지금처럼 터미널이 포커스를
 * 가져가야 한다 — 그 클릭이 사용자의 뜻이다.
 */
export const INLINE_EDIT_SELECTOR = '.main-tab-rename.is-editing, [data-inline-rename]'
function inlineEditHoldsFocus(): boolean {
  const active = document.activeElement
  return active instanceof Element && active.closest(INLINE_EDIT_SELECTOR) !== null
}

/**
 * S2·S1·S3 프로브가 읽는 쓰기 완료 기록. 최근 것만 남긴다.
 *
 * `bytes`·`cols`·`rows` 는 **프레임의 무게**다 (§10-R27-a). P3·P4·P5 통과선이 1차 스파이크의
 * 100×30·28.4KB(셀당 9.5B) 전체 리페인트로 만들어진 값이라, 같은 자리에서 비교하려면 이 부하의
 * 프레임이 몇 바이트짜리인지 **재는 쪽이 아니라 쓰는 쪽에서** 남겨야 한다.
 */
type WriteRecord = { paneId: string; seq: number; at: number; ms: number; bytes: number; cols: number; rows: number }
const WRITE_RING_MAX = 400

/**
 * **모든 pane 의 쓰기 기록** (계측 실행에서만) — §4 P2·P4 가 여기서 나온다.
 *
 * `window.corralTermProbe` 는 **마지막에 마운트한 pane** 하나만 쥔다. P2 는 "pane 당 렌더
 * 패스/s"라 4 pane 을 **동시에** 봐야 하고, 한 pane 만 보면 나머지 셋이 굶고 있어도 통과한다.
 * 그래서 pane 마다 자기 요약을 여기에 등록한다 — 읽기 전용이고 `lines` 는 안 싣는다(4 pane ×
 * 51줄을 매 폴링마다 옮길 이유가 없다).
 */
type PaneWriteSummary = { paneId: string; cols: number; rows: number; lastSeq: number; writes: WriteRecord[] }
const paneProbes = new Map<string, () => PaneWriteSummary>()

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

/**
 * **모든 pane 의 외관 상태** (계측 실행에서만) — LIFE-512 K3ⓕ·K4ⓑ. pane 마다 지금 xterm 옵션과 외관 쓰기 기록(무슨 옵션을 썼나)을
 * 남긴다. 같은 테마를 다시 골랐을 때 `theme` 쓰기가 없었다는 것을 이 기록이 보인다.
 */
type PaneAppearanceSummary = {
  paneId: string
  options: { fontSize: unknown; fontFamily: unknown; fontWeight: unknown; lineHeight: unknown; cursorStyle: unknown; cursorBlink: unknown; minimumContrastRatio: unknown; theme: unknown }
  writes: Array<{ at: number; keys: string[] }>
  /** 이 xterm 이 실제로 쓰는 셀 px — 모든 pane 에서 `live == measured` 를 본다(K2ⓓ). */
  live: { width: number; height: number } | null
}
const paneAppearance = new Map<string, () => PaneAppearanceSummary>()

export function TerminalPane({
  paneId,
  diagnostics,
  focusable = true,
  focusToken = 0,
  announceFocus = true,
}: {
  paneId: string
  diagnostics: boolean
  /**
   * 이 pane 이 **DOM 포커스를 가져가도 되는가** — 활성 영역의 pane 만 참이다 (LIFE-373 ①).
   *
   * 영역이 여럿이면 pane 도 여럿이 동시에 산다. 마운트 포커스를 그대로 두면 worktree 를 바꿀 때마다
   * 모든 영역의 pane 이 트리 순서로 `focus()` 를 불러 **마지막 영역이 포커스를 훔친다**. 활성 여부는
   * ref 로 읽는다 — 이 값이 바뀔 때마다 터미널을 다시 만들면 안 되기 때문이다.
   */
  focusable?: boolean
  /**
   * 사용자가 이 pane 을 **다시 골랐다**는 신호 (값이 바뀔 때마다 xterm 에 포커스를 준다).
   *
   * 탭바·사이드바에서 탭을 누르면 DOM 포커스는 눌린 그 요소로 간다 — 그대로 두면 다음 타건이
   * 터미널이 아니라 탭으로 들어간다. 마운트 때 한 번 주는 포커스로는 **이미 떠 있는 pane 을
   * 다시 고른 경우**를 못 잡는다 (LIFE-353 은 pane 을 고를 때마다 새로 마운트돼서 안 보였다).
   */
  focusToken?: number
  /**
   * 마운트할 때 **herdr 에 포커스를 알릴 것인가** (LIFE-373 ② · S2).
   *
   * 탭 하나에 pane 이 여럿이면 여러 개가 동시에 마운트된다. 전부 알리면 마지막에 마운트된 것이
   * 이기고, 그건 사용자가 고른 pane 이 아니다 — ① 에서 잡은 포커스 훔치기와 같은 모양이다.
   * 그 탭의 **선택 pane** 하나만 참이다. 기본값이 참인 것은 단일 pane 경로(LIFE-353 C2)를
   * 한 글자도 안 바꾸기 위해서다.
   */
  announceFocus?: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const focusableRef = useRef(focusable)
  focusableRef.current = focusable
  const announceRef = useRef(announceFocus)
  announceRef.current = announceFocus
  const settings = useSettings()
  const appearance = useMemo(() => terminalAppearanceOptions(settings), [settings])
  const appearanceRef = useRef<TerminalAppearanceOptions>(appearance)
  appearanceRef.current = appearance
  const appearanceWrites = useRef<Array<{ at: number; keys: string[] }>>([])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const term = new Terminal({
      scrollback: 0,
      // 글꼴·테마·커서·대비 — 사용자 설정(LIFE-512). 셀 측정(`useCellMetrics`)과 같은 `terminalFontOptions` 를 거친다(원천 하나, K2ⓑ).
      // 배경은 이제 앱 표면 토큰이 아니라 테마 배경이다 — pane 상자도 같은 값을 칠한다(`--term-bg`, U5).
      ...appearanceRef.current,
      // unicode-graphemes 애드온이 unicode.register(proposed API)를 쓴다 — 명시 활성 필요.
      allowProposedApi: true,
      // OSC 8 링크 ⌘+클릭 — 평문 URL 과 같은 열기 경로(LIFE-565, terminal-links.ts).
      linkHandler: terminalLinkHandler,
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
    const links = registerTerminalLinks(term)
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
      // P4 는 **`term.write` 호출 → 콜백**을 잰다 (1차 스파이크 M2 와 같은 정의). 시작 시각을
      // 여기서 찍어야 파싱·렌더에 실제로 든 시간이 남는다 — 완료 시각만으로는 못 만든다.
      const writeStartedAt = Date.now()
      term.write(prefix + (frame === null ? '' : decoder.decode(frame.data)), () => {
        writing = false
        if (disposed) return
        if (frame !== null) {
          lastSeq = frame.seq
          // 쓰기 **완료** 시각 — S2 의 renderer 쪽 끝점. 프로브(term-read)가 읽어 간다.
          // 진단(계측) 실행에서만 링에 쌓는다 (수정 1회차 L7) — 평시엔 이 링을 안 만든다.
          if (diagnostics) {
            const doneAt = Date.now()
            writes.push({
              paneId: frame.paneId,
              seq: frame.seq,
              at: doneAt,
              ms: doneAt - writeStartedAt,
              bytes: frame.data.byteLength,
              cols: frame.cols,
              rows: frame.rows,
            })
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
    const inputs: Array<{ data: string; at: number; source?: 'paste-text' | 'paste-image' | 'file-drop' }> = []
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

    // --- ⌘V 붙여넣기 (LIFE-497 · D41 이미지 · LIFE-505 텍스트) ---------------------------
    // ⌘V 는 Electron 기본 Edit 메뉴의 paste role 이 쥐고, role 은 포커스된 xterm 에 DOM `paste` 를 일으킨다
    // (메뉴는 재구성하지 않는다 — R23). 캡처 단계에서 **텍스트·이미지 모두** 가로챈다 — xterm 의 평소 붙여넣기는 안 쓴다.
    // 텍스트(LIFE-505): xterm 은 안쪽 앱의 bracketed paste(2004) 비트를 모른다 — herdr 가 그린 프레임만 받아 비트가 늘
    // false 라 틀 없이 보낸다. 그러면 main 의 분류기가 틀 없는 CR 을 Enter 키로 보내 여러 줄 붙여넣기의 첫 줄이 전송·실행된다.
    // 그래서 **강제** bracketed paste 로 싸서 보낸다 — 분류기가 그 구간을 herdr Paste 로 바꾸고, herdr 가 pane 의 실제 2004
    // 모드에 맞춰 틀을 붙이거나 벗긴다(모드 판단은 herdr 몫 — Orca 의 Ctrl+C stale 비트 추측은 옮기지 않는다).
    // herdr 의 Paste 상한(1MB)을 넘는 텍스트는 조각마다 틀 하나로 쪼개 보낸다(clipboardTextPayloads).
    // 이미지: 텍스트가 없을 때만 main 에 이미지를 PNG 로 쓰게 하고 그 경로를 강제 bracketed paste 로 보낸다.
    // 대상은 이벤트 시점의 paneId 로 고정한다 — 처리 중 다른 pane 을 고르거나 이 pane 이 닫혀도 다른 pane 에 쓰지 않는다 (K1ⓒ).
    // Ctrl+V 는 여기 안 온다 (키 입력이라 onData 로 `\x16` 이 간다 — CLI 가 클립보드를 직접 읽는다, D42).
    // 붙여넣기·드롭이 만든 바이트도 진단 링에 남긴다 (onData 를 안 거치므로 따로) — 관문이 "pane 으로 간 바이트" 를 읽는 자리.
    // 붙여넣기·드롭은 받은 순서대로 나간다 (R1-03) — 이미지 저장 왕복이 늦어도 뒤 텍스트·드롭이 앞지르지 않는다.
    // 왕복은 CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS 까지만 기다린다 — 넘으면 그 이미지는 버리고 큐를 푼다 (fix1 F2).
    // 키 입력(onData)은 이 큐를 타지 않는다 — 이미지 왕복 중 친 키는 대기 중인 붙여넣기보다 먼저 갈 수 있다(fix1 F2ⓑ, 수용).
    // 내보내기 직전에 선택을 푼다 — xterm 기본 붙여넣기의 user-input 해제와 같은 효과다. 선택이 남으면 flush 가
    // 프레임을 보류해 붙여넣은 글자의 에코가 안 그려진다 (fix1 F1).
    type GeneratedInput = { data: string; source: 'paste-text' | 'paste-image' | 'file-drop'; paneId: string }
    const sendGenerated = (input: GeneratedInput): void => {
      if (diagnostics) {
        inputs.push({ data: input.data, at: Date.now(), source: input.source })
        if (inputs.length > WRITE_RING_MAX) inputs.splice(0, inputs.length - WRITE_RING_MAX)
      }
      term.clearSelection()
      window.corral.termInput({ paneId: input.paneId, data: input.data })
    }
    const enqueueGenerated = createOrderedSender<GeneratedInput>(sendGenerated)
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      event.stopPropagation()
      // 진입 즉시 선택을 푼다(텍스트·이미지 공통) — 이미지 왕복(최대 5초) 동안 선택이 남아 프레임이 보류되지 않게 (fix2 R2-3).
      term.clearSelection()
      const target = paneId
      if (!shouldPasteClipboardImage(text)) {
        void enqueueGenerated(clipboardTextPayloads(text).map((data): GeneratedInput => ({ data, source: 'paste-text', paneId: target })))
        return
      }
      void enqueueGenerated(
        settleWithin({
          pending: window.corral.saveClipboardImage().then((result): GeneratedInput[] => {
            const data = clipboardImagePayload(result)
            if (data === null) {
              if (result.status === 'failed') console.warn('[paste] 클립보드 이미지 붙여넣기 실패', result.error)
              return []
            }
            return [{ data, source: 'paste-image', paneId: target }]
          }),
          ms: CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS,
          onTimeout: (): GeneratedInput[] => {
            console.warn('[paste] 클립보드 이미지 저장이 시간 안에 안 끝났다 — 버린다', CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS)
            return []
          },
        }),
      )
    }
    container.addEventListener('paste', onPaste, { capture: true })

    // --- OS 파일 드롭 (LIFE-497 · D43) — preload 가 드롭 지점의 pane 과 경로를 준다 ---------
    const offFileDrop = window.corral.onFileDrop((drop) => {
      if (drop.paneId !== paneId) return
      if (drop.status === 'rejected') {
        console.warn('[drop] 파일 드롭 거부', drop.reason, drop.count)
        return
      }
      void enqueueGenerated(dropPathPayloads(drop.paths).map((data): GeneratedInput => ({ data, source: 'file-drop', paneId })))
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
    // pane 이 여럿이면 마지막에 마운트한 것이 프로브를 쥔다. 내릴 때 **자기 것일 때만** 지운다 —
    // 무조건 지우면 형제 pane 하나를 닫는 순간 프로브가 통째로 사라져 하네스가 셀을 못 잰다
    // (실측: pane 닫기 직후 회차가 `그린 상자가 없다` 로 미달났다).
    let installed: Window['corralTermProbe'] = undefined
    if (diagnostics) {
      installed = {
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
        cell: () => ({ live: readCellSize(term), measured: measureCellSize(appearanceRef.current) }),
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
      window.corralTermProbe = installed
      // P2·P4 — pane 마다 자기 요약을 등록한다 (위 `paneProbes` 주석).
      paneProbes.set(paneId, () => ({ paneId, cols: term.cols, rows: term.rows, lastSeq, writes: [...writes] }))
      window.corralPaneWrites = () => [...paneProbes.values()].map((read) => read())
      paneAppearance.set(paneId, () => ({
        paneId,
        options: {
          fontSize: term.options.fontSize,
          fontFamily: term.options.fontFamily,
          fontWeight: term.options.fontWeight,
          lineHeight: term.options.lineHeight,
          cursorStyle: term.options.cursorStyle,
          cursorBlink: term.options.cursorBlink,
          minimumContrastRatio: term.options.minimumContrastRatio,
          theme: { ...term.options.theme },
        },
        writes: [...appearanceWrites.current],
        live: readCellSize(term),
      }))
      window.corralPaneAppearance = () => [...paneAppearance.values()].map((read) => read())
    }

    // 크기는 영역이 요청하고 서버가 정한다 — 여기서는 포커스만 알린다 (S2: 마운트=사용자 선택).
    if (announceRef.current) void window.corral.selectPane({ paneId })
    // **마운트한 순간의 화면을 받아 온다.** 프레임은 내용이 바뀔 때만 오므로, 탭을 바꿔 새로
    // 붙은 xterm 은 이미 지나간 프레임을 못 듣고 빈 채로 남는다 (S6 실측: 전환 10/10 빈 화면).
    void window.corral.repaintPane({ paneId })
    if (focusableRef.current && !inlineEditHoldsFocus()) term.focus()

    return () => {
      disposed = true
      if (installed !== undefined && window.corralTermProbe === installed) delete window.corralTermProbe
      if (installed !== undefined) paneProbes.delete(paneId)
      if (installed !== undefined) paneAppearance.delete(paneId)
      container.removeEventListener('wheel', onWheel, { capture: true })
      container.removeEventListener('paste', onPaste, { capture: true })
      offFileDrop()
      offFrame()
      selectionListener.dispose()
      dataListener.dispose()
      links.dispose()
      termRef.current = null
      term.dispose()
    }
  }, [paneId, diagnostics])

  // 설정이 바뀌면 열린 pane 에 즉시 반영한다(K2ⓒ·K3ⓕ) — 바뀐 옵션만 쓴다. 새로 마운트되는 pane 은 생성자에서 현재 값을 받는다.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const keys = applyTerminalAppearance({ term, next: appearance })
    if (diagnostics) {
      appearanceWrites.current.push({ at: Date.now(), keys })
      if (appearanceWrites.current.length > 100) appearanceWrites.current.shift()
    }
  }, [appearance, diagnostics])

  /**
   * **이미 떠 있는 pane 이 선택으로 바뀐 순간**에도 herdr 에 알린다 (형제 pane 클릭).
   *
   * 마운트 때 한 번 알리는 것만으로는 이 경우를 못 잡는다 — 그 pane 은 벌써 떠 있어서 마운트
   * effect 가 다시 안 돈다. 참이 된 **전이**에서만 쏜다: 마운트에서 이미 알렸으면 안 쏜다
   * (한 번의 클릭에 `pane.focus` 두 번이 나가지 않게).
   */
  const announcedRef = useRef(announceFocus)
  useEffect(() => {
    if (!announceFocus) {
      announcedRef.current = false
      return
    }
    if (announcedRef.current) return
    announcedRef.current = true
    void window.corral.selectPane({ paneId })
  }, [announceFocus, paneId])

  // 다시 고른 순간 터미널로 포커스를 돌린다 (위 focusToken 주석).
  // `0` 은 신호가 아니다 — 비활성 영역이 받는 값이라, 여기서 포커스를 주면 **비활성 영역이
  // 활성 영역 뒤에 포커스를 훔친다**(effect 순서는 활성 순서가 아니라 트리 순서다).
  useEffect(() => {
    if (focusToken === 0 || !focusableRef.current || inlineEditHoldsFocus()) return
    termRef.current?.focus()
  }, [focusToken])

  return <div className="term-host" data-term-pane={paneId} ref={containerRef} />
}
