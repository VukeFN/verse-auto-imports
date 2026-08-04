import * as vscode from "vscode";

/** Options controlling `ImportFormatter.isModuleImport`'s classification. */
export interface IsModuleImportOptions {
    /**
     * Whether the line being checked sits at file scope (column 0 of a
     * `.verse` file, or directly inside a module-definition body) rather than
     * inside a function body. The static method only sees a trimmed line, so
     * it cannot determine this itself — the caller must attest to the
     * position.
     */
    atFileScope?: boolean;
}

/**
 * Handles import formatting, syntax preferences, grouping, and path utilities.
 */
export class ImportFormatter {
    /**
     * Strips a trailing Verse comment from the content of a `using` statement.
     *
     * `#` opens a line comment and `<#` opens a block comment. Neither
     * character is legal in a module path, so everything from the first
     * comment opener onward is trivia. The path captures are greedy to end of
     * line, so without this a trailing comment is captured as part of the path
     * and re-emitted inside the braces — `using { /X # note }`, where the
     * comment swallows the closing brace and the statement no longer parses.
     *
     * @param content The captured content of a `using` statement
     * @returns The content with any trailing comment removed, trimmed
     */
    static stripTrailingComment(content: string): string {
        const hashIndex = content.indexOf("#");
        if (hashIndex === -1) {
            return content.trim();
        }
        // For a `<#` block comment the `<` opens the comment, not the path.
        const commentStart = hashIndex > 0 && content[hashIndex - 1] === "<" ? hashIndex - 1 : hashIndex;
        return content.slice(0, commentStart).trim();
    }

    /**
     * Determines if a line is a module import (as opposed to a local-scope `using`).
     *
     * `using` has two meanings in Verse:
     * - Module import: `using { /Verse.org/Simulation }`, `using { game_systems.inventory }`
     * - Local-scope using: `using{Variable}` — brings an instance's members into scope
     *
     * Verse supports three equivalent syntactic styles for `using`:
     * - Braced:   `using { /Verse.org/Simulation }`
     * - Dotted:   `using. /Verse.org/Simulation`
     * - Indented: `using:` followed by an indented path on the next line
     *
     * All three styles can express either a module import or a local-scope using.
     * Detection has two modes:
     *
     * - Default (`options.atFileScope` absent or `false`): content-based only.
     *   Paths (starting with `/`) and dot-notation module references
     *   (containing `.`) indicate module imports. Bare identifiers indicate
     *   local-scope using. This mode is used by call sites that lack
     *   positional context (they see a matched line in isolation and cannot
     *   attest to where it sits in the file).
     * - `options.atFileScope: true`: additionally treats a bare identifier as
     *   a module import (a same-directory folder-module import, e.g.
     *   `using { Features }`). This is legal per the Book of Verse only
     *   because module `using` is valid at file level or module-definition
     *   body level, while local-scope `using{instance}` is legal only inside
     *   function bodies — so a bare `using { X }` at file scope can only be a
     *   module import, never a legal local-scope using. Callers must only
     *   pass this when they know the line is not inside a function body.
     *
     * @param line The line to check
     * @param nextLine The following line in the document (needed for indented style
     *   where the content is on the next line). When not provided and the line is
     *   `using:`, conservatively returns `true`.
     * @param options Classification options; see above.
     */
    static isModuleImport(line: string, nextLine?: string, options?: IsModuleImportOptions): boolean {
        const trimmed = line.trim();
        if (!trimmed.startsWith("using")) {
            return false;
        }

        const atFileScope = options?.atFileScope ?? false;
        const isModuleImportContent = (content: string): boolean => {
            if (content.startsWith("/")) {
                return true;
            }
            if (content.includes(".")) {
                return true;
            }
            if (atFileScope && /^[A-Za-z_][A-Za-z0-9_]*$/.test(content)) {
                return true;
            }
            return false;
        };

        // Indented style: using:
        //     /Verse.org/Simulation
        // Content is on the next line — use nextLine for content-based detection.
        if (/^using\s*:\s*$/.test(trimmed)) {
            if (nextLine !== undefined) {
                return isModuleImportContent(ImportFormatter.stripTrailingComment(nextLine));
            }
            // Without next line context, conservatively assume module import
            return true;
        }

        // Dotted style: using. <content>
        const dotMatch = trimmed.match(/^using\.\s+(.+)/);
        if (dotMatch) {
            return isModuleImportContent(ImportFormatter.stripTrailingComment(dotMatch[1]));
        }

        // Braced style: using { /path } or using{Variable}
        const curlyMatch = trimmed.match(/^using\s*\{\s*([^}]+)\s*\}/);
        if (curlyMatch) {
            return isModuleImportContent(ImportFormatter.stripTrailingComment(curlyMatch[1]));
        }

        return false;
    }

    /**
     * Formats an import statement using the specified syntax.
     * @param path The module path to import
     * @param useDotSyntax Whether to use dot syntax (using. /path) or curly syntax (using { /path })
     */
    formatImportStatement(path: string, useDotSyntax: boolean): string {
        return useDotSyntax ? `using. ${path.trim()}` : `using { ${path.trim()} }`;
    }

    /**
     * Extracts the module path from an import statement.
     * Handles both curly syntax (using { /path }) and dot syntax (using. /path).
     * A trailing comment is stripped, so the returned path never carries trivia
     * that would corrupt the statement when it is re-emitted.
     * @param importStatement The full import statement
     * @returns The extracted path, or null if there is none (including a
     *   statement whose content is nothing but a comment)
     */
    extractPathFromImport(importStatement: string): string | null {
        const curlyMatch = importStatement.match(/using\s*\{\s*([^}]+)\s*\}/);
        if (curlyMatch) {
            return ImportFormatter.stripTrailingComment(curlyMatch[1]) || null;
        }

        const dotMatch = importStatement.match(/using\.\s*(.+)/);
        if (dotMatch) {
            return ImportFormatter.stripTrailingComment(dotMatch[1]) || null;
        }

        return null;
    }

    /**
     * Determines if an import is a digest import (from Verse.org, Fortnite.com, or UnrealEngine.com).
     * @param importPath The import path or statement to check
     * @returns true if the import is from a digest source, false otherwise
     */
    isDigestImport(importPath: string): boolean {
        // Extract the path if this is a full import statement
        let path = importPath;
        if (importPath.includes("using")) {
            path = this.extractPathFromImport(importPath) || importPath;
        }

        // Get configurable digest prefixes
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const digestPrefixes = config.get<string[]>("behavior.digestImportPrefixes", ["/Verse.org/", "/Fortnite.com/", "/UnrealEngine.com/"]);

        // Check if it's a digest import
        return digestPrefixes.some((prefix) => path.startsWith(prefix));
    }

    /**
     * Sorts import paths for a `using` block using rank-based ordering rather
     * than plain alphabetical order.
     *
     * Verse resolves `using` statements top-down: a statement can only see
     * identifiers brought into scope by statements above it. This matters
     * because `using` has two meanings — a module import (`using { /Path }`,
     * `using { Foo.Bar }`) and a local-scope using (`using { Variable }`) —
     * and a dotted module import's first segment is itself only in scope if
     * some other import (a bare module reference) already provided it. For
     * example `using { Economy.Shop }` needs `Economy` in scope, which
     * `using { Features }` provides if `Features` declares the `Economy`
     * submodule. Plain alphabetical sorting can reorder `Economy.Shop` before
     * `Features` (E < F) and break compilation even though both imports are
     * individually valid.
     *
     * Paths are grouped into three ranks, and only alphabetized within a rank:
     * - Rank 0 — absolute paths (start with `/`): self-contained, sorted alphabetically.
     * - Rank 1 — bare identifiers (no `/`, no `.`): kept in their original
     *   input order, never alphabetized, since the relative order between
     *   bare module imports is semantic — a nested child must follow the
     *   parent that provides it.
     * - Rank 2 — everything else (dotted references such as `Economy.Shop`,
     *   and any other non-absolute form): sorted alphabetically.
     *
     * A lower rank always precedes a higher rank, so bare imports precede
     * dotted ones, guaranteeing a provider precedes anything that might
     * depend on it. The sort is stable, so rank 1 entries keep their input
     * order (the comparator returns 0 for two rank-1 paths).
     *
     * @param paths Import paths to sort
     * @returns A new array with paths ordered by rank, then alphabetically within rank 0 and rank 2
     */
    sortImportsByRank(paths: string[]): string[] {
        const rankOf = (path: string): number => {
            if (path.startsWith("/")) {
                return 0;
            }
            if (!path.includes(".") && !path.includes("/")) {
                return 1;
            }
            return 2;
        };

        return [...paths].sort((a, b) => {
            const rankDifference = rankOf(a) - rankOf(b);
            if (rankDifference !== 0) {
                return rankDifference;
            }
            if (rankOf(a) === 1) {
                // Bare identifiers keep their input order; relative order is semantic.
                return 0;
            }
            return a.localeCompare(b);
        });
    }

    /**
     * Groups and formats imports based on the configuration settings.
     * @param importPaths Array of import paths to group and format
     * @param preferDotSyntax Whether to use dot syntax for imports
     * @param sortAlphabetically Whether to sort imports alphabetically
     * @param importGrouping The grouping strategy ('none', 'digestFirst', or 'localFirst').
     *   Any other value falls back to 'none', so a setting typo or a renamed
     *   enum member degrades to ungrouped output rather than dropping imports.
     * @returns Array of formatted import statements with potential empty lines for grouping
     */
    groupAndFormatImports(importPaths: string[], preferDotSyntax: boolean, sortAlphabetically: boolean, importGrouping: string): string[] {
        if (importGrouping !== "digestFirst" && importGrouping !== "localFirst") {
            // Rank-based sort if enabled (see sortImportsByRank for why plain
            // alphabetical order is unsafe for local imports)
            const sortedPaths = sortAlphabetically ? this.sortImportsByRank(importPaths) : importPaths;
            return sortedPaths.map((path) => this.formatImportStatement(path, preferDotSyntax));
        }

        // New grouping behavior: separate digest and local imports
        let digestImports: string[] = [];
        let localImports: string[] = [];

        for (const path of importPaths) {
            if (this.isDigestImport(path)) {
                digestImports.push(path);
            } else {
                localImports.push(path);
            }
        }

        // Sort within groups if enabled. digestImports are always absolute
        // paths, so rank sort and plain alphabetical sort are equivalent
        // there; the same helper is used for both groups for consistency.
        if (sortAlphabetically) {
            digestImports = this.sortImportsByRank(digestImports);
            localImports = this.sortImportsByRank(localImports);
        }

        // Format the imports
        const formattedDigestImports = digestImports.map((path) => this.formatImportStatement(path, preferDotSyntax));
        const formattedLocalImports = localImports.map((path) => this.formatImportStatement(path, preferDotSyntax));

        // Combine based on configuration. Only the two grouped strategies reach
        // this point, so both branches of the pair are covered.
        const [firstGroup, secondGroup] = importGrouping === "digestFirst" ? [formattedDigestImports, formattedLocalImports] : [formattedLocalImports, formattedDigestImports];

        const formattedImports: string[] = [...firstGroup];
        // Add spacing between groups if both have imports
        if (firstGroup.length > 0 && secondGroup.length > 0) {
            formattedImports.push(""); // Empty line between groups
        }
        formattedImports.push(...secondGroup);

        return formattedImports;
    }
}
