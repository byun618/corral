// LIFE-567 C2·C3 (단위) — 열 축소 reflow 가 뷰포트를 바닥에서 떼는 xterm 6.0.0 동작(양성 대조)과, resizeToFrame 이 그것을 되돌려
// 조합 상자 행(buffer.y)과 그려진 커서 행(ybase + y − ydisp)이 같고 프레임의 맨 아래 행이 화면 맨 아래에 남는지.
// xterm 은 open 없이도 버퍼·파서가 돈다 — 실제 @xterm/xterm 을 그대로 쓴다(DOM 렌더는 네이티브 관문 몫).
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { resizeToFrame, viewportOffBottom, type ResizableTerminal } from './term-resize.js'

/** frame-to-ansi 모양의 전체 리페인트 — 자동 줄바꿈 끔, 행마다 절대 CUP, 끝에 커서 CUP. `full` 행은 폭을 꽉 채운다. */
const frame = (input: { cols: number; rows: number; cursorY: number; full: number[] }): string => {
  let out = '\x1b[0m\x1b[H\x1b[2J\x1b[?7l'
  for (let y = 0; y < input.rows; y++) {
    if (y > 0) out += `\x1b[${y + 1};1H`
    out += input.full.includes(y) ? '─'.repeat(input.cols) : `row${y}`
  }
  return `${out}\x1b[?7h\x1b[0m\x1b[${input.cursorY + 1};3H\x1b[?25h`
}
const write = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve))
const lineAt = (term: Terminal, y: number): string => term.buffer.active.getLine(y)?.translateToString(true) ?? ''

// 24행·커서 20(아래 3행) — 꽉 찬 줄이 커서 아래 행 수 + 2 이상이면 열 1칸 축소로 ybase 가 오른다(c1-base/notes.md).
const FULL = [0, 1, 2, 3, 4, 5, 21, 22, 23]
const setup = async (): Promise<Terminal> => {
  const term = new Terminal({ scrollback: 0, cols: 80, rows: 24, allowProposedApi: true })
  await write(term, frame({ cols: 80, rows: 24, cursorY: 20, full: FULL }))
  return term
}

describe('xterm 6.0.0 열 축소 reflow (양성 대조)', () => {
  it('scrollback 0 인데 term.resize 만으로 baseY 가 1 이 되고 length 는 rows 그대로다', async () => {
    const term = await setup()
    term.resize(79, 24)
    expect(term.buffer.active.baseY).toBe(1)
    expect(term.buffer.active.length).toBe(24)
    // ydisp 도 같이 올라 여기서는 viewportY 1 이다 — 네이티브에서는 DOM 스크롤 영역(length = rows)이 viewportY 를 0 으로 끌어내린다
    expect(viewportOffBottom(term)).toBe(true)
    await write(term, frame({ cols: 79, rows: 24, cursorY: 20, full: FULL }))
    // 맨 아래 행이 버퍼 끝을 넘어 0번 줄로 감긴다 — 화면(viewport 0~23)의 맨 위에 맨 아래 행 내용이 보인다
    expect(lineAt(term, 0)).toBe('─'.repeat(79))
    expect(term.buffer.active.baseY).toBe(1)
    term.dispose()
  })
})

describe('resizeToFrame', () => {
  it('reflow 가 baseY 를 올리면 비워서 baseY 0 = viewportY 로 되돌린다', async () => {
    const term = await setup()
    expect(resizeToFrame(term, { cols: 79, rows: 24 })).toBe(true)
    expect(term.buffer.active.baseY).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(term.buffer.active.length).toBe(24)
    term.dispose()
  })

  it('되돌린 뒤 프레임: 조합 상자 행(cursorY) = 그려진 커서 행, 맨 아래 행이 화면 맨 아래에 있다', async () => {
    const term = await setup()
    resizeToFrame(term, { cols: 79, rows: 24 })
    await write(term, frame({ cols: 79, rows: 24, cursorY: 20, full: [23] }))
    const buffer = term.buffer.active
    expect(buffer.cursorY).toBe(20)
    expect(buffer.baseY + buffer.cursorY - buffer.viewportY).toBe(20)
    expect(lineAt(term, buffer.viewportY + 23)).toBe('─'.repeat(79))
    expect(lineAt(term, buffer.viewportY)).toBe('row0')
    term.dispose()
  })

  it('넓히기·행 변경을 섞어도 매 프레임 뒤 바닥 정합을 지킨다', async () => {
    const term = await setup()
    const sizes = [
      { cols: 79, rows: 24 },
      { cols: 60, rows: 24 },
      { cols: 90, rows: 30 },
      { cols: 50, rows: 18 },
      { cols: 50, rows: 24 },
      { cols: 120, rows: 24 },
      { cols: 70, rows: 12 },
    ]
    for (const { cols, rows } of sizes) {
      resizeToFrame(term, { cols, rows })
      const full = Array.from({ length: rows }, (_, y) => y).filter((y) => y < 6 || y >= rows - 3)
      await write(term, frame({ cols, rows, cursorY: rows - 4, full }))
      expect(viewportOffBottom(term)).toBe(false)
      expect(term.buffer.active.baseY).toBe(0)
      expect(lineAt(term, rows - 1)).toBe('─'.repeat(cols))
    }
    term.dispose()
  })

  it('크기가 같으면 아무것도 하지 않고, 정합이 유지되는 resize 는 비우지 않는다', () => {
    const buffer = { baseY: 0, viewportY: 0 }
    const fake: ResizableTerminal = { cols: 80, rows: 24, resize: vi.fn(), clear: vi.fn(), buffer: { active: buffer } }
    expect(resizeToFrame(fake, { cols: 80, rows: 24 })).toBe(false)
    expect(fake.resize).not.toHaveBeenCalled()
    expect(resizeToFrame(fake, { cols: 70, rows: 24 })).toBe(false)
    expect(fake.resize).toHaveBeenCalledWith(70, 24)
    expect(fake.clear).not.toHaveBeenCalled()
  })
})
