import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const GITDIR_PATTERN = /^gitdir:\s*(.+?)\s*$/m;

export type StoreLocation = {
  dirName: string;
  machineCache: string;
};

function worktreeOwnerRoot(repoRoot: string): string | null {
  const dotGit = join(repoRoot, '.git');
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = GITDIR_PATTERN.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    const gitDir = isAbsolute(match[1]) ? match[1] : resolve(repoRoot, match[1]);
    const worktreesDir = dirname(gitDir);
    const commonGitDir = dirname(worktreesDir);
    if (worktreesDir.split(/[\\/]/).pop() !== 'worktrees' || commonGitDir.split(/[\\/]/).pop() !== '.git') return null;
    return dirname(commonGitDir);
  } catch {
    return null;
  }
}

// Since lane-broker 0.45.0 a remote runner exports LANE_BROKER_EXECUTOR=remote and gives the tree a
// synthetic `git init`, so `.git` alone can't tell. A root with no .git at all counts too.
export function isLaneSnapshot(repoRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANE_BROKER_EXECUTOR === 'remote' || !existsSync(join(repoRoot, '.git'));
}

export function resolveArtStoreDir(
  repoRoot: string,
  location: StoreLocation,
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  if (env.ART_STORE_DIR) return resolve(env.ART_STORE_DIR);
  if (isLaneSnapshot(repoRoot, env)) return join(env.XDG_CACHE_HOME || join(home(), '.cache'), location.machineCache);
  return join(worktreeOwnerRoot(repoRoot) ?? repoRoot, location.dirName);
}
