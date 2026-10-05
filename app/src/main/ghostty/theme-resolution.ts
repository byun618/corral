// Ghostty `theme = <이름>` 해석 (LIFE-513 K3). Orca v1.4.198 `src/main/ghostty/theme-resolution.ts` 에서 옮겼다(MIT, 고지 `./NOTICE.md`).
// 탐색 순서·경로 탈출 방지·크기 상한·색 키만 받기는 Orca 그대로다(Ghostty 공식 문서와 같다 — 00-analysis §7 W8).
// 다른 점: 실패를 「없음」 하나로 뭉개지 않고 사유를 돌려준다(지원되지 않는 키에 사유로 붙는다, K3ⓓ). macOS 경로만 옮겼다.
import fs from 'node:fs/promises'
import path from 'node:path'
import { ghosttyConfigDir, type GhosttyPathEnv } from './discovery.js'
import { parseGhosttyFile, stoppedReason, type GhosttyConfig } from './parser.js'

/** 테마 파일은 수십 줄이다 — 이보다 크면 테마가 아니다(Orca 256KB). */
export const MAX_THEME_BYTES = 262_144

/** 테마에서 받는 키 — 색만. 테마 파일이 글꼴·창 설정을 사용자 구성 너머로 밀반입하지 못하게 한다(Orca 주석 그대로). */
const THEME_COLOR_KEYS: ReadonlySet<string> = new Set([
  'palette',
  'background',
  'foreground',
  'cursor-color',
  'cursor-text',
  'selection-background',
  'selection-foreground',
  'bold-color',
  'split-divider-color',
])

/** `stopped` = 4094바이트를 넘는 줄에서 읽기를 멈췄으면 그 사유(앞 줄 색은 `colors` 에 남는다, fix4 R4-02), 끝까지 읽었으면 null. */
export type ThemeResolution = { status: 'found'; colors: GhosttyConfig; stopped: string | null } | { status: 'failed'; reason: string }

/** 사용자 테마 폴더 → Ghostty 리소스 폴더(`GHOSTTY_RESOURCES_DIR/themes`, 없으면 설치본 앱 안). 사용자 테마가 내장 테마를 가린다. */
export function ghosttyThemeSearchDirs(env: GhosttyPathEnv): string[] {
  const resources = env.ghosttyResourcesDir !== undefined && env.ghosttyResourcesDir.length > 0
    ? path.join(env.ghosttyResourcesDir, 'themes')
    : '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'
  return [path.join(ghosttyConfigDir(env), 'themes'), resources]
}

type ThemeRead = { status: 'found'; colors: GhosttyConfig; stopped: string | null } | { status: 'missing' } | { status: 'invalid'; reason: string }

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

async function readThemeColors(themePath: string): Promise<ThemeRead> {
  let content: Buffer
  try {
    const info = await fs.stat(themePath)
    if (!info.isFile()) return { status: 'invalid', reason: `테마 경로가 파일이 아님: ${themePath}` }
    if (info.size > MAX_THEME_BYTES) return { status: 'invalid', reason: `테마 파일이 너무 큼: ${info.size}바이트, 한도 ${MAX_THEME_BYTES}` }
    content = await fs.readFile(themePath)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
    return { status: 'invalid', reason: `테마 파일을 읽을 수 없음: ${error instanceof Error ? error.message : String(error)}` }
  }
  // BOM 은 건너뛰지 않는다 — Ghostty `loadTheme`(Config.zig 4413-4418)은 `loadReader` 의 BOM 처리를 거치지 않는다(`parser.ts` `skipUtf8Bom`).
  const parsed = parseGhosttyFile(content)
  const colors: GhosttyConfig = new Map()
  for (const [key, values] of parsed.config) if (THEME_COLOR_KEYS.has(key)) colors.set(key, values)
  return { status: 'found', colors, stopped: parsed.stoppedAtLine === null ? null : stoppedReason({ path: themePath, line: parsed.stoppedAtLine }) }
}

export async function resolveGhosttyTheme({ name, env }: { name: string; env: GhosttyPathEnv }): Promise<ThemeResolution> {
  if (path.isAbsolute(name)) {
    const read = await readThemeColors(name)
    switch (read.status) {
      case 'found':
        return read
      case 'missing':
        return { status: 'failed', reason: `테마 파일을 찾을 수 없음: ${name}` }
      case 'invalid':
        return { status: 'failed', reason: read.reason }
    }
  }
  // 상대 이름은 파일 이름이 된다 — 경로 구분자·`.`·`..` 는 받지 않는다(절대경로만 구분자를 가질 수 있다, Ghostty 의 탈출 방지와 같다).
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return { status: 'failed', reason: `테마 이름을 쓸 수 없음: "${name}"` }
  }
  for (const dir of ghosttyThemeSearchDirs(env)) {
    const read = await readThemeColors(path.join(dir, name))
    switch (read.status) {
      case 'found':
        return read
      case 'invalid':
        // 있는데 못 읽으면 다음 폴더로 넘어가지 않는다 — 가려진 내장 테마를 몰래 쓰지 않는다(Orca 와 같다).
        return { status: 'failed', reason: read.reason }
      case 'missing':
        continue
    }
  }
  return { status: 'failed', reason: `테마 파일을 찾을 수 없음: ${name} (Ghostty 미설치이거나 없는 이름)` }
}
