"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultExec = void 0;
exports.shellQuote = shellQuote;
exports.createSshArchiveRemote = createSshArchiveRemote;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const MAX_BUFFER = 64 * 1024 * 1024;
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
const defaultExec = (file, args, input) => (0, node_child_process_1.execFileSync)(file, [...args], { input, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'inherit'] });
exports.defaultExec = defaultExec;
function createSshArchiveRemote(host, options = {}) {
    const exec = options.exec ?? exports.defaultExec;
    const controlDir = options.controlDir ?? node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'art-store-ssh-'));
    const controlPath = node_path_1.default.join(controlDir, 'ctl');
    const sshOptions = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=120'];
    const ssh = (script, input) => exec('ssh', [...sshOptions, host, script], input);
    const rsync = (...args) => exec('rsync', ['-t', '-e', `ssh ${sshOptions.join(' ')}`, ...args]);
    return {
        label: host,
        isMountpoint(mount) {
            try {
                ssh(`mountpoint -q ${shellQuote(mount)}`);
                return true;
            }
            catch {
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
            }
            catch (error) {
                const failure = error;
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
            if (node_fs_1.default.existsSync(controlPath))
                exec('ssh', ['-O', 'exit', '-o', `ControlPath=${controlPath}`, host]);
            node_fs_1.default.rmSync(controlDir, { recursive: true, force: true });
        },
    };
}
