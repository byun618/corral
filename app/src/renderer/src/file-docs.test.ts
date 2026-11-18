// LIFE-591 E1ⓒⓔⓕ·E2ⓑⓖ·E3ⓑ·E4ⓒⓓ — 문서 저장소·저장 흐름(단위). Monaco 대신 같은 모양의 가짜 모델(줄 배열 + 실행 취소 스택)을 쓴다.
// 줄끝: 섞인 줄끝·BOM·끝 개행 없음 파일을 한 글자 고쳐 직렬화하면 그 한 글자만 다르다. 수정 여부: 버전 id(실행 취소로 저장 상태면 해제).
import { beforeEach, describe, expect, it } from 'vitest'
import { adoptDoc, allDocs, applyEolChange, disposeDoc, eolsOf, getDoc, holdDocs, joinLines, markSaved, readMatchesDoc, rebaseDoc, rekeyDocs, reloadDoc, revertDoc, serialize, setComposing, type DocModel } from './file-docs.js'
import { confirmDiscardOrSave, dirtyFilesOf, saveDoc, saveFailureMessage, type SaveDeps } from './file-save.js'
import type { FileDialogChoice, FileDialogRequest, FileWriteInput, FileWriteResult } from '../../shared/file-view.js'

type Range4 = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

/** Monaco 처럼 줄을 모델 EOL 로 정규화해 들고, 편집마다 버전을 올리고, 실행 취소로 앞 버전에 돌아가는 가짜. */
class FakeModel implements DocModel {
  lines: string[]
  eol: string
  /** Monaco 처럼 글 맨 앞 U+FEFF 하나를 모델 BOM 으로 떼어 들고 줄에는 넣지 않는다(`getValue(eol, preserveBOM)`). */
  bomText = ''
  private listeners = new Set<(event: { changes: readonly { range: Range4; text: string }[] }) => void>()
  private nextVersion = 1
  private version = 1
  private undo: { lines: string[]; version: number }[] = []
  private redo: { lines: string[]; version: number }[] = []
  disposed = false
  constructor(raw: string) {
    const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
    this.bomText = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
    this.lines = text.split(/\r\n|\r|\n/)
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/\n/g) ?? []).length - crlf
    this.eol = crlf > lf ? '\r\n' : '\n'
  }
  onDidChangeContent(listener: (event: { changes: readonly { range: Range4; text: string }[] }) => void) {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
  getAlternativeVersionId(): number {
    return this.version
  }
  getLinesContent(): string[] {
    return this.lines.slice()
  }
  getValue(): string {
    return this.lines.join(this.eol)
  }
  getValueLength(_eol?: number, preserveBOM?: boolean): number {
    return this.getValue().length + (preserveBOM === true ? this.bomText.length : 0)
  }
  getEOL(): string {
    return this.eol
  }
  getLineCount(): number {
    return this.lines.length
  }
  getFullModelRange(): Range4 {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: this.lines.length, endColumn: (this.lines.at(-1) ?? '').length + 1 }
  }
  setValue(raw: string): void {
    this.bomText = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
    this.replace(this.getFullModelRange(), raw.startsWith('\uFEFF') ? raw.slice(1) : raw, false)
    this.undo = []
  }
  pushStackElement(): void {}
  pushEditOperations(_before: null, operations: { range: Range4; text: string }[]): unknown {
    for (const operation of operations) this.replace(operation.range, operation.text, true)
    return null
  }
  dispose(): void {
    this.disposed = true
  }
  /** 한 범위 편집 — Monaco 처럼 이벤트는 편집 전 좌표. */
  replace(range: Range4, text: string, undoable = true): void {
    if (undoable) {
      this.undo.push({ lines: this.lines.slice(), version: this.version })
      this.redo = []
    }
    const head = (this.lines[range.startLineNumber - 1] ?? '').slice(0, range.startColumn - 1)
    const tail = (this.lines[range.endLineNumber - 1] ?? '').slice(range.endColumn - 1)
    const inserted = (head + text + tail).split(/\r\n|\r|\n/)
    this.lines.splice(range.startLineNumber - 1, range.endLineNumber - range.startLineNumber + 1, ...inserted)
    this.nextVersion += 1
    this.version = this.nextVersion
    for (const listener of this.listeners) listener({ changes: [{ range, text }] })
  }
  /** 다시 실행 — Monaco 처럼 실행 취소한 버전 id 로 돌아간다. 새 편집은 다시 실행 기록을 버린다. */
  redoLast(): void {
    const next = this.redo.pop()
    if (next === undefined) return
    this.undo.push({ lines: this.lines.slice(), version: this.version })
    const range = this.getFullModelRange()
    this.lines = next.lines
    this.version = next.version
    for (const listener of this.listeners) listener({ changes: [{ range, text: next.lines.join(this.eol) }] })
  }
  type(line: number, column: number, text: string): void {
    this.replace({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text)
  }
  undoLast(): void {
    const last = this.undo.pop()
    if (last === undefined) return
    this.redo.push({ lines: this.lines.slice(), version: this.version })
    const range = this.getFullModelRange()
    this.lines = last.lines
    this.version = last.version
    for (const listener of this.listeners) listener({ changes: [{ range, text: last.lines.join(this.eol) }] })
  }
}

/** 조건이 참이 될 때까지 짧게 기다린다(저장이 내용을 찍는 시점은 큐·조합 대기 뒤 몇 틱이다). */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

let seq = 0
const open = (text: string, input: { bom?: boolean; stamp?: string; hash?: string } = {}) => {
  seq += 1
  const model = new FakeModel(text)
  const doc = adoptDoc({ root: '/wt', rel: `f${seq}.txt`, model, text, bom: input.bom ?? false, stamp: input.stamp ?? 's0', hash: input.hash ?? 'h0', readOnly: null, large: false })
  return { doc, model }
}

beforeEach(() => {
  for (const doc of allDocs()) disposeDoc(doc.key)
})

describe('줄끝 추적 (순수)', () => {
  it('eolsOf — \\r\\n·\\r·\\n 모두 줄바꿈, 마지막 줄은 빈 끝', () => {
    expect(eolsOf('a\r\nb\nc\rd')).toEqual(['\r\n', '\n', '\r', ''])
    expect(eolsOf('')).toEqual([''])
    expect(eolsOf('a\n')).toEqual(['\n', ''])
  })
  it('applyEolChange — 줄 안 편집은 그대로 · 줄바꿈 삽입 = 모델 EOL · 줄 합치기 = 뒤 줄 끝을 남김', () => {
    const eols = ['\n', '\r\n', '']
    expect(applyEolChange({ eols, startLine: 2, endLine: 2, text: 'x', modelEol: '\r\n' })).toEqual(eols)
    expect(applyEolChange({ eols, startLine: 1, endLine: 1, text: '\n', modelEol: '\r\n' })).toEqual(['\r\n', '\n', '\r\n', ''])
    expect(applyEolChange({ eols, startLine: 1, endLine: 2, text: '', modelEol: '\r\n' })).toEqual(['\r\n', ''])
  })
  it('joinLines — 줄 수가 어긋나면 null', () => {
    expect(joinLines(['a', 'b'], ['\r\n', ''])).toBe('a\r\nb')
    expect(joinLines(['a'], ['\n', ''])).toBeNull()
  })
})

describe('E1ⓕ 한 글자 고치고 직렬화 — 그 한 글자만 다르다', () => {
  const cases: [string, string][] = [
    ['CRLF', 'one\r\ntwo\r\nthree\r\n'],
    ['끝 개행 없음', 'one\ntwo\nthree'],
    ['혼합 줄끝', 'one\r\ntwo\nthree\rfour\r\n'],
    ['빈 파일', ''],
  ]
  for (const [name, text] of cases) {
    it(name, () => {
      const { doc, model } = open(text)
      model.type(1, 1, 'X')
      expect(serialize(doc)).toBe(`X${text}`)
    })
  }
  it('혼합 줄끝 — 새 줄바꿈은 모델 EOL, 다른 줄의 끝은 그대로(처리 방식 기록)', () => {
    const { doc, model } = open('a\r\nb\nc\r\n')
    model.type(2, 2, '\n')
    expect(serialize(doc)).toBe('a\r\nb\r\n\nc\r\n')
  })
  it('BOM 은 문서가 따로 들고(main 이 붙인다) 글에는 없다', () => {
    const { doc } = open('x', { bom: true })
    expect(doc.bom).toBe(true)
    expect(serialize(doc)).toBe('x')
  })
})

describe('E1ⓒ 수정 여부 = 버전 id', () => {
  it('편집하면 수정됨, 실행 취소로 저장 상태면 해제', () => {
    const { doc, model } = open('abc\n')
    expect(doc.dirty).toBe(false)
    model.type(1, 1, 'x')
    expect(doc.dirty).toBe(true)
    model.undoLast()
    expect(doc.dirty).toBe(false)
  })
  it('혼합 줄끝에서 줄바꿈을 지웠다 실행 취소하면 저장 때 줄끝으로 돌아온다', () => {
    const { doc, model } = open('a\nb\r\nc\r\n')
    model.replace({ startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 1 }, '')
    expect(doc.dirty).toBe(true)
    model.undoLast()
    expect(doc.dirty).toBe(false)
    expect(serialize(doc)).toBe('a\nb\r\nc\r\n')
  })
})

/** 가짜 IPC — 디스크 하나(stamp·글)와 대화상자 답 목록. */
function fakeDeps(input: { disk: { stamp: string; text: string | null }; answers?: FileDialogChoice[]; fail?: Extract<FileWriteResult, { ok: false }> }) {
  const writes: FileWriteInput[] = []
  const dialogs: FileDialogRequest[] = []
  const notes: string[] = []
  let n = 0
  const deps: SaveDeps = {
    writeFile: async (request) => {
      writes.push(request)
      if (input.fail !== undefined) return input.fail
      if (input.disk.text === null && !request.create) return { ok: false, code: 'not_found', error: '' }
      if (input.disk.text !== null && request.create) return { ok: false, code: 'exists', error: '' }
      if (!request.create && !request.overwrite && request.baseStamp !== input.disk.stamp) return { ok: false, code: 'conflict', error: '', diskStamp: input.disk.stamp }
      n += 1
      input.disk.stamp = `w${n}`
      input.disk.text = request.text
      return { ok: true, stamp: input.disk.stamp, hash: `hw${n}`, size: request.text.length }
    },
    fileDialog: async (request) => {
      dialogs.push(request)
      return input.answers?.shift() ?? 'cancel'
    },
    notify: (message) => notes.push(message),
  }
  return { deps, writes, dialogs, notes, disk: () => input.disk }
}

describe('E2 저장', () => {
  it('ⓐⓑ 저장하면 디스크 = 직렬화, 수정 해제, 실행 취소 기록 유지(저장 뒤 실행 취소 = 수정됨)', async () => {
    const { doc, model } = open('abc\r\n', { stamp: 's0' })
    model.type(1, 4, 'd')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'abc\r\n' } })
    expect(await saveDoc(doc, fake.deps)).toBe('saved')
    expect(fake.disk().text).toBe('abcd\r\n')
    expect(doc.dirty).toBe(false)
    expect(doc.stamp).toBe('w1')
    model.undoLast()
    expect(doc.dirty).toBe(true)
    expect(serialize(doc)).toBe('abc\r\n')
  })
  it('수정 없으면 쓰지 않는다', async () => {
    const { doc } = open('abc')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'abc' } })
    expect(await saveDoc(doc, fake.deps)).toBe('saved')
    expect(fake.writes).toHaveLength(0)
  })
  it('ⓖ 저장 중 편집·연속 ⌘S — 줄을 서고 마지막 내용이 디스크에, 수정 표시가 실제와 같다', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    model.type(1, 2, 'b')
    const first = saveDoc(doc, fake.deps)
    await until(() => fake.writes.length === 1)
    model.type(1, 3, 'c')
    const second = saveDoc(doc, fake.deps)
    expect(await first).toBe('saved')
    expect(await second).toBe('saved')
    expect(fake.disk().text).toBe('abc')
    expect(fake.writes.map((write) => write.baseStamp)).toEqual(['s0', 'w1'])
    expect(doc.dirty).toBe(false)
  })
  it('ⓖ 첫 저장 뒤 친 글자는 수정으로 남는다', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    const write = fake.deps.writeFile
    fake.deps.writeFile = async (request) => {
      await gate
      return write(request)
    }
    model.type(1, 2, 'b')
    const pending = saveDoc(doc, fake.deps)
    // 쓰기 요청이 나간 뒤(= 내용을 찍은 뒤) 친다 — fakeDeps 의 writes 는 gate 앞에서 쌓이지 않으므로 직접 기다린다.
    await new Promise((resolve) => setTimeout(resolve, 5))
    model.type(1, 3, 'c')
    release()
    expect(await pending).toBe('saved')
    expect(fake.disk().text).toBe('ab')
    expect(doc.dirty).toBe(true)
  })
  it('ⓔ 실패 — 알림, 수정·내용 유지', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    model.type(1, 2, 'b')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, fail: { ok: false, code: 'permission_denied', error: 'EACCES' } })
    expect(await saveDoc(doc, fake.deps)).toBe('failed')
    expect(fake.notes[0]).toContain('쓰기 권한이 없습니다')
    expect(doc.dirty).toBe(true)
    expect(serialize(doc)).toBe('ab')
  })
  it('실패 문구 — 쓰는 도중 실패는 쓴 바이트를 알린다', () => {
    expect(saveFailureMessage({ rel: 'a/b.txt', result: { ok: false, code: 'write_failed', error: '', bytesWritten: 5 } })).toContain('5 바이트')
  })
  it('E5ⓑ 조합 중이면 끝날 때까지 기다렸다 쓴다', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    setComposing(doc, true)
    model.type(1, 2, 'ㅎ')
    const pending = saveDoc(doc, fake.deps)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.writes).toHaveLength(0)
    model.replace({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 3 }, '한')
    setComposing(doc, false)
    expect(await pending).toBe('saved')
    expect(fake.disk().text).toBe('a한')
  })
})

describe('E4 충돌·삭제', () => {
  it('ⓒ 디스크가 바뀌었으면 묻는다 — 취소면 쓰지 않고 수정 유지', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    model.type(1, 2, 'b')
    const fake = fakeDeps({ disk: { stamp: 'other', text: 'z' }, answers: ['cancel'] })
    expect(await saveDoc(doc, fake.deps)).toBe('cancelled')
    expect(fake.dialogs).toEqual([{ kind: 'conflict', file: doc.rel }])
    expect(fake.disk().text).toBe('z')
    expect(doc.dirty).toBe(true)
  })
  it('ⓒ 덮어쓰기면 overwrite 로 다시 쓴다', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    model.type(1, 2, 'b')
    const fake = fakeDeps({ disk: { stamp: 'other', text: 'z' }, answers: ['overwrite'] })
    expect(await saveDoc(doc, fake.deps)).toBe('saved')
    expect(fake.writes.map((write) => write.overwrite)).toEqual([false, true])
    expect(fake.disk().text).toBe('ab')
  })
  it('ⓓ 지워졌으면 다시 만들지 묻는다 — 다시 만들기면 create', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    model.type(1, 2, 'b')
    const fake = fakeDeps({ disk: { stamp: 's0', text: null }, answers: ['recreate'] })
    expect(await saveDoc(doc, fake.deps)).toBe('saved')
    expect(fake.dialogs[0]).toEqual({ kind: 'recreate', file: doc.rel })
    expect(fake.writes.at(-1)?.create).toBe(true)
  })
  it('ⓑ 되돌리기는 실행 취소할 수 있는 편집 — 되돌린 뒤 수정 해제, 실행 취소하면 내 변경', () => {
    const { doc, model } = open('mine\n', { stamp: 's0' })
    model.type(1, 5, '!')
    revertDoc(doc, { text: 'disk\r\n', bom: false, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    expect(doc.dirty).toBe(false)
    expect(doc.stamp).toBe('s1')
    expect(serialize(doc)).toBe('disk\r\n')
    model.undoLast()
    expect(doc.dirty).toBe(true)
    expect(model.getValue()).toBe('mine!\n')
  })
})

describe('E3ⓑ 닫기 확인', () => {
  it('수정 없으면 묻지 않고 닫는다', async () => {
    const { doc } = open('a')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: fake.deps })).toBe(true)
    expect(fake.dialogs).toHaveLength(0)
  })
  it('저장 안 함 → 문서를 버린다(디스크 무변경)', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['discard'] })
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: fake.deps })).toBe(true)
    expect(getDoc(doc.key)).toBeUndefined()
    expect(model.disposed).toBe(true)
    expect(fake.writes).toHaveLength(0)
  })
  it('취소 → 닫지 않는다 · 저장 실패 → 닫지 않는다', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['cancel'] }).deps })).toBe(false)
    const failing = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['save'], fail: { ok: false, code: 'not_file', error: '' } })
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: failing.deps })).toBe(false)
    expect(getDoc(doc.key)).toBe(doc)
  })
  it('LIFE-822 fix1 R1-1 deferDiscard — 「저장 안 함」 은 결정만: 문서·편집 내용이 남고(닫을 때 부른 쪽이 버린다) true · 다시 묻지 않는다', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['discard'] })
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: fake.deps, deferDiscard: true })).toBe(true)
    expect(getDoc(doc.key)).toBe(doc)
    expect(doc.dirty).toBe(true)
    expect(model.disposed).toBe(false)
    expect(fake.dialogs).toHaveLength(1)
    expect(fake.writes).toHaveLength(0)
  })
  it('LIFE-822 fix1 R1-1 deferDiscard 여도 「저장」 은 바로 저장한다', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['save'] })
    expect(await confirmDiscardOrSave({ targets: () => [doc], deps: fake.deps, deferDiscard: true })).toBe(true)
    expect(fake.writes).toHaveLength(1)
    expect(doc.dirty).toBe(false)
  })
  it('여러 개면 목록 한 번', async () => {
    const a = open('a')
    const b = open('b')
    a.model.type(1, 1, 'x')
    b.model.type(1, 1, 'y')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['cancel'] })
    await confirmDiscardOrSave({ targets: () => [a.doc, b.doc], deps: fake.deps })
    expect(fake.dialogs).toEqual([{ kind: 'close', files: [a.doc.rel, b.doc.rel] }])
    expect(dirtyFilesOf(allDocs())).toHaveLength(2)
  })
})

// --- 수정 r1 (Codex 리뷰 r1) 회귀 — 옛 코드(1a670faf6)에서 실패, 고친 코드에서 통과 -----------------------------------------
describe('수정 r1', () => {
  it('R1-A 닫기 「저장」 응답 전 추가 편집 — 닫는다면 그 편집까지 디스크에, 아니면 수정으로 남는다', async () => {
    const { doc, model } = open('base', { stamp: 's0' })
    model.type(1, 5, '-first')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'base' }, answers: ['save'] })
    const write = fake.deps.writeFile
    let held = true
    fake.deps.writeFile = async (request) => {
      if (held) {
        held = false
        arrived()
        await gate
      }
      return write(request)
    }
    const closing = confirmDiscardOrSave({ targets: () => [doc], deps: fake.deps })
    await started
    model.type(1, 11, '-LATE')
    release()
    const mayClose = await closing
    if (mayClose) {
      expect(fake.disk().text).toBe('base-first-LATE')
      expect(doc.dirty).toBe(false)
    } else {
      expect(doc.dirty).toBe(true)
      expect(getDoc(doc.key)).toBe(doc)
    }
  })
  it('R1-C 저장은 문서가 기대는 내용 지문(baseHash)을 같이 보내고, 저장 뒤 새 지문을 든다', async () => {
    const { doc, model } = open('a', { stamp: 's0', hash: 'h-read' })
    model.type(1, 2, 'b')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    expect(await saveDoc(doc, fake.deps)).toBe('saved')
    expect(fake.writes[0]?.baseHash).toBe('h-read')
    expect(doc.hash).toBe('hw1')
  })
  it('R1-G BOM + 선두 U+FEFF — 모델이 U+FEFF 를 모델 BOM 으로 떼어도 직렬화가 되살린다(한 글자 차이만)', () => {
    // main 이 첫 BOM(EF BB BF)을 떼고 bom: true — 글은 U+FEFF 로 시작한다. Monaco 는 그 U+FEFF 를 또 BOM 으로 뗀다.
    const { doc, model } = open('\uFEFFalpha\n', { bom: true })
    model.type(1, 1, 'X')
    expect(serialize(doc)).toBe('\uFEFFXalpha\n')
  })
  it('R1-F 수정 없는 문서를 다시 읽으면 읽기 전용 까닭도 새 디스크 상태로 — 커지면 large, 작아지면 편집 가능', () => {
    const { doc } = open('small\n')
    reloadDoc(doc, { text: 'big\n', bom: false, stamp: 's1', hash: 'h1', readOnly: 'large', large: true })
    expect(doc.readOnly).toBe('large')
    reloadDoc(doc, { text: 'small again\n', bom: false, stamp: 's2', hash: 'h2', readOnly: null, large: false })
    expect(doc.readOnly).toBeNull()
    expect(doc.hash).toBe('h2')
  })
  it('R1-G 되돌리기·다시 읽기도 숨은 BOM 을 지킨다', () => {
    const { doc, model } = open('\uFEFFalpha\n', { bom: true })
    model.type(1, 1, 'X')
    revertDoc(doc, { text: '\uFEFFdisk\n', bom: true, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    expect(serialize(doc)).toBe('\uFEFFdisk\n')
    reloadDoc(doc, { text: 'plain\n', bom: true, stamp: 's2', hash: 'h2', readOnly: null, large: false })
    expect(serialize(doc)).toBe('plain\n')
    reloadDoc(doc, { text: '\uFEFFagain\n', bom: true, stamp: 's3', hash: 'h3', readOnly: null, large: false })
    expect(serialize(doc)).toBe('\uFEFFagain\n')
  })
  it('R1-H 조합이 1 s 안에 안 끝나면 저장하지 않는다(미확정 자모를 쓰지 않음) — 안내만', async () => {
    const { doc, model } = open('a', { stamp: 's0' })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' } })
    setComposing(doc, true)
    model.type(1, 2, 'ㅎ')
    const outcome = await saveDoc(doc, fake.deps)
    expect(outcome).not.toBe('saved')
    expect(fake.writes).toHaveLength(0)
    expect(fake.notes.join('\n')).toContain('조합')
    expect(doc.dirty).toBe(true)
  })
})

// --- 수정 r2 (Codex 리뷰 r2) 회귀 — 옛 코드(8ae2c57d0)에서 실패, 고친 코드에서 통과 -----------------------------------------
describe('수정 r2', () => {
  it('R2-A 여러 파일 닫기 — 저장 대기 중 처음엔 깨끗했던 대상이 수정되면 버리지 않고 다시 묻는다', async () => {
    const a = open('base-a', { stamp: 's0' })
    const b = open('base-b', { stamp: 's0' })
    a.model.type(1, 1, 'FIRST-')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'base-a' }, answers: ['save', 'cancel'] })
    const write = fake.deps.writeFile
    let held = true
    fake.deps.writeFile = async (request) => {
      if (held) {
        held = false
        arrived()
        await gate
      }
      return write(request)
    }
    // 옛 코드의 인자(`docs`)와 새 인자(`targets`)를 같이 준다 — 옛 코드에서도 같은 상황을 만든다(리터럴이 아니라 남는 속성 검사가 없다).
    const request = { docs: [a.doc, b.doc], targets: () => [a.doc, b.doc], deps: fake.deps }
    const closing = confirmDiscardOrSave(request)
    await started
    b.model.type(1, 1, 'LATE-')
    release()
    const mayClose = await closing
    expect(mayClose).toBe(false)
    expect(fake.dialogs).toEqual([
      { kind: 'close', files: [a.doc.rel] },
      { kind: 'close', files: [b.doc.rel] },
    ])
    expect(getDoc(b.doc.key)).toBe(b.doc)
    expect(b.doc.dirty).toBe(true)
    expect(serialize(b.doc)).toBe('LATE-base-b')
  })
  it('R2-A 다시 물어 「저장」 이면 새로 수정된 대상도 저장한 뒤 닫는다', async () => {
    const a = open('a', { stamp: 's0' })
    const b = open('b', { stamp: 's0' })
    a.model.type(1, 1, 'x')
    // fakeDeps 의 디스크는 하나라 b 저장은 a 저장 뒤 stamp 가 달라 충돌로 온다 — 덮어쓰기로 답한다(시험 가짜의 한계).
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['save', 'save', 'overwrite'] })
    const dialog = fake.deps.fileDialog
    let first = true
    fake.deps.fileDialog = async (req) => {
      const answer = await dialog(req)
      if (first) {
        first = false
        b.model.type(1, 1, 'y')
      }
      return answer
    }
    const request = { docs: [a.doc, b.doc], targets: () => [a.doc, b.doc], deps: fake.deps }
    expect(await confirmDiscardOrSave(request)).toBe(true)
    expect(fake.dialogs.filter((row) => row.kind === 'close')).toEqual([
      { kind: 'close', files: [a.doc.rel] },
      { kind: 'close', files: [b.doc.rel] },
    ])
    expect(a.doc.dirty || b.doc.dirty).toBe(false)
  })
  it('R2-B 되돌리기 → 실행 취소 → 직렬화 — 숨은 BOM·파일 BOM 이 원래 편집 그대로', () => {
    const { doc, model } = open('\uFEFFalpha\n', { bom: true })
    model.type(1, 1, 'X')
    // 디스크가 본문 U+FEFF 없는 내용으로 바뀌었다(main 이 파일 BOM 을 떼고 준 글 'DISK\n').
    revertDoc(doc, { text: 'DISK\n', bom: true, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    expect(serialize(doc)).toBe('DISK\n')
    model.undoLast()
    expect(doc.dirty).toBe(true)
    expect(serialize(doc)).toBe('\uFEFFXalpha\n')
    expect(doc.bom).toBe(true)
  })
  it('R2-B 파일 BOM 없는 디스크로 되돌렸다 실행 취소하면 파일 BOM 도 돌아온다', () => {
    const { doc, model } = open('alpha\n', { bom: true })
    model.type(1, 1, 'X')
    revertDoc(doc, { text: 'disk\n', bom: false, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    expect(doc.bom).toBe(false)
    model.undoLast()
    expect(doc.bom).toBe(true)
    expect(serialize(doc)).toBe('Xalpha\n')
  })
})

// --- 수정 r3 (Codex 리뷰 r3) 회귀 — 옛 코드(9fcb0bf88)에서 실패, 고친 코드에서 통과 -----------------------------------------
describe('수정 r3', () => {
  it('R3-A 저장 한 건은 한 시점 스냅샷 — 쓰기 대기 중 다시 실행으로 머리 바이트가 바뀌어도 충돌 덮어쓰기 재시도가 같은 BOM 을 쓴다', async () => {
    const { doc, model } = open('alpha\n', { bom: true, stamp: 's0' })
    model.type(1, 1, 'X')
    revertDoc(doc, { text: 'DISK\n', bom: false, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    model.undoLast()
    expect(doc.bom).toBe(true)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      arrived = resolve
    })
    // 디스크는 그 사이 다른 내용(stamp other) — 첫 쓰기는 충돌, 덮어쓰기로 다시 쓴다.
    const fake = fakeDeps({ disk: { stamp: 'other', text: 'CONFLICT\n' }, answers: ['overwrite'] })
    const write = fake.deps.writeFile
    let held = true
    fake.deps.writeFile = async (request) => {
      if (held) {
        held = false
        arrived()
        await gate
      }
      return write(request)
    }
    const saving = saveDoc(doc, fake.deps)
    await started
    model.redoLast()
    expect(doc.bom).toBe(false)
    release()
    expect(await saving).toBe('saved')
    expect(fake.writes.map((row) => ({ text: row.text, bom: row.bom, overwrite: row.overwrite }))).toEqual([
      { text: 'Xalpha\n', bom: true, overwrite: false },
      { text: 'Xalpha\n', bom: true, overwrite: true },
    ])
    // 저장 완료 표시는 스냅샷 버전에만 — 지금(다시 실행한 되돌리기 버전)은 수정됨, 실행 취소하면 저장 상태.
    expect(doc.dirty).toBe(true)
    model.undoLast()
    expect(doc.dirty).toBe(false)
    expect(doc.bom).toBe(true)
  })
  it('R3-B 편집·실행 취소를 2,000 번 — 머리 기록이 편집 수에 비례해 쌓이지 않는다(버려진 다시 실행 분기 회수)', () => {
    const { doc, model } = open('alpha', { bom: true })
    for (let index = 0; index < 2000; index += 1) {
      model.type(1, 1, 'x')
      model.undoLast()
    }
    expect(model.getValue()).toBe('alpha')
    // 옛 코드(버전마다 Map) · 새 코드(바뀐 지점 배열) 어느 쪽이든 개수를 센다.
    const legacy = Reflect.get(doc, 'headByVersion')
    const count = legacy instanceof Map ? legacy.size : Reflect.get(doc, 'headPoints').length
    expect(count).toBeLessThanOrEqual(2)
  })
  it('R3-B 지점만 보관해도 유효한 실행 취소 상태는 그대로 — 되돌리기 앞뒤를 오가도 머리가 맞다', () => {
    const { doc, model } = open('\uFEFFalpha\n', { bom: true })
    for (let index = 0; index < 50; index += 1) model.type(1, 1, 'x')
    revertDoc(doc, { text: 'DISK\n', bom: false, stamp: 's1', hash: 'h1', readOnly: null, large: false })
    for (let index = 0; index < 50; index += 1) model.type(1, 1, 'y')
    for (let index = 0; index < 50; index += 1) model.undoLast()
    expect(serialize(doc)).toBe('DISK\n')
    expect(doc.bom).toBe(false)
    model.undoLast()
    expect(serialize(doc).startsWith('\uFEFFx')).toBe(true)
    expect(doc.bom).toBe(true)
    model.redoLast()
    expect(serialize(doc)).toBe('DISK\n')
    expect(doc.bom).toBe(false)
    expect(Reflect.get(doc, 'headPoints').length).toBeLessThanOrEqual(3)
  })
})

describe('LIFE-592 E4 경로 옮김', () => {
  it('rekeyDocs — 같은 문서 객체·모델(내용·수정·실행 취소 기록)이 새 키로, 다른 worktree·형제 접두사는 그대로', () => {
    const { doc, model } = open('abc\n')
    model.type(1, 1, 'X')
    const other = adoptDoc({ root: '/other', rel: doc.rel, model: new FakeModel('q'), text: 'q', bom: false, stamp: 's', hash: 'h', readOnly: null, large: false })
    const oldKey = doc.key
    const oldRel = doc.rel
    const moved = rekeyDocs({ root: '/wt', from: doc.rel, to: `moved/${doc.rel}` })
    expect(doc.rel).toBe(`moved/${oldRel}`)
    expect(moved).toEqual([{ from: oldKey, to: doc.key }])
    expect(getDoc(oldKey)).toBeUndefined()
    expect(getDoc(doc.key)).toBe(doc)
    expect(doc.model).toBe(model)
    expect(doc.dirty).toBe(true)
    model.undoLast()
    expect(doc.dirty).toBe(false)
    expect(getDoc(other.key)).toBe(other)
  })
  it('rekeyDocs — 폴더 밑 문서 전부, 이름이 접두사만 같은 형제는 아니다', () => {
    const a = adoptDoc({ root: '/wt', rel: 'src/a.ts', model: new FakeModel('a'), text: 'a', bom: false, stamp: 's', hash: 'h', readOnly: null, large: false })
    const b = adoptDoc({ root: '/wt', rel: 'src2/b.ts', model: new FakeModel('b'), text: 'b', bom: false, stamp: 's', hash: 'h', readOnly: null, large: false })
    rekeyDocs({ root: '/wt', from: 'src', to: 'lib' })
    expect(a.rel).toBe('lib/a.ts')
    expect(b.rel).toBe('src2/b.ts')
  })
  it('holdDocs — 옮기는 동안의 저장은 풀린 뒤 새 경로에 쓴다(옛 경로를 「다시 만들기」 로 되살리지 않는다)', async () => {
    const { doc, model } = open('abc\n', { stamp: 's0' })
    model.type(1, 1, 'X')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'abc\n' } })
    const release = holdDocs([doc])
    const saving = saveDoc(doc, fake.deps)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fake.writes).toHaveLength(0)
    rekeyDocs({ root: '/wt', from: doc.rel, to: 'renamed.txt' })
    release()
    expect(await saving).toBe('saved')
    expect(fake.writes.map((write) => write.rel)).toEqual(['renamed.txt'])
    expect(fake.dialogs).toEqual([])
  })
  it('rebaseDoc — 기대던 지문과 같으면 stamp 만 옮기고 외부 변경 표시를 지운다, 다르면 아무것도 안 한다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    expect(rebaseDoc(doc, { stamp: 's9', hash: 'other' })).toBe(false)
    expect(doc.stamp).toBe('s0')
    expect(rebaseDoc(doc, { stamp: 's9', hash: 'h0' })).toBe(true)
    expect(doc.stamp).toBe('s9')
    expect(doc.dirty).toBe(true)
  })
})

describe('LIFE-592 R7-C-01 — 같은 탭의 되살림을 여러 바퀴(낡은 읽기는 처음 연 stamp 그대로)', () => {
  it('되살림 6바퀴 연속 — 바퀴마다 처음 읽기·앞 바퀴 stamp 의 같은 지문 읽기는 같고, 다른 지문·새 stamp 는 다르다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    for (let round = 1; round <= 6; round += 1) {
      expect(rebaseDoc(doc, { stamp: `s${round}`, hash: 'h0' })).toBe(true)
      for (let seen = 0; seen <= round; seen += 1) expect(readMatchesDoc(doc, { stamp: `s${seen}`, hash: 'h0' }), `바퀴 ${round} · 읽기 stamp s${seen}`).toBe(true)
      expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h1' })).toBe(false)
      expect(readMatchesDoc(doc, { stamp: `s${round + 100}`, hash: 'h0' })).toBe(false)
    }
  })
  it('상한 — 되살림이 많아도 목록이 무한히 자라지 않고, 처음 연 stamp 는 남는다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    for (let round = 1; round <= 120; round += 1) rebaseDoc(doc, { stamp: `s${round}`, hash: 'h0' })
    expect(doc.rebasedFrom.length).toBeLessThanOrEqual(50)
    expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h0' })).toBe(true)
    expect(readMatchesDoc(doc, { stamp: 's119', hash: 'h0' })).toBe(true)
  })
  it('저장하면 목록을 비운다 — 옛 stamp 는 더 같지 않다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    rebaseDoc(doc, { stamp: 's1', hash: 'h0' })
    rebaseDoc(doc, { stamp: 's2', hash: 'h0' })
    markSaved(doc, { stamp: 's3', hash: 'h3', version: model.getAlternativeVersionId(), eols: doc.eols })
    expect(doc.rebasedFrom).toEqual([])
    expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h0' })).toBe(false)
  })
})

describe('LIFE-592 D1 — 되살린 뒤 낡은 읽기 결과(최종 관문 F10 E4ⓔ)', () => {
  it('되살림이 기준을 옮긴 뒤, 옮기기 전 stamp·같은 지문의 읽기 결과는 지금 기준과 같다(거짓 외부 변경 아님)', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    // 삭제 전에 읽어 둔 결과(FileView readEntry) — 옛 inode stamp·같은 지문
    const stale = { stamp: 's0', hash: 'h0' }
    expect(readMatchesDoc(doc, stale)).toBe(true)
    expect(rebaseDoc(doc, { stamp: 's9', hash: 'h0' })).toBe(true)
    expect(readMatchesDoc(doc, stale)).toBe(true)
    expect(readMatchesDoc(doc, { stamp: 's9', hash: 'h0' })).toBe(true)
    expect(doc.external).toEqual({ kind: 'none' })
  })
  it('양성 대조 — 되살린 뒤 진짜 외부 변경(새 stamp 또는 다른 지문)은 같지 않다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    rebaseDoc(doc, { stamp: 's9', hash: 'h0' })
    expect(readMatchesDoc(doc, { stamp: 's10', hash: 'h1' })).toBe(false)
    expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h1' })).toBe(false)
    expect(readMatchesDoc(doc, { stamp: 's10', hash: 'h0' })).toBe(false)
  })
  it('되살리기 전(삭제 없이) 외부 변경은 예전처럼 같지 않다 · 지문이 달라 옮기지 않은 경우도 낡은 읽기는 같지 않다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    expect(readMatchesDoc(doc, { stamp: 's1', hash: 'h1' })).toBe(false)
    expect(rebaseDoc(doc, { stamp: 's9', hash: 'other' })).toBe(false)
    expect(readMatchesDoc(doc, { stamp: 's9', hash: 'other' })).toBe(false)
    expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h0' })).toBe(true)
  })
  it('다시 읽기·저장으로 기준이 바뀌면 옮기기 전 stamp 는 더 같지 않다', () => {
    const { doc, model } = open('abc\n', { stamp: 's0', hash: 'h0' })
    model.type(1, 1, 'X')
    rebaseDoc(doc, { stamp: 's9', hash: 'h0' })
    reloadDoc(doc, { text: 'new\n', bom: false, stamp: 's20', hash: 'h20', readOnly: null, large: false })
    expect(readMatchesDoc(doc, { stamp: 's0', hash: 'h0' })).toBe(false)
  })
})
