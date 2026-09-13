// 구조화 로그 (NDJSON). 판정 근거가 전부 여기서 나오므로 타임스탬프는 ms 정밀도로 남긴다.
// 경로: CORRAL_LOG, 없으면 <userData>/corral.ndjson.

import fs from 'node:fs'
import path from 'node:path'

type Fields = Record<string, unknown>

let stream: fs.WriteStream | null = null
let logPath = ''

export function openLog(fallbackDir: string): string {
  const fromEnv = process.env.CORRAL_LOG
  logPath = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(fallbackDir, 'corral.ndjson')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  stream = fs.createWriteStream(logPath, { flags: 'a' })
  return logPath
}

export function logFile(): string {
  return logPath
}

export function log(tag: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), at: Date.now(), tag, ...fields })
  if (stream) stream.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export function closeLog(): void {
  stream?.end()
  stream = null
}
