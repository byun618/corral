// 설정 › 설정 시작 › 일반 (LIFE-516 S36·S37 · K2). Orca 198 `GeneralPane.tsx:124-160`(탐색 › 핀 탭 확인) ·
// Orca main #21569(v1.4.206+, 탐색 › 핀 탭 행 바로 아래 실행 중 터미널 확인 — 198 은 되돌리는 컨트롤이 없는 결함, 00-analysis A2·D1) ·
// `GeneralWorkspaceSettingsSection.tsx:104-136`(워크스페이스 › 삭제 확인)을 옮겼다.
// corral 은 **확인 대화상자 행 셋만** 둔다(D6) — 탭 순서·디렉터리·편집기·CLI·업데이트는 S38·S39 의도적.
// 셋 다 「켜짐 = 묻는다」 로 보인다 — skip 칸 둘은 값 반전(Orca 와 같다). 토글 = `updateSettings` 1회.
import type { Settings } from '../../../shared/terminal-settings.js'
import { updateSettings, useSettings } from '../settings-store.js'
import { SettingsRow, SettingsSubsectionHeader, SettingsSwitch } from './SettingsControls.js'

function ConfirmRow({ id, label, description, checked, patch }: { id: string; label: string; description: string; checked: boolean; patch: (next: boolean) => Partial<Settings> }): React.JSX.Element {
  return (
    <div data-settings-general-row={id}>
      <SettingsRow label={label} description={description} control={<SettingsSwitch checked={checked} label={label} onChange={(next) => void updateSettings(patch(next))} />} />
    </div>
  )
}

export function GeneralSection(): React.JSX.Element {
  const settings = useSettings()
  return (
    <>
      <section className="settings-appearance-block" data-settings-block="general-navigation">
        <SettingsSubsectionHeader title="탐색" />
        <div className="settings-indent settings-rows">
          <ConfirmRow
            id="confirm-close-pinned-tab"
            label="고정된 탭을 닫기 전에 확인"
            description="고정된 탭을 닫기 전에 확인 대화상자를 표시합니다."
            checked={settings.confirmClosePinnedTab}
            patch={(next) => ({ confirmClosePinnedTab: next })}
          />
          <ConfirmRow
            id="confirm-close-running-terminal"
            label="실행 중인 터미널을 닫기 전에 확인"
            description="터미널을 닫을 때 실행 중인 에이전트나 명령을 중지하기 전에 묻습니다."
            checked={!settings.skipCloseTerminalWithRunningProcessConfirm}
            patch={(next) => ({ skipCloseTerminalWithRunningProcessConfirm: !next })}
          />
        </div>
      </section>
      <section className="settings-appearance-block" data-settings-block="general-workspace">
        <SettingsSubsectionHeader title="워크스페이스" />
        <div className="settings-indent settings-rows">
          <ConfirmRow
            id="confirm-delete-worktree"
            label="워크트리를 삭제하기 전에 확인"
            description="사이드바에서 워크트리를 삭제하기 전에 확인 대화상자를 표시합니다. 꺼도 커밋하지 않은 변경이나 실행 중인 세션이 있으면 묻습니다."
            checked={!settings.skipDeleteWorktreeConfirm}
            patch={(next) => ({ skipDeleteWorktreeConfirm: !next })}
          />
        </div>
      </section>
    </>
  )
}
