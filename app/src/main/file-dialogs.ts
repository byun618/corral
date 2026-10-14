// 파일 탭 확인 대화상자 문구 (LIFE-591 E3ⓑ·E4ⓒⓓ·E3ⓓⓕ) — OS 기본 `dialog.showMessageBox` 에 넘길 값과 단추 순서별 답. 순수 함수(시험 대상).
// 문구는 VS Code 한국어판 결(`'{0}'에 대한 변경 내용을 저장할까요?` · `저장하지 않으면 변경 내용이 손실됩니다.`). 단추 순서는 macOS 관례(기본 = 첫 단추, 취소 = 마지막).
import type { FileDialogChoice, FileDialogRequest } from '../shared/file-view.js'

export type MessageBoxSpec = {
  options: { type: 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }
  /** `buttons` 와 같은 자리 — 고른 단추 번호 → 답. */
  choices: FileDialogChoice[]
}

const nameOf = (rel: string): string => rel.split('/').pop() ?? rel
const LOST = '저장하지 않으면 변경 내용이 손실됩니다.'
/** 목록이 길면 앞 10개 + 「외 N개」 — 대화상자가 화면을 넘지 않게. */
const listOf = (files: string[]): string => (files.length <= 10 ? files : [...files.slice(0, 10), `외 ${files.length - 10}개`]).join('\n')

export function fileDialogSpec(request: FileDialogRequest): MessageBoxSpec {
  switch (request.kind) {
    case 'close': {
      const single = request.files.length === 1 ? request.files[0] : undefined
      return {
        options: {
          type: 'warning',
          message: single === undefined ? `다음 ${request.files.length}개 파일에 대한 변경 내용을 저장할까요?` : `'${nameOf(single)}'에 대한 변경 내용을 저장할까요?`,
          detail: single === undefined ? `${listOf(request.files)}\n\n${LOST}` : LOST,
          buttons: [single === undefined ? '모두 저장' : '저장', '저장 안 함', '취소'],
          defaultId: 0,
          cancelId: 2,
        },
        choices: ['save', 'discard', 'cancel'],
      }
    }
    case 'conflict':
      return {
        options: {
          type: 'warning',
          message: `'${nameOf(request.file)}'을(를) 저장하지 못했습니다 — 디스크의 파일이 더 최신입니다.`,
          detail: '마지막으로 읽은 뒤 다른 곳에서 파일을 고쳤습니다. 덮어쓰면 디스크의 새 내용이 지금 편집기 내용으로 바뀝니다.',
          buttons: ['덮어쓰기', '취소'],
          defaultId: 1,
          cancelId: 1,
        },
        choices: ['overwrite', 'cancel'],
      }
    case 'recreate':
      return {
        options: {
          type: 'warning',
          message: `'${nameOf(request.file)}'이(가) 디스크에서 삭제되었습니다.`,
          detail: `같은 경로(${request.file})에 다시 만들어 저장할까요?`,
          buttons: ['다시 만들기', '취소'],
          defaultId: 0,
          cancelId: 1,
        },
        choices: ['recreate', 'cancel'],
      }
    case 'discard':
      return {
        options: {
          type: 'warning',
          message: `삭제할 worktree 에 저장하지 않은 파일이 ${request.files.length}개 있습니다.`,
          detail: `${listOf(request.files)}\n\n계속하면 변경 내용이 버려집니다.`,
          buttons: ['버리고 계속', '취소'],
          defaultId: 1,
          cancelId: 1,
        },
        choices: ['discard', 'cancel'],
      }
  }
}

/** 렌더러 다시 불러오기(E3ⓕ — 기본 메뉴 View ▸ Force Reload 등) 확인. 단추 0 = 다시 불러오기. */
export function reloadDialogSpec(files: string[]): MessageBoxSpec['options'] {
  return {
    type: 'warning',
    message: `저장하지 않은 파일이 ${files.length}개 있습니다. 다시 불러오면 변경 내용이 사라집니다.`,
    detail: listOf(files),
    buttons: ['저장 안 하고 다시 불러오기', '취소'],
    defaultId: 1,
    cancelId: 1,
  }
}

/** 렌더러가 보낸 요청의 형 검사 — 모르는 모양이면 null(대화상자를 띄우지 않는다). */
export function parseFileDialogRequest(input: unknown): FileDialogRequest | null {
  if (typeof input !== 'object' || input === null || !('kind' in input)) return null
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
  const files = 'files' in input ? input.files : undefined
  const file = 'file' in input ? input.file : undefined
  switch (input.kind) {
    case 'close':
      return strings(files) ? { kind: 'close', files } : null
    case 'discard':
      return strings(files) ? { kind: 'discard', files } : null
    case 'conflict':
      return typeof file === 'string' ? { kind: 'conflict', file } : null
    case 'recreate':
      return typeof file === 'string' ? { kind: 'recreate', file } : null
    default:
      return null
  }
}
