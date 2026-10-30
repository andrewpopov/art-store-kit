import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArchiveRemote } from './archive';

export type Exec = (file: string, args: readonly string[], input?: string) => string;

const MAX_BUFFER = 64 * 1024 * 1024;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const defaultExec: Exec = (file, args, input) =>
  execFileSync(file, [...args], { input, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'inherit'] });

export function createSshArchiveRemote(
  host: string,
  options: { exec?: Exec; controlDir?: string } = {},
): ArchiveRemote & { close(): void } {
  const exec = options.exec ?? defaultExec;
  const controlDir = options.controlDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'art-store-ssh-'));
  const controlPath = path.join(controlDir, 'ctl');
  const sshOptions = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=120'];
  const ssh = (script: string, input?: string): string => exec('ssh', [...sshOptions, host, script], input);
  const rsync = (...args: string[]): string => exec('rsync', ['-t', '-e', `ssh ${sshOptions.join(' ')}`, ...args]);

  return {
    label: host,
    isMountpoint(mount) {
      try {
        ssh(`mountpoint -q ${shellQuote(mount)}`);
        return true;
      } catch {
        return false;
      }
    },
    ensureDirs(dirs) {
      ssh(`mkdir -p ${dirs.map(shellQuote).join(' ')}`);
    },
    upload(localFile, remoteFile) {
      rsync('--ignore-existing', localFile, `${host}:${remoteFile}`);
    },
    verifyObjects(objectsDir, checksumLines) {
      try {
        return { ok: true, output: ssh(`cd ${shellQuote(objectsDir)} && sha256sum -c --quiet`, checksumLines) };
      } catch (error) {
        const failure = error as { stdout?: string; message: string };
        return { ok: false, output: failure.stdout ?? failure.message };
      }
    },
    writeNoClobber(remoteFile, content) {
      ssh(`set -C; cat > ${shellQuote(remoteFile)}`, content);
    },
    download(remoteFile, localFile) {
      rsync(`${host}:${remoteFile}`, localFile);
    },
    close() {
      if (fs.existsSync(controlPath)) exec('ssh', ['-O', 'exit', '-o', `ControlPath=${controlPath}`, host]);
      fs.rmSync(controlDir, { recursive: true, force: true });
    },
  };
}
