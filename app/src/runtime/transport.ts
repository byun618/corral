import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type RpcRequest, type RpcResponse, RuntimeError } from './contracts.js';
export const MAX_REQUEST = 512 * 1024, MAX_RESPONSE = 4 * 1024 * 1024;
export function socketPath(userData: string): string { return process.env.CORRAL_RUNTIME_SOCKET ?? path.join(userData, 'runtime', 'rpc.sock'); }
export function request(command: RpcRequest['invocation'], expectedRuntimeId?: string, timeoutMs = Number(command.flags['timeout-ms'] ?? 10000)): RpcRequest { return { version: 1, id: randomUUID(), invocation: command, expectedRuntimeId, timeoutMs }; }
export function validateRequest(value: unknown): RpcRequest {
    if (!value || typeof value !== 'object')
        throw new RuntimeError('invalid_request', 'Expected object');
    const req: RpcRequest = JSON.parse(JSON.stringify(value));
    if (req.timeoutMs !== undefined && (!Number.isSafeInteger(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > 43200000))
        throw new RuntimeError('invalid_request', 'timeoutMs must be 1..43200000');
    if (req.version !== 1 || typeof req.id !== 'string' || !/^[\w-]{1,100}$/.test(req.id) || !req.invocation || typeof req.invocation.command !== 'string' || !req.invocation.flags || typeof req.invocation.flags !== 'object' || Array.isArray(req.invocation.flags) || !Array.isArray(req.invocation.args) || !req.invocation.args.every(v => typeof v === 'string') || typeof req.invocation.cwd !== 'string' || (req.expectedRuntimeId !== undefined && typeof req.expectedRuntimeId !== 'string'))
        throw new RuntimeError('invalid_request', 'Invalid protocol/version/request');
    if (req.expectedUserData !== undefined && (typeof req.expectedUserData !== 'string' || !path.isAbsolute(req.expectedUserData) || req.expectedUserData.includes('\0'))) throw new RuntimeError('invalid_request', 'expectedUserData must be an absolute path');
    if (req.invocation.stdin !== undefined && typeof req.invocation.stdin !== 'string') throw new RuntimeError('invalid_request', 'stdin must be a string');
    if (req.invocation.repeatedFlags !== undefined && (!req.invocation.repeatedFlags || typeof req.invocation.repeatedFlags !== 'object' || Array.isArray(req.invocation.repeatedFlags))) throw new RuntimeError('invalid_request', 'repeatedFlags must be an object');
    // LIFE-410 §4.5: the caller identity travels beside the flags, and each field is a string or
    // explicitly absent. A malformed one is refused rather than read as "no pane".
    const caller = req.invocation.caller;
    const namedOrAbsent = (value: unknown): boolean => value === null || typeof value === 'string';
    if (caller !== undefined && (!caller || typeof caller !== 'object' || Array.isArray(caller) || !namedOrAbsent(caller.paneId) || !namedOrAbsent(caller.session) || (caller.socket !== undefined && !namedOrAbsent(caller.socket)) || (caller.claudeSession !== undefined && !namedOrAbsent(caller.claudeSession))))
        throw new RuntimeError('invalid_request', 'caller must be { paneId, session, socket?, claudeSession? } of string or null');
    return req;
}
export async function localCall(endpoint: string, req: RpcRequest, timeout = req.timeoutMs ?? 10000, signal?: AbortSignal): Promise<RpcResponse> {
    signal?.throwIfAborted();
    if (!path.isAbsolute(endpoint) || Buffer.byteLength(endpoint) > 100) throw new RuntimeError('invalid_socket', 'Use an absolute Unix socket path of at most 100 bytes');
    try {
        const st = fs.lstatSync(endpoint), parent = fs.lstatSync(path.dirname(endpoint));
        if (!st.isSocket() || st.isSymbolicLink() || (process.getuid && (st.uid !== process.getuid() || parent.uid !== process.getuid())) || (st.mode & 0o077) || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new RuntimeError('unsafe_permissions', 'Socket and parent must be private and owned by this user');
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    validateRequest(req);
    const line = JSON.stringify(req) + '\n';
    if (Buffer.byteLength(line) > MAX_REQUEST)
        throw new RuntimeError('invalid_argument', `Request exceeds ${MAX_REQUEST} bytes`);
    return await new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let buffer = '', done = false, sent = false;
        const finish = (error: unknown, result?: RpcResponse) => { if (done)
            return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); socket.destroy(); if (error)
            reject(error);
        else
            resolve(result!); };
        const cancel = () => finish(new RuntimeError('request_cancelled', 'Caller cancelled; accepted effects may already have occurred'));
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => finish(new RuntimeError(sent ? 'outcome_unknown' : 'runtime_unavailable', 'Deadline exceeded; mutations are never automatically retried')), timeout);
        socket.once('connect', () => { if (done || signal?.aborted) return; sent = true; socket.write(line); });
        socket.once('error', error => finish(new RuntimeError(sent ? 'outcome_unknown' : 'runtime_unavailable', error.message)));
        socket.once('close', () => finish(new RuntimeError(sent ? 'outcome_unknown' : 'runtime_unavailable', 'Connection closed before response; inspect resources before retrying')));
        socket.setEncoding('utf8');
        socket.on('data', chunk => { buffer += chunk; if (Buffer.byteLength(buffer) > MAX_RESPONSE)
            return finish(new RuntimeError('invalid_response', 'Response too large')); const end = buffer.indexOf('\n'); if (end < 0)
            return; try {
            const response: RpcResponse = JSON.parse(buffer.slice(0, end));
            if (response.id !== req.id || typeof response.ok !== 'boolean' || !response._meta)
                throw new Error('Invalid response identity');
            finish(null, response);
        }
        catch (error) {
            finish(error);
        } });
    });
}
export async function serveSocket(endpoint: string, handle: (req: RpcRequest, signal: AbortSignal) => Promise<RpcResponse>, afterResponse?: (req: RpcRequest, response: RpcResponse) => void): Promise<() => Promise<void>> {
    if (!path.isAbsolute(endpoint) || Buffer.byteLength(endpoint) > 100)
        throw new RuntimeError('invalid_socket', 'Runtime socket path exceeds 100 bytes; use CORRAL_RUNTIME_SOCKET');
    const clients = new Set<net.Socket>();
    const server = net.createServer(socket => {
        clients.add(socket);
        const cancellation=new AbortController();let responseQueued=false;
        let buffer = Buffer.alloc(0), accepted = false;
        let timer = setTimeout(() => socket.destroy(), 10000);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => { clearTimeout(timer); clients.delete(socket);if(!responseQueued)cancellation.abort(); });
        socket.on('data', chunk => {
            if (accepted)
                return;
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > MAX_REQUEST) {
                socket.destroy();
                return;
            }
            const end = buffer.indexOf(10);
            if (end < 0)
                return;
            accepted = true;
            void (async () => { let response: RpcResponse; let acceptedRequest: RpcRequest | undefined; try {
                const req = validateRequest(JSON.parse(buffer.subarray(0, end).toString()));
                acceptedRequest = req;
                clearTimeout(timer);
                timer = setTimeout(() => socket.destroy(), (req.timeoutMs ?? 190000) + 5000);
                response = await handle(req,cancellation.signal);
            }
            catch (error) {
                response = { id: 'invalid', ok: false, error: { code: 'invalid_request', message: String(error) }, _meta: { runtimeId: 'unknown', outcome: 'not_started' } };
            } responseQueued=true;socket.end(JSON.stringify(response) + '\n', () => {if (acceptedRequest) afterResponse?.(acceptedRequest,response)}); })();
        });
    });
    // LIFE-519: bind creates the socket file synchronously inside listen() with mode 0777 & ~umask, and a polling
    // client rejects any group/other bit. Bind under a private umask and restore it before listen() returns, so the
    // endpoint is never visible loose; the umask is process-wide, so the changed span stays this one synchronous call.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); const umask = process.umask(0o077); try {
        server.listen(endpoint, () => { server.off('error', reject); resolve(); });
    }
    finally { process.umask(umask); } });
    fs.chmodSync(endpoint, 0o600);
    const inode = fs.statSync(endpoint).ino;
    return async () => { for (const client of clients)
        client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); try {
        if (fs.statSync(endpoint).ino === inode)
            fs.unlinkSync(endpoint);
    }
    catch { /* already removed */ } };
}
