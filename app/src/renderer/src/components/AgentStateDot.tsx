// 에이전트 상태 점 (LIFE-467 D5) — Orca 1.4.198 `AgentStateDot`(`components/AgentStateDot.tsx:80-170`) 이식.
//
// 점과 종류 아이콘은 **안 합친다** — "누가"(종류 아이콘)와 "어떤 상태인가"(이 점)를 각각 훑을 수 있어야 한다
// (Orca 같은 파일 머리 주석, corral H-6 두 칸 규칙). 크기는 사이드바 기본값 `sm` 하나만 둔다:
// 상자 10px · 안쪽 점 6px · 아이콘 10px (`h-2.5 w-2.5` · `size-1.5` · `size-2.5`).
//
// 아이콘은 Orca 가 쓰는 lucide-react 0.577.0 의 path 를 그대로 옮겼다(ISC) — 의존성을 늘리지 않는다.
// 스피너는 CSS 컴포지터 애니메이션이다(`styles.css` `.agent-dot-spinner` — Orca STA-3328 교훈: JS 시계로 돌리면
// 입력 스레드를 막는다).
import { AGENT_DOT_LABEL, type AgentDot } from '../agent-dot.js'

const STROKE: React.SVGProps<SVGSVGElement> = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }

function Lucide({ children, className = 'agent-dot-icon' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      {children}
    </svg>
  )
}

/** lucide `Activity` — 감시 중(monitoring). 워크트리 상태 슬롯(LIFE-468)도 같은 글리프를 쓴다. */
export function ActivityGlyph({ className = 'agent-dot-icon' }: { className?: string }): React.JSX.Element {
  return (
    <Lucide className={className}>
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </Lucide>
  )
}

/** lucide `MessageCircleQuestionMark` — 입력 대기. Orca `AgentQuestionIcon`. */
export function QuestionGlyph({ className = 'agent-dot-icon' }: { className?: string }): React.JSX.Element {
  return (
    <Lucide className={className}>
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </Lucide>
  )
}

function DotGlyph({ dot }: { dot: AgentDot }): React.JSX.Element {
  switch (dot) {
    case 'working':
      return <span className="agent-dot-spinner" />
    case 'monitoring':
      return <ActivityGlyph />
    case 'done':
      return (
        <Lucide>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </Lucide>
      )
    case 'unverifiable':
      return (
        <Lucide>
          <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
          <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
          <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
          <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
          <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
          <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
          <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
          <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
        </Lucide>
      )
    case 'waiting':
      return <QuestionGlyph />
    case 'blocked':
    case 'interrupted':
    case 'failed':
    case 'idle':
      return <span className="agent-dot-fill" />
  }
}

/** 상태 점 하나. `title` 을 주면 툴팁을 그 문구로 바꾼다(행 툴팁과 겹치지 않게 — 기본은 점의 뜻). */
export function AgentStateDot({ dot, title }: { dot: AgentDot; title?: string }): React.JSX.Element {
  const label = title ?? AGENT_DOT_LABEL[dot]
  return (
    <span className={`agent-dot dot-${dot}`} data-agent-dot={dot} title={label} aria-label={label}>
      <DotGlyph dot={dot} />
    </span>
  )
}

/** 셰브론 — Orca 는 lucide `ChevronRight`(행 자식 펼침)·`ChevronDown`(알약)을 쓴다. */
export function Chevron({ direction, className }: { direction: 'right' | 'down'; className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d={direction === 'right' ? 'm9 18 6-6-6-6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

/** lucide `Folder` — 레포 헤더 아이콘 (LIFE-468 D21, Orca `RepoIconGlyph` 폴백의 끝). corral 은 아이콘 지정이 없어 항상 이것이다. */
export function FolderIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

/** lucide `Ellipsis` — 더보기. */
export function EllipsisIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  )
}

/** lucide `Plus`. */
export function PlusIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}
