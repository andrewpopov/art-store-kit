import { type ArtManifest } from './manifest';
import { type RemoteStoreTarget, type RsyncCommand } from './core';
import { type HydratedRecord, type KeyState } from './manifest-edit';
export type RsyncRunner = (command: RsyncCommand) => void;
export type PullOptions = {
    publicRoot: string;
    storeDir: string;
    target: RemoteStoreTarget;
    extensions: readonly string[];
    record: HydratedRecord;
    runner: RsyncRunner;
    repair?: boolean;
    discardLocal?: boolean;
    dryRun?: boolean;
    /** Hydrate by hardlink from the store (lane snapshots): nothing may write into a hydrated file in place. */
    linkHydrated?: boolean;
    log?: (line: string) => void;
};
export type PullResult = {
    exitCode: number;
    adopted: string[];
    repaired: string[];
    fetched: string[];
    hydrated: string[];
    localEditsKept: string[];
    problems: string[];
    record: HydratedRecord;
};
export declare function needsHydration(state: KeyState, discardLocal: boolean): boolean;
export declare function planFetch(manifest: ArtManifest, states: ReadonlyMap<string, KeyState>, discardLocal: boolean, available: ReadonlySet<string>, extensions: readonly string[]): string[];
export declare function pull(manifest: ArtManifest, options: PullOptions): PullResult;
export declare function reportPull(result: PullResult, dryRun: boolean): string[];
