// LIFE-590 — VS Code 언어 구성 → Monaco 변환(단위). 반입한 실제 파일(TypeScript·Markdown·Python)로 본다.
import { describe, expect, it } from 'vitest'
import { toMonacoLanguageConfiguration } from './language-config.js'
import typescript from '../assets/textmate/language-configuration/typescript.json'
import markdown from '../assets/textmate/language-configuration/markdown.json'
import python from '../assets/textmate/language-configuration/python.json'

describe('toMonacoLanguageConfiguration', () => {
  it('TypeScript — 주석·괄호(`${` 포함)·단어 패턴·접기 표지가 정규식으로', () => {
    const config = toMonacoLanguageConfiguration(typescript)
    expect(config.comments).toEqual({ lineComment: '//', blockComment: ['/*', '*/'] })
    expect(config.brackets).toContainEqual(['{', '}'])
    expect(config.wordPattern).toBeInstanceOf(RegExp)
    expect(config.folding?.markers?.start).toBeInstanceOf(RegExp)
    expect(config.folding?.markers?.start.test('//#region a')).toBe(true)
    expect(config.autoClosingPairs?.find((pair) => pair.open === "'")).toMatchObject({ notIn: ['string', 'comment'] })
  })
  it('Markdown·Python — 있는 칸만, offSide 유지', () => {
    expect(toMonacoLanguageConfiguration(markdown).brackets?.length).toBeGreaterThan(0)
    expect(toMonacoLanguageConfiguration(python).folding?.offSide).toBe(true)
  })
  it('형 위반·깨진 정규식은 그 칸만 뺀다', () => {
    expect(toMonacoLanguageConfiguration(null)).toEqual({})
    expect(toMonacoLanguageConfiguration({ wordPattern: '(', brackets: [['(', ')'], [1, 2]] })).toEqual({ brackets: [['(', ')']] })
  })
})
