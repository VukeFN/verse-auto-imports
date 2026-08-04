import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";
import { PrecompiledDigestLoader } from "./PrecompiledDigestLoader";
import { DigestEntry, parseDigestContent, rootDomainForDigestFile } from "./digestParsing";

export { DigestEntry } from "./digestParsing";

export class DigestParser {
    private digestCache: Map<string, DigestEntry> = new Map();
    private lastParsed: number = 0;
    private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    private precompiledLoader: PrecompiledDigestLoader | null = null;
    private usePrecompiled: boolean = true;

    constructor(
        private outputChannel: vscode.OutputChannel,
        private extensionContext?: vscode.ExtensionContext,
    ) {
        if (extensionContext) {
            this.precompiledLoader = new PrecompiledDigestLoader(extensionContext);
        }
    }

    async getDigestIndex(): Promise<Map<string, DigestEntry>> {
        // Try precompiled loader first
        if (this.usePrecompiled && this.precompiledLoader) {
            try {
                if (!this.precompiledLoader.isLoaded()) {
                    await this.precompiledLoader.loadPrecompiledDigests();
                }
                if (this.precompiledLoader.isLoaded()) {
                    logger.debug("DigestParser", "Using pre-compiled digest index");
                    return this.precompiledLoader.getAllEntries();
                }
            } catch (error) {
                logger.warn("DigestParser", "Pre-compiled digests not available, falling back to runtime parsing");
                this.usePrecompiled = false;
            }
        }

        // Fallback to runtime parsing
        const now = Date.now();
        if (this.digestCache.size > 0 && now - this.lastParsed < this.CACHE_DURATION) {
            logger.debug("DigestParser", "Using cached digest index (runtime parsed)");
            return this.digestCache;
        }

        logger.debug("DigestParser", "Parsing digest files at runtime...");
        await this.parseDigestFiles();
        this.lastParsed = now;
        return this.digestCache;
    }

    async lookupIdentifier(identifier: string): Promise<DigestEntry[]> {
        const index = await this.getDigestIndex();
        const results: DigestEntry[] = [];

        // Exact match
        const exactMatch = index.get(identifier);
        if (exactMatch) {
            results.push(exactMatch);
        }

        // Partial matches (case-insensitive)
        const lowerIdentifier = identifier.toLowerCase();
        for (const [key, entry] of index) {
            if (key.toLowerCase().includes(lowerIdentifier) && key !== identifier) {
                results.push(entry);
            }
        }

        return results;
    }

    private async parseDigestFiles(): Promise<void> {
        this.digestCache.clear();

        try {
            const digestFiles = ["Fortnite.digest.verse", "UnrealEngine.digest.verse", "Verse.digest.verse"];

            const extensionPath = vscode.extensions.getExtension("vukefn.verse-auto-imports")?.extensionPath;
            if (!extensionPath) {
                logger.warn("DigestParser", "Extension path not found, using relative path");
                return;
            }

            const utilsPath = path.join(extensionPath, "src", "utils");

            for (const fileName of digestFiles) {
                const filePath = path.join(utilsPath, fileName);
                if (fs.existsSync(filePath)) {
                    logger.trace("DigestParser", `Parsing digest file: ${fileName}`);
                    this.parseDigestFile(filePath);
                } else {
                    logger.trace("DigestParser", `Digest file not found: ${filePath}`);
                }
            }

            logger.info("DigestParser", `Parsed ${this.digestCache.size} identifiers from digest files`);
        } catch (error) {
            logger.error("DigestParser", "Error parsing digest files", error);
        }
    }

    /**
     * Parses one digest file via the shared {@link parseDigestContent} module and
     * merges its entries into the runtime cache. Entries already present are kept
     * (first occurrence wins across the Fortnite, UnrealEngine, and Verse files, in
     * that iteration order), matching the precompiled loader's merge semantics.
     */
    private parseDigestFile(filePath: string): void {
        try {
            const content = fs.readFileSync(filePath, "utf8");
            const rootDomain = rootDomainForDigestFile(path.basename(filePath));
            const { entries } = parseDigestContent(content, rootDomain);

            for (const entry of Object.values(entries)) {
                if (!this.digestCache.has(entry.identifier)) {
                    this.digestCache.set(entry.identifier, entry);
                }
            }
        } catch (error) {
            logger.error("DigestParser", `Error reading digest file ${filePath}`, error);
        }
    }

    clearCache(): void {
        this.digestCache.clear();
        this.lastParsed = 0;
        if (this.precompiledLoader) {
            this.precompiledLoader.clear();
        }
        logger.debug("DigestParser", "Digest cache cleared");
    }

    /**
     * Force reparse of digest files at runtime.
     * This bypasses the precompiled loader and parses the raw .verse files.
     * Useful if user suspects the precompiled data is outdated.
     */
    async forceReparse(): Promise<void> {
        logger.info("DigestParser", "Forcing runtime reparse of digest files...");
        this.usePrecompiled = false;
        this.digestCache.clear();
        await this.parseDigestFiles();
        this.lastParsed = Date.now();
        logger.info("DigestParser", `Runtime reparse complete: ${this.digestCache.size} entries`);
    }

    /**
     * Get statistics about the current digest data
     */
    getStats(): { entries: number; source: "precompiled" | "runtime"; loaded: boolean } {
        if (this.usePrecompiled && this.precompiledLoader?.isLoaded()) {
            const stats = this.precompiledLoader.getStats();
            return {
                entries: stats.entries,
                source: "precompiled",
                loaded: stats.loaded,
            };
        }
        return {
            entries: this.digestCache.size,
            source: "runtime",
            loaded: this.digestCache.size > 0,
        };
    }
}
