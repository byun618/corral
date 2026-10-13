// Monaco 읽기 전용 편집기 (LIFE-590 E4ⓐ) — **첫 파일 탭이 열릴 때 처음 로드된다**(`FileEditor` 의 동적 import, E8ⓒ 지연 로딩).
//
// Monaco 는 `editor.api`(핵심) + 읽기 전용 뷰어에 쓰는 기여만 싣는다 — 언어 서비스(TS·JSON·CSS·HTML worker)·Monarch 기본 언어는 싣지 않는다
// (구문 강조는 VS Code TextMate — `textmate.ts`. 언어 서버·의미 강조는 F2 범위 밖).
// worker: 편집기 worker 하나(Vite `?worker` — 빌드 결과에 같은 출처 파일로 나간다, CSP `default-src 'self'` 안). file:// 에서 못 뜨면 Monaco 가
// main 스레드로 폴백한다(그 경로는 `raw/claude/` 에 실측 기록 — R10).
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/codicon/register'
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/folding/register'
import 'monaco-editor/features/bracketMatching/register'
import 'monaco-editor/features/clipboard/register'
import 'monaco-editor/features/contextmenu/register'
import 'monaco-editor/features/wordHighlighter/register'
import 'monaco-editor/features/stickyScroll/register'
import 'monaco-editor/features/lineSelection/register'
import 'monaco-editor/features/wordOperations/register'
import 'monaco-editor/features/smartSelect/register'
import 'monaco-editor/features/multicursor/register'
import 'monaco-editor/features/cursorUndo/register'
import 'monaco-editor/features/unicodeHighlighter/register'
import 'monaco-editor/features/readOnlyMessage/register'
import 'monaco-editor/features/longLinesHelper/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { createTextMate, DARK_2026, INITIAL, languageOf, monacoRules, tokenizeLine, type TextMate } from './textmate.js'
import type { StateStack } from '@shikijs/vscode-textmate'
import { toMonacoLanguageConfiguration } from './language-config.js'

/** VS Code 언어 구성 지연 로더(`assets/textmate/language-configuration/<언어>.json`). */
const configLoaders = import.meta.glob<unknown>('../assets/textmate/language-configuration/*.json', { import: 'default' })

export { monaco }

// Monaco 가 읽는 전역(타입은 monaco-editor 가 선언) — worker 를 어떻게 만들지. 편집기 worker 하나뿐이다(언어 서비스 없음).
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }

/** TextMate 상태를 Monaco `IState` 로 — 같은 스택 객체면 같다(vscode-textmate 는 같은 상태를 같은 객체로 준다). */
class TokenState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): TokenState {
    return new TokenState(this.stack)
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TokenState && other.stack === this.stack
  }
}

export const THEME = 'corral-dark-2026'

let textMate: TextMate | null = null
const registered = new Map<string, Promise<boolean>>()

/** corral 토큰(D10 B — 편집기 바탕·글꼴)을 문서 루트 CSS 변수에서 읽는다. */
function corralToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

/** 테마 — 토큰 색은 VS Code Dark 2026(TextMate 색 번호 규칙), 편집기 바탕은 corral `--bg-surface`, 그 밖 편집기 색은 Dark 2026. */
function defineTheme(colorMap: string[]): void {
  const background = corralToken('--bg-surface', '#0a0a0a')
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: false,
    rules: monacoRules(colorMap),
    colors: { ...DARK_2026.colors, 'editor.background': background, 'editorGutter.background': background, 'editorStickyScroll.background': background, 'minimap.background': background },
  })
}

function ensureTextMate(): TextMate {
  if (textMate === null) {
    textMate = createTextMate()
    defineTheme(textMate.colorMap)
  }
  return textMate
}

/**
 * 그 파일의 언어를 Monaco 에 등록하고 TextMate 토큰 공급자를 단다(언어마다 한 번). 문법을 다 실은 뒤에 끝난다 — 그래야 첫 그림부터 색이 맞는다.
 * 모르는 확장자면 `plaintext`.
 */
export async function languageFor(rel: string): Promise<string> {
  const tm = ensureTextMate()
  const language = languageOf(rel)
  if (language === null) return 'plaintext'
  let ready = registered.get(language.id)
  if (ready === undefined) {
    ready = (async () => {
      const grammar = await tm.grammar(language.scopeName)
      if (grammar === null) return false
      monaco.languages.register({ id: language.id })
      const loadConfig = language.configuration === null ? undefined : configLoaders[`../assets/textmate/language-configuration/${language.configuration}`]
      if (loadConfig !== undefined) monaco.languages.setLanguageConfiguration(language.id, toMonacoLanguageConfiguration(await loadConfig()))
      monaco.languages.setTokensProvider(language.id, {
        getInitialState: () => new TokenState(INITIAL),
        tokenize: (line, state) => {
          const stack = state instanceof TokenState ? state.stack : INITIAL
          const result = tokenizeLine({ grammar, line, state: stack })
          return { tokens: result.tokens, endState: new TokenState(result.endState) }
        },
      })
      return true
    })()
    registered.set(language.id, ready)
  }
  return (await ready) ? language.id : 'plaintext'
}

/** 읽기 전용 편집기 하나 — 옵션은 VS Code 기본값(글꼴 크기·줄 높이·미니맵·sticky scroll 은 Monaco 기본 = VS Code 기본), 글꼴만 corral 토큰. */
export function createViewer(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  ensureTextMate()
  return monaco.editor.create(host, {
    theme: THEME,
    readOnly: true,
    // 읽기 전용 편집기에서 친 글자(한글 조합 포함)가 textarea 에 쌓이지 않게 — 입력이 어디로도 새지 않는다(E3ⓖ).
    domReadOnly: true,
    automaticLayout: true,
    fontFamily: corralToken('--font-mono', 'ui-monospace, monospace'),
    // 편집기 안 링크 열기·드래그 앤 드롭 편집은 끈다 — 링크가 앱 창을 옮기지 않게(E4ⓓ 와 같은 결), 편집은 F3.
    links: false,
    dragAndDrop: false,
    // 읽기 전용 안내 말풍선(「Cannot edit in read-only editor」) — VS Code 도 띄운다. 그대로 둔다.
    model: null,
  })
}

/** 탭 하나의 모델 — URI 를 탭마다 따로(같은 파일이 두 번 열리지 않으므로 탭 id 로 충분). */
export function createModel(input: { text: string; language: string; tabId: string }): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme: 'corral-file', path: `/${encodeURIComponent(input.tabId)}` })
  monaco.editor.getModel(uri)?.dispose()
  return monaco.editor.createModel(input.text, input.language, uri)
}
