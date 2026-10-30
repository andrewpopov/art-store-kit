import type { ArchiveRemote } from './archive';
export type Exec = (file: string, args: readonly string[], input?: string) => string;
export declare function shellQuote(value: string): string;
export declare const defaultExec: Exec;
export declare function createSshArchiveRemote(host: string, options?: {
    exec?: Exec;
    controlDir?: string;
}): ArchiveRemote & {
    close(): void;
};
