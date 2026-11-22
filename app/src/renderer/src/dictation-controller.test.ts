// @vitest-environment happy-dom
// LIFE-834 — 받아쓰기 렌더러 상태 규칙. 01-criteria 「대상·상태 표」 행마다 시험 하나(C3), 넣기 바이트(C2), 권한 거부(C4), 무음(C5), 미지원·이상(C6).
// 도우미·main 은 가짜 — 이벤트는 main 이 보내는 모양(`DictationEvent`) 그대로 흉내 낸다.
import { describe, expect, it } from 'vitest'
import {
  DICTATION_NOT_TERMINAL_MESSAGE,
  DICTATION_SILENCE_NOTICE_MS,
  DICTATION_TARGET_CLOSED_MESSAGE,
  dictationErrorMessage,
  type DictationEnd,
  type DictationInsertResult,
  type DictationStartResult,
} from '../../shared/dictation.js'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, clipboardTextPayloads } from '../../shared/terminal-paste.js'
import { createDictationController, focusedTerminalPane, type DictationNotice, type DictationView } from './dictation-controller.js'

/** 순서 큐(promise 사슬)가 다 나갈 때까지 — 매크로 작업 한 번. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { start?: () => Promise<DictationStartResult>; insert?: (input: { paneId: string; text: string }) => Promise<DictationInsertResult> } = {}) {
  /** PTY 로 간 바이트 — 가짜 main 은 붙은 탭의 길(⌘V 와 같은 `clipboardTextPayloads`)을 흉내 낸다. 붙지 않은 탭의 길은 main 시험(dictation-insert*.test.ts). */
  const sent: Array<{ paneId: string; data: string }> = []
  const inserted: Array<{ paneId: string; text: string }> = []
  const notices: DictationNotice[] = []
  const views: DictationView[] = []
  const calls: string[] = []
  const live = new Set(['p1', 'p2'])
  let clock = 0
  let ids = 0
  const controller = createDictationController({
    start: (input) => {
      calls.push(`start:${input.sessionId}`)
      return options.start?.() ?? Promise.resolve({ ok: true })
    },
    stop: (input) => calls.push(`stop:${input.sessionId}`),
    cancel: (input) => calls.push(`cancel:${input.sessionId}`),
    insert: (input) => {
      calls.push(`insert:${input.paneId}`)
      inserted.push(input)
      if (options.insert !== undefined) return options.insert(input)
      for (const data of clipboardTextPayloads(input.text)) sent.push({ paneId: input.paneId, data })
      return Promise.resolve({ ok: true, via: 'paste' })
    },
    clearSelection: (paneId) => calls.push(`clear:${paneId}`),
    paneExists: (paneId) => live.has(paneId),
    notify: (notice) => notices.push(notice),
    onChange: (view) => views.push(view),
    now: () => clock,
    newSessionId: () => `s${++ids}`,
  })
  return {
    controller,
    sent,
    inserted,
    notices,
    views,
    calls,
    live,
    advance: (ms: number) => {
      clock += ms
    },
    ready: (sessionId = 's1') => controller.onEvent({ kind: 'ready', sessionId }),
    partial: (text: string, sessionId = 's1') => controller.onEvent({ kind: 'partial', sessionId, text }),
    final: (text: string, sessionId = 's1') => controller.onEvent({ kind: 'final', sessionId, text }),
    level: (rms: number, sessionId = 's1') => controller.onEvent({ kind: 'level', sessionId, rms }),
    ended: (end: DictationEnd, sessionId = 's1') => controller.onEvent({ kind: 'ended', sessionId, end }),
  }
}

const paste = (text: string): string => `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`

describe('C1 토글 — 시작·정지와 녹음 중 표시', () => {
  it('누르면 시작(표시 등장: starting → ready 뒤 listening), 다시 누르면 정지 요청, 끝나면 표시가 사라진다(idle)', async () => {
    const h = harness()
    h.controller.toggle('p1')
    expect(h.controller.view).toEqual({ phase: 'starting', paneId: 'p1' })
    expect(h.calls).toEqual(['start:s1'])
    await flush()
    h.ready()
    expect(h.controller.view).toEqual({ phase: 'listening', paneId: 'p1', partial: '', silent: false })
    h.controller.toggle('p1')
    expect(h.calls).toEqual(['start:s1', 'stop:s1'])
    expect(h.controller.view.phase).toBe('stopping')
    h.ended({ kind: 'done' })
    expect(h.controller.view).toEqual({ phase: 'idle' })
    expect(h.notices).toEqual([])
  })
  it('듣기 전(starting)에 다시 누르면 취소와 같다 — 확정할 글이 없다', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.controller.toggle('p1')
    expect(h.calls).toEqual(['start:s1', 'cancel:s1'])
    expect(h.controller.view.phase).toBe('idle')
  })
  it('정지 중(stopping)에 또 누르면 아무것도 하지 않는다', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.controller.toggle('p1')
    h.controller.toggle('p1')
    expect(h.calls).toEqual(['start:s1', 'stop:s1'])
  })
})

describe('C2 넣기 — FINAL 만, 강제 bracketed paste, Enter·CR 없음, 도착 순서', () => {
  it('partial 은 PTY 에 0바이트 — 표시에만 간다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.partial('워크트리')
    h.partial('워크트리 목록')
    await flush()
    expect(h.sent).toEqual([])
    expect(h.controller.view).toMatchObject({ phase: 'listening', partial: '워크트리 목록' })
  })
  it('FINAL 은 그 글만 틀에 싸서 대상 pane 으로 — 끝에 CR·LF 를 덧붙이지 않는다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('워크트리 목록을 보여주고 리뷰 결과를 요약해줘.')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p1', data: paste('워크트리 목록을 보여주고 리뷰 결과를 요약해줘.') }])
    expect(h.sent[0]?.data.endsWith('\r')).toBe(false)
    expect(h.sent[0]?.data.endsWith('\n')).toBe(false)
    expect(h.sent[0]?.data.endsWith(BRACKETED_PASTE_END)).toBe(true)
    expect(h.controller.view).toMatchObject({ partial: '' })
  })
  it('여러 FINAL 은 도착 순서대로 각각 넣는다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('첫째 문장.')
    h.final('둘째 문장.')
    h.final('셋째 문장.')
    await flush()
    expect(h.sent.map((item) => item.data)).toEqual([paste('첫째 문장.'), paste('둘째 문장.'), paste('셋째 문장.')])
  })
  it('빈 FINAL 은 아무것도 보내지 않는다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('')
    await flush()
    expect(h.sent).toEqual([])
  })
  it('FINAL 안의 ESC 는 무력화된다(틀을 깨고 키로 새지 않는다) — ⌘V 와 같은 정규화', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('a\x1b[201~b')
    await flush()
    expect(h.sent[0]?.data).toBe(paste('a␛[201~b'))
  })
})

describe('C3 대상·상태 표 — 행마다 하나', () => {
  it('행 1 — 시작 순간 터미널 pane 에 포커스: 그 pane 으로 고정하고 시작', () => {
    const h = harness()
    h.controller.toggle('p1')
    expect(h.controller.view).toEqual({ phase: 'starting', paneId: 'p1' })
  })
  it('행 2 — 시작 순간 비터미널 포커스: 시작하지 않고 「터미널 pane 에서 쓸 수 있다」 알림, 도우미를 띄우지 않는다', async () => {
    const h = harness()
    h.controller.toggle(null)
    await flush()
    expect(h.calls).toEqual([])
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toEqual([{ message: DICTATION_NOT_TERMINAL_MESSAGE, openPrivacy: false }])
    expect(h.sent).toEqual([])
  })
  it('행 3 — 받아쓰는 중 다른 pane 으로 포커스 이동: 대상은 그대로, FINAL 은 원래 대상에', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    // 포커스가 p2 로 옮겨 갔다 — 컨트롤러는 포커스를 다시 읽지 않는다. 그 상태에서 FINAL 이 온다.
    expect(focusedTerminalPane(paneElement('p2'))).toBe('p2')
    h.final('원래 대상으로')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p1', data: paste('원래 대상으로') }])
    expect(h.controller.view).toMatchObject({ phase: 'listening', paneId: 'p1' })
  })
  it('행 4 — FINAL 도착·대상이 아직 있음: 그 FINAL 을 넣고 계속', async () => {
    const h = harness()
    h.controller.toggle('p2')
    h.ready()
    h.final('계속 받는다')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p2', data: paste('계속 받는다') }])
    expect(h.controller.view.phase).toBe('listening')
  })
  it('행 5 — FINAL 도착·대상 pane 이 닫힘: 넣지 않고(다른 pane 에도) 정지 + 「대상 pane 이 닫혀 멈췄다」 알림', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('닫히기 전')
    h.live.delete('p1')
    h.final('닫힌 뒤')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p1', data: paste('닫히기 전') }])
    expect(h.calls).toEqual(['start:s1', 'clear:p1', 'insert:p1', 'cancel:s1'])
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toEqual([{ message: DICTATION_TARGET_CLOSED_MESSAGE, openPrivacy: false }])
    // 취소 뒤 늦게 온 줄도 버린다
    h.final('더 늦게')
    await flush()
    expect(h.sent).toHaveLength(1)
  })
  it('행 6 — 정지(같은 단축키): 마지막 FINAL 확정까지 기다린다 — 정지 뒤 온 FINAL 도 넣고 ended 에 끝난다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('앞 문장.')
    h.controller.toggle('p1')
    h.partial('마지막')
    h.final('마지막 문장.')
    expect(h.controller.view.phase).toBe('stopping')
    h.ended({ kind: 'done' })
    await flush()
    expect(h.sent.map((item) => item.data)).toEqual([paste('앞 문장.'), paste('마지막 문장.')])
    expect(h.controller.view.phase).toBe('idle')
  })
  it('행 7 — Esc(받아쓰는 중): 취소, 아직 안 넣은 글(partial·늦은 FINAL)은 버림, 이미 넣은 글은 그대로, 키를 삼킨다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('이미 넣은 글')
    h.partial('아직 안 넣은')
    expect(h.controller.cancel()).toBe(true)
    expect(h.calls).toEqual(['start:s1', 'clear:p1', 'insert:p1', 'cancel:s1'])
    expect(h.controller.view.phase).toBe('idle')
    h.final('아직 안 넣은 글')
    h.ended({ kind: 'cancelled' })
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p1', data: paste('이미 넣은 글') }])
    expect(h.notices).toEqual([])
  })
  it('행 7 보조 — 받아쓰기가 아닐 때 Esc 는 삼키지 않는다(원래 자리로 간다)', () => {
    const h = harness()
    expect(h.controller.cancel()).toBe(false)
  })
  it('행 8 — 도우미 이상 종료(ended error): 종료 + 오류 알림, 이미 넣은 글 유지, 이후 넣기 없음', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('넣은 글')
    h.ended({ kind: 'error', code: 'helper-crashed', message: '신호 SIGSEGV' })
    h.final('뒤늦은 글')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p1', data: paste('넣은 글') }])
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toEqual([{ message: dictationErrorMessage({ code: 'helper-crashed', message: '신호 SIGSEGV' }), openPrivacy: false }])
  })
  it('행 9 — 창 닫힘·화면 내려감: 진행 중 세션을 취소한다(main 쪽 정리는 dictation.test.ts)', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.controller.dispose()
    expect(h.calls).toEqual(['start:s1', 'cancel:s1'])
    expect(h.controller.view.phase).toBe('idle')
  })
  it('다른 세션의 이벤트는 버린다 — 취소한 뒤 새로 시작해도 옛 세션의 늦은 FINAL 이 새 대상에 들어가지 않는다', async () => {
    const h = harness()
    h.controller.toggle('p1')
    h.controller.cancel()
    h.controller.toggle('p2')
    h.ready('s2')
    h.final('옛 세션', 's1')
    h.final('새 세션', 's2')
    await flush()
    expect(h.sent).toEqual([{ paneId: 'p2', data: paste('새 세션') }])
  })
})

describe('C4 마이크 권한 거부 — 조용한 무결과 금지', () => {
  it('도우미가 mic-denied 로 끝나면 거부를 말하는 알림 + 개인정보 설정 열기 동작', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ended({ kind: 'error', code: 'mic-denied', message: '마이크 권한이 거부됐다' })
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.openPrivacy).toBe(true)
    expect(h.notices[0]?.message).toContain('마이크 권한이 거부')
    expect(h.notices[0]?.message).toContain('개인정보 보호 및 보안')
  })
})

describe('C5 무음 알림', () => {
  it('레벨이 계속 0 이면 상한(제품 상수) 안에 무음 표시, 소리가 들어오면 사라진다', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    expect(DICTATION_SILENCE_NOTICE_MS).toBeLessThanOrEqual(5000)
    for (let elapsed = 0; elapsed < DICTATION_SILENCE_NOTICE_MS; elapsed += 250) {
      h.level(0)
      expect(h.controller.view).toMatchObject({ silent: false })
      h.advance(250)
    }
    h.level(0)
    expect(h.controller.view).toMatchObject({ silent: true })
    h.advance(250)
    h.level(0.02)
    expect(h.controller.view).toMatchObject({ silent: false })
  })
  it('사이에 소리가 끼면 무음 시간을 처음부터 다시 잰다', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.level(0)
    h.advance(DICTATION_SILENCE_NOTICE_MS - 250)
    h.level(0.01)
    h.advance(250)
    h.level(0)
    h.advance(DICTATION_SILENCE_NOTICE_MS - 250)
    h.level(0)
    expect(h.controller.view).toMatchObject({ silent: false })
  })
})

describe('C6 미지원·이상 — 원인을 말하는 알림, 넣기 0', () => {
  it.each([
    { code: 'unsupported-os', message: '', expectText: 'macOS 26' },
    { code: 'helper-missing', message: '/x/helper/corral-dictation', expectText: '도우미 실행 파일이 없다' },
    { code: 'spawn-failed', message: 'EACCES', expectText: '실행하지 못했다' },
  ])('시작 거절 $code → 알림 「$expectText」, 표시 사라짐', async ({ code, message, expectText }) => {
    const h = harness({ start: () => Promise.resolve({ ok: false, code, message }) })
    h.controller.toggle('p1')
    await flush()
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.message).toContain(expectText)
    expect(h.sent).toEqual([])
  })
  it.each([
    { code: 'locale-not-installed', expectText: '한국어 음성 인식 자산' },
    { code: 'locale-unsupported', expectText: '한국어를 지원하지 않는다' },
    { code: 'transcriber-unavailable', expectText: '음성 인식기를 쓸 수 없다' },
    { code: 'helper-crashed', expectText: '비정상 종료' },
    { code: 'stop-timeout', expectText: '시간이 넘어' },
    { code: 'audio-engine', expectText: 'audio-engine' },
  ])('도우미 끝 $code → 알림 「$expectText」', async ({ code, expectText }) => {
    const h = harness()
    h.controller.toggle('p1')
    h.ended({ kind: 'error', code, message: '' })
    await flush()
    expect(h.notices[0]?.message).toContain(expectText)
    expect(h.sent).toEqual([])
  })
  it('시작 IPC 가 던져도(앱 쪽 예외) 알림 후 idle — 앱은 계속 돈다', async () => {
    const h = harness({ start: () => Promise.reject(new Error('ipc gone')) })
    h.controller.toggle('p1')
    await flush()
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices[0]?.message).toContain('ipc gone')
  })
  it('시작 거절이 늦게 와도 그 사이 취소했으면 알리지 않는다', async () => {
    let reject: (value: DictationStartResult) => void = () => undefined
    const h = harness({ start: () => new Promise((resolve) => (reject = resolve)) })
    h.controller.toggle('p1')
    h.controller.cancel()
    reject({ ok: false, code: 'helper-missing', message: '' })
    await flush()
    expect(h.notices).toEqual([])
  })
})

/** xterm 입력칸 모양 — `[data-term-pane]` 상자 안의 textarea. */
function paneElement(paneId: string): Element {
  const host = document.createElement('div')
  host.setAttribute('data-term-pane', paneId)
  const textarea = document.createElement('textarea')
  host.append(textarea)
  return textarea
}

describe('focusedTerminalPane — 시작 순간의 포커스 판정', () => {
  it('xterm 입력칸(터미널 pane 안) → 그 pane id, 그 밖 → null', () => {
    expect(focusedTerminalPane(paneElement('p9'))).toBe('p9')
    expect(focusedTerminalPane(document.createElement('input'))).toBeNull()
    expect(focusedTerminalPane(null)).toBeNull()
  })
})

describe('fix1 G2 — 넣기 직전에 대상 xterm 의 선택을 푼다(⌘V 와 같은 단계)', () => {
  it('FINAL 마다 선택 풀기 → 넣기 순서, 대상은 고정 pane(포커스가 옮겨도)', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.final('첫째')
    h.final('둘째')
    expect(h.calls).toEqual(['start:s1', 'clear:p1', 'insert:p1', 'clear:p1', 'insert:p1'])
  })
})

describe('fix1 G1 — 넣기가 실패로 돌아오면 조용히 버리지 않는다', () => {
  it('진행 중 세션: 멈추고(취소) 「넣지 못해 멈췄다」 알림', async () => {
    const h = harness({ insert: () => Promise.resolve({ ok: false, code: 'insert-failed', message: 'pane 을 찾지 못했다 (p1)' }) })
    h.controller.toggle('p1')
    h.ready()
    h.final('못 들어갈 글')
    await flush()
    expect(h.calls.at(-1)).toBe('cancel:s1')
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices).toEqual([{ message: dictationErrorMessage({ code: 'insert-failed', message: 'pane 을 찾지 못했다 (p1)' }), openPrivacy: false }])
    expect(h.notices[0]?.message).toContain('넣지 못해 멈췄다')
  })
  it('정지로 이미 끝난 뒤 실패가 와도 알린다(취소는 하지 않는다)', async () => {
    let fail: (result: DictationInsertResult) => void = () => undefined
    const h = harness({ insert: () => new Promise((resolve) => (fail = resolve)) })
    h.controller.toggle('p1')
    h.ready()
    h.controller.toggle('p1')
    h.final('마지막')
    h.ended({ kind: 'done' })
    fail({ ok: false, code: 'insert-failed', message: 'x' })
    await flush()
    expect(h.calls.filter((call) => call.startsWith('cancel'))).toEqual([])
    expect(h.notices).toHaveLength(1)
  })
  it('insert IPC 가 던져도 같은 처리', async () => {
    const h = harness({ insert: () => Promise.reject(new Error('ipc gone')) })
    h.controller.toggle('p1')
    h.ready()
    h.final('글')
    await flush()
    expect(h.controller.view.phase).toBe('idle')
    expect(h.notices[0]?.message).toContain('ipc gone')
  })
})

describe('fix1 F2·G4 — 입력 프레임이 끊기면 도우미가 rms 0 을 내고 무음 알림이 선다', () => {
  it('소리가 오다가 끊긴 뒤 rms 0 줄만 오면 상한 안에 무음 표시', () => {
    const h = harness()
    h.controller.toggle('p1')
    h.ready()
    h.level(0.03)
    h.advance(250)
    for (let elapsed = 0; elapsed <= DICTATION_SILENCE_NOTICE_MS; elapsed += 250) {
      h.level(0)
      h.advance(250)
    }
    expect(h.controller.view).toMatchObject({ silent: true })
  })
})
