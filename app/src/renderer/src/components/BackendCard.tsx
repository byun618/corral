// 백엔드 연결 상태 카드 (LIFE-485 D3) — 링크가 live 가 아닐 때 원인과 행동을 보인다.
//
// 사이드바가 비는 자리가 원인 안내가 없는 자리였다. 메인 영역 빈 상태 자리에 카드를 둔다.
// 결정은 main 이 한다(`decideBackend`) — 여기는 받은 상태를 그리고, 버튼은 main 에 「시작」 을 요청할 뿐이다.

import type { BackendStatus, RestoreSummary } from '../../../shared/types.js'

/**
 * 미설치 카드의 안내 (LIFE-556). 설치본은 herdr 를 앱에 넣어 쓴다 — 못 찾으면 번들이 상한 것이라 재설치가 답이다.
 * 개발 실행은 레포 guard 를 빌드해 쓴다(LIFE-561) — 빌드 명령은 `app/backend/README.md` 와 같은 문자열이다.
 * 어느 쪽도 패키지 관리자 설치를 권하지 않는다 — 설치본 사용자에게 별도 herdr 는 필요 없다.
 */
export const BUNDLED_MISSING_HINT = 'corral 을 다시 설치하세요 — dmg 의 corral 을 응용 프로그램 폴더에 다시 복사합니다'
/** 레포 guard 빌드 명령 (LIFE-561) — 레포 루트(어느 worktree 든)에서 돈다. */
export const DEV_GUARD_BUILD_COMMAND = 'npm --prefix app run herdr:guard'
export const DEV_MISSING_HINT = `개발 실행: 레포 루트에서 ${DEV_GUARD_BUILD_COMMAND} 로 herdr 를 빌드하세요 (app/backend/README.md)`
export const DEV_STALE_HINT = `레포 루트에서 ${DEV_GUARD_BUILD_COMMAND} 로 다시 빌드하면 자동으로 연결합니다 (app/backend/README.md)`

export function restoreLine(restore: RestoreSummary): string {
  if (!restore.known) return `다시 붙을 에이전트 세션 수를 확인할 수 없습니다 (${restore.reason})`
  if (restore.total === 0) return '다시 붙을 에이전트 세션이 없습니다'
  const kinds = restore.agents.map((agent) => `${agent.kind} ${agent.count}`).join(' · ')
  return `서버를 시작하면 에이전트 세션 ${restore.total}개가 다시 붙습니다 (${kinds})`
}

/** 연결 실패 카드 문구 (LIFE-532 02-kickoff 고정 문구). */
export const UNREACHABLE_SCAN_TITLE = 'herdr 세션 목록을 읽지 못했습니다'
export const UNREACHABLE_SCAN_LINE = '세션 조회가 계속 실패하고 있습니다. 서버가 돌고 있는지 확인할 수 없습니다'
export const UNREACHABLE_LINK_LINE = '자동으로 다시 연결하지 않는 오류입니다'

export function BackendCard({ status, onStart, onRetry }: { status: BackendStatus; onStart: () => void; onRetry: () => void }): React.JSX.Element | null {
  switch (status.kind) {
    case 'ok':
      return null
    case 'confirm':
      return (
        <Card status={status} title={status.reason === 'exited' ? `herdr 서버(${status.session})가 멈췄습니다` : `herdr 서버(${status.session})가 꺼져 있습니다`}>
          <span className="backend-card-line" data-backend-restore={status.restore.known ? String(status.restore.total) : 'unknown'}>
            {restoreLine(status.restore)}
          </span>
          <button className="btn-accent" data-backend-start onClick={onStart}>
            서버 시작
          </button>
        </Card>
      )
    case 'starting':
      return (
        <Card status={status} title={`herdr 서버(${status.session})를 시작하는 중입니다`}>
          <span className="backend-card-line">준비되면 자동으로 연결합니다</span>
        </Card>
      )
    case 'failed':
      return (
        <Card status={status} title={`herdr 서버(${status.session})를 시작하지 못했습니다`}>
          <pre className="backend-card-error" data-backend-error>
            {status.error}
          </pre>
          {status.logPath === null ? null : <span className="backend-card-hint">로그: {status.logPath}</span>}
          <button className="btn-ghost" data-backend-start onClick={onStart}>
            다시 시도
          </button>
        </Card>
      )
    case 'missing':
      return (
        <Card status={status} title={status.bundled ? '앱에 들어 있는 herdr 를 찾지 못했습니다' : 'herdr 를 찾지 못했습니다'}>
          <span className="backend-card-line">찾아 본 위치</span>
          <ul className="backend-card-list">
            {status.searched.map((place) => (
              <li key={place}>{place}</li>
            ))}
          </ul>
          <span className="backend-card-hint" data-backend-install={status.bundled ? 'bundled' : 'dev'}>
            {status.bundled ? BUNDLED_MISSING_HINT : DEV_MISSING_HINT}
          </span>
        </Card>
      )
    case 'stale':
      return (
        <Card status={status} title="레포 guard herdr 가 이 체크아웃과 맞지 않습니다">
          <span className="backend-card-line" data-backend-stale-reason>
            {status.reason}
          </span>
          <ul className="backend-card-list">
            <li>{status.path}</li>
          </ul>
          <span className="backend-card-hint" data-backend-install="dev-stale">
            {DEV_STALE_HINT}
          </span>
        </Card>
      )
    case 'bound-stopped':
      return (
        <Card
          status={status}
          title={status.reason === 'bound' ? `지정된 herdr 세션 ${status.session} 이(가) 멈춰 있습니다` : `붙어 있던 herdr 세션 ${status.session} 이(가) 멈췄습니다`}
        >
          <span className="backend-card-line">이 세션은 corral 이 시작하지 않습니다. 터미널에서 직접 시작하면 자동으로 연결합니다</span>
        </Card>
      )
    case 'unreachable':
      // 기존 `failed` 카드와 같은 모양(오류 원문 + 「다시 시도」). 버튼은 「서버 시작」 경로가 아니라 재조회·링크 다시 열기다.
      return (
        <Card status={status} title={status.cause === 'scan' ? UNREACHABLE_SCAN_TITLE : `herdr 세션 ${status.session} 에 연결하지 못했습니다`}>
          <span className="backend-card-line">{status.cause === 'scan' ? UNREACHABLE_SCAN_LINE : UNREACHABLE_LINK_LINE}</span>
          <pre className="backend-card-error" data-backend-error>
            {status.error}
          </pre>
          <button className="btn-ghost" data-backend-retry onClick={onRetry}>
            다시 시도
          </button>
        </Card>
      )
    case 'reconnecting':
      // 서버는 돌고 링크만 끊긴 상태 — 카드로 터미널 화면을 걷지 않는다(r1 R1-01). App 이 배너(`BackendBanner`)로 그린다.
      return null
  }
}

/** 재연결 중 배너 — 터미널 영역 위에 겹쳐 뜬다. pane 격자는 그대로 마운트돼 있다(r1 R1-01). */
export function BackendBanner({ status }: { status: BackendStatus }): React.JSX.Element | null {
  if (status.kind !== 'reconnecting') return null
  return (
    <div className="backend-banner" data-backend-banner={status.kind} role="status">
      herdr 세션 {status.session} 에 다시 연결하는 중입니다 · 시도 {status.attempt}
    </div>
  )
}

/** 카드가 터미널 자리를 차지하는 상태인가 — `ok`·`reconnecting` 은 아니다. */
export function backendBlocksTerminal(status: BackendStatus): boolean {
  return status.kind !== 'ok' && status.kind !== 'reconnecting'
}

function Card({ status, title, children }: { status: BackendStatus; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="backend-card-wrap" data-backend-card={status.kind} data-backend-cause={status.kind === 'unreachable' ? status.cause : undefined}>
      <div className="backend-card">
        <span className="backend-card-title">{title}</span>
        {children}
      </div>
    </div>
  )
}
