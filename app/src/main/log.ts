// 구조화 로그 (NDJSON). 판정 근거가 전부 여기서 나오므로 타임스탬프는 ms 정밀도로 남긴다.
// 경로: CORRAL_LOG, 없으면 <userData>/corral.ndjson. 파일을 못 열면 stdout 으로 쓰고, 재시도 간격마다 다시 열어 본다.
// 크기 상한 회전 (LIFE-788): 현재 파일이 상한을 넘으면 .1 로 밀고(.1 → .2, 이전 .2 는 덮여 사라진다) 새 파일에 쓴다.
// 열 때는 기존 파일 크기로, 도는 중에는 쓴 바이트 누적으로 판단한다 — 쓰기마다 stat 하지 않는다.
// 상한: CORRAL_LOG_MAX_BYTES — 시험·관문에서 상한을 낮추는 용도다. Number() 로 읽어 양의 안전 정수만 받는다
// (' 2000 '·'1e3'·'0x10' 도 받는다), 없거나 잘못되면 100MB. 하한은 두지 않는다 — 아주 작은 값이면 쓰기마다 회전한다.

import fs from 'node:fs'
import path from 'node:path'

type Fields = Record<string, unknown>

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const GENERATIONS = 2
// 회전·열기 실패 뒤 재시도: 1분에서 시작해 실패마다 두 배, 1시간 상한. 포기하지 않는다 — 성공하면 1분으로 돌아간다.
export const ROTATE_RETRY_MS = 60_000
export const ROTATE_RETRY_MAX_MS = 60 * 60_000
// 회전으로 만드는 새 파일: 남은 내용은 비우고(O_TRUNC), 외부에서 잘라도 끝에 붙도록(O_APPEND) — 기존 파일의 'a' 와 같다.
const NEW_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND

let stream: fs.WriteStream | null = null
let logPath = ''
let maxBytes = DEFAULT_MAX_BYTES
let written = 0
let rotateFailures = 0
let nextRotateAt = 0
// 파일을 원하는가(openLog 뒤, closeLog 전) — stdout 대체 중이면 간격마다 다시 연다.
let wantFile = false
let openFailures = 0
let nextOpenAt = 0
let lastOpenError = ''

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
  openFailures = 0
  nextOpenAt = 0
  lastOpenError = ''
  wantFile = true
  openFile()
  return logPath
}

export function logFile(): string {
  return logPath
}

export function log(tag: string, fields: Fields = {}): void {
  if (!stream && wantFile && Date.now() >= nextOpenAt) openFile()
  writeLine(entry(tag, fields))
  if (stream && written > maxBytes) rotate()
}

export function closeLog(): void {
  wantFile = false
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

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    // 이미 닫혔거나 닫을 수 없다 — 할 수 있는 것이 없다.
  }
}

// 파일을 연다(필요하면 열 때 회전). 실패하면 stdout 대체로 남고 openFailed 가 재시도 시각을 정한다.
function openFile(): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch (e) {
    openFailed(e)
    return
  }
  const size = sizeOf(logPath)
  if (size > maxBytes) {
    const rotated = rotateFiles()
    if (rotated.ok) {
      stream = rotated.stream
      written = 0
      opened()
      writeLine(entry('log.rotated', { phase: 'open', bytes: size, maxBytes }))
      return
    }
    // 회전 실패면 파일은 그대로(rotateFiles 주석) — 기존 파일에 이어 쓰고 재시도 간격을 따른다.
    if (openAppend(size)) opened()
    rotateFailed('open', rotated.error)
    return
  }
  if (openAppend(size)) opened()
}

// fd 를 동기로 열어 stream 에 넘긴다 — 회전으로 경로가 바뀌어도 이미 받은 쓰기는 그 fd(밀린 세대)로 순서대로 간다.
function openAppend(size: number): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(logPath, 'a')
    stream = fs.createWriteStream(logPath, { fd })
    written = size
    return true
  } catch (e) {
    if (fd !== null) closeQuietly(fd)
    stream = null
    openFailed(e)
    return false
  }
}

// 열기에 성공했다 — 앞서 실패했으면 그 사실을 파일에 한 줄 남긴다(GUI 에서는 stdout 이 안 보인다).
function opened(): void {
  if (openFailures > 0) writeLine(entry('log.open.recovered', { failures: openFailures, error: lastOpenError }))
  openFailures = 0
  nextOpenAt = 0
  lastOpenError = ''
}

function openFailed(error: unknown): void {
  openFailures += 1
  const delay = retryDelay(openFailures)
  nextOpenAt = Date.now() + delay
  lastOpenError = message(error)
  writeLine(entry('log.open.failed', { file: logPath, failures: openFailures, retryInMs: delay, error: lastOpenError }))
}

type Rotated = { ok: true; stream: fs.WriteStream } | { ok: false; error: unknown }

// 새 파일을 임시 이름(.next)으로 먼저 열고 나서 세대를 민다 — 열기 실패는 어떤 rename 보다 먼저 드러나 파일이 그대로다.
// 현재 파일이 없으면(외부에서 지움) 밀 것이 없으니 세대는 그대로 두고 새 파일만 놓는다.
// 실패하면 해낸 rename 을 거꾸로 되돌리되, 되돌리기가 하나라도 실패하면 거기서 멈춘다 — 계속하면 다음 rename 이
// 활성 세대(옛 stream 이 쓰는 파일)를 덮는다. 되돌리지 못하는 잔여:
// - .1 → .2 가 끝난 뒤 실패하면 이전 .2 는 이미 덮여 사라졌다(되돌리면 옛 .1 은 .1 로 돌아온다)
// - 되돌리기에서 멈추면 세대가 밀린 자리에 남는다(예: 현재 파일 내용이 .1 에, 옛 .1 이 .2 에, 현재 경로는 비어 있음).
//   옛 stream 은 그 fd 로 계속 쓰므로 줄은 잃지 않고, 다음 성공 회전이 현재 경로를 채운다
// - .next 는 정리(close·rm)가 실패하거나 회전 도중 프로세스가 죽으면 남는다 — 다음 회전이 O_TRUNC 로 비우고 다시 쓴다
function rotateFiles(): Rotated {
  const next = `${logPath}.next`
  let fd: number
  try {
    fd = fs.openSync(next, NEW_FILE_FLAGS)
  } catch (e) {
    return { ok: false, error: e }
  }
  const undo: Array<[string, string]> = []
  try {
    if (fs.existsSync(logPath)) {
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
    }
    fs.renameSync(next, logPath)
    undo.push([logPath, next])
    return { ok: true, stream: fs.createWriteStream(logPath, { fd }) }
  } catch (e) {
    for (const [from, to] of undo.reverse()) {
      try {
        fs.renameSync(from, to)
      } catch {
        break
      }
    }
    closeQuietly(fd)
    try {
      fs.rmSync(next, { force: true })
    } catch {
      // 위 주석의 잔여 — 다음 회전이 비운다.
    }
    return { ok: false, error: e }
  }
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
