import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";
import { singleFlight } from "../utils/singleFlight";
import { DigestEntry } from "./DigestParser";
import { appendDeclaration } from "./digestParsing";
import { BUNDLED_DIGEST_NAMES, digestDataFile } from "./digestManifest";

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
    entries: Record<string, DigestEntry[]>;
    moduleIndex: Record<string, string[]>;
}

/**
 * The bundled Verse API index, read from the JSON that
 * `src/scripts/parseDigestFiles.ts` generates at build time rather than parsed
 * from Verse source at startup.
 *
 * This is DigestParser's only source. It reports failure by throwing from
 * {@link loadPrecompiledDigests} and by leaving {@link isLoaded} false; there is
 * no second source to fall back to, so DigestParser surfaces that to the user.
 */
export class PrecompiledDigestLoader {
    private digestCache: Map<string, DigestEntry[]> = new Map();
    private moduleIndex: Map<string, string[]> = new Map();
    private loaded: boolean = false;
    private loadError: Error | null = null;
    /**
     * Overlapping load calls must share one run: each run merges into
     * digestCache, and `loaded` only latches after the merge, so a second
     * concurrent run would append every declaration twice.
     */
    private readonly loadOnce = singleFlight(() => this.doLoad());
    /**
     * Bumped by {@link clear} and captured at each load's start, and re-checked
     * before the load latches, so a load that a clear overtook cannot set
     * `loaded` over the emptied index - which would make every later call
     * return early onto nothing.
     */
    private loadGeneration: number = 0;

    constructor(private extensionContext: vscode.ExtensionContext) {}

    /**
     * Loads every digest file into memory, throwing if none of them could be
     * read.
     *
     * One file is enough to count as loaded, so a caller that sees
     * {@link isLoaded} true may still be holding a partial index. Only a total
     * failure leaves it false. Calling again after success is a no-op, and a
     * call that overlaps a running load joins it; only a settled failure runs
     * the load again. A load that {@link clear} overtakes resolves without
     * loading: resolution alone is not success - {@link isLoaded} is.
     */
    async loadPrecompiledDigests(): Promise<void> {
        if (this.loaded) {
            return;
        }

        return this.loadOnce();
    }

    private async doLoad(): Promise<void> {
        const startTime = Date.now();
        const generation = this.loadGeneration;
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

            // The index was cleared while loading; what this run merged is
            // gone, so latching `loaded` here would leave it true over an
            // empty cache.
            if (generation !== this.loadGeneration) {
                logger.debug("PrecompiledDigestLoader", "Cache cleared during load, leaving it unloaded");
                return;
            }

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

        for (const digestName of BUNDLED_DIGEST_NAMES) {
            const fileName = digestDataFile(digestName);
            const filePath = path.join(dataDir, fileName);

            if (!fs.existsSync(filePath)) {
                logger.warn("PrecompiledDigestLoader", `Digest file not found: ${filePath}`);
                continue;
            }

            try {
                const content = fs.readFileSync(filePath, "utf8");
                const digest: PrecompiledDigest = JSON.parse(content);

                // Every declaring module is kept, one per module path, so a
                // lookup can offer the choice. BUNDLED_DIGEST_NAMES order is
                // still the precedence between the three domains: it decides
                // which path leads the list, and the lead is what a caller
                // picking one answer takes.
                for (const [identifier, declarations] of Object.entries(digest.entries)) {
                    const merged = this.digestCache.get(identifier) ?? [];
                    for (const declaration of declarations) {
                        appendDeclaration(merged, declaration);
                    }
                    this.digestCache.set(identifier, merged);
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

    /**
     * Every module that declares this identifier, empty if none does.
     *
     * The live array, not a copy: pushing into it adds a module the digests
     * never declared, and the next lookup serves it.
     */
    getEntry(identifier: string): DigestEntry[] {
        return this.digestCache.get(identifier) ?? [];
    }

    getModuleIdentifiers(modulePath: string): string[] {
        return this.moduleIndex.get(modulePath) || [];
    }

    /** The live cache, not a copy: mutating it corrupts the index. */
    getAllEntries(): Map<string, DigestEntry[]> {
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
        // Invalidate any load still in flight - what it merged was just
        // emptied - and drop its memo so the next call starts a fresh load
        // instead of joining the overtaken one.
        this.loadGeneration++;
        this.loadOnce.reset();
        logger.debug("PrecompiledDigestLoader", "Cache cleared");
    }
}
