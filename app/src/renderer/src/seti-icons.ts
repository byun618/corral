// 파일 아이콘 = VS Code 기본 Seti (LIFE-589 E2ⓕ · D10 B). 폰트·매핑 파일은 `assets/seti/` 로 반입했다(출처 `SOURCE.md`).
//
// 찾는 순서는 VS Code 파일 아이콘 테마와 같다: ① 파일 이름(`fileNames`) ② 확장자 — 긴 복합 확장자부터(`test.ts` → `ts`) ③ 언어 id
// (`languageIds` — 확장자·파일 이름 → 언어는 VS Code 내장 확장 매니페스트에서 뽑은 `seti-language-map.json`) ④ 기본 파일 아이콘.
// Seti 는 폴더 아이콘이 없다(VS Code 도 폴더는 화살표만 보인다). 다크 값만 쓴다(`light` 칸 무시 — corral 은 다크 단일 테마).
import themeJson from './assets/seti/vs-seti-icon-theme.json'
import languageJson from './assets/seti/seti-language-map.json'

export type SetiGlyph = { char: string; color: string | null }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringMap = (value: unknown): Map<string, string> => {
  const out = new Map<string, string>()
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out.set(key.toLowerCase(), item)
  return out
}

/** `"\\E023"` → U+E023 글자. */
export function glyphOf(fontCharacter: string): string | null {
  const match = /^\\([0-9a-fA-F]{1,6})$/.exec(fontCharacter)
  return match?.[1] === undefined ? null : String.fromCodePoint(Number.parseInt(match[1], 16))
}

export type SetiTheme = {
  definitions: Map<string, SetiGlyph>
  fileNames: Map<string, string>
  fileExtensions: Map<string, string>
  languageIds: Map<string, string>
  defaultFile: string | null
  languageByExtension: Map<string, string>
  languageByFilename: Map<string, string>
}

export function readSetiTheme(theme: unknown, languages: unknown): SetiTheme {
  const definitions = new Map<string, SetiGlyph>()
  const rawDefs = isRecord(theme) ? theme['iconDefinitions'] : undefined
  if (isRecord(rawDefs)) {
    for (const [id, def] of Object.entries(rawDefs)) {
      if (!isRecord(def) || typeof def['fontCharacter'] !== 'string') continue
      const char = glyphOf(def['fontCharacter'])
      if (char !== null) definitions.set(id, { char, color: typeof def['fontColor'] === 'string' ? def['fontColor'] : null })
    }
  }
  const lang = isRecord(languages) ? languages : {}
  return {
    definitions,
    fileNames: stringMap(isRecord(theme) ? theme['fileNames'] : undefined),
    fileExtensions: stringMap(isRecord(theme) ? theme['fileExtensions'] : undefined),
    languageIds: stringMap(isRecord(theme) ? theme['languageIds'] : undefined),
    defaultFile: isRecord(theme) && typeof theme['file'] === 'string' ? theme['file'] : null,
    languageByExtension: stringMap(lang['extensions']),
    languageByFilename: stringMap(lang['filenames']),
  }
}

/** 이름의 확장자 후보 — 긴 것부터(`a.test.ts` → `test.ts`, `ts`). 점으로 시작하는 이름의 첫 점은 확장자 경계가 아니다. */
export function extensionCandidates(name: string): string[] {
  const lower = name.toLowerCase()
  const parts = lower.split('.')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 1) {
    if (i === 1 && parts[0] === '') continue
    out.push(parts.slice(i).join('.'))
  }
  return out
}

export function setiIconId(theme: SetiTheme, name: string): string | null {
  const lower = name.toLowerCase()
  const byName = theme.fileNames.get(lower)
  if (byName !== undefined) return byName
  const extensions = extensionCandidates(name)
  for (const ext of extensions) {
    const byExt = theme.fileExtensions.get(ext)
    if (byExt !== undefined) return byExt
  }
  const language = theme.languageByFilename.get(lower) ?? extensions.map((ext) => theme.languageByExtension.get(ext)).find((id) => id !== undefined)
  if (language !== undefined) {
    const byLanguage = theme.languageIds.get(language)
    if (byLanguage !== undefined) return byLanguage
  }
  return theme.defaultFile
}

const THEME = readSetiTheme(themeJson, languageJson)
const cache = new Map<string, SetiGlyph | null>()

/** 파일 이름 → Seti 글리프(글자·색). 못 찾으면 null(그릴 것 없음). */
export function setiGlyph(name: string): SetiGlyph | null {
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  const id = setiIconId(THEME, name)
  const glyph = id === null ? null : (THEME.definitions.get(id) ?? null)
  cache.set(name, glyph)
  return glyph
}
