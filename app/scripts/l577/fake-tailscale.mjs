#!/usr/bin/env node
// 가짜 tailscale CLI (LIFE-577 E4) — 격리 회차·시험이 실제 tailscale 설정을 건드리지 않게 이 파일을 CLI 자리에 꽂는다
// (`CORRAL_TAILSCALE_BIN=<이 파일>` 또는 시험의 `locate` 주입). 상태는 `FAKE_TAILSCALE_DIR` 폴더:
//
//   state.json  — { backendState, dnsName, certDomains, serve, hang: [...], failAdd }
//                 `serve` 는 `tailscale serve status --json` 이 돌려줄 객체 그대로(TCP·Web·AllowFunnel·Foreground)
//                 `hang` 에 든 명령 이름(status · serve-status · serve-add · serve-remove · version)은 끝없이 멈춘다(무응답 시나리오)
//                 `failAdd` 참이면 serve 추가가 exit 1
//   calls.ndjson — 호출마다 한 줄 {at, argv}. A1ⓒ「꺼진 상태 tailscale 호출 0회」·A7ⓑ「serve 호출 0회」 의 원자료다.
//
// 실제 CLI 와 같게 하는 점: HTTPS 꺼짐(CertDomains 에 자기 이름 없음)에서 `serve --https` 는 승인 URL 을 찍고 **블록**한다(W4).
// `serve reset`·`funnel` 은 기록하고 exit 2 — corral 이 부르면 안 되는 명령이라 호출 기록에 남는 것 자체가 실패 신호다.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.FAKE_TAILSCALE_DIR
if (!dir) {
  process.stderr.write('FAKE_TAILSCALE_DIR 가 없다\n')
  process.exit(3)
}
const stateFile = path.join(dir, 'state.json')
const argv = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.ndjson'), JSON.stringify({ at: Date.now(), argv }) + '\n')

const state = readState()
const command = commandName(argv)
if ((state.hang ?? []).includes(command)) {
  setInterval(() => {}, 60_000)
} else {
  process.exitCode = run(command)
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return { backendState: 'Running', dnsName: 'fake-mac.example.ts.net', certDomains: ['fake-mac.example.ts.net'], serve: {} }
  }
}

function writeState(next) {
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2))
}

function commandName(args) {
  if (args[0] === 'version') return 'version'
  if (args[0] === 'status') return 'status'
  if (args[0] === 'serve' && args[1] === 'status') return 'serve-status'
  if (args[0] === 'serve' && args.includes('reset')) return 'serve-reset'
  if (args[0] === 'serve' && args[args.length - 1] === 'off') return 'serve-remove'
  if (args[0] === 'serve') return 'serve-add'
  if (args[0] === 'funnel') return 'funnel'
  return 'other'
}

function httpsOn() {
  return Array.isArray(state.certDomains) && state.certDomains.includes(state.dnsName)
}

function httpsPort(args) {
  const flag = args.find((arg) => arg.startsWith('--https='))
  return flag === undefined ? null : Number(flag.slice('--https='.length))
}

function run(name) {
  switch (name) {
    case 'version':
      process.stdout.write('1.102.2-fake\n')
      return 0
    case 'status':
      process.stdout.write(JSON.stringify({
        BackendState: state.backendState ?? 'Running',
        Self: { DNSName: state.dnsName ? `${state.dnsName}.` : '' },
        CertDomains: state.certDomains ?? null,
      }) + '\n')
      return 0
    case 'serve-status':
      process.stdout.write(JSON.stringify(state.serve ?? {}) + '\n')
      return 0
    case 'serve-add': {
      const port = httpsPort(argv)
      const target = argv[argv.length - 1]
      if (port === null || !Number.isInteger(port)) return fail('--https 포트가 없다')
      if (!httpsOn()) {
        // 실제 CLI 처럼 승인 URL 을 찍고 블록한다.
        process.stdout.write('To enable HTTPS, visit: https://login.tailscale.com/f/serve?node=fake\n')
        setInterval(() => {}, 60_000)
        return undefined
      }
      if (state.failAdd) return fail('add failed (fake)')
      const serve = state.serve ?? {}
      serve.TCP = serve.TCP ?? {}
      serve.Web = serve.Web ?? {}
      if (serve.TCP[String(port)]) return fail(`port ${port} already in use (fake)`)
      serve.TCP[String(port)] = { HTTPS: true }
      serve.Web[`${state.dnsName}:${port}`] = { Handlers: { '/': { Proxy: target } } }
      state.serve = serve
      writeState(state)
      return 0
    }
    case 'serve-remove': {
      const port = httpsPort(argv)
      const serve = state.serve ?? {}
      const key = `${state.dnsName}:${port}`
      const handlers = serve.Web?.[key]?.Handlers
      if (!handlers || !handlers['/']) return fail('handler does not exist')
      delete handlers['/']
      if (Object.keys(handlers).length === 0) {
        delete serve.Web[key]
        delete serve.TCP?.[String(port)]
        if (serve.Web && Object.keys(serve.Web).length === 0) delete serve.Web
        if (serve.TCP && Object.keys(serve.TCP).length === 0) delete serve.TCP
      }
      state.serve = serve
      writeState(state)
      return 0
    }
    case 'serve-reset':
    case 'funnel':
      return fail(`${name} 는 corral 이 부르면 안 된다 (fake)`, 2)
    default:
      return fail(`모르는 명령: ${argv.join(' ')}`)
  }
}

function fail(message, code = 1) {
  process.stderr.write(message + '\n')
  return code
}
