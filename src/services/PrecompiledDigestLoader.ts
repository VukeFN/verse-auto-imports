import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";
import { DigestEntry } from "./DigestParser";

/**
 * One `src/data/*.digest.json` payload, as written by `npm run parse-digest`.
 * Hand-editing these files is not supported; change the generator or its
 * `src/utils/*.digest.verse` input instead.
 */
export interface PrecompiledDigest {
    version: string;
    generatedAt: string;
    sourceFile: string;
    sourceBuild: string;
    entries: Record<string, DigestEntry>;
    moduleIndex: Record<string, string[]>;
}

/**
 * The bundled Verse API index, read from the JSON that
 * `src/scripts/parseDigestFiles.ts` generates at build time rather than parsed
 * from Verse source at startup.
 *
 * This is DigestParser's fast path. It reports failure by throwing from
 * {@link loadPrecompiledDigests} and by leaving {@link isLoaded} false, which is
 * the signal DigestParser falls back on.
 */
export class PrecompiledDigestLoader {
    private digestCache: Map<string, DigestEntry> = new Map();
    private moduleIndex: Map<string, string[]> = new Map();
    private loaded: boolean = false;
    private loadError: Error | null = null;

    private static readonly DIGEST_FILES = ["Fortnite.digest.json", "UnrealEngine.digest.json", "Verse.digest.json"];

    constructor(private extensionContext: vscode.ExtensionContext) {}

    /**
     * Loads every digest file into memory, throwing if none of them could be
     * read.
     *
     * One file is enough to count as loaded, so a caller that sees
     * {@link isLoaded} true may still be holding a partial index. Only a total
     * failure leaves it false and sends DigestParser to runtime parsing.
     * Calling again after success is a no-op.
     */
    async loadPrecompiledDigests(): Promise<void> {
        if (this.loaded) {
            return;
        }

        const startTime = Date.now();
        logger.debug("PrecompiledDigestLoader", "Loading pre-compiled digest files...");

        try {
            const extensionPath = this.extensionContext.extensionPath;
            const dataDir = path.join(extensionPath, "src", "data");

            // The .vsix carries src/data only because .vscodeignore negates it
            // with `!src/data/**`. Drop that negation and the packaged
            // extension ships no digest data at all.
            if (!fs.existsSync(dataDir)) {
                throw new Error(`Pre-compiled digest directory not found: ${dataDir}`);
            }

            const successCount = await this.loadFromDirectory(dataDir);

            if (successCount > 0) {
                this.loaded = true;
                const elapsed = Date.now() - startTime;
                logger.info("PrecompiledDigestLoader", `Loaded ${this.digestCache.size} entries from ${successCount} pre-compiled digest file(s) in ${elapsed}ms`);
            } else {
                throw new Error("No digest files were successfully loaded");
            }
        } catch (error) {
            this.loadError = error instanceof Error ? error : new Error(String(error));
            logger.error("PrecompiledDigestLoader", "Failed to load pre-compiled digests", error);
            throw this.loadError;
        }
    }

    /**
     * How many of the expected digest files were read and merged. A file that
     * is missing or unparseable is logged and skipped rather than failing the
     * others.
     */
    private async loadFromDirectory(dataDir: string): Promise<number> {
        let successCount = 0;

        for (const fileName of PrecompiledDigestLoader.DIGEST_FILES) {
            const filePath = path.join(dataDir, fileName);

            if (!fs.existsSync(filePath)) {
                logger.warn("PrecompiledDigestLoader", `Digest file not found: ${filePath}`);
                continue;
            }

            try {
                const content = fs.readFileSync(filePath, "utf8");
                const digest: PrecompiledDigest = JSON.parse(content);

                // First file to declare an identifier wins, matching
                // DigestParser's runtime merge. DIGEST_FILES order is therefore
                // the precedence between the three domains.
                for (const [identifier, entry] of Object.entries(digest.entries)) {
                    if (!this.digestCache.has(identifier)) {
                        this.digestCache.set(identifier, entry);
                    }
                }

                // The module index unions instead, so a module re-declared
                // across files keeps every member.
                for (const [modulePath, identifiers] of Object.entries(digest.moduleIndex)) {
                    const existingSet = new Set(this.moduleIndex.get(modulePath) || []);
                    for (const id of identifiers) {
                        existingSet.add(id);
                    }
                    this.moduleIndex.set(modulePath, Array.from(existingSet));
                }

                successCount++;
                logger.trace("PrecompiledDigestLoader", `Loaded ${Object.keys(digest.entries).length} entries from ${fileName}`);
            } catch (error) {
                logger.error("PrecompiledDigestLoader", `Failed to parse ${fileName}`, error);
            }
        }

        return successCount;
    }

    getEntry(identifier: string): DigestEntry | undefined {
        return this.digestCache.get(identifier);
    }

    getModuleIdentifiers(modulePath: string): string[] {
        return this.moduleIndex.get(modulePath) || [];
    }

    /** The live cache, not a copy: mutating it corrupts the index. */
    getAllEntries(): Map<string, DigestEntry> {
        return this.digestCache;
    }

    isLoaded(): boolean {
        return this.loaded;
    }

    getLoadError(): Error | null {
        return this.loadError;
    }

    getStats(): { entries: number; modules: number; loaded: boolean } {
        return {
            entries: this.digestCache.size,
            modules: this.moduleIndex.size,
            loaded: this.loaded,
        };
    }

    /** Empties the index and allows {@link loadPrecompiledDigests} to run again. */
    clear(): void {
        this.digestCache.clear();
        this.moduleIndex.clear();
        this.loaded = false;
        this.loadError = null;
        logger.debug("PrecompiledDigestLoader", "Cache cleared");
    }
}
