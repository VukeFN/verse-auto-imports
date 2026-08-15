/**
 * The bundled Verse API digests, named in one place for both halves of the
 * pipeline: `npm run parse-digest` reads the `.verse` sources under
 * `src/utils`, and PrecompiledDigestLoader reads the `.json` it writes to
 * `src/data`. Both file-name lists derive from this one.
 *
 * A new digest needs a second edit that this module cannot carry:
 * `digestParsing.rootDomainForDigestFile` keys the root module domain off the
 * file name and returns "" for a name it does not know, which roots every
 * top-level declaration in the new file at "" rather than failing.
 *
 * No VS Code dependencies: the generator runs under ts-node outside the
 * extension host.
 */

/**
 * The bundled digests, in load precedence order. A lookup keeps every module
 * that declares an identifier, so this order no longer decides which one
 * answers - it decides which one leads the list, and the lead is what the
 * quick-fix menu prefers and what an `auto_first` strategy applies unasked.
 */
export const BUNDLED_DIGEST_NAMES = ["Fortnite", "UnrealEngine", "Verse"] as const;

/** The checked-in Verse source a digest is generated from. */
export function digestSourceFile(digestName: string): string {
    return `${digestName}.digest.verse`;
}

/** The generated JSON a digest is loaded from. */
export function digestDataFile(digestName: string): string {
    return `${digestName}.digest.json`;
}
