// 설정 › 워크플로 › 작업 연결 (LIFE-600 E · design-handoff §2 「연결 카드」·「레포 ↔ 기본 스페이스」, 목업 tasks-settings.dc.html).
//
// - 화면은 출처를 모른다(P2): 추가 버튼·카드 글자 아이콘·토큰 칸 문구는 main 이 준 `WorkSourceDescriptor` 를 그린다.
//   출처 이름으로 분기하는 코드를 두지 않는다 — `scripts/l600/renderer-source-branch.mjs` 가 검사한다(C4).
// - 상태는 main push(`corral:workSettings`)만 진실로 쓴다. 토큰은 입력칸 상태에만 잠깐 있고, 보낸 뒤 지운다. 화면에는 끝 4자만.
// - 자격은 main 이 필요할 때 푼다 — 이 화면이 열릴 때 아직 안 읽은 연결은 한 번 연결 테스트를 한다. 그때 macOS 가 키체인 허용을 물을 수 있어,
//   `pending: keychain` 이면 이유를 먼저 보인다(ad-hoc 서명이라 새로 설치할 때마다 다시 물을 수 있다).
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WorkAccountField,
  WorkConnectionStatus,
  WorkConnectionSummary,
  WorkError,
  WorkSettingsState,
  WorkSourceDescriptor,
  WorkSpaceToggle,
} from '../../../shared/work.js'
import { SettingsSubsectionHeader, SettingsSwitch } from './SettingsControls.js'

export type ConnectionsRepo = { root: string; name: string }

const EMPTY: WorkSettingsState = { sources: [], connections: [], repoDefaults: [] }

function useWorkSettings(): WorkSettingsState | null {
  const [state, setState] = useState<WorkSettingsState | null>(null)
  useEffect(() => {
    let alive = true
    void window.corral.getWorkSettings().then((value) => {
      if (alive && value !== null) setState((current) => current ?? value)
    })
    const off = window.corral.onWorkSettings((value) => setState(value))
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

const STATUS_LABELS: Record<WorkConnectionStatus, string> = {
  unchecked: '확인 전',
  testing: '확인 중',
  ok: '연결됨',
  auth: '인증 실패',
  forbidden: '권한 부족',
  offline: '닿지 않음',
  keychain: '자격 읽기 실패',
}

function formatDate(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

function formatChecked(ms: number | null): string {
  if (ms === null) return '이번 실행에서 아직 확인 안 함'
  const minutes = Math.round((Date.now() - ms) / 60_000)
  return minutes < 1 ? '마지막 확인 방금' : `마지막 확인 ${minutes}분 전`
}

/** 스페이스 색 — 출처가 준 색, 없으면 `--space-N` 을 순서대로(handoff §3). */
function spaceColor({ color, index }: { color: string | null; index: number }): string {
  return color ?? `var(--space-${(index % 7) + 1})`
}

/** 열린 폼 — `openId` 는 열 때마다 새 값이라 같은 출처·같은 연결로 다시 열어도 새 폼으로 시작한다(LIFE-615 F2-2). */
type Adding = { sourceId: string; replaceId: string | null; openId: number }

/** 폼 칸 처음 값 — 토큰 바꾸기면 지금 연결의 값(바꿀 수 없는 칸은 읽기 전용으로), 새 연결이면 빈 칸. */
function initialAccount({ source, replacing }: { source: WorkSourceDescriptor; replacing: WorkConnectionSummary | null }): Record<string, string> {
  return Object.fromEntries(source.accountFields.map((field) => [field.key, replacing?.account[field.key] ?? '']))
}

function ConnectionForm({ source, adding, replacing, onDone, onCancel }: { source: WorkSourceDescriptor; adding: Adding; replacing: WorkConnectionSummary | null; onDone: () => void; onCancel: () => void }): React.JSX.Element {
  const [token, setToken] = useState('')
  const [account, setAccount] = useState<Record<string, string>>(() => initialAccount({ source, replacing }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WorkError | null>(null)
  const firstInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    firstInput.current?.focus()
  }, [])
  const trimmed = token.trim()
  const locked = (field: WorkAccountField): boolean => adding.replaceId !== null && field.fixedOnReplace
  // 접두사가 맞지 않으면 보내지 않는다 — main 도 네트워크 전에 다시 거절한다(C5). 칸 값 검증·정규화(사이트 호스트 등)는 main 이 한다(LIFE-605 C1).
  const prefixWrong = source.tokenPrefix !== null && trimmed.length > 0 && !trimmed.startsWith(source.tokenPrefix)
  const accountReady = source.accountFields.every((field) => (account[field.key] ?? '').trim().length > 0)
  const ready = trimmed.length > 0 && accountReady && !prefixWrong && !busy
  // 처음 포커스 = 고칠 수 있는 첫 칸(토큰 바꾸기면 바꿀 수 없는 칸을 건너뛴다).
  const focusKey = source.accountFields.find((field) => !locked(field))?.key ?? null
  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    // 칸 없는 출처(LA)는 전과 같은 입력 — `account` 를 싣지 않는다.
    const sentAccount = Object.fromEntries(source.accountFields.map((field) => [field.key, (account[field.key] ?? '').trim()]))
    const result = await window.corral.addWorkConnection(source.accountFields.length === 0 ? { sourceId: source.id, token: trimmed, replaceId: adding.replaceId } : { sourceId: source.id, token: trimmed, account: sentAccount, replaceId: adding.replaceId })
    setBusy(false)
    if (result.ok) {
      setToken('')
      onDone()
    } else setError(result.error)
  }
  return (
    <form
      className="connection-form"
      data-connection-form={source.id}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="connection-form-title">{adding.replaceId === null ? source.formTitle : `${source.formTitle} — 토큰 바꾸기`}</div>
      {source.accountFields.map((field) => (
        <label key={field.key} className="connection-field">
          {field.label}
          <input
            ref={field.key === focusKey ? firstInput : undefined}
            type={field.input === 'email' ? 'email' : 'text'}
            inputMode={field.input === 'url' ? 'url' : undefined}
            autoComplete="off"
            spellCheck={false}
            data-connection-account={field.key}
            data-connection-account-locked={locked(field) ? '' : undefined}
            readOnly={locked(field)}
            value={account[field.key] ?? ''}
            placeholder={field.placeholder}
            onChange={(event) => {
              const value = event.target.value
              setAccount((current) => ({ ...current, [field.key]: value }))
            }}
          />
          {locked(field) ? <span className="connection-field-hint" data-connection-account-hint={field.key}>토큰을 바꿀 때는 고칠 수 없습니다 — 다른 {field.label}이면 새 연결로 추가하세요.</span> : field.hint === null ? null : <span className="connection-field-hint" data-connection-account-hint={field.key}>{field.hint}</span>}
        </label>
      ))}
      <label className="connection-field">
        {source.tokenLabel}
        <input
          ref={focusKey === null ? firstInput : undefined}
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-connection-token
          value={token}
          placeholder="붙여넣기"
          onChange={(event) => setToken(event.target.value)}
        />
        {source.tokenHint === null ? null : <span className="connection-field-hint" data-connection-token-hint>{source.tokenHint}</span>}
      </label>
      {prefixWrong ? <div className="connection-form-error" data-connection-form-error="prefix">{source.tokenLabel}은 {source.tokenPrefix} 로 시작합니다.</div> : null}
      {error === null ? null : <div className="connection-form-error" data-connection-form-error={error.kind}>{error.message}</div>}
      <div className="connection-form-hint">저장하면 토큰은 macOS 키체인으로 암호화되고 이 화면에 다시 보이지 않습니다. 바꾸려면 새로 붙여넣습니다.</div>
      <div className="connection-form-actions">
        <button type="button" className="connection-btn is-ghost" onClick={onCancel} disabled={busy}>취소</button>
        <button type="submit" className="connection-btn is-primary" data-connection-save disabled={!ready}>{busy ? '확인 중…' : '연결 테스트 후 저장'}</button>
      </div>
    </form>
  )
}

/** 카드 제목·메타 줄 — descriptor 가 정한 자리(`shownIn`)에 칸 값을 붙인다(「Jira Cloud · acme.atlassian.net」 · 「dev@acme.com · API 토큰 ••••7c2e」). */
function accountLine({ source, connection, shownIn }: { source: WorkSourceDescriptor | null; connection: WorkConnectionSummary; shownIn: WorkAccountField['shownIn'] }): { key: string; value: string }[] {
  return (source?.accountFields ?? [])
    .filter((field) => field.shownIn === shownIn)
    .flatMap((field) => {
      const value = connection.account[field.key]
      return value === undefined || value.length === 0 ? [] : [{ key: field.key, value }]
    })
}

function StatusPill({ connection }: { connection: WorkConnectionSummary }): React.JSX.Element {
  const testing = connection.status === 'testing'
  return (
    <span className={`connection-pill is-${connection.status}`} data-connection-status={connection.status}>
      {testing ? <span className="connection-spinner" aria-hidden /> : <span className="connection-dot" aria-hidden />}
      {STATUS_LABELS[connection.status]}
    </span>
  )
}

function SpaceRow({ connection, space, index, visibleCount }: { connection: WorkConnectionSummary; space: WorkSpaceToggle; index: number; visibleCount: number }): React.JSX.Element {
  const on = !space.hidden
  const last = on && visibleCount === 1
  const [error, setError] = useState<string | null>(null)
  const title = last ? '마지막 스페이스는 끌 수 없습니다 — 연결을 해제하세요' : on ? '작업 페이지에서 숨기기' : '보이기'
  const toggle = async (next: boolean): Promise<void> => {
    if (last) return
    const result = await window.corral.setWorkSpaceHidden({ connectionId: connection.id, spaceKey: space.key, hidden: !next })
    setError(result.ok ? null : result.error.message)
  }
  return (
    <div className={`connection-space${on ? '' : ' is-hidden'}`} data-space-row={space.key}>
      <span className="connection-space-dot" style={{ background: spaceColor({ color: space.color, index }) }} />
      <span className="connection-space-name">{space.name}</span>
      <span className="connection-space-count">{space.openCount === null ? '' : `열린 작업 ${space.openCount}`}</span>
      <span className={`connection-space-switch${last ? ' is-locked' : ''}`} title={title} data-space-locked={last ? '' : undefined}>
        <SettingsSwitch checked={on} label={`${space.name} 보이기`} disabled={last} onChange={(next) => void toggle(next)} />
      </span>
      {error === null ? null : <span className="connection-space-error" role="alert">{error}</span>}
    </div>
  )
}

function ConnectionCard({ connection, source, claimAutoTest, onReplaceToken, onRemove }: { connection: WorkConnectionSummary; source: WorkSourceDescriptor | null; claimAutoTest: (connectionId: string) => boolean; onReplaceToken: () => void; onRemove: () => void }): React.JSX.Element {
  // 사용자가 누른 연결 테스트의 실패는 연결 상태로 남지 않는 것(invalid_response·rejected 등)까지 이 카드에 보인다(R2-E).
  // 일반 작업 요청의 실패는 연결 상태 정책을 따른다 — 이 줄은 누른 테스트의 결과만.
  // 수명 = 누른 순간의 자격 세대(R3-C) — 토큰을 바꾸면(세대가 오르면) 이전 자격의 실패 줄은 버린다. 늦게 끝난 옛 테스트도 같은 규칙.
  // 결과는 **적용하기 전에** 거른다(R4-B) — 이 카드의 가장 최근 테스트이고 지금 자격 세대와 같을 때만 state 에 넣는다.
  // 옛 세대·앞선 테스트의 늦은 결과는 버린다(새 세대의 실패 줄을 지우지 못한다).
  const [testError, setTestError] = useState<{ error: WorkError; generation: number } | null>(null)
  const latestTest = useRef(0)
  const currentGeneration = useRef(connection.generation)
  useEffect(() => { currentGeneration.current = connection.generation }, [connection.generation])
  const test = async (): Promise<void> => {
    latestTest.current += 1
    const mine = latestTest.current
    const generation = connection.generation
    setTestError(null)
    const result = await window.corral.testWorkConnection({ connectionId: connection.id })
    if (mine !== latestTest.current || generation !== currentGeneration.current) return
    setTestError(result.ok ? null : { error: result.error, generation })
  }
  // 화면이 열릴 때 아직 안 읽은 연결의 자동 테스트도 같은 `test()` 를 탄다(R5-B) — 실패 줄·수명 규칙(R3-C·R4-B)이 누른 테스트와 같다.
  // 한 번만 = 화면(ConnectionsSection)이 연결마다 한 번 허락한다.
  const autoTest = useRef(test)
  autoTest.current = test
  useEffect(() => {
    if (connection.status === 'unchecked' && claimAutoTest(connection.id)) void autoTest.current()
  }, [connection.status, connection.id, claimAutoTest])
  // 연결 상태가 오류를 들고 있으면 그 줄이 같은 실패를 보인다 — 테스트 줄은 버린다(LIFE-615 F2-1).
  // 숨기기만 하면 뒤에 일반 요청 성공으로 상태가 ok 로 돌아올 때 옛 「연결 테스트 실패」 줄이 되살아난다.
  useEffect(() => {
    if (connection.error !== null && testError !== null) setTestError(null)
  }, [connection.error, testError])
  const shownTestError = testError !== null && testError.generation === connection.generation ? testError.error : null
  const spaces = connection.spaces
  const visibleCount = spaces?.filter((space) => !space.hidden).length ?? 0
  return (
    <div className="connection-card" data-connection-card={connection.id}>
      <div className="connection-card-head">
        <div className="connection-mono" aria-hidden>{connection.mono}</div>
        <div className="connection-card-text">
          <div className="connection-card-title">
            <span className="connection-name">
              {connection.name}
              {accountLine({ source, connection, shownIn: 'title' }).map((entry) => <span key={entry.key} data-connection-card-account={entry.key}> · {entry.value}</span>)}
            </span>
            <StatusPill connection={connection} />
          </div>
          <div className="connection-meta">
            {accountLine({ source, connection, shownIn: 'meta' }).map((entry) => <span key={entry.key} data-connection-card-account={entry.key}>{entry.value} · </span>)}
            {source?.tokenLabel ?? '토큰'} ••••{connection.tokenTail} · {formatDate(connection.addedAt)} 추가 · {formatChecked(connection.checkedAt)}
          </div>
        </div>
        <button type="button" className="connection-btn" data-connection-test onClick={() => void test()} disabled={connection.status === 'testing'}>연결 테스트</button>
        <button type="button" className="connection-btn is-danger" data-connection-remove onClick={onRemove}>해제</button>
      </div>
      {connection.status === 'testing' && connection.pending === 'keychain' ? (
        <div className="connection-notice" data-connection-pending="keychain">
          키체인에서 토큰을 읽는 중입니다. macOS 가 접근을 물으면 「허용」 을 누르세요 — corral 을 새로 설치한 뒤에는 다시 물을 수 있습니다.
        </div>
      ) : null}
      {connection.error === null ? null : (
        <div className="connection-error" data-connection-error={connection.status}>
          <span className="connection-error-text">{connection.error.message}</span>
          {connection.error.action === 'replace_token' ? <button type="button" className="connection-link" onClick={onReplaceToken}>토큰 다시 붙여넣기</button> : null}
          {connection.error.action === 'retry' ? <button type="button" className="connection-link" onClick={() => void test()}>다시 시도</button> : null}
        </div>
      )}
      {shownTestError === null || connection.error !== null ? null : (
        <div className="connection-error" data-connection-test-error={shownTestError.kind} role="alert">
          <span className="connection-error-text">연결 테스트 실패: {shownTestError.message}</span>
        </div>
      )}
      <div className="connection-spaces">
        <div className="connection-spaces-title">스페이스 · 작업 페이지에 보일 것</div>
        {spaces === null ? (
          <div className="connection-spaces-empty" data-connection-spaces-empty>{connection.status === 'testing' ? '스페이스 목록을 받는 중…' : '스페이스 목록을 아직 받지 못했습니다 — 연결 테스트로 받아 옵니다.'}</div>
        ) : (
          spaces.map((space, index) => <SpaceRow key={space.key} connection={connection} space={space} index={index} visibleCount={visibleCount} />)
        )}
      </div>
    </div>
  )
}

function RemoveConfirm({ connection, onCancel, onDone }: { connection: WorkConnectionSummary; onCancel: () => void; onDone: () => void }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    const result = await window.corral.removeWorkConnection({ connectionId: connection.id })
    if (result.ok) onDone()
    else setError(result.error.message)
  }
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div className="modal modal-confirm" data-connection-remove-confirm={connection.id} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title">{connection.name} 연결을 해제할까요?</h2>
          <button className="modal-close" aria-label="닫기" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">저장된 토큰을 지웁니다. 작업은 서비스에 그대로 남고, 이 연결로 붙은 worktree 링크는 다시 연결하면 브랜치 이름으로 되살아납니다.</p>
        </div>
        {error === null ? null : <p className="modal-note">해제하지 못했습니다: {error}</p>}
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onCancel}>취소</button>
          <button className="btn-danger" data-connection-remove-ok onClick={() => void remove()}>해제</button>
        </div>
      </div>
    </div>
  )
}

function RepoDefaultRow({ repo, state, first }: { repo: ConnectionsRepo; state: WorkSettingsState; first: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = state.repoDefaults.find((entry) => entry.repoRoot === repo.root) ?? null
  const options = state.connections.flatMap((connection) =>
    (connection.spaces ?? [])
      .map((space, index) => ({ connection, space, index }))
      .filter(({ space }) => !space.hidden),
  )
  const chosenConnection = current === null ? null : state.connections.find((connection) => connection.id === current.connectionId) ?? null
  const chosenIndex = chosenConnection?.spaces?.findIndex((space) => space.key === current?.spaceKey) ?? -1
  const chosen = chosenIndex < 0 ? null : chosenConnection?.spaces?.[chosenIndex] ?? null
  const label = current === null ? '지정 안 함' : chosen === null ? (chosenConnection?.spaces === null ? '불러오는 중' : '없는 스페이스') : chosen.name
  const pick = async (target: { connectionId: string; spaceKey: string } | null): Promise<void> => {
    setOpen(false)
    // 저장 실패(파일 쓰기 등)는 이 줄에 보인다(R2-E).
    const result = await window.corral.setRepoDefaultSpace({ repoRoot: repo.root, target })
    setError(result.ok ? null : result.error.message)
  }
  return (
    <div className={`repo-default${first ? '' : ' has-sep'}`} data-repo-default-space={repo.name}>
      <span className="repo-default-name" title={repo.root}>{repo.name}</span>
      <button type="button" className="connection-btn repo-default-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="connection-space-dot" style={{ background: chosen === null ? 'var(--fg-faint)' : spaceColor({ color: chosen.color, index: chosenIndex }) }} />
        {label}
      </button>
      {/* main 문구가 이미 「저장하지 못했습니다 (…)」 — 접두사를 다시 붙이지 않는다(LIFE-615). 줄은 행 아래 전폭(settings.css). */}
      {error === null ? null : <span className="connection-space-error" role="alert" data-repo-default-error>{error}</span>}
      {open ? (
        <div className="repo-default-menu" role="menu">
          <button type="button" role="menuitem" className="repo-default-option" onClick={() => void pick(null)}>
            <span className="repo-default-option-label">지정 안 함</span>
          </button>
          {options.map(({ connection, space, index }) => (
            <button key={`${connection.id}:${space.key}`} type="button" role="menuitem" className="repo-default-option" onClick={() => void pick({ connectionId: connection.id, spaceKey: space.key })}>
              <span className="connection-space-dot" style={{ background: spaceColor({ color: space.color, index }) }} />
              <span className="repo-default-option-label">{space.name}</span>
              <span className="repo-default-option-conn">{connection.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ConnectionsSection({ repos }: { repos: readonly ConnectionsRepo[] }): React.JSX.Element {
  const state = useWorkSettings() ?? EMPTY
  const [adding, setAdding] = useState<Adding | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const openSeq = useRef(0)
  const openForm = (target: { sourceId: string; replaceId: string | null }): void => {
    openSeq.current += 1
    setAdding({ ...target, openId: openSeq.current })
  }
  const autoTested = useRef(new Set<string>())
  // 이 화면이 열렸는데 이번 실행에서 아직 안 읽은 연결 — 한 번만 테스트해 스페이스 목록을 받는다(자격은 이때 풀린다). 테스트는 카드가 한다.
  const claimAutoTest = useCallback((connectionId: string): boolean => {
    if (autoTested.current.has(connectionId)) return false
    autoTested.current.add(connectionId)
    return true
  }, [])
  // 폼 완료는 자기가 연 그 폼이 아직 열려 있을 때만 닫는다(R5-A) — 저장을 기다리는 동안 다른 폼을 열었으면(같은 출처·연결로 다시 연 것 포함) 그 폼·초안을 둔다.
  // 다시 연 폼은 key(`openId`)가 달라 새 인스턴스라, 옛 저장의 결과(토큰 비우기·오류)도 새 폼에 닿지 않는다.
  const closeForm = (target: Adding): void => setAdding((current) => (current === target ? null : current))

  const addingSource = adding === null ? null : state.sources.find((source) => source.id === adding.sourceId) ?? null
  const removingConnection = removing === null ? null : state.connections.find((connection) => connection.id === removing) ?? null

  return (
    <>
      <section className="settings-appearance-block" data-settings-block="connections">
        <SettingsSubsectionHeader
          title="연결"
          action={
            <div className="connection-add-buttons">
              {state.sources.map((source) => (
                <button key={source.id} type="button" className="connection-btn" data-connection-add={source.id} onClick={() => openForm({ sourceId: source.id, replaceId: null })}>
                  {source.addLabel}
                </button>
              ))}
            </div>
          }
        />
        <div className="connection-list">
          {addingSource === null || adding === null ? null : <ConnectionForm key={adding.openId} source={addingSource} adding={adding} replacing={state.connections.find((connection) => connection.id === adding.replaceId) ?? null} onDone={() => closeForm(adding)} onCancel={() => setAdding(null)} />}
          {state.connections.length === 0 && adding === null ? <p className="connection-empty" data-connection-empty>아직 연결이 없습니다. 토큰을 붙여넣어 작업 관리 서비스를 연결하세요.</p> : null}
          {state.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              source={state.sources.find((source) => source.id === connection.sourceId) ?? null}
              claimAutoTest={claimAutoTest}
              onReplaceToken={() => openForm({ sourceId: connection.sourceId, replaceId: connection.id })}
              onRemove={() => setRemoving(connection.id)}
            />
          ))}
        </div>
      </section>

      <section className="settings-appearance-block" data-settings-block="repo-default-space">
        <SettingsSubsectionHeader title="레포 ↔ 기본 스페이스" description="이 레포의 worktree 에서 작업 페이지를 열면 이 스페이스가 먼저 열리고, 「시작」 할 때 이 레포가 기본으로 골라집니다." />
        <div className="repo-default-list">
          {repos.length === 0 ? <p className="connection-empty">등록된 레포가 없습니다.</p> : null}
          {repos.map((repo, index) => <RepoDefaultRow key={repo.root} repo={repo} state={state} first={index === 0} />)}
        </div>
      </section>

      {removingConnection === null ? null : <RemoveConfirm connection={removingConnection} onCancel={() => setRemoving(null)} onDone={() => setRemoving(null)} />}
    </>
  )
}
