// 모바일 서비스 (LIFE-577) — 서버·페어링·serve 노출을 하나로 묶는다. main(`index.ts`)은 이것 하나만 안다.
//
// - 켜기 = loopback 서버 시작 → serve 항목 reconcile. 끄기 = serve 항목 내림 + 서버 정지(연결 전부 닫힘) + 페어링 코드 폐기.
// - 꺼진 상태로 기동하면 **아무것도 열지 않고**, 소유권 기록이 없으면 tailscale 도 부르지 않는다(A1).
// - 종료(`shutdown`)는 마감 안에 serve 항목을 내리고 돌아온다 — 기존 `before-quit` 체인이 이것을 기다린다.
//   진행 중인 기동(listen·reconcile)을 같은 마감 안에서 기다린 뒤 닫는다 — 종료 뒤 새 listen·노출이 생기지 않는다(fix1 R1-A1).
// - 노출이 `exposed` 가 아니면 로컬 서버도 새 인증을 받지 않고 기존 연결을 닫는다(R1-A2) — serve 를 못 내린 채 막힌 경우에도.
// - 상태 push(`onStatus`)에는 토큰·코드가 없다(`MobileStatus`). 코드는 `createPairing` 응답에만 실린다.
// - **electron 을 모른다** — 버전·로그·push 를 주입받는다.
import path from 'node:path'
import QRCode from 'qrcode'
import type { MobilePairingResult, MobileStatus } from '../../shared/mobile.js'
import { ServeExposure } from './exposure.js'
import { fallbackMacName, readMacName } from './mac-name.js'
import { MAX_DEVICES, PairingStore } from './pairing.js'
import { pairingPayload } from './protocol.js'
import { MobileServer } from './server.js'
import { MOBILE_HTTPS_PORT, type TailscaleRunner } from './tailscale.js'

/** 켜진 동안 재확인 주기 — Funnel 감지 [E1] 는 60초 이하. */
export const MOBILE_RECHECK_MS = 30_000

export type MobileServiceDeps = {
  userData: string
  appVersion: string
  log: (tag: string, fields?: Record<string, unknown>) => void
  onStatus: (status: MobileStatus) => void
  locate: () => Promise<string | null>
  run: TailscaleRunner
  httpsPort?: number
  recheckMs?: number
  now?: () => number
  authTimeoutMs?: number
  /** 맥 이름 출처 — 없으면 `mac-name.ts` 의 scutil → hostname → 「Mac」. */
  readMacName?: () => Promise<string>
}

export class MobileService {
  private readonly deps: MobileServiceDeps
  private readonly pairing: PairingStore
  private readonly server: MobileServer
  private readonly exposure: ServeExposure
  private enabled = false
  private chain: Promise<void> = Promise.resolve()
  private exposureDone: Promise<void> = Promise.resolve()
  private recheck: NodeJS.Timeout | null = null
  private codeTimer: NodeJS.Timeout | null = null
  private closed = false
  private macName = fallbackMacName()

  constructor(deps: MobileServiceDeps) {
    this.deps = deps
    const dir = path.join(deps.userData, 'mobile')
    this.pairing = new PairingStore({ dir, now: deps.now })
    this.pairing.load()
    const onChange = (): void => this.push()
    this.server = new MobileServer({
      pairing: this.pairing,
      appVersion: deps.appVersion,
      macName: () => this.macName,
      log: deps.log,
      onChange,
      authTimeoutMs: deps.authTimeoutMs,
      accepting: () => this.exposure.exposure().kind === 'exposed',
      allowedOrigin: () => {
        const exposure = this.exposure.exposure()
        return exposure.kind === 'exposed' ? `https://${exposure.host}:${exposure.httpsPort}` : null
      },
    })
    const onExposure = (): void => {
      if (this.exposure.exposure().kind !== 'exposed') this.server.disconnectAll()
      this.push()
    }
    // 컴퓨터 이름은 기동 때 한 번 읽는다 — 읽기 전·실패면 hostname 값 그대로.
    void (deps.readMacName ?? (() => readMacName()))().then((name) => { this.macName = name }, () => {})
    this.exposure = new ServeExposure({ dir, httpsPort: deps.httpsPort ?? MOBILE_HTTPS_PORT, locate: deps.locate, run: deps.run, log: deps.log, onChange: onExposure })
  }

  /** 기동 — 저장된 스위치 값으로. 꺼져 있으면 남은 기록만 정리한다(기록이 없으면 아무것도 안 부른다). */
  start(enabled: boolean): Promise<void> {
    this.recheck = setInterval(() => void this.exposure.tick(), this.deps.recheckMs ?? MOBILE_RECHECK_MS)
    this.recheck.unref()
    return this.setEnabled(enabled)
  }

  /** 스위치 — 연타해도 마지막 값으로 수렴한다. 돌려준 약속은 serve reconcile 까지 끝나야 풀린다(시험용). */
  setEnabled(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.enabled = enabled
    this.chain = this.chain.then(() => this.sync()).catch((error: unknown) => this.deps.log('mobile.sync_failed', { error: String(error) }))
    return this.chain.then(() => this.exposureDone)
  }

  private async sync(): Promise<void> {
    if (this.closed) return
    if (this.enabled) {
      const port = await this.server.start()
      // listen 을 기다리는 사이 종료가 들어왔다 — 노출을 올리지 않는다(서버는 shutdown 이 닫는다).
      if (this.closed) return
      this.exposureDone = this.exposure.apply({ on: true, serverPort: port })
    } else {
      this.clearCode()
      this.exposureDone = this.exposure.apply({ on: false })
      await this.server.stop()
    }
    this.push()
  }

  status(): MobileStatus {
    const connected = this.server.connectedDeviceIds()
    return {
      enabled: this.enabled,
      serverPort: this.server.listeningPort(),
      checklist: this.exposure.checklist(),
      exposure: this.exposure.exposure(),
      warning: this.exposure.lastWarning(),
      devices: this.pairing.list().map((device) => ({ ...device, connected: connected.has(device.id) })),
      maxDevices: MAX_DEVICES,
      pairingExpiresAt: this.pairing.pairingExpiresAt(),
    }
  }

  /** 페어링 QR — 켜져 있고 serve 로 노출된 동안만. 응답에만 코드가 실린다(로그·push 없음). */
  createPairing(): MobilePairingResult {
    const exposure = this.exposure.exposure()
    if (!this.enabled || this.server.listeningPort() === null) return { ok: false, error: '모바일이 꺼져 있다' }
    if (exposure.kind !== 'exposed') return { ok: false, error: 'Tailscale 로 노출된 뒤에 QR 을 만들 수 있다' }
    if (this.pairing.list().length >= MAX_DEVICES) return { ok: false, error: `기기 상한(${MAX_DEVICES}대)에 닿았다 — 기기를 해지한 뒤 다시` }
    const { code, expiresAt } = this.pairing.createCode()
    const payload = pairingPayload({ url: exposure.url, code })
    const matrix = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules
    let cells = ''
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) cells += matrix.get(row, col) ? '1' : '0'
    }
    this.armCodeTimer(expiresAt)
    this.deps.log('mobile.pairing_code_created', { expiresAt })
    this.push()
    return { ok: true, code, expiresAt, url: exposure.url, payload, qr: { size: matrix.size, cells } }
  }

  /** 개별 해지 — 지우고 그 기기의 열린 연결을 닫는다(A4ⓔ). */
  revoke(id: string): boolean {
    const removed = this.pairing.revoke(id)
    if (removed) {
      this.server.disconnectDevice(id)
      this.deps.log('mobile.device_revoked', { device: id })
      this.push()
    }
    return removed
  }

  /** 「다시 확인」 — 꺼져 있으면 읽기 점검만. */
  recheckNow(): Promise<void> {
    return this.exposure.probe()
  }

  /** 종료 — serve 항목 내림(마감 안) + 서버 정지. 거부하지 않는다. */
  async shutdown(deadlineMs: number): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.recheck !== null) clearInterval(this.recheck)
    this.recheck = null
    this.clearCode()
    // 진행 중인 기동을 마감 안에서 기다린다 — 남은 시간으로 serve 를 내리고 서버를 닫는다.
    const started = Date.now()
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs) })
    await Promise.race([this.chain, deadline])
    if (timer !== null) clearTimeout(timer)
    const remaining = Math.max(0, deadlineMs - (Date.now() - started))
    await Promise.all([this.exposure.shutdown(remaining), this.server.stop()])
  }

  /** 시험·계측용 — 지금 소유권 기록. */
  ownerRecord(): ReturnType<ServeExposure['readRecord']> {
    return this.exposure.readRecord()
  }

  private clearCode(): void {
    this.pairing.clearCode()
    if (this.codeTimer !== null) clearTimeout(this.codeTimer)
    this.codeTimer = null
  }

  private armCodeTimer(expiresAt: number): void {
    if (this.codeTimer !== null) clearTimeout(this.codeTimer)
    const now = this.deps.now ?? Date.now
    this.codeTimer = setTimeout(() => {
      this.codeTimer = null
      this.push()
    }, Math.max(0, expiresAt - now()) + 50)
    this.codeTimer.unref()
  }

  private push(): void {
    this.deps.onStatus(this.status())
  }
}
