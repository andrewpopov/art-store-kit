export type StoreLocation = {
    dirName: string;
    machineCache: string;
};
export declare function isLaneSnapshot(repoRoot: string, env?: NodeJS.ProcessEnv): boolean;
export declare function resolveArtStoreDir(repoRoot: string, location: StoreLocation, env?: NodeJS.ProcessEnv, home?: () => string): string;
