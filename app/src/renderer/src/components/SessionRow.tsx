// design-handoff.md §2 SessionRow — 상태 글리프 + 제목(말줄임) + **2차 줄** + 경과 시간.
// 클릭 → 해당 worktree 선택 + 세션(탭) 활성 (§4). 탭 닫기(L3·L4·L9a, 01-criteria C1)는 핸드오프
// 목업에 없는 동작이라 hover 시에만 드러나는 보조 버튼으로 얹는다(RepoRowActions 와 같은 결 —
// 밀도 유지 + 없어지지 않는 계약).
//
// ## 1줄 → 2줄로 바뀌었다 (LIFE-366 B1) — **LIFE-357 C9(b) 를 의도적으로 대체한다**
//
// `--h-session-row: 21px` 에는 "C9 통과선이라 손대지 않는다" 는 경고가 붙어 있었다
// (design-tokens.css). 이 일감이 그 줄을 바꾼다: 행에 2차 줄을 얹는 것이 **일감의 본체**이고
// (B1), 높이를 그대로 두면 2차 줄을 그릴 자리가 없다. 경고는 "이 라운드에서 건드리지 마라" 는
// 뜻이었지 영구 동결이 아니라서, 바꾸는 대신 **왜 바꿨는지를 남기고** 토큰 원본
// (`specs/design-tokens.css`)에도 역반영한다.
//
// ## 2차 줄은 **값이 없어도 슬롯을 남긴다** (B4)
//
// Orca 가 같은 자리에 명시적 규칙으로 적어 둔 것이다("message slot is always reserved in
// collapsed view so the row height stays fixed as assistant text arrives or clears",
// `DashboardAgentRowMessage.tsx`). 텍스트가 도착·소멸할 때 목록 전체가 들썩이는 것을 막는다 —
// 취향이 아니라 리스트가 흔들리지 않게 하는 규칙이라 조건부 렌더링을 쓰지 않는다.
import { useState } from 'react'
import type { IntegrationRow, TabRow } from '../../../shared/types.js'
import { elapsedLabel, secondaryLine } from '../session-activity.js'
import { agentIcon, GLYPH, STATUS_LABEL } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { sessionTitle, tabAgent } from '../session-title.js'
export function SessionRow({
  tab,
  active,
  integrations,
  now,
  onSelect,
  onClose,
}: {
  tab: TabRow
  active: boolean
  integrations: readonly IntegrationRow[]
  /** 흐르는 「지금」 — 경과 시간이 얼지 않게 한 곳에서 틱을 받는다 (`useNowTick`). */
  now: number
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const { glyph, tone } = GLYPH[tab.agentStatus]
  // H-6 — 상태 글리프와 **별도 칸**이다. 모르는 종류면 칸 자체를 안 그린다(부재, 빈 칸 아님).
  const kind = agentIcon(tabAgent(tab))
  const secondary = secondaryLine({ tab, integrations })
  const elapsed = elapsedLabel(tab.digest.lastActivityAt, now)
  return (
    <div
      className={`session-row ${active ? 'is-active' : ''}`}
      data-tab={tab.tabId}
      data-tab-order={tab.order}
      data-tab-number={tab.number}
      data-secondary={secondary.kind}
      title={STATUS_LABEL[tab.agentStatus]}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // ⚠ 버블링을 끊는다 (11-gate1-fix3.md I-6). 이 행은 `.worktree-block` **안에** 있고
      // 그 블록의 onClick 은 `selectFirstSession` 이다 — 안 끊으면 "클릭한 세션 선택" 직후
      // "그 worktree 의 첫 세션 선택"이 덮어써서, 어느 행을 눌러도 첫 탭이 열린다.
      // 실측으로 잡았다(raw/gate1-fix3/i6-session-click.json 1차 실행: activeTabId 가 t1 고정).
      // 같은 파일의 닫기 버튼이 이미 쓰는 관용구다.
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
      {/* 왼쪽 거터 — 글리프와 종류 아이콘은 **두 줄에 걸친다**. 이 칸을 1차 줄 안에 두면
          2차 줄이 거터만큼 어긋나서, 맞추려고 들여쓰기 상수를 지어내게 된다. 실제로 처음엔
          그렇게 했다가 실측에서 30.7px 어긋났다 (raw/claude/app-sessions.json 1차 실행).
          거터를 밖으로 빼면 2차 줄이 **구조상** 제목 왼쪽 끝에 맞는다 (B3) — 종류 아이콘이
          없는 행에서도 자동으로 맞는다. */}
      <div className="session-row-gutter">
        <span className={`session-row-glyph tone-${tone}`}>{glyph}</span>
        {kind === null ? null : (
          <span className={`session-row-agent agent-${kind.kind}`} data-agent-kind={kind.kind} title={kind.label}>
            <AgentIcon kind={kind.kind} glyph={kind.glyph} />
          </span>
        )}
      </div>
      <div className="session-row-body">
        <div className="session-row-line">
          <span className="session-row-title">{sessionTitle(tab)}</span>
          <div className="session-row-spacer" />
          {/* 경과 시각이 **실재할 때만** 그린다 (D1). 없으면 칸 자체가 없다 — 지어낸 수 대신 부재. */}
          {elapsed === null ? null : (
            <span className="session-row-elapsed" data-elapsed={elapsed}>
              {elapsed}
            </span>
          )}
          {/* hover 로만 opacity 를 바꾼다 — 조건부 렌더링하면 좌표/elementFromPoint 클릭이
              hover 없이는(mousemove 없이 click 만 보내는 계측 채널) 못 찾는다(WorktreeBlock 과 같은 결). */}
          <button
            className={`session-row-close ${hovered ? 'is-active' : ''}`}
            data-close-tab={tab.tabId}
            title="탭 닫기"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            ×
          </button>
        </div>
        {/* **항상 그린다** — 빈 값이어도 슬롯이 남아야 행 높이가 안 튄다 (B4). */}
        <div
          className={`session-row-second ${secondary.kind === 'notice' ? 'is-notice' : ''}`}
          data-second-kind={secondary.kind}
          title={secondary.kind === 'empty' ? undefined : secondary.text}
        >
          {secondary.kind === 'empty' ? '\u{a0}' : secondary.text}
        </div>
      </div>
    </div>
  )
}
