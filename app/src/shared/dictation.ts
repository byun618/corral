// LIFE-834 음성 받아쓰기 — 도우미 출력 규약 · main → 렌더러 이벤트 · 사용자 문구. 순수 모듈.
//
// 도우미(`helper/corral-dictation.swift`)는 stdout 에 JSON 한 줄씩 낸다. main(`main/dictation.ts`)이 줄을 해석해
// 세션 id 를 붙여 렌더러로 보내고, 렌더러(`renderer/dictation-controller.ts`)가 대상·상태 표(01-criteria)를 적용한다.

/** 도우미가 내는 한 줄. 모양이 다른 줄은 `parseHelperLine` 이 null 로 버린다. */
export type HelperLine =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'level'; rms: number }
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
      return typeof rms === 'number' && Number.isFinite(rms) ? { type, rms } : null
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
  | { kind: 'level'; sessionId: string; rms: number }
  | { kind: 'ended'; sessionId: string; end: DictationEnd }

export type DictationStartResult = { ok: true } | { ok: false; code: DictationErrorCode; message: string }

/** 넣기 한 번의 결과(fix1 G1). `paste` = 붙은 탭 — ⌘V 와 같은 길, `send-text` = 붙지 않은 pane — guard `pane.send_text`. */
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
/** 이 시간 동안 입력 레벨이 계속 무음이면 「마이크 입력이 없다」 알림(C5 — 5초 이하). */
export const DICTATION_SILENCE_NOTICE_MS = 3000
/** 무음으로 보는 RMS 상한 — 덮개 닫은 내장 마이크는 0.00000 을 낸다(00-analysis 7절). 조용한 방의 잡음(1e-3 대)은 무음이 아니다. */
export const DICTATION_SILENCE_RMS = 1e-5
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
