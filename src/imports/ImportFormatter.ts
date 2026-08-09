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
 * Reads and writes `using` statements: their syntax, their paths, their
 * ordering rank, and the grouping the settings ask for.
 */
export class ImportFormatter {
    /**
     * The content of a `using` statement with any trailing comment removed,
     * trimmed.
     *
     * A comment left on the content is re-emitted inside the braces -
     * `using { /X # note }`, where it swallows the closing brace and the
     * statement no longer parses. Nothing upstream removes it: `#` and `<#` are
     * both illegal in a module path, so a capture that runs to end of line
     * takes the comment with it.
     */
    static stripTrailingComment(content: string): string {
        const commentStart = ImportFormatter.commentStartIndex(content);
        return commentStart === -1 ? content.trim() : content.slice(0, commentStart).trim();
    }

    /**
     * The trailing Verse comment of a `using` statement, or "" when it has none.
     *
     * The inverse of stripTrailingComment, splitting at the same point so the
     * two halves always recompose the original. A writer rebuilds an import
     * line from its path alone, which discards everything after that split;
     * this is what it needs to put back so the annotation survives.
     *
     * @param content A `using` statement, or the indented path line of one
     */
    static extractTrailingComment(content: string): string {
        const commentStart = ImportFormatter.commentStartIndex(content);
        return commentStart === -1 ? "" : content.slice(commentStart).trim();
    }

    /**
     * Where the trailing comment of a `using` statement begins, or -1 when it
     * has none. One home for the rule, so the two halves of the split cannot
     * drift apart.
     *
     * `#` opens a line comment and `<#` opens a block comment. Neither
     * character is legal in a module path, so the first `#` is always the
     * start of trivia rather than of the path.
     */
    private static commentStartIndex(content: string): number {
        const hashIndex = content.indexOf("#");
        if (hashIndex === -1) {
            return -1;
        }
        // For a `<#` block comment the `<` opens the comment, not the path.
        return hashIndex > 0 && content[hashIndex - 1] === "<" ? hashIndex - 1 : hashIndex;
    }

    /**
     * Whether a line is a module import rather than a local-scope `using`.
     *
     * `using` has two meanings in Verse:
     * - Module import: `using { /Verse.org/Simulation }`, `using { game_systems.inventory }`
     * - Local-scope using: `using{Variable}` — brings an instance's members into scope
     *
     * Either meaning can be written in any of the three equivalent styles:
     * braced `using { /Path }`, dotted `using. /Path`, or indented `using:`
     * with the path on the next line. So the two are separated by content, and
     * at file scope by position as well:
     *
     * - Default (`options.atFileScope` absent or `false`): content only. A
     *   path (leading `/`) or a dot-notation reference (containing `.`) is a
     *   module import; a bare identifier is a local-scope using. This is the
     *   mode for callers that see a matched line in isolation and cannot
     *   attest to where it sits in the file.
     * - `options.atFileScope: true`: a bare identifier is a module import too
     *   (a same-directory folder-module import, `using { Features }`). Module
     *   `using` is legal at file level or module-definition body level, while
     *   local-scope `using{instance}` is legal only inside a function body, so
     *   at file scope a bare `using { X }` can only be the former. Pass this
     *   only when you know the line is not inside a function body.
     *
     * @param nextLine The following line, which carries the content for the
     *   indented style. When it is not given and the line is `using:`, this
     *   conservatively returns `true`.
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

        // Indented style: the content is on the next line.
        if (/^using\s*:\s*$/.test(trimmed)) {
            if (nextLine !== undefined) {
                return isModuleImportContent(ImportFormatter.stripTrailingComment(nextLine));
            }
            return true;
        }

        // Dotted style.
        const dotMatch = trimmed.match(/^using\.\s+(.+)/);
        if (dotMatch) {
            return isModuleImportContent(ImportFormatter.stripTrailingComment(dotMatch[1]));
        }

        // Braced style.
        const curlyMatch = trimmed.match(/^using\s*\{\s*([^}]+)\s*\}/);
        if (curlyMatch) {
            return isModuleImportContent(ImportFormatter.stripTrailingComment(curlyMatch[1]));
        }

        return false;
    }

    /**
     * A `using` statement for a path, written in the caller's preferred style.
     *
     * @param useDotSyntax `using. /path` when true, `using { /path }` when false
     */
    formatImportStatement(path: string, useDotSyntax: boolean): string {
        return useDotSyntax ? `using. ${path.trim()}` : `using { ${path.trim()} }`;
    }

    /**
     * A dotted `using` statement, capturing its content.
     *
     * The class covers every character Verse's path production admits outside a
     * quoted suffix - a label may hold `.` and `-`, `@` introduces the account,
     * `/` separates segments, and `(`, `)` and `:` are the qualifier form
     * `(path:)ident` - together with the bare identifier and the dot-notation
     * reference a `using` may name instead of a path.
     *
     * A quoted segment suffix, `Economy.Shop'Loc'`, is consumed whole by the
     * alternative rather than by the class, because a suffix admits characters
     * no identifier may hold and the capture therefore cannot stop at the `'`.
     * Stopping there would report `Economy.Shop`, a different module that
     * exists, and a writer asked for that module would then believe the file
     * already imports it. An unbalanced `'` matches neither branch, so the
     * capture ends before it and the remainder pins the line.
     *
     * A `#` reaching the capture makes the path and the leftover disagree about
     * where the statement ends, because matchImport strips the comment from the
     * capture but measures `end` on the unstripped text. The class keeps one
     * out; the quoted alternative does not, so `using. Foo'a#b'` is only kept
     * away by isModuleImport, which refuses `Foo'a` before the line is scanned.
     * Relaxing that gate, or widening this class, brings the disagreement into
     * reach.
     */
    private static readonly DOTTED_STATEMENT = /^using\.\s*((?:[A-Za-z0-9_./@:()-]|'[^']*')*)/;

    /**
     * The `using` statement written at the head of a string: its path, and how
     * much of the string it occupies.
     *
     * Anchored on the trimmed statement, and dotted before braced, following
     * isModuleImport. Unanchored, the braced pattern is free to match inside
     * the trailing comment of a dotted statement and win the path -
     * `using. Economy.Shop # was using { Inventory }` read as `Inventory`,
     * because the comment is only stripped afterwards, from that capture.
     *
     * One home for the two patterns, so a caller asking where the statement
     * ends cannot answer it from a looser second copy that, on the same input,
     * disagrees about which statement was read.
     *
     * The dotted style closes with nothing, so its own content is what ends it:
     * the capture stops at the first character a dotted content cannot hold,
     * which is how Verse itself lexes a path - `/a/b-c` is the path `/a/b`, then
     * `-`, then `c`. Reading to end of line instead captures a statement written
     * after a `;` into the path, which is then re-emitted inside the braces. See
     * DOTTED_STATEMENT for what a dotted content may hold, and why ending the
     * capture early is not the safe direction it looks.
     *
     * @returns The path and the offset just past the statement **in the
     *   trimmed input**, or null when there is no statement (including one
     *   whose content is nothing but a comment)
     */
    private static matchImport(importStatement: string): { path: string; end: number } | null {
        const trimmed = importStatement.trim();

        const dotMatch = trimmed.match(ImportFormatter.DOTTED_STATEMENT);
        if (dotMatch) {
            const path = ImportFormatter.stripTrailingComment(dotMatch[1]);
            return path ? { path, end: dotMatch[0].length } : null;
        }

        const curlyMatch = trimmed.match(/^using\s*\{\s*([^}]+)\s*\}/);
        if (curlyMatch) {
            const path = ImportFormatter.stripTrailingComment(curlyMatch[1]);
            return path ? { path, end: curlyMatch[0].length } : null;
        }

        return null;
    }

    /**
     * The module path of the `using` statement at the head of a string, or null
     * when there is none - including a statement whose content is nothing but a
     * comment.
     *
     * The trailing comment is stripped, so the path never carries trivia that
     * would corrupt the statement when it is re-emitted.
     */
    extractPathFromImport(importStatement: string): string | null {
        return ImportFormatter.matchImport(importStatement)?.path ?? null;
    }

    /**
     * The code written after the statement at the head of a line, or "" when
     * the statement is the whole of it.
     *
     * A writer rebuilds an import line from its path, so whatever this reports
     * is text that rebuild would lose. Asking it this way rather than searching
     * the line for the `;` that separates two statements is what keeps a
     * separator apart from a `;` that is only a character - one inside the
     * braces, or in a path, is part of the statement and leaves nothing over,
     * and one inside a string literal cannot arise without leftover text around
     * it. So no depth or string tracking is needed, which nothing in this file
     * does.
     *
     * Both styles can answer. The braced one ends at its `}`; the dotted one has
     * no closing delimiter, so it ends where its content stops being content -
     * see matchImport. Content this cannot lex, such as an unbalanced `'`, ends
     * the statement early and reports the rest as leftover, which pins the line
     * rather than rewriting it from a path that was never the whole of it.
     *
     * @param lineCode A line of Verse with its comments already removed. A
     *   trailing comment left on it reads as code written after the statement.
     */
    textAfterImport(lineCode: string): string {
        const trimmed = lineCode.trim();
        const match = ImportFormatter.matchImport(trimmed);
        return match ? trimmed.slice(match.end).trim() : "";
    }

    /**
     * Whether an import comes from a digest source, which the
     * `behavior.digestImportPrefixes` setting defines and defaults to
     * Verse.org, Fortnite.com and UnrealEngine.com.
     *
     * @param importPath A bare path or a whole `using` statement
     */
    isDigestImport(importPath: string): boolean {
        let path = importPath;
        if (importPath.includes("using")) {
            path = this.extractPathFromImport(importPath) || importPath;
        }

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const digestPrefixes = config.get<string[]>("behavior.digestImportPrefixes", ["/Verse.org/", "/Fortnite.com/", "/UnrealEngine.com/"]);

        return digestPrefixes.some((prefix) => path.startsWith(prefix));
    }

    /**
     * The ordering rank of an import path: 0 for an absolute path, 1 for a bare
     * module reference, 2 for anything else (a dotted reference such as
     * `Economy.Shop`). A lower rank belongs above a higher one, because a
     * `using` can only see identifiers brought into scope above it. See
     * sortImportsByRank for what each rank means and why.
     *
     * Placement reads the same ranks the sort compares, so a new import can be
     * ranked against the whole file rather than only against the block it is
     * merged into.
     */
    importRank(path: string): number {
        if (path.startsWith("/")) {
            return 0;
        }
        if (!path.includes(".") && !path.includes("/")) {
            return 1;
        }
        return 2;
    }

    /**
     * A new array of the paths ordered by rank, and alphabetically within ranks
     * 0 and 2. The input is not modified.
     *
     * Rank ordering rather than plain alphabetical order, because Verse
     * resolves `using` statements top-down: a statement sees only identifiers
     * brought into scope above it. A dotted import's first segment is in scope
     * only if a bare module reference already provided it, so
     * `using { Economy.Shop }` needs the `Economy` that `using { Features }`
     * brings - and alphabetical order puts `Economy.Shop` first (E < F) and
     * breaks compilation, though both imports are individually valid.
     *
     * - Rank 0, absolute paths (leading `/`): self-contained, alphabetized.
     * - Rank 1, bare identifiers (no `/`, no `.`): kept in input order, never
     *   alphabetized, since the order between bare module imports is semantic
     *   - a nested child must follow the parent that provides it.
     * - Rank 2, everything else (dotted references such as `Economy.Shop`):
     *   alphabetized.
     *
     * A lower rank always precedes a higher one, so a provider precedes
     * anything that might depend on it. The sort is stable, which is what keeps
     * rank 1 in input order once its comparator returns 0.
     */
    sortImportsByRank(paths: string[]): string[] {
        const rankOf = (path: string): number => this.importRank(path);

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
     * The formatted `using` statements for a set of paths, with an empty string
     * between the two groups when a grouping strategy puts imports in both.
     *
     * @param sortAlphabetically Enables the rank sort, which is not alphabetical
     *   order - see sortImportsByRank for why plain alphabetical order breaks
     *   local imports.
     * @param importGrouping 'none', 'digestFirst' or 'localFirst'. Any other
     *   value falls back to 'none', so a setting typo or a renamed enum member
     *   degrades to ungrouped output rather than dropping imports.
     */
    groupAndFormatImports(importPaths: string[], preferDotSyntax: boolean, sortAlphabetically: boolean, importGrouping: string): string[] {
        if (importGrouping !== "digestFirst" && importGrouping !== "localFirst") {
            const sortedPaths = sortAlphabetically ? this.sortImportsByRank(importPaths) : importPaths;
            return sortedPaths.map((path) => this.formatImportStatement(path, preferDotSyntax));
        }

        let digestImports: string[] = [];
        let localImports: string[] = [];

        for (const path of importPaths) {
            if (this.isDigestImport(path)) {
                digestImports.push(path);
            } else {
                localImports.push(path);
            }
        }

        // digestImports are always absolute paths, so rank sort and plain
        // alphabetical sort agree there; one helper serves both groups.
        if (sortAlphabetically) {
            digestImports = this.sortImportsByRank(digestImports);
            localImports = this.sortImportsByRank(localImports);
        }

        const formattedDigestImports = digestImports.map((path) => this.formatImportStatement(path, preferDotSyntax));
        const formattedLocalImports = localImports.map((path) => this.formatImportStatement(path, preferDotSyntax));

        // Only the two grouped strategies reach here, so the pair covers both.
        const [firstGroup, secondGroup] = importGrouping === "digestFirst" ? [formattedDigestImports, formattedLocalImports] : [formattedLocalImports, formattedDigestImports];

        const formattedImports: string[] = [...firstGroup];
        if (firstGroup.length > 0 && secondGroup.length > 0) {
            formattedImports.push("");
        }
        formattedImports.push(...secondGroup);

        return formattedImports;
    }
}
