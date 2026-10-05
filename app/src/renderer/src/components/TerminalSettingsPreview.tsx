// 외관 › 터미널 미리보기 (LIFE-512 K3ⓔ) — Orca 198 `TerminalSettingsPreview.tsx` 를 옮겼다(다크 단일, 리거처 없음).
// **실제 xterm 인스턴스**를 36×15 고정 크기로 띄워 샘플을 그린다. 옵션은 라이브 pane 과 같은 `terminalAppearanceOptions` ·
// `applyTerminalAppearance` 로 만들고 쓴다 — 미리보기와 pane 이 다른 해석을 타지 않는다(드리프트 금지, 단위 테스트).
// herdr 와 무관하다: 격자 요청·PTY 가 없다(입력 막음 `disableStdin`). 크기가 고정이라 글꼴이 바뀌어도 다시 맞출 것이 없다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Settings } from '../../../shared/terminal-settings.js'
import { applyTerminalAppearance, terminalAppearanceOptions, type TerminalAppearanceOptions } from '../terminal-appearance.js'
import { SettingsSwitch } from './SettingsControls.js'

// 198 그대로 — 가장 긴 줄(32자)이 줄바꿈 없이 들어가는 크기.
export const PREVIEW_COLS = 36
export const PREVIEW_ROWS = 15
const STUB_PANE_PX = 40

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'
const CYAN = '\x1b[36m'
const BG_GREEN = '\x1b[42m'
const FG_BLACK = '\x1b[30m'
const prompt = (): string => `${BLUE}~/corral${RESET} ${MAGENTA}main${RESET} ${YELLOW}*${RESET} $ `
/** 198 `terminal-preview-content.ts` 의 샘플 — 경로 이름만 `~/corral`. 리거처 줄은 리거처 기능이 없어도 기호 표본으로 남긴다. */
export const PREVIEW_BUFFER = [
  `${prompt()}npm test`,
  ` ${BG_GREEN}${FG_BLACK} PASS ${RESET} src/preview.test.ts`,
  ` ${GREEN}✓${RESET} renders sample output ${DIM}(3ms)${RESET}`,
  ` ${RED}✗ ligatures: => != >= <= ===${RESET}`,
  ``,
  `${YELLOW}def${RESET} ${CYAN}total${RESET}(xs: list[${CYAN}int${RESET}]) -> ${CYAN}int${RESET}:`,
  `    ${ITALIC}${GREEN}"""Sum the values."""${RESET}`,
  `    ${YELLOW}return${RESET} ${CYAN}sum${RESET}(x ${YELLOW}for${RESET} x ${YELLOW}in${RESET} xs)`,
  ``,
  `${prompt()}git diff`,
  `${CYAN}@@ -1,2 +1,3 @@${RESET}`,
  `${RED}-const size = 13${RESET}`,
  `${GREEN}+const size = 14${RESET}`,
  ``,
  `${prompt()}`,
].join('\r\n')

/** 미리보기 옵션 — 라이브 pane 옵션 그대로에 비활성 커서 모양만 고른 모양으로(미리보기는 포커스를 받지 않는다, 198 주석). */
export function previewAppearanceOptions(settings: Settings): TerminalAppearanceOptions {
  const options = terminalAppearanceOptions(settings)
  return { ...options, cursorInactiveStyle: options.cursorStyle }
}

export function TerminalSettingsPreview({ settings }: { settings: Settings }): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const terminal = useRef<Terminal | null>(null)
  const options = useMemo(() => previewAppearanceOptions(settings), [settings])
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [dividerVisible, setDividerVisible] = useState(false)

  useEffect(() => {
    const host = container.current
    if (host === null) return
    const term = new Terminal({ ...optionsRef.current, disableStdin: true, scrollback: 0, cols: PREVIEW_COLS, rows: PREVIEW_ROWS })
    terminal.current = term
    term.open(host)
    term.write(PREVIEW_BUFFER)
    return () => {
      terminal.current = null
      term.dispose()
    }
  }, [])

  useEffect(() => {
    const term = terminal.current
    if (term === null) return
    const written = applyTerminalAppearance({ term, next: options })
    // 테마가 바뀌면 샘플을 다시 쓴다 — reset 인 이유는 버퍼가 줄 가운데서 끝나 clear()+write 면 꼬리가 겹치기 때문(198 주석).
    if (written.includes('theme')) {
      term.reset()
      term.write(PREVIEW_BUFFER)
    }
  }, [options])

  const background = options.theme.background ?? '#000000'
  return (
    <div className="terminal-preview" data-settings-preview>
      <div className="terminal-preview-header">
        <div className="terminal-preview-text">
          <span className="terminal-preview-title">다크 모드 미리보기</span>
          <span className="terminal-preview-description">적용 중인 다크 터미널 모양을 표시합니다.</span>
        </div>
        <div className="terminal-preview-toggle">
          <span>창 구분선</span>
          <SettingsSwitch checked={dividerVisible} onChange={setDividerVisible} label="미리보기에 창 구분선 표시" />
        </div>
      </div>
      <div className="terminal-preview-body">
        <div className="terminal-preview-frame" aria-hidden>
          <div ref={container} className="terminal-preview-term" data-settings-preview-term style={{ backgroundColor: background }} />
          {dividerVisible ? (
            <div className="terminal-preview-divider" style={{ width: `${settings.terminalDividerThicknessPx}px`, backgroundColor: settings.terminalDividerColorDark }} />
          ) : null}
          <div className="terminal-preview-stub" style={{ width: `${STUB_PANE_PX}px`, backgroundColor: background, opacity: settings.terminalInactivePaneOpacity }} />
        </div>
      </div>
    </div>
  )
}
