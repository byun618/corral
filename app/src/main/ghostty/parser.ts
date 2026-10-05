// Ghostty 구성 파일 줄 파서 (LIFE-513 K2ⓐ). Orca v1.4.198 `src/main/ghostty/parser.ts` 에서 옮겨 Ghostty 쪽으로 고쳤다(MIT, 고지 `./NOTICE.md`).
//
// 규칙은 Ghostty v1.3.1 `src/cli/args.zig` `LineIterator`(1393-1495) 그대로(00-analysis §4 D2, fix4 R4-01·R4-02):
//   `\n` 으로 줄을 나눈다 → 줄이 **4094바이트**(UTF-8, CR·양끝 공백 포함)를 넘으면 그 파일은 **거기서 읽기를 멈춘다**(주석 판정 전, 앞 줄 할당은 남는다).
//     버퍼 `entry: [MAX_LINE_SIZE=4096]u8` 의 앞 2바이트가 `--` 라 writer 는 `.fixed(entry[2..])` 4094바이트 — 넘치면 Zig 0.15.2 `Writer.fixedDrain` 이
//     `WriteFailed` → `streamDelimiterEnding` 실패 → `next()` 가 `return null`(파일 끝과 같다). 4094바이트는 `Writer.write` 의 `end + len <= buffer.len` 로 통과.
//   줄 양끝 `whitespace ++ "\r"`(space·tab·CR) 제거 → 빈 줄·`#` 로 **시작하는** 줄만 무시. 값 뒤 `#` 는 값의 일부다(Orca 는 앞이 공백인 `#` 이후를 잘랐다).
//   `=` 기준으로 키·값을 나눠 각각 `whitespace`(space·tab **만** — args.zig 19) 로 다듬고, 값이 **큰따옴표**로 시작하고 끝날 때만 벗긴다(Orca 는 작은따옴표도 벗겼다).
//   JS `trim()` 은 쓰지 않는다 — NBSP·유니코드 공백·값 안쪽 CR 까지 벗겨 Ghostty 가 거절할 값을 받는 값으로 바꾼다(r4 R4-01).
//   `=` 없는 줄은 무시한다(01-criteria K2ⓐ). 같은 키 반복은 순서대로 모두 남긴다(font-family·palette 는 반복이 뜻을 가진다).
// 파일 시작 UTF-8 BOM 은 줄 파서가 아니라 파일 읽기 쪽 규칙이다 — `skipUtf8Bom` 주석.

/** 키 → 값 목록(나온 순서). Map 이라 `__proto__` 같은 키도 그냥 문자열이다. */
export type GhosttyConfig = Map<string, string[]>

/** `LineIterator.MAX_LINE_SIZE`(4096) − 앞 `--` 2바이트. */
export const MAX_LINE_BYTES = 4094

/** `stoppedAtLine` = 4094바이트를 넘어 읽기를 멈춘 줄 번호(1부터, 빈 줄·주석 포함). 끝까지 읽었으면 null. */
export type GhosttyFileParse = { config: GhosttyConfig; stoppedAtLine: number | null }

function trimLine(text: string): string {
  return text.replace(/^[ \t\r]+|[ \t\r]+$/g, '')
}

function trimField(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '')
}

/**
 * 구성 파일 시작의 UTF-8 BOM(EF BB BF)을 건너뛴다 — `Config.loadReader`(Config.zig 3886-3896)가 LineIterator 전에 한다.
 * **테마 파일에는 쓰지 않는다** — `loadTheme`(Config.zig 4413-4418)은 BOM 처리 없이 LineIterator 를 바로 돌려 BOM 이 첫 줄 키의 일부가 된다.
 */
export function skipUtf8Bom(bytes: Buffer): Buffer {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
}

export function parseGhosttyFile(bytes: Buffer): GhosttyFileParse {
  const config: GhosttyConfig = new Map()
  let start = 0
  let lineNumber = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const end = newline === -1 ? bytes.length : newline
    lineNumber += 1
    if (end - start > MAX_LINE_BYTES) return { config, stoppedAtLine: lineNumber }
    const line = trimLine(bytes.subarray(start, end).toString('utf8'))
    start = end + 1
    if (line.length === 0 || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimField(line.slice(0, eqIndex))
    if (key.length === 0) continue
    let value = trimField(line.slice(eqIndex + 1))
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    const existing = config.get(key)
    if (existing === undefined) config.set(key, [value])
    else existing.push(value)
  }
  return { config, stoppedAtLine: null }
}

/** 문자열 하나를 BOM 처리 없이 한 파일로 읽는다(테스트·매퍼 입력용). */
export function parseGhosttyConfig(content: string): GhosttyConfig {
  return parseGhosttyFile(Buffer.from(content, 'utf8')).config
}

/** 미리보기에 보일 사유 — 그 파일의 이 줄부터 뒤는 Ghostty 도 읽지 않는다. */
export function stoppedReason({ path, line }: { path: string; line: number }): string {
  return `${path} ${line}번째 줄이 ${MAX_LINE_BYTES}바이트를 넘어 Ghostty 처럼 그 뒤를 읽지 않음`
}

/**
 * 여러 파일을 로드 순서대로 합친다 — **모든 키의 할당을 순서대로 이어 붙인다.** Ghostty 는 파일마다 같은 Config 에 한 줄씩 대입하므로
 * 반복 키(palette·font-family)는 목록에 누적되고, 나머지 키는 **Ghostty 가 받은 마지막 할당**이 남는다 — 거절된 줄은 앞 값을 지우지 않는다
 * (fix2 R2-01, `cli/args.zig` 136·348). 어느 할당이 남는지는 키 문법을 아는 매퍼가 고른다(`mapper.ts` `ghosttyAccepts`).
 */
export function mergeGhosttyConfig({ target, next }: { target: GhosttyConfig; next: GhosttyConfig }): void {
  for (const [key, values] of next) target.set(key, [...(target.get(key) ?? []), ...values])
}
