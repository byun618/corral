// design-handoff.md §2 SessionRow — 상태 글리프 + `제목 - 2차 줄`(한 칸에서 같이 잘린다) + 경과 시간.
// 클릭 → 해당 worktree 선택 + 세션(탭) 활성 (§4). 탭 닫기(L3·L4·L9a, 01-criteria C1)는 핸드오프
// 목업에 없는 동작이라 hover 시에만 드러나는 보조 버튼으로 얹는다(RepoRowActions 와 같은 결 —
// 밀도 유지 + 없어지지 않는 계약).
//
// ## 2줄 → **다시 1줄** (LIFE-366 C8, 수정 라운드 7) — 사용자 지시 "한줄로 가자"
//
// B1 이 이 행을 2줄로 만들었고(`--h-session-row-2` 30px), 그게 Orca 와 다른 자리였다. Orca 의
// 사이드바 행은 `flex h-6 items-center` 한 줄이고 제목과 2차 줄을 ` - ` 로 잇는다
// (`worktree-card-compact-agent-row.tsx:141-145`, `:230-245`). 사용자가 그 화면을 짚었다 —
// *"한줄로 가자. 아예 ORCA랑 같이 맞춰버려"*. 그래서 높이 토큰이 LIFE-357 C9(b) 의 21px 로
// 돌아온다: B1 이 그 통과선을 대체한 사유(2차 줄 자리)가 없어졌으니 원래 값이 다시 산다.
//
// ## **B4 는 폐기됐다** (C8-②)
//
// B4 는 "값이 없어도 2차 줄 슬롯을 남긴다" 였다 — 텍스트가 도착·소멸할 때 행 높이가 들썩이는
// 것을 막으려는 규칙. 한 줄이면 **구조상** 높이가 고정돼서 그 목적이 저절로 달성된다. 규칙이
// 필요 없어졌으므로 빈 슬롯(`\u{a0}`)을 그리지 않는다 — 2차 줄이 없으면 ` - ` 도 안 그린다.
import { useState } from 'react'
import type { IntegrationRow, PaneRow } from '../../../shared/types.js'
import { elapsedLabel, paneSecondaryLine, sessionRowText } from '../session-activity.js'
import { agentIcon, GLYPH, STATUS_LABEL } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { paneSessionTitle } from '../session-title.js'
export function SessionRow({
  pane,
  ordinal,
  home,
  active,
  integrations,
  now,
  onSelect,
  onClose,
}: {
  pane: PaneRow
  ordinal: number
  home: string
  active: boolean
  integrations: readonly IntegrationRow[]
  /** 흐르는 「지금」 — 경과 시간이 얼지 않게 한 곳에서 틱을 받는다 (`useNowTick`). */
  now: number
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const { glyph, tone } = GLYPH[pane.agentStatus]
  // H-6 — 상태 글리프와 **별도 칸**이다. 모르는 종류면 칸 자체를 안 그린다(부재, 빈 칸 아님).
  const kind = agentIcon(pane.agent)
  const secondary = paneSecondaryLine({ pane, integrations })
  const text = sessionRowText({ title: paneSessionTitle({ pane, ordinal, home }), secondary })
  const elapsed = elapsedLabel(pane.digest.lastActivityAt, now)
  return (
    <div
      className={`session-row ${active ? 'is-active' : ''}`}
      data-tab={pane.tabId}
      data-pane={pane.paneId}
      data-secondary={secondary.kind}
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
      {/* 상태 말은 **글리프가 쥔다** — 행 툴팁은 이제 글 전문의 것이다 (C8). 둘을 같은
          `title` 에 겹치면 전문이 상태 단어에 가려진다. */}
      <span className={`session-row-glyph tone-${tone}`} title={STATUS_LABEL[pane.agentStatus]}>
        {glyph}
      </span>
      {kind === null ? null : (
        <span className={`session-row-agent agent-${kind.kind}`} data-agent-kind={kind.kind} title={kind.label}>
          <AgentIcon kind={kind.kind} glyph={kind.glyph} />
        </span>
      )}
      {/* **글 칸 하나** — 제목과 2차 줄이 여기서 같이 잘린다. 전문은 툴팁이 쥔다 (C8,
          Orca `worktree-card-compact-agent-row.tsx:230-245` 와 같은 모양). */}
      <span className="session-row-text" title={text.full}>
        <span className="session-row-title">{text.leading}</span>
        {text.trailing === null ? null : (
          <span className={`session-row-second ${secondary.kind === 'notice' ? 'is-notice' : ''}`} data-second-kind={secondary.kind}>
            {' - '}
            {text.trailing}
          </span>
        )}
      </span>
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
        data-close-pane={pane.paneId}
        title="세션 닫기"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}
