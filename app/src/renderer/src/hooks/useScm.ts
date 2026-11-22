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
// · 원격(LIFE-831) — 진행 중 동작(`remote`)도 루트마다 든다. 안내는 쓰기와 같은 칸(`notice`). 끝난 결과는 요청 루트의 상태에만 적용한다(제약 8 상태 표).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ScmBasePush, ScmChange } from '../../../shared/scm.js'
import { scmWriteMessage, type ScmWriteInput } from '../../../shared/scm-write.js'
import { SCM_REMOTE_BUSY_TEXT, scmRemoteMessage, type ScmRemoteAction, type ScmRemoteInput } from '../../../shared/scm-remote.js'
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
  /** 지금 루트에서 진행 중인 원격 동작(LIFE-831) — 없으면 null. */
  remote: ScmRemoteAction | null
  /** 원격 동작 하나 — 그 루트에서 진행 중이면 무시한다(main 도 `busy` 로 git 을 더 띄우지 않는다). 결과는 `input.root` 의 상태에만. */
  runRemote: (input: ScmRemoteInput) => Promise<void>
  /** 지금 루트의 진행 중 원격 동작 취소. */
  cancelRemote: () => void
}

export function useScm({ root, active }: { root: string | null; active: boolean }): ScmApi {
  const stores = useRef(new Map<string, ScmRootState>())
  const remotes = useRef(new Map<string, ScmRemoteAction>())
  /** 진행 항목을 세운 요청(`runRemote` 의 표지) — 다른 요청·main 알림이 다시 세우면 바뀐다. */
  const owners = useRef(new Map<string, symbol>())
  /** 루트별 마지막 원격 요청 표지(수정 r3 E1) — 안내는 마지막 요청의 응답만 쓴다. 앞 요청의 늦은 응답이 다음 요청의 안내를 지우거나 지운 안내를 되살리지 않게. */
  const latest = useRef(new Map<string, symbol>())
  /** 루트별 main 알림 순번(수정 r4 F1) — 상태 질의 뒤 알림이 왔으면 그 질의 응답은 낡았다. */
  const events = useRef(new Map<string, number>())
  /** busy 안내를 지울 루트(F4) — 끝 알림 처리에서 쓴다. `writes` 는 아래에서 만든다. */
  const clearBusyNotice = useRef<(key: string) => void>(() => {})
  /** main 에 진행 상태를 물어 되살린다 — 질의 뒤 그 루트의 알림이 왔으면 응답을 버린다(알림이 더 새 상태 — F1). */
  const syncRemoteState = useCallback(async (key: string): Promise<void> => {
    const seen = events.current.get(key) ?? 0
    const state = await window.corral.scmRemoteState({ root: key }).catch(() => ({ action: null }))
    if ((events.current.get(key) ?? 0) !== seen || state.action === null || remotes.current.has(key)) return
    remotes.current.set(key, state.action)
    bump()
  }, [])
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

  // 원격 진행 상태(수정 r1 C6) — main 이 시작·끝을 민다. 렌더러가 다시 그려졌거나(reload·창 재생성) 루트를 바꿨으면 main 에 물어 되살린다.
  useEffect(
    () =>
      window.corral.onScmRemoteEvent((event) => {
        // main 의 알림이 진행 항목의 주인이 된다 — 그 뒤 온 앞 요청의 응답은 이 항목을 지우지 않는다(D2).
        owners.current.delete(event.root)
        events.current.set(event.root, (events.current.get(event.root) ?? 0) + 1)
        if (event.action === null) {
          remotes.current.delete(event.root)
          clearBusyNotice.current(event.root)
        } else remotes.current.set(event.root, event.action)
        bump()
      }),
    [],
  )
  useEffect(() => {
    // 모르면 진행 없음으로 둔다 — 누르면 main 이 `busy` 로 답하고 그때 다시 묻는다.
    if (root !== null) void syncRemoteState(root)
  }, [root, syncRemoteState])

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
  // 끝 알림이 오면 그 루트의 busy 안내만 지운다 — 다른 실패 안내는 그대로(수정 r4 F4).
  clearBusyNotice.current = (key) => {
    const current = writes.current.get(key)
    if (current?.notice?.text === SCM_REMOTE_BUSY_TEXT) writes.current.set(key, { ...current, notice: null })
  }
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
  const runRemote = useCallback(
    async (input: ScmRemoteInput) => {
      const key = input.root
      if (remotes.current.has(key)) return
      // 이 요청의 진행 항목 표지(수정 r2 D2) — 응답 때 진행 항목이 아직 이 요청의 것일 때만 지운다. main 의 끝 알림 뒤·응답 전 틈에 시작한 다음 동작의 진행 표시를 지우지 않게.
      const token = Symbol(input.action)
      owners.current.set(key, token)
      latest.current.set(key, token)
      remotes.current.set(key, input.action)
      bump()
      const result = await window.corral.scmRemote(input).catch((error: unknown) => ({ ok: false as const, code: 'git_error' as const, error: String(error) }))
      if (owners.current.get(key) === token) {
        owners.current.delete(key)
        remotes.current.delete(key)
      }
      // 이미 진행 중(`busy`) — 이 렌더러가 모르는 동작이 돈다(다시 그려지기 전에 누른 것). main 에 물어 진행 표시·취소를 되살린다(C6).
      if (!result.ok && result.code === 'busy') await syncRemoteState(key)
      // 성공·고르기 닫음은 앞 안내를 지운다(D10 — 목록·숫자 갱신이 결과). 실패·취소·시간 초과는 그 안내로. 그 뒤 같은 루트에 새 요청이 있었으면 쓰지 않는다(E1).
      if (latest.current.get(key) !== token) {
        bump()
        return
      }
      patch(key, (current) => ({ ...current, notice: scmRemoteMessage({ action: input.action, result }) }))
    },
    [patch, syncRemoteState],
  )
  const cancelRemote = useCallback(() => {
    if (root === null || !remotes.current.has(root)) return
    const key = root
    void window.corral
      .scmRemoteCancel({ root: key })
      .catch(() => ({ ok: false }))
      .then((result) => {
        // main 에 취소할 동작이 없다 — 진행 표시가 낡았다(끝 알림을 놓쳤거나 늦은 상태 응답). 풀고 다시 묻는다(F1).
        if (result.ok) return
        owners.current.delete(key)
        remotes.current.delete(key)
        bump()
        return syncRemoteState(key)
      })
  }, [root, syncRemoteState])

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
    remote: root === null ? null : (remotes.current.get(root) ?? null),
    runRemote,
    cancelRemote,
    compare,
    setCompare,
  }
}
