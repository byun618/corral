// `tailscale serve` 노출 상태기계 (LIFE-577 A6·A7) — corral 자기 항목 하나만 올리고 내린다.
//
// 상태: off · checking · blocked(이유) · foreign · failed · exposed. 화면은 이것과 점검표 4줄을 그대로 보여 준다.
//
// **소유권 기록**(`<dir>/serve-owner.json`, 0600): `{host, httpsPort, target}`. 지우는 것은 serve 설정의 그 포트 항목이
// **기록과 같을 때만**(호스트·대상 둘 다). 포트만 보고 지우지 않는다(00-analysis W2·W5).
// - 추가 **전에** 기록을 쓴다 — 추가 직후 죽어도 다음 기동이 그 항목을 자기 것으로 알아본다. 추가가 안 됐으면 기록만 지운다.
// - 같은 포트에 기록과 다른 항목 = 남의 것 → 덮어쓰지 않고 `foreign`(기록도 버린다 — 더는 우리 것이 아니다).
//
// **reconcile 은 한 줄로만 돈다**(`request`) — 스위치 연타·주기 재확인·종료가 겹쳐도 마지막 원하는 값으로 수렴한다(A6ⓖ).
// **꺼져 있고 기록도 없으면 tailscale 을 부르지 않는다**(A1ⓒ). 사용자가 「다시 확인」 을 누를 때만 읽기 점검을 한다.
// 호출 전 사전 점검 — CLI · 로그인 · HTTPS 인증서(`CertDomains` 에 자기 이름, W4) · Funnel 꺼짐 [E1]. 하나라도 ✗ 이면 serve 를 부르지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from '../../runtime/storage.js'
import { isRecord, readNumber, readString } from '../../shared/json.js'
import {
  TAILSCALE_READ_TIMEOUT_MS,
  TAILSCALE_WRITE_TIMEOUT_MS,
  funnelOn,
  parseNodeStatus,
  parseServeConfig,
  portUse,
  serveAddArgs,
  serveRemoveArgs,
  serveStatusArgs,
  serveTarget,
  statusArgs,
  type NodeStatus,
  type TailscaleRunner,
} from './tailscale.js'
import type { MobileBlockReason, MobileCheck, MobileChecklist, MobileExposure } from '../../shared/mobile.js'

type Check = MobileCheck
type Checklist = MobileChecklist
type BlockReason = MobileBlockReason
type Exposure = MobileExposure

export type OwnerRecord = { host: string; httpsPort: number; target: string }

type Desired = { on: false } | { on: true; serverPort: number }

export type ServeExposureDeps = {
  dir: string
  httpsPort: number
  locate: () => Promise<string | null>
  run: TailscaleRunner
  log: (tag: string, fields?: Record<string, unknown>) => void
  onChange: () => void
}

const UNKNOWN: Check = { state: 'unknown', detail: '확인 안 함' }
export const UNKNOWN_CHECKLIST: Checklist = { cli: UNKNOWN, loggedIn: UNKNOWN, https: UNKNOWN, funnelOff: UNKNOWN }

export const HTTPS_HINT = 'Tailscale 관리 콘솔 › DNS › HTTPS Certificates 를 켠다'

export class ServeExposure {
  private readonly deps: ServeExposureDeps
  private readonly recordFile: string
  private desired: Desired = { on: false }
  private pending = false
  private probeOnly = false
  private running: Promise<void> | null = null
  private bin: string | null = null
  private abort = new AbortController()
  private state: Exposure = { kind: 'off' }
  private checks: Checklist = UNKNOWN_CHECKLIST
  private warning: string | null = null

  constructor(deps: ServeExposureDeps) {
    this.deps = deps
    this.recordFile = path.join(deps.dir, 'serve-owner.json')
  }

  exposure(): Exposure {
    return this.state
  }

  checklist(): Checklist {
    return this.checks
  }

  /** 켜진 동안 Funnel 때문에 내렸을 때 남기는 경고. 다시 켜지거나 끄면 지운다. */
  lastWarning(): string | null {
    return this.warning
  }

  /** 원하는 값을 바꾸고 reconcile 을 줄 세운다. 돌려준 약속은 **줄이 빌 때** 풀린다. */
  apply(desired: Desired): Promise<void> {
    this.desired = desired
    if (!desired.on) this.warning = null
    return this.request()
  }

  /** 주기 재확인 — 켜져 있거나, 꺼졌는데 기록이 남았을 때(제거 실패 마무리)만 돈다. 그 밖엔 아무것도 부르지 않는다. */
  tick(): Promise<void> {
    if (!this.desired.on && this.readRecord() === null) return Promise.resolve()
    return this.request()
  }

  /** 「다시 확인」 — 꺼져 있어도 읽기 점검만 한다(serve 쓰기 없음). */
  probe(): Promise<void> {
    if (this.desired.on || this.readRecord() !== null) return this.request()
    this.probeOnly = true
    return this.request()
  }

  /** 종료 — 원하는 값을 꺼짐으로, `deadlineMs` 안에 끝나지 않으면 진행 중 tailscale 자식을 죽이고 돌아온다. 거부하지 않는다. */
  async shutdown(deadlineMs: number): Promise<void> {
    this.desired = { on: false }
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs) })
    const outcome = await Promise.race([this.request().then(() => 'done' as const), deadline])
    if (timer !== null) clearTimeout(timer)
    if (outcome === 'deadline') {
      this.deps.log('mobile.serve_shutdown_deadline', { deadlineMs })
      this.abort.abort()
    }
  }

  private request(): Promise<void> {
    this.pending = true
    if (this.running === null) {
      this.running = this.loop().finally(() => { this.running = null })
    }
    return this.running
  }

  private async loop(): Promise<void> {
    while (this.pending) {
      this.pending = false
      const desired = this.desired
      const probeOnly = this.probeOnly
      this.probeOnly = false
      try {
        await this.reconcile({ desired, probeOnly })
      } catch (error) {
        this.set({ kind: 'failed', message: `내부 오류: ${String(error)}` })
        this.deps.log('mobile.serve_error', { error: String(error) })
      }
    }
  }

  private set(state: Exposure): void {
    this.state = state
    this.deps.onChange()
  }

  private async reconcile(input: { desired: Desired; probeOnly: boolean }): Promise<void> {
    const { desired } = input
    const record = this.readRecord()
    if (!desired.on && record === null && !input.probeOnly) {
      this.checks = UNKNOWN_CHECKLIST
      this.set({ kind: 'off' })
      return
    }
    if (desired.on) this.set({ kind: 'checking' })

    // ① CLI
    const bin = await this.resolveBin()
    if (bin === null) {
      this.checks = { ...UNKNOWN_CHECKLIST, cli: { state: 'fail', detail: 'tailscale CLI 를 찾지 못했다' } }
      return this.settleBlocked({ desired, reason: 'cli', message: 'Tailscale CLI 를 찾지 못했다 — Tailscale 앱을 설치하거나 「CLI integration」 을 켠다', record })
    }
    const cli: Check = { state: 'ok', detail: bin }

    // ② 로그인 · ③ HTTPS — `status --json`
    const statusRun = await this.call(statusArgs(), TAILSCALE_READ_TIMEOUT_MS)
    const status: NodeStatus | null = statusRun.ok ? parseNodeStatus(statusRun.stdout) : null
    if (status === null) {
      this.checks = { ...UNKNOWN_CHECKLIST, cli, loggedIn: { state: 'fail', detail: statusRun.ok ? 'status 출력을 읽지 못했다' : `tailscale 응답 없음(${statusRun.detail})` } }
      return this.settleBlocked({ desired, reason: 'unreadable', message: 'Tailscale 상태를 읽지 못했다 — Tailscale 이 실행 중인지 확인한다', record })
    }
    const loggedIn: Check = status.running
      ? { state: 'ok', detail: status.dnsName ?? '이름 없음' }
      : { state: 'fail', detail: `상태 ${status.backendState ?? '알 수 없음'}` }
    const https: Check = !status.running
      ? UNKNOWN
      : status.https
        ? { state: 'ok', detail: `인증서 도메인에 ${status.dnsName}` }
        : { state: 'fail', detail: HTTPS_HINT }

    // ④ Funnel — `serve status --json`. 이 값으로 우리 포트의 소유권도 본다.
    const serveRun = status.running ? await this.call(serveStatusArgs(), TAILSCALE_READ_TIMEOUT_MS) : null
    const config = serveRun !== null && serveRun.ok ? parseServeConfig(serveRun.stdout) : null
    const funnel = config === null ? null : funnelOn(config)
    const funnelOff: Check = funnel === null
      ? (status.running ? { state: 'fail', detail: 'serve 설정을 읽지 못했다' } : UNKNOWN)
      : funnel ? { state: 'fail', detail: 'Funnel 이 켜져 있다 — 끄기 전엔 노출하지 않는다' } : { state: 'ok', detail: '꺼짐' }
    this.checks = { cli, loggedIn, https, funnelOff }

    if (input.probeOnly && !desired.on && record === null) {
      this.set({ kind: 'off' })
      return
    }
    if (!status.running) return this.settleBlocked({ desired, reason: 'logged_out', message: 'Tailscale 에 로그인되어 있지 않다', record })
    if (config === null) return this.settleBlocked({ desired, reason: 'unreadable', message: 'serve 설정을 읽지 못했다 — 아무것도 바꾸지 않았다', record })

    const use = portUse({ config, port: this.deps.httpsPort })
    const ours = record !== null && use.kind === 'proxy' && use.host === record.host && use.target === record.target && record.httpsPort === this.deps.httpsPort

    // 꺼짐(또는 막힘) 쪽 — 우리 항목만 내린다.
    if (!desired.on) {
      if (ours) {
        const removed = await this.remove()
        if (!removed) return
      } else if (record !== null) {
        this.deleteRecord('not_ours_or_gone')
      }
      this.set({ kind: 'off' })
      return
    }
    if (funnel === true) {
      const wasExposed = this.state.kind === 'exposed' || ours
      if (ours) await this.remove()
      if (wasExposed) this.warning = 'Funnel 이 켜져 corral 항목을 내렸다'
      this.deps.log('mobile.serve_blocked', { reason: 'funnel', removed: ours })
      this.set({ kind: 'blocked', reason: 'funnel', message: 'Funnel 이 켜져 있다 — Funnel 을 끄기 전엔 노출하지 않는다' })
      return
    }
    if (!status.https || status.dnsName === null) {
      if (ours) await this.remove()
      this.set({ kind: 'blocked', reason: 'https', message: `tailnet HTTPS 인증서가 꺼져 있다 — ${HTTPS_HINT}` })
      return
    }

    const host = status.dnsName
    const target = serveTarget(desired.serverPort)
    if (ours && record.target === target) {
      return this.set(this.exposedState(host))
    }
    if (ours) {
      // 대상(서버 포트)이 바뀌었다 — 비정상 종료 뒤 재기동. 내리고 다시 올린다.
      if (!(await this.remove())) return
    } else if (use.kind !== 'free') {
      if (record !== null) this.deleteRecord('foreign')
      this.deps.log('mobile.serve_foreign', { httpsPort: this.deps.httpsPort })
      this.set({ kind: 'foreign', message: `HTTPS 포트 ${this.deps.httpsPort} 를 다른 항목이 쓰고 있다 — 덮어쓰지 않는다` })
      return
    }
    await this.add({ host, target, serverPort: desired.serverPort })
  }

  private async add(input: { host: string; target: string; serverPort: number }): Promise<void> {
    this.writeRecord({ host: input.host, httpsPort: this.deps.httpsPort, target: input.target })
    const run = await this.call(serveAddArgs({ httpsPort: this.deps.httpsPort, serverPort: input.serverPort }), TAILSCALE_WRITE_TIMEOUT_MS)
    // 결과를 믿지 않고 다시 읽어 확인한다 — 「추가했다」 는 serve 설정에 우리 모양이 보일 때만.
    const after = await this.call(serveStatusArgs(), TAILSCALE_READ_TIMEOUT_MS)
    const config = after.ok ? parseServeConfig(after.stdout) : null
    const use = config === null ? null : portUse({ config, port: this.deps.httpsPort })
    if (use !== null && use.kind === 'proxy' && use.host === input.host && use.target === input.target) {
      this.deps.log('mobile.serve_added', { httpsPort: this.deps.httpsPort, target: input.target })
      this.warning = null
      this.set(this.exposedState(input.host))
      return
    }
    if (use !== null && use.kind === 'free') this.deleteRecord('add_failed')
    this.deps.log('mobile.serve_add_failed', { detail: run.ok ? 'not_visible' : run.detail })
    this.set({ kind: 'failed', message: `serve 항목을 올리지 못했다(${run.ok ? '설정에 보이지 않음' : run.detail}) — 다시 확인에서 재시도한다` })
  }

  /** 우리 항목 제거 — 성공(다시 읽어 그 포트가 비었음)하면 기록도 지운다. 실패면 기록을 남겨 다음 재확인이 마무리한다. */
  private async remove(): Promise<boolean> {
    const run = await this.call(serveRemoveArgs({ httpsPort: this.deps.httpsPort }), TAILSCALE_WRITE_TIMEOUT_MS)
    const after = await this.call(serveStatusArgs(), TAILSCALE_READ_TIMEOUT_MS)
    const config = after.ok ? parseServeConfig(after.stdout) : null
    if (config !== null && portUse({ config, port: this.deps.httpsPort }).kind === 'free') {
      this.deleteRecord('removed')
      this.deps.log('mobile.serve_removed', { httpsPort: this.deps.httpsPort })
      return true
    }
    this.deps.log('mobile.serve_remove_failed', { detail: run.ok ? 'still_visible' : run.detail })
    this.set({ kind: 'failed', message: `serve 항목을 내리지 못했다(${run.ok ? '설정에 남음' : run.detail}) — 다음 재확인에서 다시 내린다` })
    return false
  }

  private settleBlocked(input: { desired: Desired; reason: BlockReason; message: string; record: OwnerRecord | null }): void {
    if (!input.desired.on) {
      // 끄려는데 tailscale 을 못 본다 — 기록이 있으면 남은 항목일 수 있다. 기록을 지우지 않고 다음 재확인에 맡긴다.
      if (input.record !== null) {
        this.set({ kind: 'failed', message: `serve 항목을 확인하지 못했다 — ${input.message}` })
        return
      }
      this.set({ kind: 'off' })
      return
    }
    this.deps.log('mobile.serve_blocked', { reason: input.reason })
    this.set({ kind: 'blocked', reason: input.reason, message: input.message })
  }

  private exposedState(host: string): Exposure {
    return { kind: 'exposed', host, httpsPort: this.deps.httpsPort, url: `wss://${host}:${this.deps.httpsPort}/ws` }
  }

  private async resolveBin(): Promise<string | null> {
    if (this.bin !== null && fs.existsSync(this.bin)) return this.bin
    this.bin = await this.deps.locate()
    return this.bin
  }

  private call(args: string[], timeoutMs: number): ReturnType<TailscaleRunner> {
    const bin = this.bin
    if (bin === null) return Promise.resolve({ ok: false, reason: 'spawn', detail: 'CLI 없음' })
    return this.deps.run({ bin, args, timeoutMs, signal: this.abort.signal })
  }

  readRecord(): OwnerRecord | null {
    let parsed: unknown
    try { parsed = JSON.parse(fs.readFileSync(this.recordFile, 'utf8')) } catch { return null }
    if (!isRecord(parsed)) return null
    const host = readString(parsed, 'host')
    const httpsPort = readNumber(parsed, 'httpsPort')
    const target = readString(parsed, 'target')
    if (host === null || httpsPort === null || target === null) return null
    return { host, httpsPort, target }
  }

  private writeRecord(record: OwnerRecord): void {
    atomicWrite(this.recordFile, record)
  }

  private deleteRecord(why: string): void {
    fs.rmSync(this.recordFile, { force: true })
    this.deps.log('mobile.serve_record_cleared', { why })
  }
}
