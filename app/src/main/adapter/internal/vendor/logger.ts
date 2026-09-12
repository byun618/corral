// **corral 작성** — 벤더 아님. endpoint-terminal-session.ts 가 원본에서 import 하던
// `../utils/logger` 의 얇은 대체다 (00-analysis §4-2 — 벤더 수정 지점 2: "corral log.ts 로
// 얇은 shim"). 원본 utils/logger.ts 는 Studio 서버의 스코프·레벨 장치가 붙은 200줄이라
// 벤더하지 않고, 세션이 실제로 쓰는 표면(Logger 타입 + silentLogger + warn/debug)만 맞춘다.

import { log } from '../../../log.js'

export type LogFields = Record<string, unknown>

export type Logger = {
  error: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  debug: (message: string, fields?: LogFields) => void
}

/** corral 의 ndjson 로그로 흘린다 — 태그에 vendor 접두를 붙여 출처가 구분되게. */
export const corralLogger: Logger = {
  error: (message, fields) => log('vendor.error', { message, ...fields }),
  warn: (message, fields) => log('vendor.warn', { message, ...fields }),
  info: (message, fields) => log('vendor.info', { message, ...fields }),
  debug: (message, fields) => log('vendor.debug', { message, ...fields }),
}

export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}
