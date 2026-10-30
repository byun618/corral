// Monaco 편집기 (LIFE-590 E4ⓐ 읽기 · LIFE-591 F3 편집) — **첫 파일 탭이 열릴 때 처음 로드된다**(`FileEditor` 의 동적 import, E8ⓒ 지연 로딩).
//
// Monaco 는 `editor.api`(핵심) + 편집기에 쓰는 기여만 골라 싣는다 — 언어 서비스(TS·JSON·CSS·HTML worker)·Monarch 기본 언어는 싣지 않는다
// (구문 강조는 VS Code TextMate — `textmate.ts`. 언어 서버·의미 강조는 F2 범위 밖).
// LIFE-692 — VS Code 줄 편집 키: linesOperations(⌘⌫·⌘⇧K·⌥↑↓·⌥⇧↑↓·⌘] ⌘[·⌘↵·⌃J) · comment(⌘/·⌥⇧A — 주석 문자는 `language-config.ts`) · indentation ·
// caretOperations(⌃T) · wordPartOperations(⌃⌥←→). 키는 Monaco(= VS Code) 기본 그대로다. 앱 단축키와 겹치는 ⌘K 화음(⌘K ⌘C 등)은 앱 ⌘K 팔레트가 이긴다.
// suggest·quickAccess·insertFinalNewLine 은 싣지 않는다(동작 변경·앱 팔레트와 겹침 — 00-analysis §4).
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
import 'monaco-editor/features/linesOperations/register'
import 'monaco-editor/features/comment/register'
import 'monaco-editor/features/indentation/register'
import 'monaco-editor/features/caretOperations/register'
import 'monaco-editor/features/wordPartOperations/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { createTextMate, DARK_2026, INITIAL, languageOf, tokenizeLine, type TextMate } from './textmate.js'
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

/**
 * 테마 — 토큰 색은 VS Code Dark 2026: TextMate 색표를 **그대로** `encodedTokensColors` 로 줘서 Monaco 색 번호 = TextMate 색 번호(번호 1 = 기본 전경, 2 = 기본 바탕 —
 * Monaco 가 색을 앞 6 자리로 묶으므로 알파만 다른 색이 있으면 번호가 밀린다; Dark 2026 색표 34 색에는 없다 — 2026-10-13 확인).
 * 편집기 바탕은 corral `--bg-surface`, 그 밖 편집기 색은 Dark 2026.
 */
function defineTheme(colorMap: string[]): void {
  const background = corralToken('--bg-surface', '#0a0a0a')
  const strip = (color: string | undefined): string | undefined => (color === undefined ? undefined : color.replace(/^#/, '').slice(0, 6))
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: false,
    encodedTokensColors: colorMap.slice(1),
    rules: [{ token: '', foreground: strip(colorMap[1]), background: strip(colorMap[2]) }],
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
      if (!monaco.languages.getLanguages().some((row) => row.id === language.id)) monaco.languages.register({ id: language.id })
      // 토큰 메타데이터의 언어 칸 = Monaco 인코딩 언어 id — 괄호쌍 색·괄호 짝이 이 언어의 구성을 찾는다.
      const languageId = monaco.languages.getEncodedLanguageId(language.id)
      const grammar = await tm.grammar({ scopeName: language.scopeName, languageId })
      if (grammar === null) return false
      const loadConfig = language.configuration === null ? undefined : configLoaders[`../assets/textmate/language-configuration/${language.configuration}`]
      if (loadConfig !== undefined) monaco.languages.setLanguageConfiguration(language.id, toMonacoLanguageConfiguration(await loadConfig()))
      monaco.languages.setTokensProvider(language.id, {
        getInitialState: () => new TokenState(INITIAL),
        tokenizeEncoded: (line, state) => {
          const stack = state instanceof TokenState ? state.stack : INITIAL
          const result = tokenizeLine({ grammar, line, state: stack, languageId })
          return { tokens: result.tokens, endState: new TokenState(result.endState) }
        },
      })
      return true
    })()
    registered.set(language.id, ready)
  }
  // 실패(문법 없음·읽기 오류)는 캐시에 남기지 않는다 — 다음 열기가 다시 시도한다(수정 r1 R1-D).
  const ok = await ready.catch(() => false)
  if (!ok && registered.get(language.id) === ready) registered.delete(language.id)
  return ok ? language.id : 'plaintext'
}

const LARGE_FILE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = { folding: false, occurrencesHighlight: 'off', selectionHighlight: false, stickyScroll: { enabled: false } }

/**
 * 편집기 하나 — 옵션은 VS Code 기본값(글꼴 크기·줄 높이·미니맵·sticky scroll 은 Monaco 기본 = VS Code 기본), 글꼴만 corral 토큰.
 * `large`(20 MB 초과, E4ⓕ) — Monaco 모델이 스스로 토큰화를 끄는 것(`largeFileOptimizations` 기본 켬 — VS Code 와 같은 코드·같은 문턱)에 더해
 * 접기·단어 강조·sticky scroll 을 끈다(VS Code 가 대용량 모델에서 끄는 기능들). 언어는 부르는 쪽이 `plaintext` 로 준다(문법을 싣지 않는다).
 * `readOnly`(LIFE-591) — 편집할 수 없는 파일(비 UTF-8·하드링크·20 MB 초과)만 읽기 전용. 그때는 `domReadOnly` 로 친 글자(한글 조합 포함)가 입력 요소에 쌓이지 않게 한다(590 E3ⓖ).
 * IME: `editContext` 옵션은 지정하지 않는다(Monaco 0.57 기본 true — Chromium 에 EditContext 가 있으면 그 경로로 입력). 실제 한글 IME 는 E10 사용자 확인.
 */
export function createEditor(input: { host: HTMLElement; large: boolean; readOnly: boolean }): monaco.editor.IStandaloneCodeEditor {
  ensureTextMate()
  return monaco.editor.create(input.host, {
    ...(input.large ? LARGE_FILE_OPTIONS : {}),
    theme: THEME,
    readOnly: input.readOnly,
    domReadOnly: input.readOnly,
    automaticLayout: true,
    fontFamily: corralToken('--font-mono', 'ui-monospace, monospace'),
    // 편집기 안 링크 열기·드래그 앤 드롭은 끈다 — 링크가 앱 창을 옮기지 않게(E4ⓓ 와 같은 결).
    links: false,
    dragAndDrop: false,
    // 읽기 전용 안내 말풍선(「Cannot edit in read-only editor」) — VS Code 도 띄운다. 그대로 둔다.
    model: null,
  })
}

/**
 * 모델 URI — **경로에서 만들지 않는다**(LIFE-592 E4). Monaco 모델 URI 는 바꿀 수 없어서, 경로로 만들면 탐색기 이름 변경·이동 뒤 새 모델을 만들어야 하고
 * 그러면 편집 실행 취소 기록이 사라진다. 만들 때마다 새 번호를 붙여 모델과 경로를 떼고, 문서 저장소(`file-docs.ts`)가 「경로 키 → 문서 → 모델」 을 든다.
 * (같은 상대 경로가 여러 worktree 에 열려도 모델이 서로 다르다 — LIFE-591 문서 키와 같다.)
 */
let modelSerial = 0
const freshUri = (key: string): monaco.Uri => {
  modelSerial += 1
  const rel = key.slice(key.indexOf('\0') + 1)
  return monaco.Uri.from({ scheme: 'corral-file', path: `/${modelSerial}/${encodeURIComponent(rel.slice(rel.lastIndexOf('/') + 1))}` })
}

/** 문서가 든 모델이 Monaco 에 아직 살아 있으면 그 모델 — 편집기를 다시 만들 때 같은 모델에 붙는다. 버려졌으면 null. */
export function liveModel(model: unknown): monaco.editor.ITextModel | null {
  return monaco.editor.getModels().find((item) => item === model && !item.isDisposed()) ?? null
}

/** 파일 하나의 모델 — 언어는 경로로 고르지만 URI 는 경로와 무관한 새 번호다(위). */
export function createModel(input: { text: string; language: string; key: string }): monaco.editor.ITextModel {
  return monaco.editor.createModel(input.text, input.language, freshUri(input.key))
}

/**
 * LIFE-592 수정 r1 R1-F — 이름 변경으로 확장자가 바뀌면 **같은 모델**(내용·편집 실행 취소 기록 그대로)의 언어만 새 경로 것으로 바꾼다.
 * URI 는 경로와 무관한 번호라(위) 바꾸지 않는다 — 언어는 URI 가 아니라 모델 언어 id 로 정해진다.
 */
export function setModelLanguage(model: monaco.editor.ITextModel, language: string): void {
  if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
}

/**
 * 소스 제어 diff 편집기 (LIFE-683 S5) — VS Code `editor/common/config/diffEditor.ts` 기본(나란히 · 폭 900 미만이면 인라인 · `useInlineViewWhenSpaceIsLimited`).
 * **양쪽 다 읽기 전용**(Q1) — 편집은 「파일 열기」 로 보통 파일 탭에서. diff 계산은 같은 편집기 worker(`MonacoEnvironment`)가 한다.
 */
export function createDiffEditor(input: { host: HTMLElement; large: boolean }): monaco.editor.IStandaloneDiffEditor {
  ensureTextMate()
  return monaco.editor.createDiffEditor(input.host, {
    // fix r1 R1-10 — 20 MB 초과는 파일 탭(`createEditor`)과 같은 대용량 처리(언어는 부르는 쪽이 `plaintext`).
    ...(input.large ? LARGE_FILE_OPTIONS : {}),
    theme: THEME,
    readOnly: true,
    domReadOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 900,
    automaticLayout: true,
    fontFamily: corralToken('--font-mono', 'ui-monospace, monospace'),
    links: false,
    dragAndDrop: false,
  })
}
