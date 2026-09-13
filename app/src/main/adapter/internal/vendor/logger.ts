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

/**
 * 평시(비계측) 실행용 (수정 1회차 C1). error·warn 은 남기고 info·debug 만 죽인다.
 *
 * C1 이 문제 삼은 것은 **프레임당 debug 로그**다 — `endpoint-terminal-session.ts` 의 debug 호출은
 * 전부 이벤트마다 찍히고(`:214` surface 는 프레임마다, `:279/:396` resize, `:501` scroll-fail),
 * warn 은 연결 실패 한 곳(`:129`)뿐이다. 그래서 debug/info 만 끄면 무한 누적을 멈추면서도 평시
 * 진단 가시성(연결 실패 등)은 지킨다. 판정 지시는 "silentLogger" 였지만, 오류를 통째로 삼키는
 * 것은 새 사각을 만들므로 그 의도(프레임당 잡음 제거)만 취하고 error/warn 은 보존한다.
 * (logger.ts 는 corral 작성 파일이라 이 결정으로 벤더 원본은 한 글자도 안 바뀐다 — PROVENANCE 불변.)
 */
export const quietLogger: Logger = {
  error: (message, fields) => log('vendor.error', { message, ...fields }),
  warn: (message, fields) => log('vendor.warn', { message, ...fields }),
  info: () => {},
  debug: () => {},
}
