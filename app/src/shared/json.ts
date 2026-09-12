// 모르는 JSON 을 안전하게 읽는 헬퍼. **herdr 를 모른다** — 그냥 JSON 을 읽을 뿐이다.
//
// 어댑터 내부(herdr 응답)와 main(레지스트리 파일·제어 채널)이 같이 쓴다. 옛 앱은 이걸
// `herdr/protocol.ts` 에 뒀는데, 그러면 제어 채널이 herdr 프로토콜 모듈을 import 하게 되어
// N2 의 경계를 그 자리에서 깬다. 그래서 벤더 중립인 층으로 내렸다.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' ? value : null
}

export function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return isRecord(value) ? value : null
}

export function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key]
  return Array.isArray(value) ? value : []
}

export function safeParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
