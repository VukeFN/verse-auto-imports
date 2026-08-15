import * as vscode from "vscode";
import { logger } from "../utils";
import { PrecompiledDigestLoader } from "./PrecompiledDigestLoader";
import { DigestEntry } from "./digestParsing";

export { DigestEntry } from "./digestParsing";

/**
 * The index of importable Verse API identifiers, served from the precompiled
 * JSON in `src/data`.
 *
 * There is no second source. A load failure is reported to the user and leaves
 * the index empty rather than degrading quietly, and every later call retries,
 * so an install repaired mid-session recovers on the next lookup.
 *
 * Constructed without an `ExtensionContext` it holds nothing and serves nothing,
 * which is how the unit tests get an instance without a packaged extension.
 */
export class DigestParser {
    private precompiledLoader: PrecompiledDigestLoader | null = null;
    private loadFailureReported: boolean = false;

    constructor(
        private outputChannel: vscode.OutputChannel,
        extensionContext?: vscode.ExtensionContext,
    ) {
        if (extensionContext) {
            this.precompiledLoader = new PrecompiledDigestLoader(extensionContext);
        }
    }

    /** The identifier index, empty when the digest data could not be loaded. */
    async getDigestIndex(): Promise<Map<string, DigestEntry[]>> {
        if (!this.precompiledLoader) {
            return new Map();
        }

        try {
            if (!this.precompiledLoader.isLoaded()) {
                await this.precompiledLoader.loadPrecompiledDigests();
            }
            return this.precompiledLoader.getAllEntries();
        } catch (error) {
            this.reportLoadFailure(error);
            return new Map();
        }
    }

    /**
     * Tells the user once per instance that the digest data is unusable.
     *
     * Once, because the caller is a per-diagnostic lookup: reporting every
     * failure would put a modal on every keystroke that produces an unknown
     * identifier.
     */
    private reportLoadFailure(error: unknown): void {
        logger.error("DigestParser", "Pre-compiled digest data could not be loaded; identifier lookups will return nothing", error);

        if (this.loadFailureReported) {
            return;
        }
        this.loadFailureReported = true;

        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Verse Auto Imports could not read its bundled digest data, so identifier lookups are unavailable. Reinstalling the extension should restore it. (${detail})`);
    }

    /**
     * Every entry declaring this exact identifier, one per module that declares
     * it, led by the module the digest precedence order prefers.
     *
     * More than one is the normal case for a name two modules both export, and
     * the diagnostics handler reads the extras as a choice to offer, or under an
     * `auto_*` multi-option strategy to make on the user's behalf.
     *
     * The match is exact on purpose. Matching by substring returned every entry
     * whose name merely contained the identifier - 226 of them for `device`.
     *
     * The live array, not a copy: pushing into it adds a module the digests
     * never declared, and the next lookup serves it.
     */
    async lookupIdentifier(identifier: string): Promise<DigestEntry[]> {
        const index = await this.getDigestIndex();
        return index.get(identifier) ?? [];
    }

    /** Drops the loaded index, so the next lookup re-reads it from disk. */
    clearCache(): void {
        if (this.precompiledLoader) {
            this.precompiledLoader.clear();
        }
        logger.debug("DigestParser", "Digest cache cleared");
    }

    /** How much the index holds, and whether it loaded at all. */
    getStats(): { entries: number; loaded: boolean } {
        if (!this.precompiledLoader) {
            return { entries: 0, loaded: false };
        }
        const stats = this.precompiledLoader.getStats();
        return { entries: stats.entries, loaded: stats.loaded };
    }
}
