// 백엔드 연결 상태 카드 (LIFE-485 D3) — 링크가 live 가 아닐 때 원인과 행동을 보인다.
//
// 사이드바가 비는 자리가 원인 안내가 없는 자리였다. 메인 영역 빈 상태 자리에 카드를 둔다.
// 결정은 main 이 한다(`decideBackend`) — 여기는 받은 상태를 그리고, 버튼은 main 에 「시작」 을 요청할 뿐이다.

import type { BackendStatus, RestoreSummary } from '../../../shared/types.js'

export function restoreLine(restore: RestoreSummary): string {
  if (!restore.known) return `다시 붙을 에이전트 세션 수를 확인할 수 없습니다 (${restore.reason})`
  if (restore.total === 0) return '다시 붙을 에이전트 세션이 없습니다'
  const kinds = restore.agents.map((agent) => `${agent.kind} ${agent.count}`).join(' · ')
  return `서버를 시작하면 에이전트 세션 ${restore.total}개가 다시 붙습니다 (${kinds})`
}

export function BackendCard({ status, onStart }: { status: BackendStatus; onStart: () => void }): React.JSX.Element | null {
  switch (status.kind) {
    case 'ok':
      return null
    case 'confirm':
      return (
        <Card kind={status.kind} title={status.reason === 'exited' ? `herdr 서버(${status.session})가 멈췄습니다` : `herdr 서버(${status.session})가 꺼져 있습니다`}>
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
        <Card kind={status.kind} title={`herdr 서버(${status.session})를 시작하는 중입니다`}>
          <span className="backend-card-line">준비되면 자동으로 연결합니다</span>
        </Card>
      )
    case 'failed':
      return (
        <Card kind={status.kind} title={`herdr 서버(${status.session})를 시작하지 못했습니다`}>
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
        <Card kind={status.kind} title="herdr 를 찾지 못했습니다">
          <span className="backend-card-line">찾아 본 위치</span>
          <ul className="backend-card-list">
            {status.searched.map((place) => (
              <li key={place}>{place}</li>
            ))}
          </ul>
        </Card>
      )
    case 'bound-stopped':
      return (
        <Card kind={status.kind} title={`herdr 세션 ${status.session} 이(가) 멈춰 있습니다`}>
          <span className="backend-card-line">이 세션은 corral 이 시작하지 않습니다. 터미널에서 직접 시작하면 자동으로 연결합니다</span>
        </Card>
      )
    case 'reconnecting':
      return (
        <Card kind={status.kind} title={`herdr 세션 ${status.session} 에 다시 연결하는 중입니다`}>
          <span className="backend-card-line">시도 {status.attempt}</span>
        </Card>
      )
  }
}

function Card({ kind, title, children }: { kind: BackendStatus['kind']; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="backend-card-wrap" data-backend-card={kind}>
      <div className="backend-card">
        <span className="backend-card-title">{title}</span>
        {children}
      </div>
    </div>
  )
}
