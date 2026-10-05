// Ghostty 구성 파일 줄 파서 (LIFE-513 K2ⓐ). Orca v1.4.198 `src/main/ghostty/parser.ts` 에서 옮겨 Ghostty 쪽으로 고쳤다(MIT, 고지 `./NOTICE.md`).
//
// 규칙은 Ghostty v1.3.1 `src/cli/args.zig` `LineIterator` 그대로(00-analysis §4 D2):
//   줄 양끝 공백·CR 제거 → 빈 줄·`#` 로 **시작하는** 줄만 무시. 값 뒤 `#` 는 값의 일부다(Orca 는 앞이 공백인 `#` 이후를 잘랐다).
//   `=` 기준으로 키·값을 나눠 각각 다듬고, 값이 **큰따옴표**로 시작하고 끝날 때만 벗긴다(Orca 는 작은따옴표도 벗겼다).
//   `=` 없는 줄은 무시한다(01-criteria K2ⓐ). 같은 키 반복은 순서대로 모두 남긴다(font-family·palette 는 반복이 뜻을 가진다).

/** 키 → 값 목록(나온 순서). Map 이라 `__proto__` 같은 키도 그냥 문자열이다. */
export type GhosttyConfig = Map<string, string[]>

export function parseGhosttyConfig(content: string): GhosttyConfig {
  const result: GhosttyConfig = new Map()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    if (key.length === 0) continue
    let value = line.slice(eqIndex + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    const existing = result.get(key)
    if (existing === undefined) result.set(key, [value])
    else existing.push(value)
  }
  return result
}

/**
 * 여러 파일을 로드 순서대로 합친다 — 뒤 파일이 앞 파일을 덮는다. 단 **반복 키**(palette·font-family)는 Ghostty 처럼 이어 붙는다:
 * Ghostty 는 파일마다 같은 Config 에 값을 더하므로 반복 키는 목록에 누적되고(palette 는 인덱스별로 뒤가 이긴다), 나머지는 마지막 값이 남는다.
 */
const REPEATABLE_KEYS: ReadonlySet<string> = new Set(['palette', 'font-family'])
export function mergeGhosttyConfig({ target, next }: { target: GhosttyConfig; next: GhosttyConfig }): void {
  for (const [key, values] of next) {
    const existing = target.get(key)
    target.set(key, REPEATABLE_KEYS.has(key) && existing !== undefined ? [...existing, ...values] : [...values])
  }
}
