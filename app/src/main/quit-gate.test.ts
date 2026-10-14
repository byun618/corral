// LIFE-591 E3ⓒ — 종료 확인 관문(단위): 수정 파일이 없으면 막지 않음 · 있으면 막고 확인 요청 · 확인 뒤엔 막지 않음 · 받을 렌더러가 없으면 막지 않음.
import { describe, expect, it } from 'vitest'
import { createQuitGate, parseDirtyFiles } from './quit-gate.js'
import { fileDialogSpec, parseFileDialogRequest, reloadDialogSpec } from './file-dialogs.js'

describe('quit gate', () => {
  it('수정 파일이 없으면 지금과 같이 묻지 않는다', () => {
    let asked = 0
    const gate = createQuitGate({ requestConfirm: () => ++asked > 0 })
    expect(gate.intercept('before-quit')).toBe(false)
    expect(asked).toBe(0)
  })
  it('있으면 막고 확인을 요청한다 — 취소(allow 없음)면 다음에도 막는다', () => {
    let asked = 0
    const gate = createQuitGate({ requestConfirm: () => ++asked > 0 })
    gate.setDirty([{ root: '/r', rel: 'a.txt' }])
    expect(gate.intercept('before-quit')).toBe(true)
    expect(gate.intercept('window-close')).toBe(true)
    expect(asked).toBe(2)
  })
  it('allow 뒤에는 막지 않는다', () => {
    const gate = createQuitGate({ requestConfirm: () => true })
    gate.setDirty([{ root: '/r', rel: 'a.txt' }])
    gate.allow()
    expect(gate.intercept('before-quit')).toBe(false)
  })
  it('확인을 받을 렌더러가 없으면 막지 않는다', () => {
    const gate = createQuitGate({ requestConfirm: () => false })
    gate.setDirty([{ root: '/r', rel: 'a.txt' }])
    expect(gate.intercept('before-quit')).toBe(false)
  })
  it('목록 형 검사', () => {
    expect(parseDirtyFiles([{ root: '/r', rel: 'a' }])).toEqual([{ root: '/r', rel: 'a' }])
    expect(parseDirtyFiles([{ root: '/r' }])).toBeNull()
    expect(parseDirtyFiles('x')).toBeNull()
  })
})

describe('file dialogs', () => {
  it('닫기 — 한 파일: 저장 / 저장 안 함 / 취소, 기본 = 저장, 취소 = 마지막', () => {
    const spec = fileDialogSpec({ kind: 'close', files: ['src/a.ts'] })
    expect(spec.options.message).toBe("'a.ts'에 대한 변경 내용을 저장할까요?")
    expect(spec.options.buttons).toEqual(['저장', '저장 안 함', '취소'])
    expect(spec.choices).toEqual(['save', 'discard', 'cancel'])
    expect(spec.options.cancelId).toBe(2)
  })
  it('닫기 — 여러 파일: 목록·모두 저장', () => {
    const spec = fileDialogSpec({ kind: 'close', files: ['a', 'b'] })
    expect(spec.options.detail).toContain('a\nb')
    expect(spec.options.buttons[0]).toBe('모두 저장')
  })
  it('충돌 — 덮어쓰기 / 취소, 기본 = 취소(묻지 않고 덮지 않는다)', () => {
    const spec = fileDialogSpec({ kind: 'conflict', file: 'a.txt' })
    expect(spec.choices).toEqual(['overwrite', 'cancel'])
    expect(spec.options.defaultId).toBe(1)
  })
  it('형 검사 — 모르는 모양은 null', () => {
    expect(parseFileDialogRequest({ kind: 'close', files: [] })).toBeNull()
    expect(parseFileDialogRequest({ kind: 'conflict', file: 'a' })).toEqual({ kind: 'conflict', file: 'a' })
    expect(parseFileDialogRequest({ kind: 'nope' })).toBeNull()
    expect(reloadDialogSpec(['a']).buttons).toHaveLength(2)
  })
})
