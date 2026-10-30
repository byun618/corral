// 설정 › AI 기능 › 에이전트 (LIFE-515 S32 · K2). Orca 198 `AgentDefaultSetting.tsx`(pill)·`AgentsPane.tsx:240-247`(맨 위 「기본 Agent」)를 옮겼다.
// corral 은 이 섹션에 **기본 Agent 하나**만 둔다(D4) — 활성 토글·명령·인자·env·상태 훅 등은 없다(S34·S35 의도적).
// pill 은 감지된 에이전트만(LIFE-520 S33). 감지 전·실패면 고정 3종(base). 저장됐는데 미감지인 명시값은 pill 하나로 남기고 「저장된 기본값이 감지되지 않음」 을 붙인다.
// 클릭 = `updateSettings` 1회, 이미 선택된 pill 은 쓰지 않는다(K2ⓒ). 감지 결과로 저장값을 고쳐 쓰지 않는다(LIFE-520 K4ⓔ).
import type { AgentDetectionSnapshot } from '../../../shared/agent-detection.js'
import type { DefaultAgent } from '../../../shared/terminal-settings.js'
import { refreshAgentDetection, useAgentDetection, useAgentDetectionRefreshing } from '../agent-detection-store.js'
import { useBindingLabel } from '../hooks/BindingLabels.js'
import { updateSettings, useSettings } from '../settings-store.js'
import { agentLabel, autoAgent, buildAgentLaunchOptions, explicitDefaultAgent, isAgentAvailable } from '../tab-create-menu.js'
import { AgentIcon } from './AgentIcon.js'
import { SettingsSubsectionHeader } from './SettingsControls.js'
import { CheckIcon, TerminalIcon } from './SidebarIcons.js'

function DefaultAgentPill({ value, active, onSelect, children, title }: { value: DefaultAgent; active: boolean; onSelect: (value: DefaultAgent) => void; children: React.ReactNode; title?: string }): React.JSX.Element {
  return (
    <button type="button" className={`settings-agent-pill${active ? ' is-active' : ''}`} aria-pressed={active} data-default-agent={value} title={title} onClick={() => onSelect(value)}>
      {children}
    </button>
  )
}

/** 자동 설명 — 그 순간 자동이 실제로 여는 것. 감지 전·실패면 base 문장(카탈로그 첫 번째 Claude). */
export function autoDescription(detection: AgentDetectionSnapshot): string {
  const agent = autoAgent(detection)
  switch (detection.kind) {
    case 'unknown':
      return `자동은 목록의 첫 번째 agent(${agent === null ? 'Claude' : agentLabel(agent)})입니다.`
    case 'detected':
      return agent === null ? '감지된 agent가 없어 자동은 빈 terminal을 엽니다.' : `자동은 감지된 agent 중 첫 번째(${agentLabel(agent)})입니다.`
  }
}

export function AgentsSection(): React.JSX.Element {
  const { defaultAgent } = useSettings()
  const detection = useAgentDetection()
  const refreshing = useAgentDetectionRefreshing()
  const bindingLabel = useBindingLabel()
  const chord = bindingLabel('terminal.newAgent')
  const select = (value: DefaultAgent): void => {
    if (value === defaultAgent) return
    void updateSettings({ defaultAgent: value })
  }
  const options = buildAgentLaunchOptions(detection)
  const saved = explicitDefaultAgent(defaultAgent)
  // 저장됐는데 감지되지 않은 명시값 — 그 pill 하나만 남긴다(Orca `AgentDefaultSetting` 의 「저장된 기본값」 pill).
  const missingSaved = saved !== null && !isAgentAvailable({ agent: saved, detection }) ? saved : null
  const noneDetected = detection.kind === 'detected' && options.length === 0
  // D5 — Orca 설명(명령 재정의·CLI 인수·실행 환경·SSH 원격)은 corral 에 없다. 이 값이 실제로 쓰이는 두 자리만 말한다.
  const description = `${chord === '' ? '새 에이전트 탭 단축키' : `새 에이전트 탭(${chord})`}과 탭바 + 메뉴의 맨 앞 에이전트에 쓰입니다. ${autoDescription(detection)}`
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
        {options.map((option) => (
          <DefaultAgentPill key={option.agent} value={option.agent} active={defaultAgent === option.agent} onSelect={select}>
            <AgentIcon kind={option.agent} glyph="" size={14} />
            {option.label}
            {defaultAgent === option.agent ? <CheckIcon className="settings-agent-pill-icon" /> : null}
          </DefaultAgentPill>
        ))}
        {missingSaved === null ? null : (
          <DefaultAgentPill value={missingSaved} active onSelect={select} title="저장된 기본값이 감지되지 않음">
            <AgentIcon kind={missingSaved} glyph="" size={14} />
            {agentLabel(missingSaved)}
            <CheckIcon className="settings-agent-pill-icon" />
            <span className="settings-agent-pill-note" data-default-agent-missing="">저장된 기본값이 감지되지 않음</span>
          </DefaultAgentPill>
        )}
      </div>
      <div className="settings-agent-detect">
        {noneDetected ? <span className="settings-agent-detect-empty" data-agent-detect-empty="">감지된 agents가 없습니다</span> : null}
        <button type="button" className="settings-agent-detect-refresh" data-agent-detect-refresh="" disabled={refreshing} onClick={() => void refreshAgentDetection()}>
          {refreshing ? '감지 중…' : '다시 감지'}
        </button>
      </div>
    </section>
  )
}
