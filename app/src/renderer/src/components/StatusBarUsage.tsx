// 상태바 왼쪽 사용량 슬롯의 칩·팝오버 (LIFE-636 E8). Orca `StatusBarSurface`·`ProviderPanel` 의 compact 패턴을 corral 토큰으로 옮겼다(00-analysis D5·D8).
//
// 칩 = provider 하나, 아이콘 + **가장 빡빡한 창의 사용률 %**. 자격 없음(`unavailable`)·꺼짐(`disabled`)은 칩이 없다.
// 상태별 모양(E8ⓑ): 첫 로딩 `···` · ok `NN%` · stale `NN% ⚠` · error `⚠ 짧은 사유`(만료면 「만료」 — 팝오버에 「<cli> 실행 시 갱신」).
// 색(E8ⓒ): 60% 미만 기본 · 60% 이상 주의(`--st-dirty`) · 80% 이상 경고(`--st-error`).
// 칩 클릭 = 팝오버(창마다 라벨·막대·%·초기화까지 남은 시간 · 마지막 갱신 · 오류 문구 · 새로고침). 열면 포커스가 팝오버 안으로, Esc = 닫고 칩으로 포커스, 바깥 클릭 = 닫기.
// 이 파일의 클래스(`.statusbar-usage-*`)·컴포넌트는 LIFE-637 이 가져다 쓰는 공개 API 가 아니다(킥오프 슬롯 계약 6).
import { useEffect, useRef, useState } from 'react'
import { expireStale, formatResetIn, tightestWindow, usageTone, type ProviderUsage, type ProviderUsageEntry, type UsageErrorKind } from '../../../shared/usage.js'
import { useNowTick } from '../hooks/useNowTick.js'
import { refreshUsage, useUsage } from '../usage-store.js'
import { AgentIcon } from './AgentIcon.js'
import { RefreshCwIcon } from './SidebarIcons.js'

const NOW_MS = 30_000
const POPOVER_WIDTH = 264

/** 칩에 자리를 차지하는가 — 자격 없음·꺼짐은 칩이 없다(E8ⓑ). */
export function showsChip(usage: ProviderUsage): boolean {
  switch (usage.status) {
    case 'loading':
    case 'ok':
    case 'stale':
    case 'error':
      return true
    case 'unavailable':
    case 'disabled':
      return false
  }
}

/** 칩의 짧은 사유 — 긴 문구는 팝오버에. */
export function shortReason(kind: UsageErrorKind): string {
  switch (kind) {
    case 'expired':
      return '만료'
    case 'forbidden':
      return '권한'
    case 'rate_limited':
      return '제한'
    case 'server':
      return '서버'
    case 'network':
      return '연결'
    case 'timeout':
      return '시간 초과'
    case 'parse':
      return '알 수 없음'
    case 'credential':
      return '자격 증명'
    case 'http':
      return '오류'
  }
}

function ProviderMark({ id, name }: { id: string; name: string }): React.JSX.Element {
  switch (id) {
    case 'claude':
      return <span className="statusbar-usage-icon agent-claude"><AgentIcon kind="claude" glyph="" size={11} /></span>
    case 'codex':
      return <span className="statusbar-usage-icon agent-codex"><AgentIcon kind="codex" glyph="" size={11} /></span>
    case 'grok':
      return <span className="statusbar-usage-icon agent-grok"><AgentIcon kind="grok" glyph="" size={11} /></span>
    default:
      return <span className="statusbar-usage-icon">{name.slice(0, 1)}</span>
  }
}

function ChipBody({ usage }: { usage: ProviderUsage }): React.JSX.Element | null {
  switch (usage.status) {
    case 'loading':
      return <span className="statusbar-usage-value is-loading">···</span>
    case 'ok':
    case 'stale': {
      const tight = tightestWindow(usage.windows)
      const value = tight === null ? '—' : `${Math.round(tight.usedPercent)}%`
      return (
        <>
          <span className={`statusbar-usage-value tone-${tight === null ? 'normal' : usageTone(tight.usedPercent)}`}>{value}</span>
          {usage.status === 'stale' ? <span className="statusbar-usage-warn" aria-label="오래된 값">⚠</span> : null}
        </>
      )
    }
    case 'error':
      return (
        <>
          <span className="statusbar-usage-warn" aria-hidden>⚠</span>
          <span className="statusbar-usage-reason">{shortReason(usage.error.kind)}</span>
        </>
      )
    case 'unavailable':
    case 'disabled':
      return null
  }
}

function chipTitle({ entry, usage }: { entry: ProviderUsageEntry; usage: ProviderUsage }): string {
  switch (usage.status) {
    case 'loading':
      return `${entry.name} 사용량 — 불러오는 중`
    case 'ok':
    case 'stale': {
      const tight = tightestWindow(usage.windows)
      const head = tight === null ? `${entry.name} 사용량` : `${entry.name} ${tight.label} ${Math.round(tight.usedPercent)}% 사용`
      return usage.status === 'stale' ? `${head} — 오래된 값: ${usage.error.message}` : head
    }
    case 'error':
      return `${entry.name} 사용량 — ${usage.error.message}`
    case 'unavailable':
      return `${entry.name} 사용량 — ${usage.reason}`
    case 'disabled':
      return `${entry.name} 사용량 — 꺼짐`
  }
}

function clockLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function agoLabel({ at, now }: { at: number; now: number }): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  return `${Math.floor(minutes / 60)}시간 전`
}

function PopoverBody({ usage, now }: { usage: ProviderUsage; now: number }): React.JSX.Element {
  switch (usage.status) {
    case 'loading':
      return <p className="statusbar-usage-pop-note">불러오는 중…</p>
    case 'ok':
    case 'stale':
      return (
        <>
          <ul className="statusbar-usage-windows">
            {usage.windows.map((window, index) => (
              <li key={`${index}:${window.label}`} className="statusbar-usage-window" data-statusbar-usage-window={window.label}>
                <div className="statusbar-usage-window-head">
                  <span className="statusbar-usage-window-label">{window.label}</span>
                  <span className={`statusbar-usage-window-pct tone-${usageTone(window.usedPercent)}`}>{Math.round(window.usedPercent)}% 사용</span>
                </div>
                <div className="statusbar-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.usedPercent)} aria-label={`${window.label} 사용률`}>
                  <div className={`statusbar-usage-bar-fill tone-${usageTone(window.usedPercent)}`} style={{ width: `${window.usedPercent}%` }} />
                </div>
                <div className="statusbar-usage-window-reset">{window.resetsAt === null ? '초기화 시각 모름' : `초기화까지 ${formatResetIn({ resetsAt: window.resetsAt, now })}`}</div>
              </li>
            ))}
          </ul>
          {usage.status === 'stale' ? <p className="statusbar-usage-pop-error" data-statusbar-usage-error>⚠ {usage.error.message} — 마지막 값을 보이는 중</p> : null}
          <p className="statusbar-usage-pop-note">갱신 {clockLabel(usage.updatedAt)} ({agoLabel({ at: usage.updatedAt, now })})</p>
        </>
      )
    case 'error':
      return <p className="statusbar-usage-pop-error" data-statusbar-usage-error>⚠ {usage.error.message}</p>
    case 'unavailable':
      return <p className="statusbar-usage-pop-note">{usage.reason}</p>
    case 'disabled':
      return <p className="statusbar-usage-pop-note">꺼짐</p>
  }
}

type Anchor = { id: string; left: number; bottom: number }

/** `suspended` — 팔레트·퀵오픈이 열려 상태바가 inert 일 때 팝오버를 닫는다. */
export function StatusBarUsage({ suspended = false }: { suspended?: boolean }): React.JSX.Element {
  const snapshot = useUsage()
  const now = useNowTick(NOW_MS)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const chips = useRef(new Map<string, HTMLButtonElement>())
  const popover = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (suspended) setAnchor(null)
  }, [suspended])

  // 열면 포커스를 팝오버 안으로(r1 R1-9) — 첫 버튼(새로고침). 버튼이 없으면 팝오버 자체. Esc 는 칩으로 되돌린다(아래).
  const openId = anchor?.id ?? null
  useEffect(() => {
    if (openId === null) return
    const node = popover.current
    if (node === null) return
    const target = node.querySelector<HTMLElement>('button') ?? node
    target.focus()
  }, [openId])

  useEffect(() => {
    if (anchor === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      chips.current.get(anchor.id)?.focus()
      setAnchor(null)
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popover.current?.contains(target) || chips.current.get(anchor.id)?.contains(target)) return
      setAnchor(null)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onPointer, true)
    }
  }, [anchor])

  const toggle = (id: string): void => {
    if (anchor?.id === id) {
      setAnchor(null)
      return
    }
    const chip = chips.current.get(id)
    const rect = chip?.getBoundingClientRect()
    const viewport = typeof window === 'undefined' ? 0 : window.innerWidth
    const height = typeof window === 'undefined' ? 0 : window.innerHeight
    setAnchor({
      id,
      left: rect === undefined ? 8 : Math.max(8, Math.min(rect.left, viewport - POPOVER_WIDTH - 8)),
      bottom: rect === undefined ? 32 : height - rect.top + 6,
    })
  }

  const visible = snapshot.providers.map((entry) => ({ entry, usage: expireStale({ usage: entry.usage, now }) })).filter(({ usage }) => showsChip(usage))
  const open = anchor === null ? undefined : visible.find(({ entry }) => entry.id === anchor.id)
  // 열린 팝오버의 provider 칩이 사라지면(로그아웃·끄기) anchor 를 비운다(r2 R2-7) — Esc 리스너가 남아 다른 Esc 를 삼키거나,
  // provider 가 돌아왔을 때 팝오버가 혼자 다시 뜨지 않게.
  const openGone = anchor !== null && open === undefined
  useEffect(() => {
    if (openGone) setAnchor(null)
  }, [openGone])

  return (
    <>
      {visible.map(({ entry, usage }) => (
        <button
          key={entry.id}
          type="button"
          ref={(node) => {
            if (node === null) chips.current.delete(entry.id)
            else chips.current.set(entry.id, node)
          }}
          className={`statusbar-usage-chip is-${usage.status}`}
          data-statusbar-usage-chip={entry.id}
          data-statusbar-usage-status={usage.status}
          aria-haspopup="dialog"
          aria-expanded={anchor?.id === entry.id}
          title={chipTitle({ entry, usage })}
          onClick={() => toggle(entry.id)}
        >
          <ProviderMark id={entry.id} name={entry.name} />
          <ChipBody usage={usage} />
        </button>
      ))}
      {open === undefined || anchor === null ? null : (
        <div
          ref={popover}
          className="statusbar-usage-popover"
          role="dialog"
          aria-label={`${open.entry.name} 사용량`}
          data-statusbar-usage-popover={open.entry.id}
          tabIndex={-1}
          style={{ left: anchor.left, bottom: anchor.bottom, width: POPOVER_WIDTH }}
        >
          <div className="statusbar-usage-pop-head">
            <ProviderMark id={open.entry.id} name={open.entry.name} />
            <span className="statusbar-usage-pop-title">{open.entry.name}</span>
            <button
              type="button"
              className="statusbar-usage-refresh"
              data-statusbar-usage-refresh
              // 갱신 중에도 `disabled` 를 쓰지 않는다(r2 R2-6) — 포커스를 가진 버튼이 비활성이 되면 Chromium 이 포커스를 body 로 보낸다.
              // 대신 aria-disabled 로 알리고 클릭은 무시한다(main 도 진행 중 요청을 같이 기다려 중복 요청은 없다).
              aria-disabled={open.entry.refreshing}
              aria-label="새로고침"
              title={open.entry.refreshing ? '갱신 중…' : '새로고침'}
              onClick={() => {
                if (!open.entry.refreshing) void refreshUsage(open.entry.id)
              }}
            >
              <RefreshCwIcon className={`statusbar-usage-refresh-icon${open.entry.refreshing ? ' is-spinning' : ''}`} />
            </button>
          </div>
          <PopoverBody usage={open.usage} now={now} />
        </div>
      )}
    </>
  )
}
