// 설정 › 원격 호스트 › Mobile (LIFE-577 A8) — 스위치 · Tailscale 점검표 · tailnet 주소 · 페어링 QR · 기기 목록·해지가 한 절에.
// 상태는 main push(`corral:mobile`)만 진실로 쓴다 — 토큰·코드는 거기 없다. 코드는 「QR 만들기」 응답에서 받아 이 컴포넌트 상태에만 두고,
// main 이 「유효 코드 없음」(사용·만료·끄기)을 알리면 바로 지운다.
// QR 은 인라인 SVG 로 그린다 — CSP `default-src 'self'` 가 data-URL 이미지를 막는다(F5).
import { useEffect, useState } from 'react'
import type { MobileCheck, MobileExposure, MobilePairingResult, MobileQr, MobileStatus } from '../../../shared/mobile.js'
import { updateSettings, useSettings } from '../settings-store.js'
import { SettingsRow, SettingsSubsectionHeader, SettingsSwitch } from './SettingsControls.js'

type Pairing = Extract<MobilePairingResult, { ok: true }>

function useMobileStatus(): MobileStatus | null {
  const [status, setStatus] = useState<MobileStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.corral.getMobileStatus().then((value) => {
      if (alive && value !== null) setStatus((current) => current ?? value)
    })
    const off = window.corral.onMobileStatus((value) => setStatus(value))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

const CHECK_LABELS: { key: 'cli' | 'loggedIn' | 'https' | 'funnelOff'; label: string }[] = [
  { key: 'cli', label: 'Tailscale CLI' },
  { key: 'loggedIn', label: '로그인' },
  { key: 'https', label: 'HTTPS 인증서' },
  { key: 'funnelOff', label: 'Funnel 꺼짐' },
]

function CheckMark({ check }: { check: MobileCheck }): React.JSX.Element {
  const mark = check.state === 'ok' ? '✓' : check.state === 'fail' ? '✗' : '–'
  return <span className={`mobile-check-mark is-${check.state}`} aria-label={check.state}>{mark}</span>
}

function exposureText(exposure: MobileExposure, enabled: boolean): string {
  switch (exposure.kind) {
    case 'off': return enabled ? '확인 중' : '꺼짐 — 아무 포트도 열지 않는다'
    case 'checking': return '확인 중'
    case 'exposed': return `노출됨 — HTTPS ${exposure.httpsPort}`
    case 'blocked':
    case 'foreign':
    case 'failed':
      return exposure.message
  }
}

export function MobileQrCode({ qr, label }: { qr: MobileQr; label: string }): React.JSX.Element {
  const quiet = 4
  const span = qr.size + quiet * 2
  let d = ''
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (qr.cells[row * qr.size + col] === '1') d += `M${col + quiet} ${row + quiet}h1v1h-1z`
    }
  }
  return (
    <svg className="mobile-qr" data-mobile-qr viewBox={`0 0 ${span} ${span}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={span} height={span} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}

function formatTime(ms: number | null): string {
  return ms === null ? '없음' : new Date(ms).toLocaleString('ko-KR')
}

export function MobileSection(): React.JSX.Element {
  const settings = useSettings()
  const status = useMobileStatus()
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [pairError, setPairError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // main 이 유효 코드가 없다고 하면(사용·만료·끄기) 화면의 코드도 지운다.
  useEffect(() => {
    if (status !== null && status.pairingExpiresAt === null) setPairing(null)
  }, [status])

  const enabled = settings.mobileEnabled
  const exposure: MobileExposure = status?.exposure ?? { kind: 'off' }
  const createPairing = async (): Promise<void> => {
    setPairError(null)
    const result = await window.corral.createMobilePairing()
    if (result.ok) setPairing(result)
    else {
      setPairing(null)
      setPairError(result.error)
    }
  }
  const recheck = async (): Promise<void> => {
    setBusy(true)
    try { await window.corral.recheckMobile() } finally { setBusy(false) }
  }

  return (
    <>
      <section className="settings-appearance-block" data-settings-block="mobile-switch">
        <SettingsSubsectionHeader title="Mobile" description="폰에서 tailnet 으로 이 맥의 corral 에 붙습니다. 서버는 127.0.0.1 에만 열리고 tailscale serve 로만 닿습니다." />
        <div className="settings-indent settings-rows">
          <div data-settings-mobile-row="enabled">
            <SettingsRow
              label="Mobile 켜기"
              description="꺼 두면 아무 포트도 열지 않고 Tailscale 도 부르지 않습니다. 켜 둔 상태는 다시 실행해도 유지됩니다."
              control={<SettingsSwitch checked={enabled} label="Mobile 켜기" onChange={(next) => void updateSettings({ mobileEnabled: next })} />}
            />
          </div>
        </div>
      </section>

      <section className="settings-appearance-block" data-settings-block="mobile-checklist">
        <SettingsSubsectionHeader
          title="Tailscale 점검"
          description="넷 다 ✓ 일 때만 노출합니다. Funnel 이 켜져 있으면 노출하지 않습니다."
          action={<button type="button" className="settings-ghostty-import" data-mobile-recheck disabled={busy} onClick={() => void recheck()}>다시 확인</button>}
        />
        <div className="settings-indent settings-rows">
          {CHECK_LABELS.map(({ key, label }) => {
            const check: MobileCheck = status?.checklist[key] ?? { state: 'unknown', detail: '확인 안 함' }
            return (
              <div key={key} data-mobile-check={key} data-mobile-check-state={check.state}>
                <SettingsRow label={<><CheckMark check={check} /> {label}</>} description={check.detail} control={null} />
              </div>
            )
          })}
          <div data-mobile-exposure={exposure.kind}>
            <SettingsRow
              label="상태"
              description={exposureText(exposure, enabled)}
              control={exposure.kind === 'exposed' ? <code className="mobile-address" data-mobile-address>{exposure.url}</code> : null}
            />
          </div>
          {status?.warning ? <p className="mobile-warning" role="alert" data-mobile-warning>{status.warning}</p> : null}
        </div>
      </section>

      <section className="settings-appearance-block" data-settings-block="mobile-pairing">
        <SettingsSubsectionHeader
          title="페어링"
          description="QR 에는 tailnet 주소와 10분짜리 1회용 코드가 들어갑니다. 새 QR 을 만들면 이전 코드는 무효가 됩니다."
          action={<button type="button" className="settings-ghostty-import" data-mobile-create-pairing disabled={!enabled || exposure.kind !== 'exposed'} onClick={() => void createPairing()}>QR 만들기</button>}
        />
        <div className="settings-indent">
          {pairError === null ? null : <p className="mobile-warning" data-mobile-pair-error>{pairError}</p>}
          {pairing === null ? null : (
            <div className="mobile-pairing" data-mobile-pairing>
              <MobileQrCode qr={pairing.qr} label="페어링 QR" />
              <dl className="mobile-pairing-text">
                <dt>주소</dt>
                <dd><code data-mobile-pairing-url>{pairing.url}</code></dd>
                <dt>코드</dt>
                <dd><code className="mobile-code" data-mobile-pairing-code>{pairing.code}</code></dd>
                <dt>만료</dt>
                <dd>{formatTime(pairing.expiresAt)}</dd>
                <dt>QR 내용</dt>
                <dd><code className="mobile-payload" data-mobile-pairing-payload>{pairing.payload}</code></dd>
              </dl>
            </div>
          )}
        </div>
      </section>

      <section className="settings-appearance-block" data-settings-block="mobile-devices">
        <SettingsSubsectionHeader title={`기기 (${status?.devices.length ?? 0}/${status?.maxDevices ?? 5})`} description="해지하면 그 기기의 연결이 바로 끊기고 다시 붙지 못합니다." />
        <div className="settings-indent settings-rows">
          {status === null || status.devices.length === 0 ? <p className="settings-row-description mobile-empty" data-mobile-devices-empty>페어링된 기기가 없습니다.</p> : null}
          {(status?.devices ?? []).map((device) => (
            <div key={device.id} data-mobile-device={device.id}>
              <SettingsRow
                label={<>{device.connected ? <span className="mobile-connected" aria-label="연결됨">●</span> : null} {device.name}</>}
                description={`페어링 ${formatTime(device.pairedAt)} · 마지막 접속 ${formatTime(device.lastSeenAt)}`}
                control={<button type="button" className="settings-ghostty-import" data-mobile-revoke={device.id} onClick={() => void window.corral.revokeMobileDevice({ id: device.id })}>해지</button>}
              />
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
