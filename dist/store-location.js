"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLaneSnapshot = isLaneSnapshot;
exports.resolveArtStoreDir = resolveArtStoreDir;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const GITDIR_PATTERN = /^gitdir:\s*(.+?)\s*$/m;
function worktreeOwnerRoot(repoRoot) {
    const dotGit = (0, node_path_1.join)(repoRoot, '.git');
    try {
        if (!(0, node_fs_1.statSync)(dotGit).isFile())
            return null;
        const match = GITDIR_PATTERN.exec((0, node_fs_1.readFileSync)(dotGit, 'utf8'));
        if (!match)
            return null;
        const gitDir = (0, node_path_1.isAbsolute)(match[1]) ? match[1] : (0, node_path_1.resolve)(repoRoot, match[1]);
        const worktreesDir = (0, node_path_1.dirname)(gitDir);
        const commonGitDir = (0, node_path_1.dirname)(worktreesDir);
        if (worktreesDir.split(/[\\/]/).pop() !== 'worktrees' || commonGitDir.split(/[\\/]/).pop() !== '.git')
            return null;
        return (0, node_path_1.dirname)(commonGitDir);
    }
    catch {
        return null;
    }
}
// Since lane-broker 0.45.0 a remote runner exports LANE_BROKER_EXECUTOR=remote and gives the tree a
// synthetic `git init`, so `.git` alone can't tell. A root with no .git at all counts too.
function isLaneSnapshot(repoRoot, env = process.env) {
    return env.LANE_BROKER_EXECUTOR === 'remote' || !(0, node_fs_1.existsSync)((0, node_path_1.join)(repoRoot, '.git'));
}
function resolveArtStoreDir(repoRoot, location, env = process.env, home = node_os_1.homedir) {
    if (env.ART_STORE_DIR)
        return (0, node_path_1.resolve)(env.ART_STORE_DIR);
    if (isLaneSnapshot(repoRoot, env))
        return (0, node_path_1.join)(env.XDG_CACHE_HOME || (0, node_path_1.join)(home(), '.cache'), location.machineCache);
    return (0, node_path_1.join)(worktreeOwnerRoot(repoRoot) ?? repoRoot, location.dirName);
}
