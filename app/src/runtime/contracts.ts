/** Public domain boundary. No Electron, herdr wire types or provider credentials here. */
export type Flags = Record<string, string | boolean>;
export interface CommandSpec {
    command: string;
    path: string[];
    aliases: string[][];
    argumentMode: string;
    booleanFlags?: string[];
    repeatableFlags?: string[];
    execution?: 'client';
    summary: string;
    usage: string;
    flags: string[];
    positionalArgs: string[];
    examples: string[];
    notes: string[];
}
/**
 * LIFE-410 §4.5. What the CLI client observed about *itself* when it made the call: which terminal
 * pane its shell belongs to, and which backend session that pane lives in. Populated from the
 * environment herdr gives a pane, never from a flag, so it is not part of a receipt hash and cannot
 * be typed by hand at a prompt.
 *
 * It is evidence, not authentication: anything that can already write to the 0600 runtime socket
 * could state any value. It exists to keep a *confused* caller — a stale preamble, a second worker,
 * a report pasted into the coordinator's own shell — from settling somebody else's attempt.
 */
export interface CallerIdentity {
    paneId: string | null;
    session: string | null;
}
export interface Invocation {
    command: string;
    flags: Flags;
    args: string[];
    cwd: string;
    /** Optional literal UTF-8 stdin; never logged or persisted as receipt content. */
    stdin?: string;
    /** Ordered values for explicitly repeatable flags; flags retains the final value. */
    repeatedFlags?: Record<string, string[]>;
    /** Who the client says it is. Absent means "not called from a corral-managed pane". */
    caller?: CallerIdentity;
}
/**
 * LIFE-410 §4.6. The only two commands that block on another party — the coordinator waiting for a
 * worker, the worker waiting for an answer — and so the only two allowed the ten minutes a Claude
 * Code Bash call can actually spend. Everything else keeps the two-minute ceiling.
 */
export const WAITING_COMMANDS: ReadonlySet<string> = new Set(['orchestration check', 'orchestration ask']);
export const WAITING_TIMEOUT_MAX = 600000;
export const DEFAULT_TIMEOUT_MAX = 120000;
export interface RpcRequest {
    version: 1;
    id: string;
    invocation: Invocation;
    expectedRuntimeId?: string;
    /** open must name the profile that will launch its desktop. Checked before effects. */
    expectedUserData?: string;
    timeoutMs?: number;
}
export interface RpcResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: {
        code: string;
        message: string;
        stage?: string;
        resources?: unknown;
    };
    _meta: {
        runtimeId: string;
        instanceId?: string;
        outcome?: 'not_started' | 'completed' | 'unknown';
    };
}
export class RuntimeError extends Error {
    constructor(readonly code: string, message: string, readonly resources?: unknown, readonly stage?: string, readonly outcome?: 'not_started' | 'unknown') { super(message); }
}
export interface CommandModule {
    specs: CommandSpec[];
    tracksEffects?: boolean;
    executeLocal?(invocation: Invocation, context: { userData: string }): Promise<unknown>;
    isMutation?(invocation: Invocation): boolean;
    /** Only commands sharing mutable state need a lane. Waiting commands should return undefined. */
    serialKey?(invocation: Invocation): string | undefined;
    /** Shared parser calls this before dispatch, runtime calls it again before any effect. */
    validate(invocation: Invocation): void;
    execute(invocation: Invocation, context: CommandContext): Promise<unknown>;
}
export interface CommandContext {
    runtimeId: string;
    instanceId: string;
    userData: string;
    signal: AbortSignal;
    remote: boolean;
    deadlineAt: number;
    onEffect?: () => void;
}
export function stringFlag(flags: Flags, name: string, required = false): string | undefined {
    const value = flags[name];
    if (value === undefined && !required)
        return undefined;
    if (typeof value !== 'string' || !value.length || value.includes('\0'))
        throw new RuntimeError('invalid_argument', `Missing or invalid --${name}`);
    return value;
}
export function reject(message: string): never { throw new RuntimeError('invalid_argument', message); }

export function repeatedFlag(inv: Invocation, name: string): string[] {
    const values = inv.repeatedFlags?.[name] ?? (inv.flags[name] === undefined ? [] : [stringFlag(inv.flags, name, true)!]);
    if (values.some(value => !value.length || value.includes("\0"))) reject(`Invalid --${name}`);
    return [...values];
}
