export type ArchiveEntry = {
    sha: string;
    path: string;
};
export type ArchiveSettings = {
    root: string;
    requireMount: string;
    snapshotPrefix: string;
    sourceDir: string;
    manifestPath: string;
    extensions: readonly string[];
};
export type ArchiveRemote = {
    label: string;
    isMountpoint(mount: string): boolean;
    ensureDirs(dirs: readonly string[]): void;
    upload(localFile: string, remoteFile: string): void;
    verifyObjects(objectsDir: string, checksumLines: string): {
        ok: boolean;
        output: string;
    };
    writeNoClobber(remoteFile: string, content: string): void;
    download(remoteFile: string, localFile: string): void;
};
export type ArchiveDeps = {
    now?: () => Date;
    log?: (line: string) => void;
};
export type ArchiveResult = {
    count: number;
    snapshot: string;
};
export type ArchivePullResult = {
    selected: number;
    fetched: number;
    failed: string[];
};
export declare function sha256File(file: string): string;
export declare function archiveObjectName(entry: ArchiveEntry): string;
export declare function scanArchiveSource(sourceDir: string, extensions: readonly string[]): ArchiveEntry[];
export declare function serializeArchiveManifest(entries: readonly ArchiveEntry[]): string;
export declare function parseArchiveManifest(text: string): ArchiveEntry[];
export declare function checksumLines(entries: readonly ArchiveEntry[]): string;
export declare function snapshotStamp(now: Date): string;
export declare function archive(settings: ArchiveSettings, remote: ArchiveRemote, deps?: ArchiveDeps): ArchiveResult;
export declare function archivePull(settings: ArchiveSettings, remote: ArchiveRemote, prefix?: string): ArchivePullResult;
