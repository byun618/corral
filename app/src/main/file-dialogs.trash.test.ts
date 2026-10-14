// LIFE-592 E3ⓑ — 삭제 확인 대화상자(휴지통). 폴더·실행 취소 가능 여부(Q1)·수정 중 탭(Q3) 문구, 요청 형 검사.
import { describe, expect, it } from 'vitest'
import { fileDialogSpec, parseFileDialogRequest } from './file-dialogs.js'

describe('삭제 확인', () => {
  it('파일 — 실행 취소 가능, 기본 단추 = 휴지통으로 이동, 취소 = 취소', () => {
    const spec = fileDialogSpec({ kind: 'trash', file: 'src/a.ts', isDir: false, undoable: true, dirty: [] })
    expect(spec.options.message).toBe("'a.ts'을(를) 휴지통으로 이동할까요?")
    expect(spec.options.detail).toBe('실행 취소(⌘Z)로 되돌릴 수 있습니다.')
    expect(spec.options.buttons).toEqual(['휴지통으로 이동', '취소'])
    expect(spec.choices).toEqual(['trash', 'cancel'])
    expect(spec.options.cancelId).toBe(1)
  })
  it('폴더·수정 중 탭 — 안의 내용까지 · 되돌릴 수 없음(휴지통에서 복원) · 수정 중 목록', () => {
    const spec = fileDialogSpec({ kind: 'trash', file: 'src', isDir: true, undoable: false, dirty: ['src/a.ts'] })
    expect(spec.options.detail).toContain('폴더 안의 내용까지')
    expect(spec.options.detail).toContain('휴지통에서 복원')
    expect(spec.options.detail).toContain('src/a.ts')
    expect(spec.options.detail).toContain('「삭제됨」')
  })
  it('요청 형 검사', () => {
    expect(parseFileDialogRequest({ kind: 'trash', file: 'a', isDir: false, undoable: true, dirty: ['a'] })).toEqual({ kind: 'trash', file: 'a', isDir: false, undoable: true, dirty: ['a'] })
    expect(parseFileDialogRequest({ kind: 'trash', file: 'a', isDir: 'no', undoable: true, dirty: [] })).toBeNull()
    expect(parseFileDialogRequest({ kind: 'trash', file: 'a', isDir: false, undoable: true, dirty: [1] })).toBeNull()
  })
})
