/**
 * Recognizes the one compiler message that a `<public>` module declaration
 * fixes, and pulls the two Verse paths out of it. No VS Code dependencies.
 */

/**
 * The help sentence the compiler appends only when the inaccessible definition
 * is a module whose derived access level is internal. Every other shape of
 * error 3593 - an inaccessible class, a private field, the "All references to
 * `X` are inaccessible" sibling - lacks it, so matching this is what keeps the
 * quick fix off diagnostics a `<public>` module part would not fix.
 *
 * Keyed on the tail rather than on the `<public>` token: the token is rendered
 * backticked in some captures and bare in others, and which one a given UEFN
 * build emits is not established.
 */
const INTERNAL_MODULE_HELP = /to make it accessible from other modules within your project/;

/**
 * The inaccessible module, written as a parenthesized parent path followed by
 * the module's own name: "`(/Account@fortnite.com/Project/Gadgets:)Tools`".
 */
const TARGET_QUALIFIED = /`\((\/[^:)]+):\)([A-Za-z_][A-Za-z0-9_]*(?:'[^']*')?)`/;

/**
 * The referencing scope: the second backticked path, introduced by "from".
 * Its kind word varies (module, class, function), so the pattern does not
 * pin it.
 */
const IMPORTER_PATH = /\bfrom\s+\w+\s+`(\/[^`]+)`/;

/** An inaccessible-module diagnostic, reduced to the two paths that decide the fix. */
export interface ModuleVisibilityRequest {
    /** Absolute Verse path of the module that must become public. */
    targetPath: string;

    /** Absolute Verse path of the scope that failed to reach it. */
    importerPath: string;

    /** Final segment of `targetPath`, for the quick fix title. */
    moduleName: string;
}

/**
 * The request a compiler message describes, or null when the message is not an
 * internal-module access error.
 *
 * Returning null is the common case by a wide margin: this runs against every
 * diagnostic the editor reports.
 */
export function parseModuleVisibilityMessage(message: string): ModuleVisibilityRequest | null {
    if (!INTERNAL_MODULE_HELP.test(message)) {
        return null;
    }

    const target = message.match(TARGET_QUALIFIED);
    const importer = message.match(IMPORTER_PATH);
    if (!target || !importer) {
        return null;
    }

    const [, parentPath, moduleName] = target;

    return {
        targetPath: `${parentPath}/${moduleName}`,
        importerPath: importer[1],
        moduleName,
    };
}
