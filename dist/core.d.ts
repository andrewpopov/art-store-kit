import { type ArtManifest } from './manifest';
export declare const LISTING_CAP = 20;
export type StoreProblems = {
    missing: string[];
    corrupt: string[];
};
export type MaterializeResult = {
    created: number;
    present: number;
    repaired: string[];
    corrupt: string[];
    missingSources: string[];
    changedSources: string[];
};
export type PublishTarget = {
    host: string;
    projectDir: string;
};
export type RemoteStoreTarget = PublishTarget & {
    storeName: string;
};
export type RsyncCommand = {
    args: string[];
    stdin: string;
};
export declare function hashBytes(bytes: Uint8Array): string;
export declare function buildManifest(keys: readonly string[], readBytes: (key: string) => Uint8Array, extensions: readonly string[]): ArtManifest;
export declare function serializeManifest(manifest: ArtManifest): string;
export declare function formatCapped(label: string, items: readonly string[], cap?: number): string[];
export declare function objectNames(manifest: ArtManifest, extensions: readonly string[]): Map<string, string>;
export declare function hashFile(file: string): string;
export declare function hashOfObjectName(name: string): string;
export declare function storeObject(source: string, storeDir: string, name: string): 'created' | 'present' | 'changed' | 'repaired';
export declare function materialize(manifest: ArtManifest, publicRoot: string, storeDir: string, extensions: readonly string[]): MaterializeResult;
export declare function verifyStore(manifest: ArtManifest, storeDir: string, extensions: readonly string[]): StoreProblems & {
    checked: number;
};
export declare function remoteStoreDir(target: RemoteStoreTarget): string;
export declare function buildSendCommand(storeDir: string, target: RemoteStoreTarget, names: readonly string[], repair?: boolean): RsyncCommand;
export declare function buildFetchCommand(storeDir: string, target: RemoteStoreTarget, names: readonly string[], repair?: boolean): RsyncCommand;
export declare function buildVerifyCommand(storeDir: string, target: RemoteStoreTarget, names: readonly string[]): RsyncCommand;
export declare function buildMkdirCommand(target: RemoteStoreTarget): string[];
export declare function parseItemizedNames(output: string): string[];
export declare function listFilesUnder(publicRoot: string, startKey: string): string[];
