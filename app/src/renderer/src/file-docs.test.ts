// LIFE-591 E1ⓒⓔⓕ·E2ⓑⓖ·E3ⓑ·E4ⓒⓓ — 문서 저장소·저장 흐름(단위). Monaco 대신 같은 모양의 가짜 모델(줄 배열 + 실행 취소 스택)을 쓴다.
// 줄끝: 섞인 줄끝·BOM·끝 개행 없음 파일을 한 글자 고쳐 직렬화하면 그 한 글자만 다르다. 수정 여부: 버전 id(실행 취소로 저장 상태면 해제).
import { beforeEach, describe, expect, it } from 'vitest'
import { adoptDoc, allDocs, applyEolChange, disposeDoc, eolsOf, getDoc, joinLines, reloadDoc, revertDoc, serialize, setComposing, type DocModel } from './file-docs.js'
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
    if (undoable) this.undo.push({ lines: this.lines.slice(), version: this.version })
    const head = (this.lines[range.startLineNumber - 1] ?? '').slice(0, range.startColumn - 1)
    const tail = (this.lines[range.endLineNumber - 1] ?? '').slice(range.endColumn - 1)
    const inserted = (head + text + tail).split(/\r\n|\r|\n/)
    this.lines.splice(range.startLineNumber - 1, range.endLineNumber - range.startLineNumber + 1, ...inserted)
    this.nextVersion += 1
    this.version = this.nextVersion
    for (const listener of this.listeners) listener({ changes: [{ range, text }] })
  }
  type(line: number, column: number, text: string): void {
    this.replace({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text)
  }
  undoLast(): void {
    const last = this.undo.pop()
    if (last === undefined) return
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
    expect(await confirmDiscardOrSave({ docs: [doc], deps: fake.deps })).toBe(true)
    expect(fake.dialogs).toHaveLength(0)
  })
  it('저장 안 함 → 문서를 버린다(디스크 무변경)', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['discard'] })
    expect(await confirmDiscardOrSave({ docs: [doc], deps: fake.deps })).toBe(true)
    expect(getDoc(doc.key)).toBeUndefined()
    expect(model.disposed).toBe(true)
    expect(fake.writes).toHaveLength(0)
  })
  it('취소 → 닫지 않는다 · 저장 실패 → 닫지 않는다', async () => {
    const { doc, model } = open('a')
    model.type(1, 1, 'x')
    expect(await confirmDiscardOrSave({ docs: [doc], deps: fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['cancel'] }).deps })).toBe(false)
    const failing = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['save'], fail: { ok: false, code: 'not_file', error: '' } })
    expect(await confirmDiscardOrSave({ docs: [doc], deps: failing.deps })).toBe(false)
    expect(getDoc(doc.key)).toBe(doc)
  })
  it('여러 개면 목록 한 번', async () => {
    const a = open('a')
    const b = open('b')
    a.model.type(1, 1, 'x')
    b.model.type(1, 1, 'y')
    const fake = fakeDeps({ disk: { stamp: 's0', text: 'a' }, answers: ['cancel'] })
    await confirmDiscardOrSave({ docs: [a.doc, b.doc], deps: fake.deps })
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
    const closing = confirmDiscardOrSave({ docs: [doc], deps: fake.deps })
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
