// Ghostty 설정 가져오기 미리보기 (LIFE-513 K1·K3·K4). Orca v1.4.198 `src/main/ghostty/index.ts` 에서 옮겨 고쳤다(MIT, 고지 `./NOTICE.md`).
//
// 하는 일: 후보 파일을 Ghostty 로드 순서로 **모두** 읽어 합친다 → `theme` 해석(테마 색은 기본값, 구성의 명시 키가 이긴다) → corral 칸으로
// 옮긴다 → **현재 설정과 다른 칸만** diff 로 돌려준다. **아무것도 쓰지 않는다**(K4ⓒ) — 적용은 렌더러가 기존 쓰기 경로(`corral:setSettings`)로 한다.
// 다른 점(00-analysis §4): 빈 파일(0바이트)은 Ghostty `file_load.open` 처럼 읽지 않는다(D3 — Orca 는 읽은 파일로 셌다) · 디렉터리도 조용히 건너뛴다 ·
// override diff 는 **바뀌는 색만** 담는다(Orca 는 가져온 override 객체 전체를 비교·전달했다 — 일부만 같으면 같은 색까지 diff 에 올랐다).
import fs from 'node:fs/promises'
import type { GhosttyImportPreview, GhosttyUnsupportedKey } from '../../shared/ghostty-import.js'
import { settingValuesEqual, type Settings, type TerminalColorOverrides } from '../../shared/terminal-settings.js'
import { ghosttyConfigCandidates, type GhosttyPathEnv } from './discovery.js'
import { mapGhosttyToCorral } from './mapper.js'
import { mergeGhosttyConfig, parseGhosttyFile, skipUtf8Bom, stoppedReason, type GhosttyConfig } from './parser.js'
import { ghosttyTheme } from './ghostty-grammar.js'
import { resolveGhosttyTheme } from './theme-resolution.js'

/** main 이 읽을 구성 파일 상한 — 실제 구성은 몇 KB 다. 넘으면 심볼릭 링크 실수나 병적인 파일로 보고 오류로 알린다(Orca 와 같다). */
export const MAX_CONFIG_BYTES = 1_000_000

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

/**
 * 후보를 순서대로 읽는다. 없음·디렉터리·빈 파일은 조용히 건너뛰고, 읽기 실패·크기 초과는 그 파일만 건너뛰며 첫 오류를 남긴다(K1ⓑ).
 * 4094바이트를 넘는 줄에서 멈춘 파일은 앞 줄까지만 합치고 사유를 남긴다 — 다음 후보 파일은 따로 읽는다(Ghostty 도 파일마다 LineIterator 를 새로 만든다, fix4 R4-02).
 */
async function readConfigFiles(env: GhosttyPathEnv): Promise<{ config: GhosttyConfig; readPaths: string[]; firstError: string | null; stopped: GhosttyUnsupportedKey[] }> {
  const config: GhosttyConfig = new Map()
  const readPaths: string[] = []
  const stopped: GhosttyUnsupportedKey[] = []
  let firstError: string | null = null
  for (const candidate of ghosttyConfigCandidates(env)) {
    try {
      const info = await fs.stat(candidate)
      if (!info.isFile() || info.size === 0) continue
      if (info.size > MAX_CONFIG_BYTES) {
        firstError ??= `구성 파일이 너무 커서 가져올 수 없습니다 (${candidate}: ${info.size}바이트, 한도 ${MAX_CONFIG_BYTES}).`
        continue
      }
      const parsed = parseGhosttyFile(skipUtf8Bom(await fs.readFile(candidate)))
      mergeGhosttyConfig({ target: config, next: parsed.config })
      readPaths.push(candidate)
      if (parsed.stoppedAtLine !== null) stopped.push({ key: candidate, reason: stoppedReason({ path: candidate, line: parsed.stoppedAtLine }) })
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      firstError ??= `구성을 읽을 수 없습니다 (${candidate}): ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { config, readPaths, firstError, stopped }
}

/**
 * `theme` 을 꺼내 테마 색을 기본값으로 깐다 — 키마다 테마 할당을 구성 할당 **앞에** 붙인다. Ghostty 처럼 테마가 먼저 대입되고 구성이 다시 대입되므로
 * 구성의 받아들여진 명시 값이 이기고, 구성 값이 Ghostty 에서 거절되면 테마 값이 남는다(fix2 R2-01). palette 는 인덱스별로 같은 규칙.
 * `theme` 자체도 **Ghostty 가 받는 마지막 할당**을 고른다(fix3 R3-04, `Theme.parseCLI` → `ghosttyTheme`): 문법 오류(`light:x` 단독·`garbage:value`·`foo=bar`)는
 * 사유만 남기고 앞 테마를 유지, 유효한 light/dark 쌍은 받는 값이라 앞 테마도 가져오지 않음(corral 은 다크 단일, S19 — Orca 와 같이 쌍 미지원),
 * 길이 0 은 리셋. 쌍 문법에 따옴표·이스케이프가 있으면 해석을 확정할 수 없어 테마를 아예 가져오지 않는다.
 */
type ThemeChoice = ReturnType<typeof ghosttyTheme> | { kind: 'reset' }

function readThemeAssignment(value: string): ThemeChoice {
  return value.length === 0 ? { kind: 'reset' } : ghosttyTheme(value)
}

async function applyTheme({ config, env }: { config: GhosttyConfig; env: GhosttyPathEnv }): Promise<GhosttyUnsupportedKey[]> {
  const raw = config.get('theme')
  if (raw === undefined) return []
  config.delete('theme')
  const reasons: GhosttyUnsupportedKey[] = []
  let chosen: Exclude<ThemeChoice, { kind: 'rejected' } | { kind: 'uncertain' }> | null = null
  for (const value of raw) {
    const parsed = readThemeAssignment(value)
    if (parsed.kind === 'uncertain') return [...reasons, { key: 'theme', reason: `"${value}" — 따옴표·이스케이프가 든 light/dark 쌍 · Ghostty 해석을 확정할 수 없어 가져오지 않음` }]
    if (parsed.kind === 'rejected') reasons.push({ key: 'theme', reason: `"${value}" — Ghostty 테마 문법이 아님 (이름 하나 또는 light:이름,dark:이름) · Ghostty 도 받지 않아 이 줄은 무시됨` })
    else chosen = parsed
  }
  if (chosen === null) return reasons
  switch (chosen.kind) {
    case 'reset':
      return [...reasons, { key: 'theme', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }]
    case 'pair':
      return [...reasons, { key: 'theme', reason: 'light:/dark: 쌍은 지원하지 않음 (corral 은 다크 테마 하나)' }]
    case 'single':
      break
  }
  const name = chosen.name
  const resolved = await resolveGhosttyTheme({ name, env })
  if (resolved.status === 'failed') return [...reasons, { key: 'theme', reason: resolved.reason }]
  if (resolved.stopped !== null) reasons.push({ key: 'theme', reason: resolved.stopped })
  for (const [key, values] of resolved.colors) config.set(key, [...values, ...(config.get(key) ?? [])])
  return reasons
}

/** 가져올 값 중 현재와 다른 칸만. override 는 **바뀌는 색만** 남긴다 — 적용 때 현재 override 위에 병합된다(K4ⓑ·K5ⓐ). */
export function diffAgainstCurrent({ patch, current }: { patch: Partial<Settings>; current: Settings }): Partial<Settings> {
  const diff: Partial<Settings> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'terminalColorOverrides') continue
    if (!settingValuesEqual({ a: Reflect.get(current, key), b: value })) Object.assign(diff, { [key]: value })
  }
  const overrides: TerminalColorOverrides = {}
  for (const [key, color] of Object.entries(patch.terminalColorOverrides ?? {})) {
    if (Reflect.get(current.terminalColorOverrides, key) !== color) Object.assign(overrides, { [key]: color })
  }
  if (Object.keys(overrides).length > 0) diff.terminalColorOverrides = overrides
  return diff
}

export async function previewGhosttyImport({ env, current }: { env: GhosttyPathEnv; current: Settings }): Promise<GhosttyImportPreview> {
  const { config, readPaths, firstError, stopped } = await readConfigFiles(env)
  if (readPaths.length === 0) return firstError === null ? { status: 'not-found' } : { status: 'error', error: firstError }
  const themeUnsupported = await applyTheme({ config, env })
  const { patch, unsupported } = mapGhosttyToCorral(config)
  return { status: 'found', configPaths: readPaths, diff: diffAgainstCurrent({ patch, current }), unsupported: [...stopped, ...unsupported, ...themeUnsupported] }
}
