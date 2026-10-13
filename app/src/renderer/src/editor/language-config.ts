// VS Code `language-configuration.json` → Monaco `LanguageConfiguration` (LIFE-590 — 괄호 짝·괄호 색·접기·단어 경계를 VS Code 와 같게).
// VS Code `languageConfigurationExtensionPoint.ts` 가 읽는 칸 중 **읽기 전용 뷰어에 보이는 것**만 옮긴다: comments·brackets·colorizedBracketPairs·
// autoClosingPairs·surroundingPairs·wordPattern·indentationRules·folding. onEnterRules 는 편집 동작이라 F3 이 들일 때 옮긴다.
// 정규식 칸은 문자열 또는 `{ pattern, flags }` — 못 만들면 그 칸만 뺀다(VS Code 도 그 칸을 버리고 경고만 한다).
import type { languages } from 'monaco-editor/editor/editor.api'

type Pair = [string, string]

function regex(value: unknown): RegExp | undefined {
  try {
    if (typeof value === 'string') return new RegExp(value)
    if (value !== null && typeof value === 'object') {
      const pattern = Reflect.get(value, 'pattern')
      const flags = Reflect.get(value, 'flags')
      if (typeof pattern === 'string') return new RegExp(pattern, typeof flags === 'string' ? flags : undefined)
    }
  } catch {
    return undefined
  }
  return undefined
}

function pairs(value: unknown): Pair[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: Pair[] = []
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') result.push([item[0], item[1]])
  }
  return result
}

function closingPairs(value: unknown): languages.IAutoClosingPairConditional[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: languages.IAutoClosingPairConditional[] = []
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') result.push({ open: item[0], close: item[1] })
    else if (item !== null && typeof item === 'object') {
      const open = Reflect.get(item, 'open')
      const close = Reflect.get(item, 'close')
      const notIn = Reflect.get(item, 'notIn')
      if (typeof open !== 'string' || typeof close !== 'string') continue
      result.push(Array.isArray(notIn) ? { open, close, notIn: notIn.filter((entry): entry is string => typeof entry === 'string') } : { open, close })
    }
  }
  return result
}

export function toMonacoLanguageConfiguration(raw: unknown): languages.LanguageConfiguration {
  if (raw === null || typeof raw !== 'object') return {}
  const config: languages.LanguageConfiguration = {}
  const comments = Reflect.get(raw, 'comments')
  if (comments !== null && typeof comments === 'object') {
    const lineComment = Reflect.get(comments, 'lineComment')
    const block = Reflect.get(comments, 'blockComment')
    config.comments = {
      ...(typeof lineComment === 'string' ? { lineComment } : {}),
      ...(Array.isArray(block) && typeof block[0] === 'string' && typeof block[1] === 'string' ? { blockComment: [block[0], block[1]] } : {}),
    }
  }
  const brackets = pairs(Reflect.get(raw, 'brackets'))
  if (brackets !== undefined) config.brackets = brackets
  const colorized = pairs(Reflect.get(raw, 'colorizedBracketPairs'))
  if (colorized !== undefined) config.colorizedBracketPairs = colorized
  const autoClosing = closingPairs(Reflect.get(raw, 'autoClosingPairs'))
  if (autoClosing !== undefined) config.autoClosingPairs = autoClosing
  const surrounding = closingPairs(Reflect.get(raw, 'surroundingPairs'))
  if (surrounding !== undefined) config.surroundingPairs = surrounding
  const wordPattern = regex(Reflect.get(raw, 'wordPattern'))
  if (wordPattern !== undefined) config.wordPattern = wordPattern
  const indentation = Reflect.get(raw, 'indentationRules')
  if (indentation !== null && typeof indentation === 'object') {
    const increaseIndentPattern = regex(Reflect.get(indentation, 'increaseIndentPattern'))
    const decreaseIndentPattern = regex(Reflect.get(indentation, 'decreaseIndentPattern'))
    if (increaseIndentPattern !== undefined && decreaseIndentPattern !== undefined) {
      const indentNextLinePattern = regex(Reflect.get(indentation, 'indentNextLinePattern'))
      const unIndentedLinePattern = regex(Reflect.get(indentation, 'unIndentedLinePattern'))
      config.indentationRules = {
        increaseIndentPattern,
        decreaseIndentPattern,
        ...(indentNextLinePattern === undefined ? {} : { indentNextLinePattern }),
        ...(unIndentedLinePattern === undefined ? {} : { unIndentedLinePattern }),
      }
    }
  }
  const folding = Reflect.get(raw, 'folding')
  if (folding !== null && typeof folding === 'object') {
    const offSide = Reflect.get(folding, 'offSide')
    const markers = Reflect.get(folding, 'markers')
    const start = markers !== null && typeof markers === 'object' ? regex(Reflect.get(markers, 'start')) : undefined
    const end = markers !== null && typeof markers === 'object' ? regex(Reflect.get(markers, 'end')) : undefined
    config.folding = { ...(typeof offSide === 'boolean' ? { offSide } : {}), ...(start !== undefined && end !== undefined ? { markers: { start, end } } : {}) }
  }
  return config
}
