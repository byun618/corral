// 경로 정규화 한 자리 (수정 1회차 L8 — codex 5).
//
// worktree 의 열림상태는 **경로 문자열로** 조인한다: git 이 준 worktree 경로와 herdr 가 준
// `worktree.list` 의 경로가 같아야 "이 체크아웃이 열려 있다" 가 성립한다.
// 1회차는 양쪽 다 `path.resolve` 만 거쳤다 — 그건 `..`·상대경로만 펴고 **symlink 는 안 푼다.**
// 사용자가 symlink 로 레포를 등록하거나 두 쪽이 서로 다른 canonical path 를 돌려주면
// 열린 worktree 가 `닫힘` 으로 보이고 그 workspace 가 `등록 안 됨` 으로 밀린다.
//
// 그래서 조인에 쓰는 경로는 **전부 이 함수를 지난다**. 없는 경로(아직 안 만들어진 worktree,
// herdr 가 기억만 하고 있는 경로)는 realpath 가 던지므로 resolve 결과로 물러난다.

import fs from 'node:fs'
import path from 'node:path'

export function canonicalPath(input: string): string {
  const resolved = path.resolve(input)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}
