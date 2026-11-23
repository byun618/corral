// LIFE-834 음성 받아쓰기 — 도우미 출력 규약 · main → 렌더러 이벤트 · 사용자 문구. 순수 모듈.
//
// 도우미(`helper/corral-dictation.swift`)는 stdout 에 JSON 한 줄씩 낸다. main(`main/dictation.ts`)이 줄을 해석해
// 세션 id 를 붙여 렌더러로 보내고, 렌더러(`renderer/dictation-controller.ts`)가 대상·상태 표(01-criteria)를 적용한다.

/** 도우미가 내는 한 줄. 모양이 다른 줄은 `parseHelperLine` 이 null 로 버린다. */
export type HelperLine =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  /** `stalled` = 지난 구간에 오디오 프레임이 하나도 없었다(장치 끊김 — fix4 F-2). 그때 `rms` 는 0 이다 — 디지털 0(노이즈 게이트·워밍업)과 구분한다. */
  | { type: 'level'; rms: number; stalled: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }

export function parseHelperLine(line: string): HelperLine | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const type: unknown = Reflect.get(value, 'type')
  const text: unknown = Reflect.get(value, 'text')
  switch (type) {
    case 'ready':
    case 'done':
      return { type }
    case 'partial':
    case 'final':
      return typeof text === 'string' ? { type, text } : null
    case 'level': {
      const rms: unknown = Reflect.get(value, 'rms')
      return typeof rms === 'number' && Number.isFinite(rms) ? { type, rms, stalled: Reflect.get(value, 'stalled') === true } : null
    }
    case 'error': {
      const code: unknown = Reflect.get(value, 'code')
      const message: unknown = Reflect.get(value, 'message')
      return typeof code === 'string' ? { type, code, message: typeof message === 'string' ? message : '' } : null
    }
    default:
      return null
  }
}

/**
 * 받아쓰기가 오류로 끝난 사유. 도우미가 내는 코드(`mic-denied`·`locale-*`·`transcriber-unavailable`·`audio-engine`·`analyzer`·`no-input-format`)와
 * main 이 정하는 코드(`unsupported-os`·`helper-missing`·`spawn-failed`·`helper-crashed`·`stop-timeout`). 모르는 도우미 코드는 그대로 실린다.
 */
export type DictationErrorCode = string

export type DictationEnd = { kind: 'done' } | { kind: 'cancelled' } | { kind: 'error'; code: DictationErrorCode; message: string }

/** main → 렌더러 (`corral:dictationEvent`). `sessionId` 는 렌더러가 시작할 때 준 값이다. */
export type DictationEvent =
  | { kind: 'ready'; sessionId: string }
  | { kind: 'partial'; sessionId: string; text: string }
  | { kind: 'final'; sessionId: string; text: string }
  | { kind: 'level'; sessionId: string; rms: number; stalled: boolean }
  | { kind: 'ended'; sessionId: string; end: DictationEnd }

export type DictationStartResult = { ok: true } | { ok: false; code: DictationErrorCode; message: string }

/**
 * 넣기 한 번의 결과(fix1 G1). `paste` = 붙은 탭 — ⌘V 와 같은 길, `send-text` = 붙지 않은 pane — guard `pane.send_text`.
 * `code: 'skipped'` = 그 세션이 이미 취소·실패해 보내지 않았다(fix2 C-R2-3) — 알릴 일이 아니다.
 */
export type DictationInsertResult = { ok: true; via: 'paste' | 'send-text' } | { ok: false; code: DictationErrorCode; message: string }

/**
 * 날 바이트 경로(`pane.send_text`)로 보낼 글 — 2004 틀 없이 PTY 에 그대로 쓰이므로 Enter·키가 될 수 있는 것을 뺀다:
 * 줄바꿈·탭 → 공백, 그 밖 C0 제어 문자·DEL·C1 제어 문자(ESC 포함) → 버림. 남는 것은 글자뿐이라 입력줄이 제출되지 않는다.
 */
export function dictationTypedText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\r' || char === '\n' || char === '\t') {
      if (!out.endsWith(' ')) out += ' '
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    out += char
  }
  return out
}

/** 정지를 누른 뒤 마지막 FINAL 확정을 기다리는 상한. 넘으면 main 이 도우미를 끝낸다(`stop-timeout`). */
export const DICTATION_STOP_TIMEOUT_MS = 5000
/**
 * 「마이크 입력이 없다」 알림까지의 시간(C5 — 5초 이하). 알림은 두 경우만이다(fix4 F-2): 세션 시작 뒤 **한 번도 소리가 없던 채** 이만큼,
 * 또는 오디오 프레임 끊김(`stalled`)이 이만큼 이어짐. 소리가 한 번 들어온 뒤의 조용함으로는 띄우지 않는다 — 노이즈 게이트·워밍업 마이크의 시작 직후 디지털 0 도 소리가 들어오면 사라진다.
 */
export const DICTATION_SILENCE_NOTICE_MS = 3000
/** 무음으로 보는 RMS 상한 — 덮개 닫은 내장 마이크는 0.00000 을 낸다(00-analysis 7절). 조용한 방의 잡음(1e-3 대)은 무음이 아니다. */
export const DICTATION_SILENCE_RMS = 1e-5
/** 단축키를 이만큼 이상 누르고 있었으면 홀드 — 떼면 정지. 더 짧은 탭은 켜진 채 둔다(fix4 F-1, orca Auto `AUTO_HOLD_THRESHOLD_MS`). */
export const DICTATION_HOLD_THRESHOLD_MS = 300
/** 탭으로 켠 세션은 마지막 말소리 뒤 이만큼 지나면 스스로 정지한다(fix4 F-1, orca `DEFAULT_STOP_AFTER_SILENCE_SECONDS`). 시계 기준 — 레벨 줄이 끊겨도 센다. */
export const DICTATION_AUTO_STOP_SILENCE_MS = 60_000
/** 60초 자동 정지가 보는 「말소리」 RMS 하한 — 조용한 방의 잡음(1e-3 대)은 말소리가 아니다. partial·FINAL 글이 오는 것도 말소리로 센다. */
export const DICTATION_SPEECH_RMS = 0.01
export const DICTATION_AUTO_STOPPED_MESSAGE = '60초 동안 소리가 없어 받아쓰기를 멈췄다'
/** 받아쓰기를 연 누름의 키 — 뗌을 알아보고(렌더러), 뗀 뒤 남은 반복을 막는 데(main) 쓴다. */
export type DictationPressKeys = { code: string; meta: boolean; shift: boolean; control: boolean; alt: boolean }

/**
 * main `before-input-event` 의 뗀 뒤 반복 막기(r5 C-R5-2) — 렌더러가 알린 누름의 글쇠가 그 누름의 수식 키 일부를 뗀 채 반복되면 막는다.
 * 수식 키 하나를 뗀 순간 홀드는 끝났다(`dictationRelease`) — 남은 반복(⇧ 를 먼저 떼면 ⌘M)이 메뉴 가속키(기본 메뉴 Window ▸ Minimize)로 가지 않게 한다.
 * 렌더러 `preventDefault` 는 메뉴 가속키보다 늦을 수 있어 여기(메뉴보다 먼저)서 막는다. 그 글쇠의 반복이 아닌 keyDown 이 오면 풀린다 — 평소 ⌘M 은 그대로(반복은 늘 같은 글쇠의 non-repeat keyDown 뒤에 온다).
 */
export function dictationRepeatGuard(input: { held: DictationPressKeys | null; keyDown: { code: string; isAutoRepeat: boolean; meta: boolean; shift: boolean; control: boolean; alt: boolean } }): { held: DictationPressKeys | null; swallow: boolean } {
  const { held, keyDown } = input
  if (held === null || keyDown.code !== held.code) return { held, swallow: false }
  if (!keyDown.isAutoRepeat) return { held: null, swallow: false }
  const sameModifiers = keyDown.meta === held.meta && keyDown.shift === held.shift && keyDown.control === held.control && keyDown.alt === held.alt
  return { held, swallow: !sameModifiers }
}

/** IPC 로 온 누름 키 — 모양이 다르면 null(main 은 렌더러 값을 믿지 않는다). */
export function parseDictationPressKeys(value: unknown): DictationPressKeys | null {
  if (typeof value !== 'object' || value === null) return null
  const code = Reflect.get(value, 'code')
  const meta = Reflect.get(value, 'meta')
  const shift = Reflect.get(value, 'shift')
  const control = Reflect.get(value, 'control')
  const alt = Reflect.get(value, 'alt')
  if (typeof code !== 'string' || code === '' || typeof meta !== 'boolean' || typeof shift !== 'boolean' || typeof control !== 'boolean' || typeof alt !== 'boolean') return null
  return { code, meta, shift, control, alt }
}

/** 시스템 설정 › 개인정보 보호 및 보안 › 마이크. */
export const MIC_PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/** macOS 26(Darwin 25) 이상에서만 SpeechAnalyzer 가 있다. `release` = `os.release()`. */
export function dictationOsSupported(input: { platform: string; release: string }): boolean {
  if (input.platform !== 'darwin') return false
  const major = Number.parseInt(input.release.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= 25
}

/** 오류 사유 → 사용자 문구. 원인을 말한다(C4·C6 — 조용한 무결과 금지). */
export function dictationErrorMessage(input: { code: DictationErrorCode; message: string }): string {
  switch (input.code) {
    case 'mic-denied':
      return '받아쓰기: 마이크 권한이 거부돼 있다 — 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 corral 을 허용한다'
    case 'unsupported-os':
      return '받아쓰기: macOS 26 이상에서만 쓸 수 있다'
    case 'locale-not-installed':
      return '받아쓰기: 한국어 음성 인식 자산이 설치돼 있지 않다 — 시스템 설정 › 키보드 › 받아쓰기에서 한국어를 추가한다'
    case 'locale-unsupported':
      return '받아쓰기: 이 기기의 음성 인식기가 한국어를 지원하지 않는다'
    case 'transcriber-unavailable':
      return '받아쓰기: 이 기기에서 음성 인식기를 쓸 수 없다'
    case 'helper-missing':
      return `받아쓰기: 도우미 실행 파일이 없다${input.message === '' ? '' : ` (${input.message})`}`
    case 'spawn-failed':
      return `받아쓰기: 도우미를 실행하지 못했다${input.message === '' ? '' : ` — ${input.message}`}`
    case 'helper-crashed':
      return `받아쓰기: 도우미가 비정상 종료했다${input.message === '' ? '' : ` (${input.message})`} — 이미 넣은 글은 그대로다`
    case 'stop-timeout':
      return '받아쓰기: 마지막 글을 기다리다 시간이 넘어 멈췄다'
    case 'insert-failed':
      return `받아쓰기: 대상 pane 에 글을 넣지 못해 멈췄다${input.message === '' ? '' : ` (${input.message})`}`
    default:
      return `받아쓰기 오류 (${input.code})${input.message === '' ? '' : `: ${input.message}`}`
  }
}

export const DICTATION_NOT_TERMINAL_MESSAGE = '받아쓰기는 터미널 pane 에서 쓸 수 있다 — 터미널을 누른 뒤 다시 시작한다'
export const DICTATION_TARGET_CLOSED_MESSAGE = '받아쓰기: 대상 pane 이 닫혀 멈췄다 — 남은 글은 넣지 않았다'
