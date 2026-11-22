// 소스 제어 데이터 (LIFE-683) — 탐색기 허브가 미는 git push(`changes`)를 루트마다 메모리에 든다. 새 조회·폴링은 없다(S8).
//
// · 구독은 「패널 열림 + 소스 제어 보기 + 활성 worktree」 일 때만 건다 — 탐색기와 같은 루트면 참조 셈으로 한 벌(`explorer-watch-refs.ts`).
// · push 는 보이든 아니든 받아 둔다(탐색기가 구독 중일 때 온 것도) — 보기로 돌아오면 바로 마지막 목록을 그린다. 구독이 시작되면 허브가 한 번 다시 읽어 민다.
// · `stamps` — 루트별 git push 차례. 열린 diff 탭이 이 값이 바뀔 때 양쪽 내용을 다시 읽는다(S6 — 탭 갱신도 같은 push 경로).
// · 비교 기준(LIFE-830) — 루트별 「작업 트리」(기본) / 「base 대비」. 메모리에만 든다(재시작 복원 없음). base 대비이고 보기가 활성일 때만
//   main 에 켜 달라고 한다(`scmBaseMode`) — 그때만 허브가 같은 git 회차에 base 대비 목록을 더 읽어 push 의 `base` 로 싣는다.
//   **쓰기 단추(K1)가 읽을 자리는 `compare` 하나다** — `'base'` 면 stage·unstage·discard·커밋을 그리지 않는다(B8, D1).
// · 쓰기(LIFE-829) — 입력란 메시지·안내·진행 상태를 **루트마다** 든다(K12 — 결과는 요청 루트의 상태에만 적용한다. 지금 보이는 루트가 달라도
//   그 루트의 입력란·안내는 그대로). 요청의 루트는 누른 때 값(`input.root`)이다.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ScmBasePush, ScmChange } from '../../../shared/scm.js'
import { scmWriteMessage, type ScmWriteInput } from '../../../shared/scm-write.js'
import { acquireExplorerWatch } from '../explorer-watch-refs.js'

/** `total` — main 이 상한 + 1 로 자른 `changes` 의 전체 개수(fix r1 R1-05). */
/** `base` — 마지막 `scmBase` push 의 base 대비 목록(LIFE-830). 받기 전·base 대비를 다시 켠 직후면 null. */
export type ScmRootState = { changes: ScmChange[] | null; total: number; error: string | null; stamp: number; base: ScmBasePush | null }

/** 비교 기준 — 작업 트리(지금까지의 보기) / base 대비. */
export type ScmCompare = 'working' | 'base'

/** 루트별 쓰기 상태 — `committing` 동안은 입력란을 읽기 전용으로 둔다(성공 때 지울 메시지가 보낸 사본과 같게). */
export type ScmWriteState = { message: string; notice: { kind: 'info' | 'error'; text: string } | null; committing: boolean }
const EMPTY_WRITE: ScmWriteState = { message: '', notice: null, committing: false }

export type ScmApi = {
  root: string | null
  state: ScmRootState | null
  version: number
  /** 그 루트의 git push 차례(없으면 0) — diff 탭 갱신 신호. */
  stampOf: (root: string) => number
  refresh: () => void
  /** 목록 / 트리 (S4) — ui-prefs `scmViewMode` 에 영속(전역). */
  mode: 'list' | 'tree'
  setMode: (mode: 'list' | 'tree') => void
  /** 지금 루트의 비교 기준(LIFE-830) — 기본 작업 트리. K1 쓰기 단추가 읽는 자리. */
  compare: ScmCompare
  setCompare: (compare: ScmCompare) => void
  /** 지금 루트의 쓰기 상태. */
  write: ScmWriteState
  setMessage: (message: string) => void
  dismissNotice: () => void
  /** 쓰기 하나 — 결과는 `input.root` 의 상태에만 적용한다. 성공한 커밋은 그 루트의 입력란을 비운다(D10). */
  run: (input: ScmWriteInput) => Promise<void>
}

export function useScm({ root, active }: { root: string | null; active: boolean }): ScmApi {
  const stores = useRef(new Map<string, ScmRootState>())
  const [version, bump] = useReducer((value: number) => value + 1, 0)
  const [mode, setModeState] = useState<'list' | 'tree'>('list')
  const [compareByRoot, setCompareByRoot] = useState(() => new Map<string, ScmCompare>())
  const compare: ScmCompare = root === null ? 'working' : (compareByRoot.get(root) ?? 'working')

  useEffect(() => {
    let cancelled = false
    void window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (!cancelled) setModeState(prefs.scmViewMode === 'tree' ? 'tree' : 'list')
      })
      .catch(() => {
        // 기본 목록.
      })
    return () => {
      cancelled = true
    }
  }, [])
  const setMode = useCallback((next: 'list' | 'tree') => {
    setModeState(next)
    window.corral.setUiPrefs({ scmViewMode: next })
  }, [])

  useEffect(
    () =>
      window.corral.onExplorerEvent((event) => {
        if (event.kind === 'scmBase') {
          // base 대비 목록은 같은 회차의 `git` push 뒤에 따로 온다(수정 r1 A6). 작업 트리 상태·stamp 는 그대로 — 열린 diff 탭은 `git` push 가 다시 읽힌다.
          const previous = stores.current.get(event.root)
          if (previous === undefined) return
          stores.current.set(event.root, { ...previous, base: event.base })
          bump()
          return
        }
        if (event.kind !== 'git') return
        const previous = stores.current.get(event.root)
        // `changes` 가 없는 push(옛 main) 는 git 오류와 같게 본다 — 목록을 지어내지 않는다.
        const changes = event.git === null ? null : (event.changes ?? null)
        stores.current.set(event.root, {
          changes,
          total: event.changesTotal ?? changes?.length ?? 0,
          error: event.git === null ? (event.error ?? 'git 상태를 읽지 못했다') : null,
          stamp: (previous?.stamp ?? 0) + 1,
          // 다음 `scmBase` push 가 올 때까지 앞 목록을 둔다 — 회차마다 「읽는 중」 으로 깜빡이지 않게.
          base: previous?.base ?? null,
        })
        bump()
      }),
    [],
  )

  useEffect(() => {
    if (!active || root === null) return
    return acquireExplorerWatch(root)
  }, [active, root])

  useEffect(() => {
    if (!active || root === null || compare !== 'base') return
    // 켤 때 앞서 받은 목록(꺼져 있던 동안 낡았다)은 버린다 — 새 `scmBase` push 까지 「읽는 중」.
    const previous = stores.current.get(root)
    if (previous !== undefined && previous.base !== null) {
      stores.current.set(root, { ...previous, base: null })
      bump()
    }
    window.corral.scmBaseMode({ root, on: true })
    return () => window.corral.scmBaseMode({ root, on: false })
  }, [active, root, compare])

  const setCompare = useCallback(
    (next: ScmCompare) => {
      if (root === null) return
      setCompareByRoot((current) => new Map(current).set(root, next))
    },
    [root],
  )

  const stampOf = useCallback((key: string) => stores.current.get(key)?.stamp ?? 0, [])
  const refresh = useCallback(() => {
    if (root !== null) window.corral.explorerRefreshGit(root)
  }, [root])

  const writes = useRef(new Map<string, ScmWriteState>())
  const patch = useCallback((key: string, update: (current: ScmWriteState) => ScmWriteState) => {
    writes.current.set(key, update(writes.current.get(key) ?? EMPTY_WRITE))
    bump()
  }, [])
  const setMessage = useCallback(
    (message: string) => {
      if (root !== null) patch(root, (current) => ({ ...current, message }))
    },
    [root, patch],
  )
  const dismissNotice = useCallback(() => {
    if (root !== null) patch(root, (current) => ({ ...current, notice: null }))
  }, [root, patch])
  const run = useCallback(
    async (input: ScmWriteInput) => {
      const key = input.root
      const commit = input.action === 'commit'
      patch(key, (current) => ({ ...current, committing: current.committing || commit }))
      const result = await window.corral.scmWrite(input).catch((error: unknown) => ({ ok: false as const, code: 'git_error' as const, error: String(error) }))
      const notice = scmWriteMessage(result)
      patch(key, (current) => ({
        message: result.ok && commit ? '' : current.message,
        // 성공·취소는 앞 안내를 지운다. 실패는 그 안내로 바꾼다.
        notice,
        committing: commit ? false : current.committing,
      }))
    },
    [patch],
  )

  return {
    root,
    state: root === null ? null : (stores.current.get(root) ?? null),
    version,
    stampOf,
    refresh,
    mode,
    setMode,
    write: root === null ? EMPTY_WRITE : (writes.current.get(root) ?? EMPTY_WRITE),
    setMessage,
    dismissNotice,
    run,
    compare,
    setCompare,
  }
}
