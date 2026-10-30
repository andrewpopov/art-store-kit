export declare const ART_HASH_HEX_LENGTH = 32;
export type ArtManifest = {
    version: 1;
    hash: 'sha256-128';
    entries: Record<string, string>;
};
export type ArtLayout = {
    trackedDir: string;
    extensions: readonly string[];
};
export declare function isArtExtension(logicalPath: string, extensions: readonly string[]): boolean;
export declare function artObjectName(logicalPath: string, hash: string, extensions: readonly string[]): string;
export declare function isArtObjectName(name: string, extensions: readonly string[]): boolean;
export declare function parseArtManifest(json: unknown, layout: ArtLayout): ArtManifest;
