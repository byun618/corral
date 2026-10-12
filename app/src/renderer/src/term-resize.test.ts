// LIFE-567 C2·C3 (단위) — 열 축소 reflow 가 뷰포트를 바닥에서 떼는 xterm 6.0.0 동작(양성 대조)과, resizeToFrame 이 그것을 되돌려
// 조합 상자 행(buffer.y)과 그려진 커서 행(ybase + y − ydisp)이 같고 프레임의 맨 아래 행이 화면 맨 아래에 남는지. writeFrame 의 순서(동기 출력 모드).
// xterm 은 open 없이도 버퍼·파서가 돈다 — 실제 @xterm/xterm 을 그대로 쓴다(DOM 렌더는 sync-fixture·네이티브 관문 몫).
// open 없이는 DOM 스크롤이 viewportY 를 끌어내리지 않는다 — 그래서 baseY·viewportY 를 **둘 다 0 으로 고정**하고 표시 범위를 실제 인덱스로 읽는다(리뷰 r1 R1-03).
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  NO_REFLOW_WINDOWS_PTY,
  resizeToFrame,
  SYNC_OUTPUT_BEGIN,
  SYNC_OUTPUT_END,
  viewportOffBottom,
  writeFrame,
  type FrameTerminal,
  type ResizableTerminal,
} from './term-resize.js'

/** 행 y 의 기대 내용 — 꽉 찬 행은 행마다 다른 글자(A, B, …)로 채워 첫 행·마지막 행이 문자열만으로 구분된다. */
const rowText = (input: { cols: number; full: number[] }, y: number): string =>
  input.full.includes(y) ? String.fromCharCode(65 + y).repeat(input.cols) : `row${y}`

/** frame-to-ansi 모양의 전체 리페인트 — 자동 줄바꿈 끔, 행마다 절대 CUP, 끝에 커서 CUP. `full` 행은 폭을 꽉 채운다. */
const frame = (input: { cols: number; rows: number; cursorY: number; full: number[] }): string => {
  let out = '\x1b[0m\x1b[H\x1b[2J\x1b[?7l'
  for (let y = 0; y < input.rows; y++) {
    if (y > 0) out += `\x1b[${y + 1};1H`
    out += rowText(input, y)
  }
  return `${out}\x1b[?7h\x1b[0m\x1b[${input.cursorY + 1};3H\x1b[?25h`
}
const write = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve))
const lineAt = (term: Terminal, y: number): string => term.buffer.active.getLine(y)?.translateToString(true) ?? ''
/** 화면에 보이는 행들 — 실제 표시 범위 viewportY … viewportY + rows − 1. 버퍼 길이를 넘는 인덱스는 감기지 않게 null 로 둔다. */
const visibleRows = (term: Terminal): Array<string | null> => {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, i) => (buffer.viewportY + i < buffer.length ? lineAt(term, buffer.viewportY + i) : null))
}

// 24행·커서 20(아래 3행) — 이 장면에서는 열 1칸 축소로 ybase 가 오른다(일반 조건은 c1-base/notes.md 정정 절).
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
    // 맨 아래 행(23, 'X…')이 버퍼 끝(인덱스 24)을 넘어 0번 줄로 감긴다 — 0번 줄이 첫 행 'A…' 가 아니라 마지막 행 내용이 된다
    expect(lineAt(term, 0)).toBe('X'.repeat(79))
    expect(lineAt(term, 0)).not.toBe(rowText({ cols: 79, full: FULL }, 0))
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

  it('되돌린 뒤 프레임: baseY = viewportY = 0, 조합 상자 행(cursorY) = 그려진 커서 행, 화면 첫·마지막 행이 프레임 첫·마지막 행이다', async () => {
    const term = await setup()
    resizeToFrame(term, { cols: 79, rows: 24 })
    const next = { cols: 79, rows: 24, cursorY: 20, full: FULL }
    await write(term, frame(next))
    const buffer = term.buffer.active
    expect(buffer.baseY).toBe(0)
    expect(buffer.viewportY).toBe(0)
    expect(buffer.cursorY).toBe(20)
    expect(buffer.baseY + buffer.cursorY - buffer.viewportY).toBe(buffer.cursorY)
    const visible = visibleRows(term)
    expect(visible[0]).toBe('A'.repeat(79))
    expect(visible[23]).toBe('X'.repeat(79))
    expect(visible).toEqual(Array.from({ length: 24 }, (_, y) => rowText(next, y)))
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
      expect(visibleRows(term)).toEqual(Array.from({ length: rows }, (_, y) => rowText({ cols, full }, y)))
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

describe('writeFrame', () => {
  const recorder = (size: { cols: number; rows: number }) => {
    const calls: string[] = []
    const callbacks: Array<() => void> = []
    const buffer = { baseY: 0, viewportY: 0 }
    const term: FrameTerminal = {
      cols: size.cols,
      rows: size.rows,
      resize: (cols, rows) => calls.push(`resize ${cols}x${rows}`),
      clear: () => calls.push('clear'),
      buffer: { active: buffer },
      write: (data, callback) => {
        calls.push(`write ${JSON.stringify(data)}`)
        if (callback) callbacks.push(callback)
      },
    }
    return { term, calls, callbacks }
  }

  it('크기가 같으면 프레임만 쓴다 — 동기 출력 모드 없음', () => {
    const { term, calls, callbacks } = recorder({ cols: 80, rows: 24 })
    const done = vi.fn()
    writeFrame(term, { cols: 80, rows: 24, data: 'F', alive: () => true, done })
    expect(calls).toEqual(['write "F"'])
    callbacks[0]?.()
    expect(done).toHaveBeenCalledOnce()
  })

  it('크기가 다르면 동기 출력 모드 시작이 파싱된 뒤(콜백 안에서) resize 하고, 프레임 끝에서 모드를 끈다', () => {
    const { term, calls, callbacks } = recorder({ cols: 80, rows: 24 })
    const done = vi.fn()
    writeFrame(term, { cols: 79, rows: 24, data: 'F', alive: () => true, done })
    expect(calls).toEqual([`write ${JSON.stringify(SYNC_OUTPUT_BEGIN)}`])
    callbacks[0]?.()
    expect(calls).toEqual([`write ${JSON.stringify(SYNC_OUTPUT_BEGIN)}`, 'resize 79x24', `write ${JSON.stringify(`F${SYNC_OUTPUT_END}`)}`])
    expect(done).not.toHaveBeenCalled()
    callbacks[1]?.()
    expect(done).toHaveBeenCalledOnce()
  })

  it('그 사이 pane 이 내려가면(alive false) resize·쓰기를 하지 않는다', () => {
    const { term, calls, callbacks } = recorder({ cols: 80, rows: 24 })
    writeFrame(term, { cols: 79, rows: 24, data: 'F', alive: () => false, done: vi.fn() })
    callbacks[0]?.()
    expect(calls).toEqual([`write ${JSON.stringify(SYNC_OUTPUT_BEGIN)}`])
  })

  it('실제 xterm: 복구가 일어나는 축소에서도 끝나면 동기 출력 모드가 꺼져 있고 화면이 새 프레임이다', async () => {
    const term = await setup()
    const next = { cols: 79, rows: 24, cursorY: 20, full: FULL }
    await new Promise<void>((resolve) => writeFrame(term, { cols: 79, rows: 24, data: frame(next), alive: () => true, done: resolve }))
    expect(term.modes.synchronizedOutputMode).toBe(false)
    expect(term.buffer.active.baseY).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(visibleRows(term)).toEqual(Array.from({ length: 24 }, (_, y) => rowText(next, y)))
    term.dispose()
  })
})

describe('NO_REFLOW_WINDOWS_PTY (fix2 — reflow 예방)', () => {
  const setupNoReflow = async (): Promise<Terminal> => {
    const term = new Terminal({ scrollback: 0, windowsPty: NO_REFLOW_WINDOWS_PTY, cols: 80, rows: 24, allowProposedApi: true })
    await write(term, frame({ cols: 80, rows: 24, cursorY: 20, full: FULL }))
    return term
  }

  it('양성 대조와 같은 장면에서 term.resize 만 해도 baseY 가 0 이고 커서가 밀리지 않는다', async () => {
    const term = await setupNoReflow()
    term.resize(79, 24)
    expect(term.buffer.active.baseY).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
    expect(term.buffer.active.cursorY).toBe(20)
    expect(term.buffer.active.length).toBe(24)
    term.dispose()
  })

  it('큰 축소·행 변경을 섞어도 resize 직후에 이미 바닥 정합이고 복구(clear)가 한 번도 필요 없다', async () => {
    const term = await setupNoReflow()
    const clear = vi.spyOn(term, 'clear')
    const sizes = [
      { cols: 40, rows: 24 },
      { cols: 90, rows: 30 },
      { cols: 30, rows: 18 },
      { cols: 30, rows: 24 },
      { cols: 120, rows: 24 },
      { cols: 20, rows: 12 },
    ]
    for (const { cols, rows } of sizes) {
      expect(resizeToFrame(term, { cols, rows })).toBe(false)
      expect(term.buffer.active.baseY).toBe(0)
      const full = Array.from({ length: rows }, (_, y) => y).filter((y) => y < 6 || y >= rows - 3)
      await write(term, frame({ cols, rows, cursorY: rows - 4, full }))
      expect(visibleRows(term)).toEqual(Array.from({ length: rows }, (_, y) => rowText({ cols, full }, y)))
    }
    expect(clear).not.toHaveBeenCalled()
    term.dispose()
  })

  it('Windows 줄바꿈 추론은 꺼져 있다 — 꽉 찬 행 뒤 CUP 로 쓴 행도 isWrapped 가 아니다(복사 때 줄이 이어붙지 않는다)', async () => {
    const term = await setupNoReflow()
    for (let y = 0; y < 24; y++) expect(term.buffer.active.getLine(y)?.isWrapped).toBe(false)
    term.dispose()
  })
})

describe('writeFrame 예외', () => {
  it('resize 가 던져도 프레임·모드 해제·done 이 간다', () => {
    const calls: string[] = []
    const callbacks: Array<() => void> = []
    const term: FrameTerminal = {
      cols: 80,
      rows: 24,
      resize: () => {
        throw new Error('boom')
      },
      clear: () => calls.push('clear'),
      buffer: { active: { baseY: 0, viewportY: 0 } },
      write: (data, callback) => {
        calls.push(`write ${JSON.stringify(data)}`)
        if (callback) callbacks.push(callback)
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const done = vi.fn()
    writeFrame(term, { cols: 79, rows: 24, data: 'F', alive: () => true, done })
    callbacks[0]?.()
    expect(calls).toEqual([`write ${JSON.stringify(SYNC_OUTPUT_BEGIN)}`, `write ${JSON.stringify(`F${SYNC_OUTPUT_END}`)}`])
    callbacks[1]?.()
    expect(done).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
