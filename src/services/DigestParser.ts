import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";
import { PrecompiledDigestLoader } from "./PrecompiledDigestLoader";
import { DigestEntry, parseDigestContent, rootDomainForDigestFile } from "./digestParsing";

export { DigestEntry } from "./digestParsing";

/**
 * The index of importable Verse API identifiers, served from precompiled JSON
 * where possible and parsed from the bundled `.digest.verse` files where not.
 *
 * The fallback is one-way: the first failure to load the precompiled data
 * latches precompiled use off for the lifetime of the instance, so a transient
 * failure costs runtime parsing for the rest of the session rather than
 * retrying on every lookup. {@link forceReparse} is the only way back to
 * runtime parsing by choice, and nothing returns to precompiled data short of a
 * new instance.
 */
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

    /**
     * Entries whose identifier matches, the exact one first and then every
     * case-insensitive substring match. This order survives into the quick-fix
     * menu, so the exact match is what the user is offered first.
     */
    async lookupIdentifier(identifier: string): Promise<DigestEntry[]> {
        const index = await this.getDigestIndex();
        const results: DigestEntry[] = [];

        const exactMatch = index.get(identifier);
        if (exactMatch) {
            results.push(exactMatch);
        }

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
     * Merges one digest file's entries into the runtime cache, keeping the entry
     * already there on a collision. First occurrence therefore wins across the
     * Fortnite, UnrealEngine and Verse files in that iteration order, which is
     * what the precompiled loader does too - the two must agree, or the same
     * identifier resolves differently depending on which path served it.
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
     * Reparses the bundled `.verse` files and switches this instance to runtime
     * parsing for good, for when the precompiled data is suspected stale.
     * Nothing switches it back.
     */
    async forceReparse(): Promise<void> {
        logger.info("DigestParser", "Forcing runtime reparse of digest files...");
        this.usePrecompiled = false;
        this.digestCache.clear();
        await this.parseDigestFiles();
        this.lastParsed = Date.now();
        logger.info("DigestParser", `Runtime reparse complete: ${this.digestCache.size} entries`);
    }

    /** Which of the two sources is currently serving lookups, and how much it holds. */
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
