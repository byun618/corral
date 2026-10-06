// 설정 › AI 기능 › 에이전트 (LIFE-515 S32 · K2). Orca 198 `AgentDefaultSetting.tsx`(pill)·`AgentsPane.tsx:240-247`(맨 위 「기본 Agent」)를 옮겼다.
// corral 은 이 섹션에 **기본 Agent 하나**만 둔다(D4) — 감지·활성 토글·명령·인자·env·상태 훅 등은 없다(S33·S34·S35 의도적, 감지는 LIFE-520).
// pill 은 고정 3종(D3 — 감지가 없어 「저장됐는데 미감지」 pill·title 도 없다). 클릭 = `updateSettings` 1회, 이미 선택된 pill 은 쓰지 않는다(K2ⓒ).
import type { DefaultAgent } from '../../../shared/terminal-settings.js'
import { useBindingLabel } from '../hooks/BindingLabels.js'
import { updateSettings, useSettings } from '../settings-store.js'
import { buildAgentLaunchOptions } from '../tab-create-menu.js'
import { AgentIcon } from './AgentIcon.js'
import { SettingsSubsectionHeader } from './SettingsControls.js'
import { CheckIcon, TerminalIcon } from './SidebarIcons.js'

const AGENT_OPTIONS = buildAgentLaunchOptions()

function DefaultAgentPill({ value, active, onSelect, children }: { value: DefaultAgent; active: boolean; onSelect: (value: DefaultAgent) => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" className={`settings-agent-pill${active ? ' is-active' : ''}`} aria-pressed={active} data-default-agent={value} onClick={() => onSelect(value)}>
      {children}
    </button>
  )
}

export function AgentsSection(): React.JSX.Element {
  const { defaultAgent } = useSettings()
  const bindingLabel = useBindingLabel()
  const chord = bindingLabel('terminal.newAgent')
  const select = (value: DefaultAgent): void => {
    if (value === defaultAgent) return
    void updateSettings({ defaultAgent: value })
  }
  // D5 — Orca 설명(명령 재정의·CLI 인수·실행 환경·SSH 원격)은 corral 에 없다. 이 값이 실제로 쓰이는 두 자리만 말한다.
  const description = `${chord === '' ? '새 에이전트 탭 단축키' : `새 에이전트 탭(${chord})`}과 탭바 + 메뉴의 맨 앞 에이전트에 쓰입니다. 자동은 목록의 첫 번째 agent(Claude)입니다.`
  return (
    <section className="settings-agent-default" data-settings-block="default-agent">
      <SettingsSubsectionHeader title="기본 Agent" description={description} />
      <div className="settings-agent-pills" role="group" aria-label="기본 Agent">
        <DefaultAgentPill value="auto" active={defaultAgent === 'auto'} onSelect={select}>
          {defaultAgent === 'auto' ? <CheckIcon className="settings-agent-pill-icon" /> : null}
          자동
        </DefaultAgentPill>
        <DefaultAgentPill value="blank" active={defaultAgent === 'blank'} onSelect={select}>
          <TerminalIcon className="settings-agent-pill-icon" />
          agent 없음(빈 terminal)
          {defaultAgent === 'blank' ? <CheckIcon className="settings-agent-pill-icon" /> : null}
        </DefaultAgentPill>
        {AGENT_OPTIONS.map((option) => (
          <DefaultAgentPill key={option.agent} value={option.agent} active={defaultAgent === option.agent} onSelect={select}>
            <AgentIcon kind={option.agent} glyph="" size={14} />
            {option.label}
            {defaultAgent === option.agent ? <CheckIcon className="settings-agent-pill-icon" /> : null}
          </DefaultAgentPill>
        ))}
      </div>
    </section>
  )
}
