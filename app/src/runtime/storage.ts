import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from './contracts.js';
export function defaultUserData(): string {
    return process.env.CORRAL_USER_DATA ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/corral') : process.platform === 'win32' ? path.join(process.env.APPDATA ?? os.homedir(), 'corral') : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'corral'));
}
export function privateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (process.platform !== 'win32' && (st.mode & 0o077)))
        throw new RuntimeError('unsafe_permissions', `${directory} must be owned by this user with mode 0700`);
}
export function atomicWrite(file: string, value: unknown): void {
    privateDirectory(path.dirname(file));
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        ;
        fs.renameSync(tmp, file);
    }
    finally {
        fs.rmSync(tmp, { force: true });
    }
}
/** Runtime profile files are read under the exclusive owner lock. */
export function readFile<T>(file: string, fallback: () => T): T {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return fallback();
        throw new RuntimeError('storage_corrupt', `Cannot read ${file}: ${String(error)}`);
    }
}
/** Serializes stale-owner recovery. Never remove another contender's newly acquired lock. */
export function recoverLock<T>(lock: string, recover: () => T): T {
    let fd: number;
    try {
        fd = fs.openSync(`${lock}.recovery`, 'wx', 0o600);
    }
    catch {
        throw new RuntimeError('store_busy', `Lock recovery already in progress: ${lock}`);
    }
    try {
        return recover();
    }
    finally {
        fs.closeSync(fd);
        fs.unlinkSync(`${lock}.recovery`);
    }
}
