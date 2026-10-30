import { type ArtLayout, type ArtManifest } from './manifest';
export type HydratedRecord = Record<string, string>;
export type LocalHashes = Map<string, string | null>;
export type KeyState = 'in-sync' | 'absent' | 'stale-untouched' | 'local-edit';
export type ManifestChanges = {
    updated: string[];
    added: string[];
    removed: string[];
};
export type KeySpace = ArtLayout & {
    publicRoot: string;
    publicRootRelative: string;
};
export declare function readHydratedRecord(file: string): HydratedRecord;
export declare function writeHydratedRecord(file: string, record: HydratedRecord): void;
export declare function hashLocalKeys(keys: Iterable<string>, publicRoot: string): LocalHashes;
export declare function classifyKey(entry: string, local: string | null | undefined, recorded: string | undefined): KeyState;
export declare function classifyKeys(manifest: ArtManifest, local: LocalHashes, record: HydratedRecord): Map<string, KeyState>;
export type LocalEditResult = {
    manifest: ArtManifest;
    record: HydratedRecord;
    updated: string[];
    conflicts: string[];
};
export declare function applyLocalEdits(manifest: ArtManifest, local: LocalHashes, record: HydratedRecord, takeLocal?: readonly string[]): LocalEditResult;
export declare function normalizeArtKey(arg: string, space: KeySpace): string;
export declare function resolveAddKeys(args: readonly string[], space: KeySpace): string[];
export declare function applyAddRemove(manifest: ArtManifest, added: ReadonlyMap<string, string>, removeKeys: readonly string[]): {
    manifest: ArtManifest;
    added: string[];
    removed: string[];
};
export declare function checkLocal(manifest: ArtManifest, local: LocalHashes): {
    missing: string[];
    differs: string[];
};
export declare function findTrackedImages(trackedFiles: readonly string[], extensions: readonly string[]): string[];
