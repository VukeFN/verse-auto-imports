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
     * statement no longer parses. A path may hold no `#`, but the captures that
     * produce one may: the braced capture stops only at its `}`, and the dotted
     * and indented forms read to end of line. So the comment arrives here still
     * attached, and this is where it comes off.
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
     * The dotted and braced styles answer from the statement at the head of the
     * line rather than from the whole of it, since a line may write more than
     * one and a definition after a `;` belongs to none of the `using` before
     * it. The dotted form reads matchImport's DOTTED_STATEMENT to do that: its
     * content is what ends it, and a second copy of that pattern is a second
     * opinion about where it ended. The indented style is the exception and
     * classifies from the whole of nextLine.
     *
     * @param nextLine The following line, which carries the content for the
     *   indented style. When it is not given and the line is `using:`, this
     *   conservatively returns `true`.
     *
     *   A `nextLine` that is given and carries no path must answer `false`,
     *   blank and comment-only lines included. ImportScanner's loop gate reads
     *   that answer to route a `using:` whose path sits further down onto its
     *   pinned branch; answering `true` there makes the pair rewritable, and a
     *   writer rebuilding that span from one path deletes the lines the author
     *   wrote inside it.
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
        const dotMatch = trimmed.match(ImportFormatter.DOTTED_STATEMENT);
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
     * Matched by isModuleImport as well as matchImport, so the classifier and
     * the reader cannot disagree about how much of a line the statement
     * occupies. Widening the class widens both.
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
     * The form of an import path: 0 for an absolute path, 1 for a bare module
     * reference, 2 for anything else (a dotted reference such as
     * `Economy.Shop`).
     *
     * Ranks 1 and 2 differ in form, not in ordering: either can bring the scope
     * the other resolves through, so neither belongs above the other. Which of
     * the two a path is still narrows one thing - whether a pinned import may
     * be read as the consumer a newly added one was added for, which takes a
     * diagnostic to establish and not the form alone
     * (ImportDocumentEditor.couldResolveAgainst). Everything else asks only
     * whether the rank is 0, through resolvesAgainstScopeAbove.
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
     * Whether `path` resolves its first segment against what the `using`
     * statements above it brought into scope, which makes every import written
     * above it a possible provider for it.
     *
     * True of every relative path, dotted and bare alike. Either can provide
     * for the other: `using { Features }` brings the `Economy` that
     * `using { Economy.Shop }` needs, and `using { GameSystems.Inventory }`
     * brings the `Weapons` that a later bare `using { Weapons }` needs. Only an
     * absolute path resolves from the global registry and needs nothing above
     * it.
     */
    resolvesAgainstScopeAbove(path: string): boolean {
        return this.importRank(path) !== 0;
    }

    /**
     * A new array with the absolute paths hoisted to the front and
     * alphabetized, and every relative path left in input order. The input is
     * not modified.
     *
     * Not plain alphabetical order, because Verse resolves `using` statements
     * top-down and importing a scope exposes that scope's member modules to the
     * statements below it. Which of two relative imports provides for the other
     * can go either way, and their written order is the only evidence of which
     * way round it is here - so relative imports keep it, and a file that
     * compiles still compiles after being organized.
     *
     * Absolute paths are free to sort: one needs nothing in scope, and hoisting
     * it takes scope away from nothing below it.
     *
     * The sort is stable, which is what keeps the relative paths in input order
     * once their comparator returns 0.
     */
    sortImportsByRank(paths: string[]): string[] {
        return [...paths].sort((a, b) => {
            const aIsRelative = this.resolvesAgainstScopeAbove(a);
            const bIsRelative = this.resolvesAgainstScopeAbove(b);
            if (aIsRelative !== bIsRelative) {
                return aIsRelative ? 1 : -1;
            }
            return aIsRelative ? 0 : a.localeCompare(b);
        });
    }

    /**
     * The formatted `using` statements for a set of paths, with an empty string
     * between each pair of groups a grouping strategy puts imports in.
     *
     * `localFirst` writes three groups rather than two once the paths include a
     * digest import: the local absolute paths, then the digest ones, then the
     * local relative paths. A relative path resolves its first segment against
     * what the `using` statements above it brought into scope
     * (resolvesAgainstScopeAbove), so a digest import written below one that
     * resolves through it stops the file compiling. The preference is honoured
     * wherever it is free - an absolute path needs nothing above it, so the
     * local absolutes stay on top - and yields only where the compiler forbids
     * it.
     *
     * `digestFirst` needs no such split: it already writes every absolute path
     * above every relative one.
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

        const format = (paths: string[]): string[] => paths.map((path) => this.formatImportStatement(path, preferDotSyntax));

        if (importGrouping === "digestFirst") {
            return this.joinGroups([format(digestImports), format(localImports)]);
        }

        // With nothing to write between them the local imports stay one group:
        // splitting them by rank would separate imports the strategy never had
        // a reason to move apart.
        if (digestImports.length === 0) {
            return format(localImports);
        }

        return this.joinGroups([
            format(localImports.filter((path) => !this.resolvesAgainstScopeAbove(path))),
            format(digestImports),
            format(localImports.filter((path) => this.resolvesAgainstScopeAbove(path))),
        ]);
    }

    /**
     * The groups run together with one empty string between each adjacent pair.
     *
     * An empty group contributes no separator of its own, so a strategy whose
     * groups do not all have imports writes one blank line between the ones that
     * do, rather than opening or closing the run with a stray blank line.
     */
    private joinGroups(groups: string[][]): string[] {
        return groups.filter((group) => group.length > 0).reduce<string[]>((result, group) => (result.length === 0 ? [...group] : [...result, "", ...group]), []);
    }
}
