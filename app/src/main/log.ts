// 구조화 로그 (NDJSON). 판정 근거가 전부 여기서 나오므로 타임스탬프는 ms 정밀도로 남긴다.
// 경로: CORRAL_LOG, 없으면 <userData>/corral.ndjson.
// 크기 상한 회전 (LIFE-788): 현재 파일이 상한을 넘으면 .1 로 밀고(.1 → .2, 이전 .2 는 덮여 사라진다) 새 파일에 쓴다.
// 열 때는 기존 파일 크기로, 도는 중에는 쓴 바이트 누적으로 판단한다 — 쓰기마다 stat 하지 않는다.
// 상한: CORRAL_LOG_MAX_BYTES(양의 정수), 없거나 잘못되면 100MB.

import fs from 'node:fs'
import path from 'node:path'

type Fields = Record<string, unknown>

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const GENERATIONS = 2
// 회전 실패 뒤 재시도: 간격 1분, 연속 실패 5회면 다음 openLog 까지 멈춘다.
export const ROTATE_RETRY_MS = 60_000
export const ROTATE_MAX_FAILURES = 5

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

export function openLog(fallbackDir: string): string {
  const fromEnv = process.env.CORRAL_LOG
  logPath = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(fallbackDir, 'corral.ndjson')
  maxBytes = maxBytesFromEnv(process.env.CORRAL_LOG_MAX_BYTES)
  rotateFailures = 0
  nextRotateAt = 0
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const size = sizeOf(logPath)
  const over = size > maxBytes
  const error = over ? shiftGenerations() : null
  stream = openStream()
  written = over && error === null ? 0 : size
  if (error !== null) rotateFailed('open', error)
  else if (over) writeLine(entry('log.rotated', { phase: 'open', bytes: size, maxBytes }))
  return logPath
}

export function logFile(): string {
  return logPath
}

export function log(tag: string, fields: Fields = {}): void {
  const line = entry(tag, fields)
  if (!stream) {
    process.stdout.write(line)
    return
  }
  writeLine(line)
  if (written > maxBytes) rotate()
}

export function closeLog(): void {
  stream?.end()
  stream = null
}

function entry(tag: string, fields: Fields): string {
  return JSON.stringify({ ts: new Date().toISOString(), at: Date.now(), tag, ...fields }) + '\n'
}

function writeLine(line: string): void {
  stream?.write(line)
  written += Buffer.byteLength(line)
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// fd 를 동기로 열어 넘긴다 — 회전으로 경로가 바뀌어도 이미 받은 쓰기는 그 fd(밀린 세대)로 순서대로 간다.
function openStream(): fs.WriteStream {
  return fs.createWriteStream(logPath, { fd: fs.openSync(logPath, 'a') })
}

// .1 → .2 … 순으로 밀고 현재 파일을 .1 로. 실패하면 오류를 돌려준다(던지지 않는다).
function shiftGenerations(): unknown {
  try {
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`)
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
    }
    fs.renameSync(logPath, `${logPath}.1`)
    return null
  } catch (e) {
    return e
  }
}

// 도는 중 회전. 회전은 write 와 write 사이에서만 일어나 한 줄이 두 파일로 갈리지 않는다.
function rotate(): void {
  if (rotateFailures >= ROTATE_MAX_FAILURES || Date.now() < nextRotateAt) return
  const bytes = written
  const error = shiftGenerations()
  if (error !== null) {
    rotateFailed('run', error)
    return
  }
  let next: fs.WriteStream
  try {
    next = openStream()
  } catch (e) {
    // 새 파일을 못 열면 밀었던 파일을 되돌려 놓고 기존 stream 에 계속 쓴다.
    try {
      fs.renameSync(`${logPath}.1`, logPath)
    } catch {
      // 되돌리지 못해도 기존 stream 은 밀린 파일(.1)에 계속 쓴다 — 줄은 잃지 않는다.
    }
    rotateFailed('run', e)
    return
  }
  stream?.end()
  stream = next
  written = 0
  rotateFailures = 0
  writeLine(entry('log.rotated', { phase: 'run', bytes, maxBytes }))
}

function rotateFailed(phase: 'open' | 'run', error: unknown): void {
  rotateFailures += 1
  nextRotateAt = Date.now() + ROTATE_RETRY_MS
  const gaveUp = rotateFailures >= ROTATE_MAX_FAILURES
  writeLine(
    entry('log.rotate.failed', {
      phase,
      failures: rotateFailures,
      gaveUp,
      error: error instanceof Error ? error.message : String(error)
    })
  )
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT'
}
