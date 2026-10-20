// 설정 › 외관 › 상태바 (LIFE-636 E9) — provider 별 사용량 칩 스위치(기본 켬). 값은 `settings.json` 칸(`statusBarUsage*`)이고
// main 이 저장 뒤 사용량 서비스에 알린다: 끄면 칩이 사라지고 조회가 멈추며(키체인·파일·네트워크 접근 0), 켜면 즉시 1회 조회한다.
// 자격 증명이 없는 provider(main 이 `unavailable` 로 본 것)는 스위치 옆에 「로그인 정보 없음」. 꺼 둔 provider 는 자격을 보지 않으므로 표시가 없다.
// LIFE-637 이 상태바 토글을 더하려면 636 출고 뒤 이 카드에 행을 더한다(킥오프 슬롯 계약 7).
import type { Settings } from '../../../shared/terminal-settings.js'
import { USAGE_SETTING_ROWS, type UsageSettingKey } from '../../../shared/usage.js'
import { updateSettings, useSettings } from '../settings-store.js'
import { useUsage } from '../usage-store.js'
import { SettingsCollapsibleCard, SettingsRow, SettingsSwitch } from './SettingsControls.js'
import { GaugeIcon } from './SidebarIcons.js'

function usagePatch({ key, value }: { key: UsageSettingKey; value: boolean }): Partial<Settings> {
  switch (key) {
    case 'statusBarUsageClaude':
      return { statusBarUsageClaude: value }
    case 'statusBarUsageCodex':
      return { statusBarUsageCodex: value }
    case 'statusBarUsageGrok':
      return { statusBarUsageGrok: value }
  }
}

export function StatusBarCard({ query }: { query: string }): React.JSX.Element {
  const settings = useSettings()
  const snapshot = useUsage()
  const on = USAGE_SETTING_ROWS.filter((row) => settings[row.key]).map((row) => row.name)
  return (
    <SettingsCollapsibleCard id="statusbar" icon={<GaugeIcon className="settings-icon" />} title="상태바" summary={on.length === 0 ? '사용량 표시 없음' : `사용량 ${on.join('·')}`} forceOpen={query.trim() !== ''}>
      <section className="settings-appearance-block" data-settings-block="statusbar-usage">
        <div className="settings-rows">
          {USAGE_SETTING_ROWS.map((row) => {
            const signedOut = snapshot.providers.find((entry) => entry.id === row.id)?.usage.status === 'unavailable'
            return (
              <SettingsRow
                key={row.id}
                label={`${row.name} 사용량`}
                description={`상태바에 ${row.name} 한도 사용률을 표시합니다. 끄면 사용량을 조회하지 않습니다.`}
                control={
                  <span className="statusbar-settings-control" data-statusbar-usage-setting={row.id}>
                    {signedOut ? <span className="statusbar-settings-note" data-statusbar-usage-signed-out>로그인 정보 없음</span> : null}
                    <SettingsSwitch checked={settings[row.key]} label={`${row.name} 사용량`} onChange={(next) => void updateSettings(usagePatch({ key: row.key, value: next }))} />
                  </span>
                }
              />
            )
          })}
        </div>
      </section>
    </SettingsCollapsibleCard>
  )
}
