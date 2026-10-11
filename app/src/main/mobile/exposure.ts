// `tailscale serve` 노출 상태기계 (LIFE-577 A6·A7) — corral 자기 항목 하나만 올리고 내린다.
//
// 상태: off · checking · blocked(이유) · foreign · failed · exposed. 화면은 이것과 점검표 4줄을 그대로 보여 준다.
//
// **소유권 기록**(`<dir>/serve-owner.json`, 0600): `{host, httpsPort, target}`. 지우는 것은 serve 설정의 `host:port` 의
// **`/` 프록시가 기록과 같을 때만**. 포트만 보고 지우지 않는다(00-analysis W2·W5). 포트 점유와 `/` 소유는 따로 본다(fix1 R1-A4) —
// 같은 host:port 에 남의 다른 경로가 있어도 `/` 는 우리 것이고, 끄기(`--set-path=/ off`)는 `/` 만 지운다.
// - 추가 **전에** 기록을 쓴다 — 추가 직후 죽어도 다음 기동이 그 항목을 자기 것으로 알아본다. 추가가 안 됐으면 기록만 지운다.
// - `/` 가 기록과 다르면(Proxy 아님·대상 다름·없음) 남의 것이거나 사라진 것 → 기록을 버린다.
// - **올리기는 전용 포트가 완전히 비었을 때만**(수정 r4) — 남의 것이 하나라도 있으면 자기 `/` 는 지울 수 있어도 다시 올리지 않고 `foreign`.
//   대상 교체(크래시 뒤 새 서버 포트)도 같다 — 남의 것이 모두 치워진 뒤 재확인이 빈 포트 등록으로 올린다.
// - **쓰기(add·off) 직전에 다시 읽고, 쓰기 뒤에 다시 읽어 기대 상태와 대조한다(R1-A3)** — `/` 말고 다른 곳이 바뀌었으면
//   `failed` + 경고. CLI 방식이라 「읽기 → 쓰기」 사이 ms 창의 외부 변경 경합은 남는다(SURFACE.md 위협 모델).
// - Tailscale 이름이 바뀌면(R1-A11) 옛 이름의 `/` 를 CLI 로 지울 수 없다 — `off` 는 **지금** 이름으로 키를 만든다
//   (1.102.2 serve_v2.go:451). 새 이름으로 off 를 부르면 남의 항목을 지울 수 있어 부르지 않고 `failed` 로 알린다.
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
  rootAddable,
  rootTarget,
  sameJson,
  serveAddArgs,
  serveRemoveArgs,
  serveStatusArgs,
  serveTarget,
  statusArgs,
  type NodeStatus,
  type TailscaleRunner,
  withoutRoot,
} from './tailscale.js'
import type { MobileBlockReason, MobileCheck, MobileChecklist, MobileExposure } from '../../shared/mobile.js'

type Check = MobileCheck
type Checklist = MobileChecklist
type BlockReason = MobileBlockReason
type Exposure = MobileExposure

/** 지금 설정에 있는 자기 `/`(host·target 이 일치하는 Proxy)를 가리킬 때만 의미가 있다 — 자기 `/` 가 사라지면 버린다(수정 r4). */
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

/** 쓰기 전후 대조에서 `/` 말고 다른 곳이 바뀌었을 때(R1-A3). */
export const CONCURRENT_WARNING = 'serve 설정이 corral 쓰기와 동시에 바뀌었다 — 설정을 확인한다'

type RemoveOutcome = 'removed' | 'not_ours' | 'failed'

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
  private closed = false

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
    if (this.closed) return Promise.resolve()
    this.desired = desired
    if (!desired.on) this.warning = null
    return this.request()
  }

  /** 주기 재확인 — 켜져 있거나, 꺼졌는데 기록이 남았을 때(제거 실패 마무리)만 돈다. 그 밖엔 아무것도 부르지 않는다. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.desired.on && this.readRecord() === null) return Promise.resolve()
    return this.request()
  }

  /** 「다시 확인」 — 꺼져 있어도 읽기 점검만 한다(serve 쓰기 없음). */
  probe(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.desired.on || this.readRecord() !== null) return this.request()
    this.probeOnly = true
    return this.request()
  }

  /** 종료 — 원하는 값을 꺼짐으로, `deadlineMs` 안에 끝나지 않으면 진행 중 tailscale 자식을 죽이고 돌아온다. 거부하지 않는다. */
  async shutdown(deadlineMs: number): Promise<void> {
    // 이 뒤로 apply·tick·probe 는 무시한다 — 진행 중인 reconcile 은 add 직전에 원하는 값(꺼짐)을 다시 보고 올리지 않는다(R1-A1).
    this.closed = true
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
    // 노출된 채 도는 재확인은 `checking` 으로 내리지 않는다 — 내리면 연결된 폰을 30초마다 끊는다(R1-A2 차단 연결 끊기와 맞물림).
    if (desired.on && this.state.kind !== 'exposed') this.set({ kind: 'checking' })

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

    const port = this.deps.httpsPort
    const ours = record !== null && record.httpsPort === port && rootTarget({ config, host: record.host, port }) === record.target

    // 이름이 바뀌었다(R1-A11) — 옛 `/` 를 CLI 로 지울 수 없고, 새 이름으로 off 하면 남의 것을 지울 수 있다. 쓰지 않는다.
    if (ours && record.host !== status.dnsName) {
      this.deps.log('mobile.serve_renamed', { httpsPort: port })
      // 복구 안내(R1-A11 대체안) — 소스 근거 추론, 실제 tailscale 로는 실행하지 않았다(SURFACE.md §7).
      this.set({
        kind: 'failed',
        message: `Tailscale 이름이 바뀌어 옛 이름(${record.host})의 serve 항목을 corral 이 내릴 수 없다. 복구: ① Tailscale 관리 콘솔에서 이 맥 이름을 잠시 옛 이름으로 되돌린다 ② Mobile 을 끄고 꺼짐을 확인한다(옛 항목 제거) ③ 새 이름으로 바꾸고 Mobile 을 다시 켠다. serve reset 은 남의 항목까지 지우므로 쓰지 않는다`,
      })
      return
    }
    if (record !== null && !ours) this.deleteRecord('not_ours_or_gone')

    // 꺼짐(또는 막힘) 쪽 — 우리 항목만 내린다.
    if (!desired.on) {
      if (ours && (await this.remove({ record })) === 'failed') return
      this.set({ kind: 'off' })
      return
    }
    if (funnel === true) {
      // 「내렸다」 는 제거를 다시 읽어 확인했을 때만 쓴다(R1-A2). 못 내렸으면 failed — 재확인이 다시 내린다.
      const outcome: RemoveOutcome | 'none' = ours ? await this.remove({ record }) : 'none'
      if (outcome === 'failed') {
        this.deps.log('mobile.serve_blocked', { reason: 'funnel', removed: false })
        this.set({ kind: 'failed', message: 'Funnel 감지 — corral 항목을 내리지 못했다, 재확인에서 다시 내린다' })
        return
      }
      if (outcome === 'removed') this.warning = 'Funnel 이 켜져 corral 항목을 내렸다'
      this.deps.log('mobile.serve_blocked', { reason: 'funnel', removed: outcome === 'removed' })
      this.set({ kind: 'blocked', reason: 'funnel', message: 'Funnel 이 켜져 있다 — Funnel 을 끄기 전엔 노출하지 않는다' })
      return
    }
    if (!status.https || status.dnsName === null) {
      if (ours && (await this.remove({ record })) === 'failed') return
      this.set({ kind: 'blocked', reason: 'https', message: `tailnet HTTPS 인증서가 꺼져 있다 — ${HTTPS_HINT}` })
      return
    }

    const host = status.dnsName
    const target = serveTarget(desired.serverPort)
    if (ours && record.target === target) {
      return this.set(this.exposedState(host))
    }
    // 대상(서버 포트)이 바뀌었다 — 비정상 종료 뒤 재기동. 자기 `/` 를 내리고, 포트가 비었을 때만 다시 올린다(수정 r4 —
    // 남의 것이 남아 있으면 add 가 foreign 으로 끝난다. 남의 것이 모두 치워진 뒤 재확인이 빈 포트 등록으로 올린다).
    if (ours && (await this.remove({ record })) === 'failed') return
    await this.add({ host, target, serverPort: desired.serverPort })
  }

  /** 등록은 언제나 **빈 포트에만**(R2-A3 · 수정 r4) — `<host>:8577` 에 TCP·Web 칸·Foreground 가 하나라도 있으면 foreign. */
  private async add(input: { host: string; target: string; serverPort: number }): Promise<void> {
    const port = this.deps.httpsPort
    // 쓰기 직전 재조회(R1-A3) — 그 사이 남이 포트·`/` 를 잡았으면 덮지 않는다.
    const before = await this.readServe()
    if (before === null) {
      this.set({ kind: 'failed', message: 'serve 설정을 다시 읽지 못했다 — 아무것도 바꾸지 않았다' })
      return
    }
    if (!rootAddable({ config: before, port })) {
      this.deps.log('mobile.serve_foreign', { httpsPort: port })
      this.set({ kind: 'foreign', message: `HTTPS 포트 ${port} 에 다른 항목이 있다 — corral 은 덮어쓰거나 같이 올리지 않는다. 그 항목을 치우면 다시 확인에서 올린다` })
      return
    }
    // 그 사이 꺼짐·종료가 들어왔으면 올리지 않는다(R1-A1).
    if (!this.desired.on || this.closed) return
    this.writeRecord({ host: input.host, httpsPort: port, target: input.target })
    const run = await this.call(serveAddArgs({ httpsPort: port, serverPort: input.serverPort }), TAILSCALE_WRITE_TIMEOUT_MS)
    // 결과를 믿지 않고 다시 읽어 확인한다 — 「추가했다」 는 serve 설정에 우리 `/` 가 보이고 나머지가 그대로일 때만.
    const after = await this.readServe()
    const now = after === null ? undefined : rootTarget({ config: after, host: input.host, port })
    if (after !== null && now === input.target) {
      if (!sameJson(withoutRoot({ config: before, host: input.host, port }), withoutRoot({ config: after, host: input.host, port }))) {
        this.warning = CONCURRENT_WARNING
        this.deps.log('mobile.serve_concurrent_change', { during: 'add' })
        this.set({ kind: 'failed', message: `serve 항목은 올렸지만 ${CONCURRENT_WARNING}` })
        return
      }
      this.deps.log('mobile.serve_added', { httpsPort: port, target: input.target })
      this.warning = null
      this.set(this.exposedState(input.host))
      return
    }
    if (now === null) this.deleteRecord('add_failed')
    else if (now !== undefined) {
      // `/` 가 남의 대상이다 — 우리 쓰기와 겹쳐 남이 잡았다. 기록을 버리고 덮지 않는다.
      this.deleteRecord('foreign')
      this.warning = CONCURRENT_WARNING
    }
    this.deps.log('mobile.serve_add_failed', { detail: run.ok ? 'not_visible' : run.detail })
    this.set({ kind: 'failed', message: `serve 항목을 올리지 못했다(${run.ok ? '설정에 보이지 않음' : run.detail}) — 다시 확인에서 재시도한다` })
  }

  /**
   * 우리 `/` 제거 — 쓰기 직전에 다시 읽어 아직 우리 것일 때만 off 하고(R1-A3), 다시 읽어 `/` 가 사라졌으면 기록을 지운다.
   * `/` 밖이 같이 바뀌었으면 `failed` + 경고. 실패면 기록을 남겨 다음 재확인이 마무리한다.
   */
  private async remove(input: { record: OwnerRecord }): Promise<RemoveOutcome> {
    const record = input.record
    const port = this.deps.httpsPort
    const before = await this.readServe()
    if (before === null) {
      this.set({ kind: 'failed', message: 'serve 설정을 다시 읽지 못했다 — 다음 재확인에서 다시 내린다' })
      return 'failed'
    }
    if (rootTarget({ config: before, host: record.host, port }) !== record.target) {
      this.deleteRecord('not_ours_before_write')
      return 'not_ours'
    }
    const run = await this.call(serveRemoveArgs({ httpsPort: port }), TAILSCALE_WRITE_TIMEOUT_MS)
    const after = await this.readServe()
    const now = after === null ? undefined : rootTarget({ config: after, host: record.host, port })
    if (after !== null && now !== record.target && now !== undefined) {
      this.deleteRecord(now === null ? 'removed' : 'foreign')
      const unchanged = now === null && sameJson(withoutRoot({ config: before, host: record.host, port }), withoutRoot({ config: after, host: record.host, port }))
      if (unchanged) {
        this.deps.log('mobile.serve_removed', { httpsPort: port })
        return 'removed'
      }
      this.warning = CONCURRENT_WARNING
      this.deps.log('mobile.serve_concurrent_change', { during: 'remove' })
      this.set({ kind: 'failed', message: `serve 항목을 내리는 중 ${CONCURRENT_WARNING}` })
      return 'failed'
    }
    // 사후 조회 실패는 「남음」 으로 단정하지 않는다(R4-A1) — 기록은 남기되, 다음 조회에서 자기 `/` 가 없으면 버린다(host·target·Proxy 일치만 소유).
    const detail = !run.ok ? run.detail : after === null ? '내린 뒤 설정을 다시 읽지 못함' : '설정에 남음'
    this.deps.log('mobile.serve_remove_failed', { detail })
    this.set({ kind: 'failed', message: `serve 항목을 내리지 못했다(${detail}) — 다음 재확인에서 다시 확인한다` })
    return 'failed'
  }

  private async readServe(): Promise<Record<string, unknown> | null> {
    const run = await this.call(serveStatusArgs(), TAILSCALE_READ_TIMEOUT_MS)
    return run.ok ? parseServeConfig(run.stdout) : null
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
