// 구조화 로그 (NDJSON). 판정 근거가 전부 여기서 나오므로 타임스탬프는 ms 정밀도로 남긴다.
// 경로: CORRAL_LOG, 없으면 <userData>/corral.ndjson. 파일을 못 열면 stdout 으로 쓴다.
// 크기 상한 회전 (LIFE-788): 현재 파일이 상한을 넘으면 .1 로 밀고(.1 → .2, 이전 .2 는 덮여 사라진다) 새 파일에 쓴다.
// 열 때는 기존 파일 크기로, 도는 중에는 쓴 바이트 누적으로 판단한다 — 쓰기마다 stat 하지 않는다.
// 상한: CORRAL_LOG_MAX_BYTES — 시험·관문에서 상한을 낮추는 용도다. Number() 로 읽어 양의 안전 정수만 받는다
// (' 2000 '·'1e3'·'0x10' 도 받는다), 없거나 잘못되면 100MB. 하한은 두지 않는다 — 아주 작은 값이면 쓰기마다 회전한다.

import fs from 'node:fs'
import path from 'node:path'

type Fields = Record<string, unknown>

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const GENERATIONS = 2
// 회전 실패 뒤 재시도: 1분에서 시작해 실패마다 두 배, 1시간 상한. 포기하지 않는다 — 성공하면 1분으로 돌아간다.
export const ROTATE_RETRY_MS = 60_000
export const ROTATE_RETRY_MAX_MS = 60 * 60_000

let stream: fs.WriteStream | null = null
let logPath = ''
let maxBytes = DEFAULT_MAX_BYTES
let written = 0
let rotateFailures = 0
let nextRotateAt = 0

export function maxBytesFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_MAX_BYTES
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES
}

export function retryDelay(failures: number): number {
  return Math.min(ROTATE_RETRY_MS * 2 ** Math.max(0, failures - 1), ROTATE_RETRY_MAX_MS)
}

// 던지지 않는다 — 열기 실패로 앱 기동이 막히면 안 된다(LIFE-788 r1 A). 못 열면 stream 없이 stdout 으로 간다.
export function openLog(fallbackDir: string): string {
  const fromEnv = process.env.CORRAL_LOG
  logPath = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(fallbackDir, 'corral.ndjson')
  maxBytes = maxBytesFromEnv(process.env.CORRAL_LOG_MAX_BYTES)
  closeLog()
  written = 0
  rotateFailures = 0
  nextRotateAt = 0
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch (e) {
    writeLine(entry('log.open.failed', { file: logPath, error: message(e) }))
    return logPath
  }
  const size = sizeOf(logPath)
  if (size > maxBytes) {
    const rotated = rotateFiles()
    if (rotated.ok) {
      stream = rotated.stream
      writeLine(entry('log.rotated', { phase: 'open', bytes: size, maxBytes }))
      return logPath
    }
    // 회전 실패면 파일은 그대로(rotateFiles 주석) — 기존 파일에 이어 쓰고 재시도 간격을 따른다.
    openAppend(size)
    rotateFailed('open', rotated.error)
    return logPath
  }
  openAppend(size)
  return logPath
}

export function logFile(): string {
  return logPath
}

export function log(tag: string, fields: Fields = {}): void {
  writeLine(entry(tag, fields))
  if (stream && written > maxBytes) rotate()
}

export function closeLog(): void {
  stream?.end()
  stream = null
}

function entry(tag: string, fields: Fields): string {
  return JSON.stringify({ ts: new Date().toISOString(), at: Date.now(), tag, ...fields }) + '\n'
}

function writeLine(line: string): void {
  if (!stream) {
    process.stdout.write(line)
    return
  }
  stream.write(line)
  written += Buffer.byteLength(line)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// fd 를 동기로 열어 stream 에 넘긴다 — 회전으로 경로가 바뀌어도 이미 받은 쓰기는 그 fd(밀린 세대)로 순서대로 간다.
function openAppend(size: number): void {
  try {
    stream = fs.createWriteStream(logPath, { fd: fs.openSync(logPath, 'a') })
    written = size
  } catch (e) {
    stream = null
    writeLine(entry('log.open.failed', { file: logPath, error: message(e) }))
  }
}

type Rotated = { ok: true; stream: fs.WriteStream } | { ok: false; error: unknown }

// 새 파일을 임시 이름(.next)으로 먼저 열고 나서 세대를 민다 — 열기 실패는 어떤 rename 보다 먼저 드러나 파일이 그대로다.
// rename 단계 실패는 거꾸로 되돌린다. 되돌리지 못하는 잔여:
// - .1 → .2 가 끝난 뒤 실패하면 이전 .2 는 이미 덮여 사라졌다(되돌리면 옛 .1 은 .1 로 돌아온다)
// - 되돌리기 rename 자체가 실패하면 .1 이 빈 채(현재 파일은 .1 또는 .2 에 있다)로 남는다 — 다음 성공 회전이 채운다
function rotateFiles(): Rotated {
  const next = `${logPath}.next`
  let fd: number
  try {
    fd = fs.openSync(next, 'w')
  } catch (e) {
    return { ok: false, error: e }
  }
  const undo: Array<[string, string]> = []
  try {
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`)
        undo.push([`${logPath}.${i + 1}`, `${logPath}.${i}`])
      } catch (e) {
        // ENOENT 만 넘긴다 — 다른 오류를 넘기면 다음 rename 이 기존 .i 를 덮어 지운다.
        if (!isNotFound(e)) throw e
      }
    }
    fs.renameSync(logPath, `${logPath}.1`)
    undo.push([`${logPath}.1`, logPath])
    fs.renameSync(next, logPath)
  } catch (e) {
    for (const [from, to] of undo.reverse()) {
      try {
        fs.renameSync(from, to)
      } catch {
        // 위 주석의 잔여 — 줄은 잃지 않는다.
      }
    }
    try {
      fs.closeSync(fd)
      fs.rmSync(next, { force: true })
    } catch {
      // 남은 .next 는 다음 회전이 'w' 로 다시 연다.
    }
    return { ok: false, error: e }
  }
  return { ok: true, stream: fs.createWriteStream(logPath, { fd }) }
}

// 도는 중 회전. 회전은 write 와 write 사이에서만 일어나 한 줄이 두 파일로 갈리지 않는다.
function rotate(): void {
  if (Date.now() < nextRotateAt) return
  const bytes = written
  const rotated = rotateFiles()
  if (!rotated.ok) {
    rotateFailed('run', rotated.error)
    return
  }
  stream?.end()
  stream = rotated.stream
  written = 0
  rotateFailures = 0
  nextRotateAt = 0
  writeLine(entry('log.rotated', { phase: 'run', bytes, maxBytes }))
}

function rotateFailed(phase: 'open' | 'run', error: unknown): void {
  rotateFailures += 1
  const delay = retryDelay(rotateFailures)
  nextRotateAt = Date.now() + delay
  writeLine(entry('log.rotate.failed', { phase, failures: rotateFailures, retryInMs: delay, error: message(error) }))
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT'
}
