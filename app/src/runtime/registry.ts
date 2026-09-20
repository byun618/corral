import specs from './foundation-specs.json';
import { type CommandSpec, type Invocation, type CommandModule, stringFlag, reject } from './contracts.js';
export const foundationSpecs: CommandSpec[] = specs;
const commonBooleans = new Set(['help', 'json']);
export class CommandRegistry {
    private readonly modules = new Map<string, CommandModule>();
    private readonly names = new Map<string, CommandSpec>();
    register(module: CommandModule): void {
        for (const spec of module.specs) {
            for (const name of [spec.command, ...spec.aliases.map(parts => parts.join(' '))]) {
                if (this.names.has(name))
                    throw new Error(`Duplicate command ${name}`);
                this.names.set(name, spec);
            }
            this.modules.set(spec.command, module);
        }
    }
    schema() { return { schemaVersion: 1, commandCount: this.modules.size, commands: [...this.modules.keys()].map(name => this.names.get(name)!) }; }
    spec(name: string) { return this.names.get(name); }
    module(name: string) { const spec = this.names.get(name); return spec ? this.modules.get(spec.command) : undefined; }
    parse(argv: string[], cwd: string): Invocation {
        const pass = this.spec(argv[0] ?? '');
        if (pass?.argumentMode === 'passthrough') return {command: pass.command, flags: {}, args: argv.slice(1), cwd};
        const flags: Invocation['flags'] = {}, args: string[] = [];
        const occurrences: Record<string,string[]> = {};
        const repeatable = new Set(this.schema().commands.flatMap(spec => spec.repeatableFlags ?? []));
        const allFlags = new Set(this.schema().commands.flatMap(spec => spec.flags));
        const booleans = new Set([...commonBooleans, ...this.schema().commands.flatMap(spec => spec.booleanFlags ?? [])]);
        for (let i = 0; i < argv.length; i++) {
            const raw = argv[i]!;
            if (!raw.startsWith('--')) {
                args.push(raw);
                continue;
            }
            const equal = raw.indexOf('=');
            const key = raw.slice(2, equal < 0 ? undefined : equal);
            if (!allFlags.has(key))
                reject(`Unknown flag --${key}`);
            if (key in flags && !repeatable.has(key))
                reject(`Duplicate --${key}`);
            if (booleans.has(key)) {
                if (equal >= 0)
                    reject(`Unexpected value for --${key}`);
                flags[key] = true;
                continue;
            }
            if (equal >= 0)
                flags[key] = raw.slice(equal + 1);
            else {
                const value = argv[++i];
                if (value === undefined || value.startsWith('--'))
                    reject(`Missing value for --${key}`);
                flags[key] = value;
            }
            const parsedValue = flags[key];
            if (typeof parsedValue === 'string') (occurrences[key] ??= []).push(parsedValue);
        }
        if (!args.length && flags.help)
            return { command: '', flags, args: [], cwd };
        const spec = [...this.names.entries()].sort((a, b) => b[0].length - a[0].length).find(([name]) => args.slice(0, name.split(' ').length).join(' ') === name);
        if (!spec)
            reject('Unknown command; see --help');
        const repeatedFlags: Record<string,string[]> = {};
        for (const [key,values] of Object.entries(occurrences)) {
            if (spec[1].repeatableFlags?.includes(key)) repeatedFlags[key] = values;
            else if (values.length > 1) reject(`Duplicate --${key}`);
        }
        const invocation: Invocation = { command: spec[1].command, flags, args: args.slice(spec[0].split(' ').length), cwd, ...(Object.keys(repeatedFlags).length ? {repeatedFlags} : {}) };
        this.validate(invocation);
        return invocation;
    }
    validate(inv: Invocation): void {
        const module = this.module(inv.command), spec = this.spec(inv.command);
        const booleans = new Set([...commonBooleans, ...(spec?.booleanFlags ?? [])]);
        if (!module || !spec)
            reject('Unknown command');
        for (const key of Object.keys(inv.flags))
            if (!spec.flags.includes(key))
                reject(`Invalid flag for ${inv.command}: --${key}`);
        if (spec.execution === 'client' && (inv.flags.environment || inv.flags['pairing-code'] || (inv.flags.host && inv.flags.host !== 'local'))) reject(`${inv.command} executes on this CLI host`);
        for (const [key,values] of Object.entries(inv.repeatedFlags ?? {})) {
            if (!spec.repeatableFlags?.includes(key) || !Array.isArray(values) || !values.length || !values.every(value => typeof value === 'string' && !value.includes('\0')) || values.at(-1) !== inv.flags[key]) reject(`Invalid repeated --${key}`);
        }
        if (spec.argumentMode === 'passthrough') { module.validate(inv); return; }
        if (inv.args.length && !spec.positionalArgs.length)
            reject('Unexpected positional arguments');
        for (const [key, value] of Object.entries(inv.flags)) {
            if (booleans.has(key) ? value !== true : typeof value !== 'string' || value.includes('\0'))
                reject(`Invalid --${key}`);
        }
        if (!inv.flags.help)
            module.validate(inv);
    }
}
export function validateFoundation(inv: Invocation): void {
    for (const key of ['socket', 'instance']) if (inv.flags[key] !== undefined) stringFlag(inv.flags, key, true);
    const timeout = inv.flags['timeout-ms'];
    if (timeout !== undefined && (!/^\d+$/.test(String(timeout)) || Number(timeout) < 1 || Number(timeout) > 120000)) reject('--timeout-ms must be 1..120000');
}
