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
export interface Invocation {
    command: string;
    flags: Flags;
    args: string[];
    cwd: string;
    /** Optional literal UTF-8 stdin; never logged or persisted as receipt content. */
    stdin?: string;
    /** Ordered values for explicitly repeatable flags; flags retains the final value. */
    repeatedFlags?: Record<string, string[]>;
}
export interface RpcRequest {
    version: 1;
    id: string;
    invocation: Invocation;
    expectedRuntimeId?: string;
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
    constructor(readonly code: string, message: string, readonly resources?: unknown, readonly stage?: string) { super(message); }
}
export interface CommandModule {
    specs: CommandSpec[];
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
