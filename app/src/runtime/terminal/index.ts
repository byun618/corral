import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import specs from './specs.json'
import { RuntimeError, reject, stringFlag, type CommandModule, type CommandSpec, type Invocation, type CommandContext } from '../contracts.js'
import { validateFoundation } from '../registry.js'
import { TerminalBackend, type TerminalIdentity } from '../../main/adapter/index.js'
import { RepoRegistry } from '../../main/registry.js'
import { WorktreeMetadata, worktreeSelect } from '../workspace/model.js'
import { Tokens } from './tokens.js'
import { Receipts, REQUEST_ID } from './receipts.js'
export const terminalSpecs: CommandSpec[] = specs
export const MAX_INPUT = 65536
export interface TerminalDesktop {
  available(): boolean
  changed(): Promise<void>
  reveal(target: TerminalIdentity, context: CommandContext): Promise<void>
}
const reads = new Set(['terminal list', 'terminal show', 'terminal read', 'terminal wait'])
function bytes(value: unknown, max: number, name: string) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) reject(`${name} must be NUL-free UTF-8, at most ${max} bytes`)
}
export function validateTerminal(inv: Invocation): void {
  validateFoundation(inv)
  const f = inv.flags
  if (!['terminal create', 'terminal list'].includes(inv.command)) stringFlag(f, 'terminal', true)
  for (const key of ['worktree', 'cursor', 'expect-process']) if (f[key] !== undefined) stringFlag(f, key, true)
  if (f.title !== undefined || inv.command === 'terminal rename') { stringFlag(f, 'title', true); bytes(f.title, 1024, '--title') }
  if (f.command !== undefined) { stringFlag(f, 'command', true); bytes(f.command, MAX_INPUT, '--command') }
  if (f.text !== undefined) bytes(f.text, MAX_INPUT, '--text')
  if (inv.stdin !== undefined) { if (!f.stdin) reject('Unexpected stdin'); bytes(inv.stdin, MAX_INPUT, 'stdin') }
  if (f['request-id'] !== undefined && !REQUEST_ID.test(String(f['request-id']))) reject('--request-id must be r1.<13-digit Unix milliseconds>.<UUID>')
  if (f.limit !== undefined && (!/^\d+$/.test(String(f.limit)) || Number(f.limit) < 1 || Number(f.limit) > (inv.command === 'terminal list' ? 10000 : 262144))) reject('--limit out of range (list 1..10000; read 1..262144)')
  if (f.screen && f.cursor !== undefined) reject('--screen and --cursor are mutually exclusive')
  if (inv.command === 'terminal send') {
    if (f.stdin && f.text !== undefined) reject('--text and --stdin are mutually exclusive')
    if (f.interrupt && (f.text !== undefined || f.stdin || f.enter)) reject('--interrupt cannot be combined with text/stdin/enter')
    if (!f.interrupt && f.text === undefined && !f.stdin && !f.enter) reject('Send requires text, stdin, enter, or interrupt')
  }
  if (inv.command === 'terminal wait') {
    if (!['ready', 'output', 'exit'].includes(String(f.for))) reject('--for must be ready, output, or exit')
    if (f.for !== 'output' && (f.cursor !== undefined || f.text !== undefined)) reject('--cursor and --text require --for output')
    if (f.text === '') reject('Output match text must not be empty')
  }
}
interface Cursor { target: string; offset: number; pending: string }
/** Hold at most three trailing bytes until the next observation completes their UTF-8 sequence. */
function decodeChunk(bytes: Buffer): { text: string; pending: string } {
  let start = bytes.length - 1
  while (start >= Math.max(0, bytes.length - 3) && (bytes[start]! & 0xc0) === 0x80) start--
  if (start >= 0) {
    const first = bytes[start]!, width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1
    if (bytes.length - start < width) return { text: bytes.subarray(0, start).toString('utf8'), pending: bytes.subarray(start).toString('base64') }
  }
  return { text: bytes.toString('utf8'), pending: '' }
}
export function terminalModule(userData: string, desktop?: TerminalDesktop): CommandModule {
  const startedAt = Date.now(), receipts = new Receipts(userData, startedAt)
  let tokens: Tokens | undefined
  return {
    specs: terminalSpecs, validate: validateTerminal, tracksEffects: true,
    isMutation: inv => !reads.has(inv.command),
    serialKey: inv => reads.has(inv.command) ? undefined : 'terminal',
    async execute(original, ctx) {
      tokens ??= new Tokens(userData)
      const codec = tokens, inv = { ...original, flags: { ...original.flags } }, f = inv.flags
      const flag = (name: string) => stringFlag(f, name), required = (name: string) => stringFlag(f, name, true)!
      if (f['expect-process'] !== undefined) throw new RuntimeError('unsupported', 'Backend cannot atomically condition on foreground/exec ownership; no effect started', { conditionalProcess: false }, 'preflight', 'not_started')
      if ((inv.command === 'terminal switch' || f.focus) && !desktop?.available()) throw new RuntimeError('ui_unavailable', 'This runtime has no available GUI', undefined, 'preflight', 'not_started')
      const socket = process.env.CORRAL_BACKEND_SOCKET
      if (!socket) throw new RuntimeError('backend_unavailable', 'Profile has no configured terminal backend')
      const backend = new TerminalBackend(socket)
      const epoch = await backend.epoch(ctx)
      const registry = new RepoRegistry(userData), records = () => new WorktreeMetadata(registry).list(registry.records(), ctx.signal)
      const handle = (target: TerminalIdentity) => codec.encode('t1', { runtimeId: ctx.runtimeId, epoch: target.epoch, ptyId: target.ptyId, paneId: target.paneId })
      const describe = async (target: TerminalIdentity) => {
        const worktree = (await records()).find(w => w.path === target.path)
        return { handle: handle(target), ...target, repo: registry.records().find(repo => repo.id === worktree?.repoId)?.path ?? target.repo, repoId: worktree?.repoId ?? null, worktreeId: worktree?.id ?? null }
      }
      let target: TerminalIdentity | undefined
      if (f.terminal !== undefined) {
        const decoded = codec.decode<TerminalIdentity & { runtimeId: string }>('t1', required('terminal'))
        if (decoded.runtimeId !== ctx.runtimeId || decoded.epoch !== epoch) throw new RuntimeError('stale_terminal', 'Handle belongs to another runtime/backend generation', { recovery: 'terminal list' })
        target = decoded
      }
      const resolve = async (allowExit = false) => {
        const current = (await backend.list(epoch, ctx)).find(p => p.paneId === target!.paneId)
        if (!current && allowExit) return undefined
        if (!current || current.ptyId !== target!.ptyId) throw new RuntimeError('stale_terminal', 'PTY disappeared or was replaced', { terminal: required('terminal'), recovery: 'terminal list' })
        return current
      }
      const read = async (selected: TerminalIdentity, cursor?: string, limit = 65536) => {
        const output = await backend.read(selected, false, ctx), data = Buffer.from(output.text, 'base64'), oldest = output.total - data.length
        const targetKey = createHash('sha256').update(required('terminal')).digest('hex')
        const prior = cursor ? codec.decode<Cursor>('c1', cursor) : { target: targetKey, offset: oldest, pending: '' }
        if (prior.target !== targetKey || !Number.isSafeInteger(prior.offset) || prior.offset < 0 || prior.offset > output.total) throw new RuntimeError('invalid_cursor', 'Cursor is future or belongs to another terminal')
        const gap = prior.offset < oldest, start = Math.max(oldest, prior.offset), end = Math.min(output.total, start + limit)
        const chunk = data.subarray(start - oldest, end - oldest), decoded = decodeChunk(Buffer.concat([Buffer.from(gap ? '' : prior.pending, 'base64'), chunk]))
        return { source: 'raw-pty', text: decoded.text, bytesBase64: chunk.toString('base64'), from: start, to: end, retainedFrom: oldest, availableTo: output.total,
          gap, truncated: gap || (!cursor && oldest > 0), hasMore: end < output.total, generation: selected.epoch + ':' + selected.ptyId,
          cursor: codec.encode('c1', { target: targetKey, offset: end, pending: decoded.pending } satisfies Cursor),
          recoveryCursor: codec.encode('c1', { target: targetKey, offset: oldest, pending: '' } satisfies Cursor) }
      }
      const execute = async (): Promise<unknown> => {
        if (inv.command === 'terminal list') {
          const worktree = f.worktree ? worktreeSelect(await records(), required('worktree'), inv.cwd) : undefined
          const panes = (await backend.list(epoch, ctx)).filter(p => !worktree || p.path === worktree.path), limit = Number(f.limit ?? 100)
          return { terminals: await Promise.all(panes.slice(0, limit).map(describe)), totalCount: panes.length, truncated: panes.length > limit }
        }
        if (inv.command === 'terminal create') {
          const worktree = worktreeSelect(await records(), flag('worktree') ?? 'current', inv.cwd)
          const created = await backend.create(epoch, worktree.path, flag('title'), ctx)
          if (f.title !== undefined && created.title !== f.title) { await backend.rename(created, required('title'), ctx); created.title = required('title') }
          // command is intentionally a shell command; text/stdin send never execute in the CLI host shell.
          if (f.command !== undefined) await backend.send(created, required('command') + '\r', ctx)
          await desktop?.changed()
          if (f.focus) await desktop!.reveal(created, ctx)
          return { terminal: await describe(created), stage: f.command === undefined ? 'pty_created' : 'command_accepted', outcome: 'completed' }
        }
        if (inv.command === 'terminal wait') {
          let cursor = flag('cursor'), matched = '', baselineSet = !!cursor
          for (;;) {
            ctx.signal.throwIfAborted()
            if (Date.now() >= ctx.deadlineAt - 15) throw new RuntimeError('wait_timeout', 'Condition not met before deadline', { terminal: required('terminal'), condition: f.for, cursor }, 'wait')
            const live = await resolve(true)
            if (!live) {
              if (f.for === 'exit') return { terminal: required('terminal'), condition: 'exit', exitCode: null, stage: 'observed' }
              throw new RuntimeError('terminal_exited', 'PTY exited before condition was met')
            }
            if (f.for === 'ready') {
              const process = await backend.process(live, ctx)
              if (process.shellPid !== null) return { terminal: required('terminal'), condition: 'ready', meaning: 'transport', agentReady: null, stage: 'observed' }
            }
            if (f.for === 'output') {
              const output = await read(live, cursor)
              if (!baselineSet) {
                // Begin after all bytes already present, including output larger than one result page.
                cursor = codec.encode('c1', { target: createHash('sha256').update(required('terminal')).digest('hex'), offset: output.availableTo, pending: '' })
                baselineSet = true
              } else {
                if (output.gap) throw new RuntimeError('output_gap', 'Output was evicted before observation', output)
                cursor = output.cursor; matched += output.text
                if (output.to > output.from && (f.text === undefined || matched.includes(String(f.text)))) return { terminal: required('terminal'), condition: 'output', output, stage: 'observed' }
                // Matching can span pages, without retaining unbounded terminal output.
                const keep = Math.max(0, String(f.text ?? '').length - 1)
                matched = keep ? matched.slice(-keep) : ''
                if (output.hasMore) continue
              }
            }
            await delay(Math.min(30, Math.max(1, ctx.deadlineAt - Date.now() - 15)), undefined, { signal: ctx.signal })
          }
        }
        const live = (await resolve())!
        if (inv.command === 'terminal show') {
          const process = await backend.process(live, ctx)
          return { terminal: await describe(live), process: { ...process, observationId: 'p1.' + createHash('sha256').update(JSON.stringify(process)).digest('base64url') },
            connected: true, writable: process.shellPid !== null, capabilities: { atomicTerminal: true, conditionalProcess: false, rawOutput: true, gui: desktop?.available() ?? false } }
        }
        if (inv.command === 'terminal read') {
          if (!f.screen) return { terminal: required('terminal'), ...await read(live, flag('cursor'), Number(f.limit ?? 65536)) }
          const output = await backend.read(live, true, ctx), buffer = Buffer.from(output.text), limit = Number(f.limit ?? 65536), decoded = decodeChunk(buffer.subarray(0, limit))
          return { terminal: required('terminal'), source: 'screen-snapshot', text: decoded.text, truncated: output.truncated || buffer.length > limit, generation: live.epoch + ':' + live.ptyId, cursor: null }
        }
        if (inv.command === 'terminal send') {
          if (f.stdin && inv.stdin === undefined) reject('--stdin requires literal UTF-8 stdin in request')
          const text = f.interrupt ? '\x03' : String(f.stdin ? inv.stdin : f.text ?? '') + (f.enter ? '\r' : '')
          await backend.send(live, text, ctx)
          return { terminal: required('terminal'), stage: 'backend_accepted', bytes: Buffer.byteLength(text), consumed: null, outcome: 'completed' }
        }
        if (inv.command === 'terminal close') {
          await backend.close(live, ctx)
          if ((await backend.list(epoch, ctx)).some(p => p.ptyId === live.ptyId)) throw new RuntimeError('outcome_unknown', 'Close accepted but PTY removal not observed', { terminal: required('terminal') }, 'close', 'unknown')
          await desktop?.changed()
          return { terminal: required('terminal'), stage: 'closed', exitCode: null, outcome: 'completed' }
        }
        if (inv.command === 'terminal rename') {
          await backend.rename(live, required('title'), ctx); await desktop?.changed()
          return { terminal: required('terminal'), tabId: live.tabId, scope: 'tab', title: required('title'), stage: 'renamed' }
        }
        if (inv.command === 'terminal switch') {
          ctx.signal.throwIfAborted(); ctx.onEffect?.(); await desktop!.reveal(live, ctx)
          return { terminal: required('terminal'), stage: 'gui_selected' }
        }
        throw new RuntimeError('unsupported', 'Unknown terminal command')
      }
      if (['terminal create', 'terminal send'].includes(inv.command)) {
        f['request-id'] ??= `r1.${Date.now()}.${randomUUID()}`
        return receipts.run(inv, execute)
      }
      return execute()
    },
  }
}
