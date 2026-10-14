// 파일 탭 저장·닫기 확인 흐름 (LIFE-591 E2·E3·E4ⓒⓓ) — 문서(`file-docs.ts`)를 main 쓰기 IPC 로 저장하고, 충돌·삭제·닫기 확인 대화상자를 거친다.
// IPC·알림은 인자로 받는다(시험이 바꿔 끼운다). 화면 상태는 문서 저장소가 알린다.
//
// 저장 한 번(`saveDoc`):
//   · 같은 문서의 저장은 줄을 선다(연속 ⌘S·저장 중 편집 — E2ⓖ). 각 저장은 **시작할 때의** 내용·버전·줄끝을 쓰고, 끝나면 그 버전을 저장 상태로 친다 — 그 사이 친 글자는 수정으로 남는다
//   · 조합(IME) 중이면 끝날 때까지 기다렸다 쓴다(E5ⓑ — 최대 1 s). 1 s 안에 안 끝나면 **쓰지 않고** 안내한다(수정 r1 R1-H — 미확정 자모를 저장하지 않는다)
//   · `baseStamp`·`baseHash` = 문서가 기대는 디스크 stamp·내용 지문 → main 이 다르면 쓰지 않고 `conflict`(E4ⓒ·R1-C) → 「덮어쓰기 / 취소」 · 지워졌으면 `not_found` → 「다시 만들기 / 취소」(E4ⓓ)
//     쓴 직후 다시 읽어 보니 다른 내용이면(외부 쓰기가 겹침 — R1-B) 그것도 `conflict` 로 와서 같은 확인을 거친다(저장된 것으로 치지 않는다)
//   · 그 밖의 실패(권한·폴더로 바뀜·밖으로 바뀜·쓰기 오류)는 알림 한 줄 — 수정 상태·내용은 그대로(E2ⓔ)
import type { DirtyFile, FileDialogChoice, FileDialogRequest, FileWriteInput, FileWriteResult } from '../../shared/file-view.js'
import { disposeDoc, getDoc, markSaved, serialize, setSaving, untilComposed, type FileDoc } from './file-docs.js'

export type SaveDeps = {
  writeFile: (input: FileWriteInput) => Promise<FileWriteResult>
  fileDialog: (request: FileDialogRequest) => Promise<FileDialogChoice>
  notify: (message: string) => void
}

export type SaveOutcome = 'saved' | 'cancelled' | 'failed'

const nameOf = (rel: string): string => rel.split('/').pop() ?? rel

/** 실패 사유를 사람 말로(E2ⓔ 오류 안내). 코드는 괄호로 남긴다 — 회차 원자료가 어느 검사에서 났는지 본다. */
export function saveFailureMessage(input: { rel: string; result: Extract<FileWriteResult, { ok: false }> }): string {
  const { result } = input
  const why = (() => {
    switch (result.code) {
      case 'permission_denied':
        return '쓰기 권한이 없습니다'
      case 'not_file':
        return '일반 파일이 아닙니다(폴더 등으로 바뀌었습니다)'
      case 'outside_root':
        return 'worktree 밖을 가리키게 바뀌었습니다'
      case 'changed':
        return '저장하는 동안 경로가 바뀌었습니다'
      case 'hardlink':
        return '다른 위치와 하드링크로 연결된 파일입니다'
      case 'too_large':
        return '내용이 너무 큽니다'
      case 'not_worktree':
        return '열린 worktree 의 파일이 아닙니다'
      case 'write_failed':
        return `쓰는 도중 실패했습니다 — ${result.bytesWritten} 바이트를 쓴 뒤`
      default:
        return '저장할 수 없습니다'
    }
  })()
  return `'${nameOf(input.rel)}' 을(를) 저장하지 못했습니다: ${why} (${result.code})`
}

async function saveOnce(doc: FileDoc, deps: SaveDeps): Promise<SaveOutcome> {
  const composed = await untilComposed(doc)
  // 닫기·「저장 안 함」 으로 이미 버린 문서면 할 일이 없다.
  if (getDoc(doc.key) !== doc) return 'cancelled'
  if (!composed) {
    deps.notify(`'${nameOf(doc.rel)}' 을(를) 저장하지 않았습니다: 입력 조합(한글 등)이 끝나지 않았습니다 — 조합을 마친 뒤 다시 저장하세요`)
    return 'failed'
  }
  if (!doc.dirty) return 'saved'
  const version = doc.model.getAlternativeVersionId()
  const eols = doc.eols.slice()
  const text = serialize(doc)
  let overwrite = false
  let create = false
  setSaving(doc, true)
  try {
    // 충돌 → 덮어쓰기, 삭제 → 다시 만들기, 다시 만들려는데 그 사이 생김 → 충돌로 — 갈래마다 한 번씩이라 몇 바퀴 안에 끝난다.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await deps.writeFile({ root: doc.root, rel: doc.rel, text, bom: doc.bom, baseStamp: doc.stamp, baseHash: doc.hash, overwrite, create })
      if (result.ok) {
        markSaved(doc, { stamp: result.stamp, hash: result.hash, version, eols })
        return 'saved'
      }
      if (result.code === 'conflict') {
        if ((await deps.fileDialog({ kind: 'conflict', file: doc.rel })) !== 'overwrite') return 'cancelled'
        overwrite = true
        continue
      }
      if (result.code === 'not_found' && !create) {
        if ((await deps.fileDialog({ kind: 'recreate', file: doc.rel })) !== 'recreate') return 'cancelled'
        create = true
        continue
      }
      if (result.code === 'exists') {
        create = false
        continue
      }
      deps.notify(saveFailureMessage({ rel: doc.rel, result }))
      return 'failed'
    }
    deps.notify(`'${nameOf(doc.rel)}' 을(를) 저장하지 못했습니다 (반복 충돌)`)
    return 'failed'
  } finally {
    setSaving(doc, false)
  }
}

/** 저장 — 같은 문서의 저장은 앞 저장이 끝난 뒤에 돈다(E2ⓖ). */
export function saveDoc(doc: FileDoc, deps: SaveDeps): Promise<SaveOutcome> {
  const run = doc.queue.then(() => saveOnce(doc, deps))
  doc.queue = run.catch(() => undefined)
  return run
}

/**
 * 수정된 문서들을 닫기 전에 묻는다(E3ⓑ) — 저장 / 저장 안 함 / 취소. 수정된 것이 없으면 묻지 않고 true.
 *   · 저장 → 전부 저장, 하나라도 못 하면 false(닫지 않는다). 저장을 기다리는 사이 더 친 글자가 있으면 그 버전까지 다시 저장한다(수정 r1 R1-A —
 *     옛 코드는 대화상자 응답·쓰기 IPC 사이의 추가 편집을 저장하지 않고 닫았다). 몇 번 해도 따라잡지 못하면 닫지 않는다. true 를 돌려주는 순간 문서는 수정 없음이고,
 *     부른 쪽은 같은 마이크로태스크 안에서 닫는다(입력 이벤트는 그 사이에 끼지 못한다)
 *   · 저장 안 함 → 그 문서들을 버린다(디스크 무변경 — 다시 열면 디스크 내용, E3ⓖ) → true
 *   · 취소 → false
 * `label` = 대화상자에 보일 이름(여러 worktree 를 묻는 종료 확인은 worktree 이름을 붙인다).
 */
export async function confirmDiscardOrSave(input: { docs: FileDoc[]; deps: SaveDeps; label?: (doc: FileDoc) => string }): Promise<boolean> {
  const dirty = input.docs.filter((doc) => doc.dirty)
  if (dirty.length === 0) return true
  const label = input.label ?? ((doc: FileDoc) => doc.rel)
  const choice = await input.deps.fileDialog({ kind: 'close', files: dirty.map(label) })
  if (choice === 'save') {
    for (let round = 0; round < 3; round += 1) {
      const pending = dirty.filter((doc) => doc.dirty)
      if (pending.length === 0) return true
      for (const doc of pending) if ((await saveDoc(doc, input.deps)) !== 'saved') return false
    }
    const behind = dirty.find((doc) => doc.dirty)
    if (behind === undefined) return true
    input.deps.notify(`'${nameOf(behind.rel)}' 을(를) 저장하는 동안 계속 바뀌어 닫지 않았습니다`)
    return false
  }
  if (choice === 'discard') {
    for (const doc of dirty) disposeDoc(doc.key)
    return true
  }
  return false
}

/** main 에 미는 수정 목록(E3ⓒ). */
export const dirtyFilesOf = (docs: readonly FileDoc[]): DirtyFile[] => docs.filter((doc) => doc.dirty).map((doc) => ({ root: doc.root, rel: doc.rel }))
