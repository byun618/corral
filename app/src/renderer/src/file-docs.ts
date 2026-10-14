// 파일 탭 문서 (LIFE-591 F3 · E1ⓔ) — 편집 중인 내용(Monaco 모델 = 내용 + 실행 취소 기록)을 **컴포넌트 수명 밖**에 둔다.
//
// F2 는 비활성 탭이 언마운트될 때 모델을 버렸다(`FileView` `TextBody` 정리). 편집을 켜면 탭만 바꿔도 수정 내용이 사라지므로, 모델을 여기 `(worktree 루트, 상대 경로)`
// 키로 맡긴다 — 탭 전환·worktree 전환 왕복·탭을 다른 영역으로 끌기·영역 분할은 편집기(뷰)만 새로 만들고 같은 모델에 붙는다.
// 모델을 버리는 때: 사용자가 탭을 닫음(확인 뒤) · 「저장 안 함」 · 수정 없는 문서의 탭이 배치에서 사라짐. **수정된 문서는 조용히 버리지 않는다.**
//
// 이 파일은 Monaco 를 **런타임에 싣지 않는다**(형만 가져온다) — 앱 셸이 수정 여부를 보려고 편집기 코드를 처음부터 싣지 않게(590 E8ⓒ 지연 로딩 유지).
// 모델은 `FileView` 가 Monaco 를 동적 import 한 뒤 만들어 넘긴다.
//
// 수정 여부(E1ⓒ) = Monaco `getAlternativeVersionId()` 가 저장(또는 읽기) 때 값과 다른가 — VS Code 와 같은 방식. 실행 취소로 저장된 상태에 돌아오면 같은 값이 된다.
// 줄끝(E1ⓕ) — Monaco 모델은 줄끝을 하나(모델 EOL)로 정규화한다. 섞인 줄끝 파일을 한 글자 고쳐 저장해도 다른 줄의 줄끝이 바뀌지 않게, **줄마다 끝 글자**(`eols`)를
// 따로 들고 편집 이벤트로 맞춰 간다(새로 생긴 줄바꿈 = 모델 EOL). 저장은 `줄 + 그 줄의 끝 글자` 를 잇는다. 실행 취소로 저장 상태에 돌아오면 저장 때 줄끝으로 되돌린다.
// 숨은 BOM(수정 r1 R1-G) — main 은 파일 BOM(EF BB BF)을 떼어 `bom` 으로 준다. 그 뒤 글이 또 U+FEFF 로 시작하면 Monaco 가 그것을 모델 BOM 으로 떼어
// 줄에 넣지 않는다(`getValue()`·`getLinesContent()` 에 없음). 그 글자를 잃지 않게 문서가 `hiddenBom` 으로 들고 직렬화 앞에 다시 붙인다.
// 기준 내용(수정 r1 R1-B·C) — 문서는 디스크 stamp 와 **내용 지문**(`hash`, 바이트 sha256)을 같이 든다. 저장 시점 충돌 검사는 둘 다 본다.
type Disposable = { dispose: () => void }
type Range4 = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

/**
 * 문서가 쓰는 모델 기능만 — Monaco `ITextModel` 이 그대로 들어맞는다(편집기에 붙이는 진짜 모델은 `FileView` 가 URI 로 다시 찾는다). 시험은 이 모양의 가짜를 쓴다.
 */
export type DocModel = {
  onDidChangeContent: (listener: (event: { changes: readonly { range: Range4; text: string }[] }) => void) => Disposable
  getAlternativeVersionId: () => number
  getLinesContent: () => string[]
  getValue: () => string
  /** Monaco `getValueLength(eol, preserveBOM)` — `preserveBOM` 이면 모델 BOM 길이를 더한다(숨은 BOM 판정, R1-G). */
  getValueLength: (eol?: number, preserveBOM?: boolean) => number
  getEOL: () => string
  getLineCount: () => number
  setValue: (text: string) => void
  getFullModelRange: () => Range4
  pushStackElement: () => void
  pushEditOperations: (before: null, operations: { range: Range4; text: string }[], cursor: () => null) => unknown
  dispose: () => void
}
type Model = DocModel

/** 읽기 전용으로 여는 까닭(E1ⓕⓖ·E6ⓑ⑪) — null 이면 편집 가능. */
export type ReadOnlyReason = 'encoding' | 'hardlink' | 'large'

/** 수정 중 외부 변경(E4ⓑ) — `changed` = 배너를 띄운다 · `kept` = 「내 변경 유지」 를 골랐다(같은 디스크 상태로는 다시 묻지 않는다). */
export type ExternalState = { kind: 'none' } | { kind: 'changed'; diskStamp: string | null; deleted: boolean } | { kind: 'kept'; diskStamp: string | null }

export type FileDoc = {
  readonly key: string
  readonly root: string
  readonly rel: string
  readonly model: Model
  /** 읽기 전용 까닭 — 다시 읽을 때(수정 없는 문서 갱신·되돌리기) 디스크 메타데이터로 다시 잰다(수정 r1 R1-F). */
  readOnly: ReadOnlyReason | null
  /** 디스크가 20 MB 를 넘는다(대용량 편집기 옵션 — 읽기 전용 까닭이 비 UTF-8 등 다른 것이어도). 다시 읽을 때 같이 잰다. */
  large: boolean
  bom: boolean
  /** 모델이 글 맨 앞 U+FEFF 를 모델 BOM 으로 들고 있다 — 직렬화 앞에 붙인다(R1-G). */
  hiddenBom: boolean
  /**
   * 모델 버전(`getAlternativeVersionId`)마다 그때의 머리 바이트 상태(`bom`·`hiddenBom`) — 모델 밖 값이라 실행 취소·다시 실행이 되돌리지 않는다.
   * 편집 이벤트마다 처음 보는 버전이면 지금 값을 적고, 아는 버전(실행 취소·다시 실행으로 돌아옴)이면 그 값으로 되돌린다(수정 r2 R2-B —
   * 되돌리기 → 실행 취소 → 저장에서 본문 U+FEFF·파일 BOM 이 빠졌다). 다시 읽기(`setValue` — 실행 취소 기록이 새로 시작)면 비운다.
   */
  headByVersion: Map<number, { bom: boolean; hiddenBom: boolean }>
  /** 줄마다 끝 글자(`\n`·`\r\n`·`\r`, 마지막 줄 ''). 길이 = 모델 줄 수. */
  eols: string[]
  /** 저장(또는 읽기) 때의 `eols` — 실행 취소로 저장 상태에 돌아오면 되살린다. */
  savedEols: string[]
  /** 이 내용이 기대는 디스크 stamp(마지막으로 읽거나 저장한 것) — 저장 시점 충돌 검사의 기준(E4ⓒ). */
  stamp: string
  /** `stamp` 와 같은 때의 디스크 바이트 sha256(R1-C) — 같은 크기·같은 mtime 의 다른 내용을 가른다. */
  hash: string
  savedVersion: number
  dirty: boolean
  external: ExternalState
  /** 저장 진행 중(연속 ⌘S 는 줄을 선다 — E2ⓖ). 그동안 온 감시 push·읽기 결과는 자기 저장의 중간 상태일 수 있어 보류한다(E2ⓒ). */
  saving: boolean
  /**
   * 저장 세대 — 저장이 시작하고 끝날 때마다 오른다. 읽기 결과는 요청할 때의 세대를 들고 오고, 세대가 다르면(저장 전·중에 찍은 읽기) 그 결과로 판단하지 않고 다시 읽는다.
   * (수정 r1 R1-B — 옛 `ignoredStamps` 는 저장 중 본 stamp 를 **영영** 무시해, 저장과 겹친 외부 변경까지 놓쳤다.)
   */
  saveGen: number
  queue: Promise<unknown>
  /** 편집기 IME 조합 중인가(E5ⓑ — 저장은 조합이 끝난 뒤). */
  composing: boolean
  compositionWaiters: (() => void)[]
  listeners: Disposable[]
}

// --- 줄끝 (순수 함수 — 시험 대상) ---------------------------------------------------------

const LINE_BREAK = /\r\n|\r|\n/g

/** 글의 줄마다 끝 글자 — Monaco 와 같은 줄 나눔(`\r\n`·`\r`·`\n` 모두 줄바꿈). 길이 = 줄 수(마지막 줄은 ''). */
export function eolsOf(text: string): string[] {
  const eols: string[] = []
  for (const match of text.matchAll(LINE_BREAK)) eols.push(match[0])
  eols.push('')
  return eols
}

/**
 * 편집 한 번을 `eols` 에 반영 — 범위(1 기반 줄) `startLine..endLine` 을 `text` 로 바꾸면 그 사이 줄바꿈(endLine − startLine 개)이 사라지고,
 * `text` 안 줄바꿈 수만큼 모델 EOL 이 들어온다. 합쳐진 마지막 줄은 원래 `endLine` 의 끝 글자를 그대로 가진다.
 */
export function applyEolChange(input: { eols: string[]; startLine: number; endLine: number; text: string; modelEol: string }): string[] {
  const inserted = (input.text.match(LINE_BREAK) ?? []).map(() => input.modelEol)
  const next = input.eols.slice()
  next.splice(input.startLine - 1, input.endLine - input.startLine, ...inserted)
  return next
}

/** 줄 + 끝 글자를 잇는다. 줄 수가 어긋나면(있어선 안 된다) null — 부른 쪽이 모델 값으로 떨어진다. */
export function joinLines(lines: readonly string[], eols: readonly string[]): string | null {
  if (lines.length !== eols.length) return null
  let out = ''
  for (let index = 0; index < lines.length; index += 1) out += lines[index] + (eols[index] ?? '')
  return out
}

// --- 저장소 ------------------------------------------------------------------------------

const docs = new Map<string, FileDoc>()
const subscribers = new Set<() => void>()
let version = 0

export const docKey = (root: string, rel: string): string => `${root}\0${rel}`

function notify(): void {
  version += 1
  for (const listener of subscribers) listener()
}

/** `useSyncExternalStore` 용 — 문서가 생기고 없어지고 수정 여부·외부 상태·저장 중이 바뀔 때 오른다. */
export function subscribeDocs(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}
export const docsVersion = (): number => version

export const getDoc = (key: string): FileDoc | undefined => docs.get(key)
export const allDocs = (): FileDoc[] => [...docs.values()]
export const dirtyDocs = (): FileDoc[] => allDocs().filter((doc) => doc.dirty)

/** 저장할 글 — (숨은 BOM) + 모델 줄 + 줄마다 끝 글자. */
export function serialize(doc: FileDoc): string {
  return (doc.hiddenBom ? '\uFEFF' : '') + (joinLines(doc.model.getLinesContent(), doc.eols) ?? doc.model.getValue())
}

/** 모델이 모델 BOM 을 들고 있나(Monaco 가 글 맨 앞 U+FEFF 를 뗐나) — 길이 두 번 재기라 글을 복사하지 않는다. */
const hasModelBom = (model: Model): boolean => model.getValueLength(undefined, true) > model.getValueLength(undefined, false)

function refreshDirty(doc: FileDoc): void {
  const current = doc.model.getAlternativeVersionId()
  // 실행 취소로 저장 상태에 돌아왔다 — 그 사이 줄끝 추적이 모델 EOL 로 바꿔 둔 줄을 저장 때 줄끝으로 되돌린다(내용이 저장 때와 같으므로 줄 수도 같다).
  if (current === doc.savedVersion && doc.eols.length === doc.savedEols.length) doc.eols = doc.savedEols.slice()
  const dirty = current !== doc.savedVersion
  if (dirty === doc.dirty) return
  doc.dirty = dirty
  notify()
}

/** 모델을 맡긴다 — 같은 키가 있으면 그것을 돌려준다(새 모델은 버린다). */
export function adoptDoc(input: { root: string; rel: string; model: Model; text: string; bom: boolean; stamp: string; hash: string; readOnly: ReadOnlyReason | null; large: boolean }): FileDoc {
  const key = docKey(input.root, input.rel)
  const existing = docs.get(key)
  if (existing !== undefined) {
    if (existing.model !== input.model) input.model.dispose()
    return existing
  }
  const hiddenBom = hasModelBom(input.model)
  // 줄끝은 모델 줄과 같은 글로 잰다(숨은 BOM 은 줄이 아니다).
  const eols = eolsOf(hiddenBom ? input.text.slice(1) : input.text)
  const doc: FileDoc = {
    key,
    root: input.root,
    rel: input.rel,
    model: input.model,
    readOnly: input.readOnly,
    large: input.large,
    bom: input.bom,
    hiddenBom,
    headByVersion: new Map([[input.model.getAlternativeVersionId(), { bom: input.bom, hiddenBom }]]),
    eols,
    savedEols: eols.slice(),
    stamp: input.stamp,
    hash: input.hash,
    savedVersion: input.model.getAlternativeVersionId(),
    dirty: false,
    external: { kind: 'none' },
    saving: false,
    saveGen: 0,
    queue: Promise.resolve(),
    composing: false,
    compositionWaiters: [],
    listeners: [],
  }
  doc.listeners.push(
    input.model.onDidChangeContent((event) => {
      // 범위는 편집 전 좌표 — 뒤에서부터 반영해야 앞 편집이 뒤 편집의 줄 번호를 밀지 않는다(Monaco 는 한 이벤트의 changes 를 뒤에서부터 준다).
      const modelEol = doc.model.getEOL()
      const changes = [...event.changes].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn)
      for (const change of changes) doc.eols = applyEolChange({ eols: doc.eols, startLine: change.range.startLineNumber, endLine: change.range.endLineNumber, text: change.text, modelEol })
      if (doc.eols.length !== doc.model.getLineCount()) doc.eols = eolsOf(doc.model.getValue())
      const version = doc.model.getAlternativeVersionId()
      const head = doc.headByVersion.get(version)
      if (head === undefined) doc.headByVersion.set(version, { bom: doc.bom, hiddenBom: doc.hiddenBom })
      else {
        doc.bom = head.bom
        doc.hiddenBom = head.hiddenBom
      }
      refreshDirty(doc)
    }),
  )
  docs.set(key, doc)
  notify()
  return doc
}

/** 디스크에서 다시 읽은 것 — 내용·BOM·기준(stamp·지문)·읽기 전용 까닭. */
export type DiskState = { text: string; bom: boolean; stamp: string; hash: string; readOnly: ReadOnlyReason | null; large: boolean }

/**
 * 디스크 내용으로 바꾼다(수정 없는 문서의 외부 변경 반영 — F2 와 같이 같은 모델에 `setValue`). 실행 취소 기록은 새로 시작한다.
 * 읽기 전용 까닭도 새 디스크 상태로 바꾼다(R1-F — 열린 뒤 20 MB 를 넘거나 비 UTF-8·하드링크가 되면 읽기 전용, 다시 작아지면 편집 가능).
 */
export function reloadDoc(doc: FileDoc, input: DiskState): void {
  // 이벤트(편집 리스너)가 옛 머리 값으로 새 버전을 적지 않게, 값을 먼저 바꾸고 넣는다. 실행 취소 기록이 새로 시작하니 버전 기록도 비운다.
  doc.bom = input.bom
  doc.headByVersion.clear()
  doc.model.setValue(input.text)
  doc.hiddenBom = hasModelBom(doc.model)
  doc.headByVersion.set(doc.model.getAlternativeVersionId(), { bom: doc.bom, hiddenBom: doc.hiddenBom })
  doc.stamp = input.stamp
  doc.hash = input.hash
  doc.readOnly = input.readOnly
  doc.large = input.large
  doc.eols = eolsOf(doc.hiddenBom ? input.text.slice(1) : input.text)
  doc.savedEols = doc.eols.slice()
  doc.savedVersion = doc.model.getAlternativeVersionId()
  doc.external = { kind: 'none' }
  doc.dirty = false
  notify()
}

/**
 * 「디스크 내용으로 되돌리기」(E4ⓑ) — **실행 취소할 수 있게** 편집으로 넣는다(⌘Z 가 내 변경을 되살린다). 그 상태를 저장된 상태로 친다.
 * 줄끝은 디스크 글의 것으로 다시 잰다(`setValue` 와 달리 모델 EOL 은 그대로라 직렬화는 `eols` 가 맞춘다).
 * 숨은 BOM(R1-G) — 편집으로는 모델 BOM 을 바꿀 수 없다. 모델이 BOM 을 들고 있고 디스크 글도 U+FEFF 로 시작하면 그 글자를 빼고 넣고(모델 BOM 이 맡는다),
 * 디스크 글이 U+FEFF 로 시작하지 않으면 직렬화에서 모델 BOM 을 빼게 표시한다. 그 뒤 실행 취소로 옛 내용에 돌아가면 그 버전의 머리 값(`headByVersion`)이
 * 돌아온다(수정 r2 R2-B) — 그래서 머리 값을 **편집 전에** 바꿔, 되돌린 새 버전이 새 값으로 적히게 한다.
 */
export function revertDoc(doc: FileDoc, input: DiskState): void {
  const modelBom = hasModelBom(doc.model)
  const leading = input.text.startsWith('\uFEFF')
  const text = modelBom && leading ? input.text.slice(1) : input.text
  doc.bom = input.bom
  doc.hiddenBom = modelBom && leading
  doc.model.pushStackElement()
  doc.model.pushEditOperations(null, [{ range: doc.model.getFullModelRange(), text }], () => null)
  doc.model.pushStackElement()
  doc.headByVersion.set(doc.model.getAlternativeVersionId(), { bom: doc.bom, hiddenBom: doc.hiddenBom })
  doc.stamp = input.stamp
  doc.hash = input.hash
  doc.readOnly = input.readOnly
  doc.large = input.large
  doc.eols = eolsOf(text)
  if (doc.eols.length !== doc.model.getLineCount()) doc.eols = eolsOf(doc.model.getValue())
  doc.savedEols = doc.eols.slice()
  doc.savedVersion = doc.model.getAlternativeVersionId()
  doc.external = { kind: 'none' }
  doc.dirty = false
  notify()
}

/** 저장이 끝났다 — 저장을 시작할 때의 버전·줄끝이 이제 디스크와 같다. 그 뒤에 친 글자가 있으면 여전히 수정됨. */
export function markSaved(doc: FileDoc, input: { stamp: string; hash: string; version: number; eols: string[] }): void {
  doc.stamp = input.stamp
  doc.hash = input.hash
  doc.savedVersion = input.version
  doc.savedEols = input.eols
  doc.external = { kind: 'none' }
  doc.dirty = doc.model.getAlternativeVersionId() !== input.version
  notify()
}

export function setExternal(doc: FileDoc, external: ExternalState): void {
  doc.external = external
  notify()
}

export function setSaving(doc: FileDoc, saving: boolean): void {
  doc.saveGen += 1
  doc.saving = saving
  notify()
}

/** 편집기가 조합 시작/끝을 알린다. 끝나면 기다리던 저장을 깨운다. */
export function setComposing(doc: FileDoc, composing: boolean): void {
  doc.composing = composing
  if (composing) return
  const waiters = doc.compositionWaiters
  doc.compositionWaiters = []
  for (const wake of waiters) wake()
}

/**
 * 조합 중이면 끝날 때까지(최대 `timeoutMs`) 기다린다 — 저장이 조합 중인 글자를 반쯤 담지 않게(E5ⓑ). 끝났으면 true, **시간 초과면 false** —
 * 시간 초과를 저장 허가로 쓰지 않는다(수정 r1 R1-H: 1 s 뒤 미확정 자모가 저장됐다). 부른 쪽이 저장을 보류하고 안내한다.
 */
export function untilComposed(doc: FileDoc, timeoutMs = 1000): Promise<boolean> {
  if (!doc.composing) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!doc.composing), timeoutMs)
    doc.compositionWaiters.push(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** 모델을 버린다(닫기 확인 뒤·「저장 안 함」·수정 없는 문서의 탭이 사라짐). */
export function disposeDoc(key: string): void {
  const doc = docs.get(key)
  if (doc === undefined) return
  docs.delete(key)
  for (const listener of doc.listeners) listener.dispose()
  doc.model.dispose()
  notify()
}
