// 소스 제어 원격 (LIFE-831) — 가져오기·끌어오기·밀어넣기·브랜치 게시. 렌더러·main 이 같이 쓰는 요청·결과 형과 순수 함수(분류·자격 가림·안내 문구).
//
// · 요청은 「동작 이름 + 루트(누른 때)」 뿐이다 — 원격·브랜치 이름과 git 인자는 main 이 git 에서 읽어 고정 모양으로 만든다(K9 — `main/scm-remote.ts`).
//   게시의 원격 고르기도 main 이 띄운다(목록 = `git remote`).
// · 안내 = 분류 문장 + stderr 원문(D9). 원문의 URL 자격(`scheme://user[:pass]@`)은 가린다 — main 이 돌려주기 전에 한 번, 문구를 만들 때 한 번 더.

export type ScmRemoteAction = 'fetch' | 'pull' | 'push' | 'publish'

export type ScmRemoteInput = { action: ScmRemoteAction; root: string }

export type ScmRemoteRefusal =
  | 'not_worktree'
  | 'bad_request'
  /** 그 루트에서 원격 동작이 이미 진행 중이다 — git 을 더 띄우지 않는다(K4ⓑ). */
  | 'busy'
  | 'no_remote'
  | 'no_upstream'
  | 'detached'
  /** git 이 준 원격·브랜치 이름이 argv 에 넣을 수 없는 모양이거나, 고른 원격이 더 이상 없다(K9). */
  | 'bad_name'
  /** 게시 원격 고르기를 닫았다 — git 0. */
  | 'pick_cancelled'
  /** 사용자가 취소 단추를 눌렀다(진행 중이면 프로세스 그룹 종료, 기다리던 것이면 git 없이 빠짐). */
  | 'cancelled'
  /** 상한(기본 10 분)을 넘겨 끊었다. */
  | 'timeout'
  /** git 이 실패했다 — `error` 는 stderr 원문(자격 가림). */
  | 'git_error'

/** `hint` — main 이 자르기 전 원문 전체로 고른 분류 문장(없으면 null, 모르면 생략 — 그때는 `error` 로 분류한다). */
export type ScmRemoteResult = { ok: true } | { ok: false; code: ScmRemoteRefusal; error: string; hint?: string | null }

const ACTIONS: readonly ScmRemoteAction[] = ['fetch', 'pull', 'push', 'publish']
const isAction = (value: unknown): value is ScmRemoteAction => ACTIONS.some((action) => action === value)

/** 렌더러가 보낸 요청의 형 검사 — 모르는 동작이면 null(git 없이 거절 — K9ⓑ). 루트가 열린 worktree 인지는 main 이 따로 본다. */
export function parseScmRemoteInput(input: unknown): ScmRemoteInput | null {
  if (typeof input !== 'object' || input === null) return null
  const root = 'root' in input ? input.root : undefined
  const action = 'action' in input ? input.action : undefined
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !isAction(action)) return null
  return { action, root }
}

/** argv 에 넣어도 되는 원격·브랜치 이름 — `-` 로 시작하지 않고(옵션으로 읽히지 않게) 공백·제어 문자·`:` 가 없다(refspec 을 깨지 않게). git 이 준 값도 다시 본다. */
export const isSafeRefName = (name: string): boolean =>
  name.length > 0 && name.length <= 1024 && !name.startsWith('-') && !/[\s:]/.test(name) && [...name].every((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)

/** 표시·반환 원문의 URL 자격 가림 — `https://user:secret@host` → `https://***@host`. */
export const maskCredentials = (text: string): string => text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')

const ACTION_TEXT: Readonly<Record<ScmRemoteAction, { label: string; busy: string }>> = {
  fetch: { label: '가져오기', busy: '가져오는 중…' },
  pull: { label: '끌어오기', busy: '끌어오는 중…' },
  push: { label: '밀어넣기', busy: '밀어넣는 중…' },
  publish: { label: '브랜치 게시', busy: '브랜치 게시하는 중…' },
}
export const scmRemoteLabel = (action: ScmRemoteAction): string => ACTION_TEXT[action].label
export const scmRemoteBusyLabel = (action: ScmRemoteAction): string => ACTION_TEXT[action].busy

/** git 오류 원문의 분류 문장(D9 · VS Code `git.ts` 분류 문구 결) — 모르면 null(원문만). 순서가 뜻이다: rebase 멈춤 → 충돌 → 갈라짐 → dirty → 거절 → 인증 → 네트워크. */
export function classifyRemoteError(stderr: string): string | null {
  if (/could not apply|Resolve all conflicts manually|git rebase --continue/i.test(stderr)) return 'rebase 가 충돌로 멈췄습니다 — 터미널에서 해결한 뒤 `git rebase --continue`(또는 `--abort`) 하세요.'
  const conflicts = stderr.match(/^CONFLICT \(/gm)?.length ?? 0
  if (conflicts > 0) return `충돌 ${conflicts}개 — 「병합 변경 사항」에서 해결한 뒤 커밋하세요.`
  if (/Need to specify how to reconcile divergent branches/.test(stderr))
    return '브랜치가 갈라졌고 끌어오기 방식(merge·rebase)이 정해져 있지 않아 git 이 멈췄습니다 — 터미널에서 `git config pull.rebase false`(merge) 또는 `true`(rebase) 를 정한 뒤 다시 끌어오세요. 아무것도 바꾸지 않았습니다.'
  if (/would be overwritten by (merge|checkout)|untracked working tree files would be (overwritten|removed)|cannot (pull|rebase) with rebase|Your index contains uncommitted changes/.test(stderr))
    return '작업 트리의 변경이 끌어올 변경과 겹칩니다 — 커밋하거나 치운 뒤 다시 끌어오세요. 작업 트리는 그대로입니다.'
  if (/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/.test(stderr)) return '원격에 새 커밋이 있습니다 — 끌어온 뒤 다시 밀어넣으세요.'
  if (/\[(remote )?rejected\]/.test(stderr)) return '원격이 밀어넣기를 거절했습니다.'
  if (/Host key verification failed/.test(stderr)) return '원격 호스트 키를 확인하지 못했습니다 — 터미널에서 한 번 접속해 known_hosts 에 등록한 뒤 다시 하세요.'
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey|Invalid username or password/i.test(stderr))
    return '원격 인증에 실패했습니다 — 터미널에서 git 자격(키체인·ssh 키)을 설정한 뒤 다시 하세요.'
  if (/returned error: 40[13]\b/.test(stderr)) return '원격이 접근을 거부했습니다(HTTP 401/403) — 자격과 그 저장소 권한을 확인하세요.'
  // `unable to access` 단독은 여러 원인(TLS·프록시·HTTP 오류)이라 분류하지 않는다 — 원문만(수정 r1 C4).
  if (/Could not resolve host|Connection timed out|Connection refused|Could not read from remote repository/i.test(stderr)) return '원격에 닿지 못했습니다 — 네트워크와 원격 주소를 확인하세요.'
  return null
}

/** 결과를 보기 안 안내 문구로 — 성공·고르기 닫음은 null(D10 — 목록·숫자 갱신이 결과). */
export function scmRemoteMessage(input: { action: ScmRemoteAction; result: ScmRemoteResult }): { kind: 'info' | 'error'; text: string } | null {
  const { result } = input
  if (result.ok) return null
  const label = scmRemoteLabel(input.action)
  switch (result.code) {
    case 'pick_cancelled':
      return null
    case 'busy':
      return { kind: 'info', text: '원격 동작이 이미 진행 중입니다.' }
    case 'no_remote':
      return { kind: 'info', text: `원격이 없습니다 — ${input.action === 'publish' ? '게시할' : label} 원격을 터미널에서 추가하세요(\`git remote add\`).` }
    case 'no_upstream':
      return { kind: 'info', text: input.action === 'push' ? '이 브랜치에는 upstream 이 없습니다 — 「브랜치 게시」로 올리세요.' : '이 브랜치에는 upstream 이 없어 끌어올 곳이 없습니다 — 먼저 「브랜치 게시」로 올리세요.' }
    case 'detached':
      return { kind: 'info', text: `분리된 HEAD 입니다 — 브랜치를 체크아웃한 뒤 ${label} 하세요.` }
    case 'cancelled':
      return { kind: 'info', text: `${label}를 취소했습니다.` }
    case 'timeout':
      return { kind: 'error', text: `${label}가 시간 초과로 끊겼습니다.${result.error === '' ? '' : `\n${maskCredentials(result.error)}`}` }
    case 'not_worktree':
      return { kind: 'error', text: `열린 worktree 가 아니어서 실행하지 않았습니다.\n${result.error}` }
    case 'bad_request':
      return { kind: 'error', text: `요청 형식이 올바르지 않습니다.\n${result.error}` }
    case 'bad_name':
      return { kind: 'error', text: maskCredentials(result.error) }
    case 'git_error': {
      const raw = maskCredentials(result.error)
      const sentence = result.hint !== undefined ? result.hint : classifyRemoteError(raw)
      return { kind: 'error', text: sentence === null ? raw : `${sentence}\n${raw}` }
    }
  }
}
