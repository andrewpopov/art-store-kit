import type { ArchiveSettings } from './archive';
import type { RemoteStoreTarget } from './core';
import type { ArtLayout } from './manifest';
import type { StoreLocation } from './store-location';
export declare const CONFIG_FILE_NAME = "art-store.config.json";
export type ArchiveConfig = {
    remote: string;
    root: string;
    sourceDir: string;
    extensions: string[];
    manifest: string;
    requireMount: string;
    snapshotPrefix: string;
};
export type ArtStoreConfig = {
    publicRoot: string;
    manifest: string;
    hydratedRecord: string;
    trackedDir: string;
    extensions: string[];
    store: StoreLocation;
    publish?: {
        host: string;
        projectDir: string;
    };
    archive?: ArchiveConfig;
};
export type ResolvedConfig = {
    repoRoot: string;
    publicRoot: string;
    publicRootRelative: string;
    manifestPath: string;
    recordPath: string;
    layout: ArtLayout;
    store: StoreLocation;
    publish: RemoteStoreTarget | null;
    archive: {
        remote: string;
        settings: ArchiveSettings;
    } | null;
};
export declare function findConfigFile(startDir: string): string;
export declare function resolveConfig(raw: unknown, repoRoot: string): ResolvedConfig;
export declare function loadConfig(startDir: string): ResolvedConfig;
