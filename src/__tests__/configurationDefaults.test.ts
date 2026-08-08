import * as fs from "fs";
import * as path from "path";
import { DEFAULT_AMBIGUOUS_IMPORTS } from "../imports/ImportSuggestionExtractor";

/**
 * Guard for issue #135's defect class: a code-side fallback that disagrees with
 * the default package.json registers.
 *
 * config.get returns the registered default for a registered setting, so a
 * disagreeing fallback is dead in production - but src/__mocks__/vscode.ts
 * returns the passed fallback, so the suite runs against the fallback instead.
 * A divergence therefore changes nothing a user sees and everything the tests
 * see, which is why two of them survived a release each.
 *
 * This walks the real call sites rather than a hand-kept list: a new
 * config.get with a wrong fallback fails here without anyone remembering to
 * update a table.
 */
describe("code-side configuration fallbacks", () => {
    const srcRoot = path.join(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(srcRoot, "..", "package.json"), "utf8"));
    const registered: Record<string, { default?: unknown }> = manifest.contributes.configuration.properties;

    /** One `config.get<T>("key", fallback)` call found in the source. */
    interface CallSite {
        file: string;
        key: string;
        /** The fallback's source text, before any attempt to resolve it. */
        fallbackSource: string;
    }

    /** Every .ts file under src/, excluding tests, mocks and the integration suite. */
    const sourceFiles = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                return ["__tests__", "__mocks__", "test-integration"].includes(entry.name) ? [] : sourceFiles(full);
            }
            return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
        });

    /**
     * Matches `.get<T>("key", fallback)` where the fallback is a single
     * argument with no nested parentheses or commas - a literal, or an
     * identifier naming one. Object and call-expression fallbacks are left to
     * UNRESOLVED below rather than parsed badly.
     */
    const GET_WITH_FALLBACK = /\.get<[^>]+>\(\s*"([^"]+)"\s*,\s*([^(),]+?)\s*\)/g;

    /** `const NAME = <literal>` or `static readonly NAME = <literal>` in the same file. */
    const literalConstant = (source: string, name: string): string | undefined => {
        const declaration = new RegExp(`(?:const|static readonly)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+);`).exec(source);
        return declaration?.[1].trim();
    };

    /**
     * Fallbacks this scan cannot read statically. Each needs its own assertion
     * below; listing them here means a NEW unreadable site fails the scan
     * rather than being skipped in silence.
     */
    const UNRESOLVED = new Set(["behavior.ambiguousImports"]);

    const callSites: CallSite[] = [];
    for (const file of sourceFiles(srcRoot)) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(GET_WITH_FALLBACK)) {
            const [, key, fallbackSource] = match;
            const resolved = /^[A-Za-z_$][\w$.]*$/.test(fallbackSource) ? literalConstant(source, fallbackSource.split(".").pop() as string) : fallbackSource;
            callSites.push({ file: path.relative(srcRoot, file), key, fallbackSource: resolved ?? fallbackSource });
        }
    }

    it("finds the call sites at all, so a broken scan cannot pass vacuously", () => {
        expect(callSites.length).toBeGreaterThan(5);
    });

    it("reads only settings package.json contributes", () => {
        for (const site of callSites) {
            expect({ site: `${site.file}:${site.key}`, contributed: `verseAutoImports.${site.key}` in registered }).toEqual({
                site: `${site.file}:${site.key}`,
                contributed: true,
            });
        }
    });

    it("passes the registered default as the fallback at every call site", () => {
        for (const site of callSites) {
            if (UNRESOLVED.has(site.key)) {
                continue;
            }

            const expected = registered[`verseAutoImports.${site.key}`]?.default;
            // The fallback's source text, compared as JSON so "curly", false
            // and 500 each match the manifest value they stand for.
            expect({ site: `${site.file}:${site.key}`, fallback: site.fallbackSource }).toEqual({
                site: `${site.file}:${site.key}`,
                fallback: JSON.stringify(expected),
            });
        }
    });

    it("has an assertion for every fallback the scan could not read", () => {
        // behavior.ambiguousImports: an object literal, compared by value.
        expect(DEFAULT_AMBIGUOUS_IMPORTS).toEqual(registered["verseAutoImports.behavior.ambiguousImports"].default);

        expect([...UNRESOLVED]).toEqual(["behavior.ambiguousImports"]);
    });
});
