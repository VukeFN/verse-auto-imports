/**
 * The one lexer for Verse comment, string and indentation structure.
 *
 * Every reader in the extension that has to know what a line means - the import
 * scanner, the comment/string masker, the brace counters - goes through this,
 * so a lexical fact about Verse is learned in one place. Nothing outside this
 * file may re-decide what is comment, what is literal text, or how wide an
 * indent is; a second opinion about any of them is what the readers this
 * replaced disagreed over.
 *
 * No VS Code dependencies, so importing this from a pure module is safe.
 *
 * The rules below are the compiler's, taken from `VerseGrammar.h` in the
 * VerseCompiler source rather than from any reader here. Line references are to
 * that file.
 *
 * - `<#>` is the INDENTED comment marker, not a block that closes on the `#>`
 *   inside it. The rest of its line is comment text, and so is every line
 *   indented past it, blank lines included. It must be tested before `<#`
 *   wherever both can appear, or its first two characters read as a block
 *   opener that never closes. At `Text`'s `case '<'` (:2115-2137) a `<#`
 *   dispatches `BlockCmt()` at every place, while a `<#>` dispatches `IndCmt()`
 *   only at trivia, code and marker-body place and is three characters of plain
 *   text inside a block comment or a literal. It advances block-comment depth
 *   nowhere.
 *
 *   One written inside a marker body is left as text here rather than nested,
 *   which the grammar allows because the two cannot disagree: the body it would
 *   open is indented past a marker that already sits inside the outer body, so
 *   it can never outlast it.
 * - `<# ... #>` nests, and beats a string literal: a `<#` inside a string really
 *   does open a comment there. Both digraphs are consumed whole, so the `#` of a
 *   `<#` cannot also be read as closing one.
 * - `#` runs to the end of the line, but inside a literal it is content. What it
 *   opens does not have to end there: `LineCmt` is `'#' !'>' {Text} Ending`
 *   (:2014-2024) over the same `Text` as everywhere else, and `Text`'s `case '<'`
 *   dispatches `BlockCmt()` at every place, so a `<#` written in a line comment
 *   opens a block that runs to its `#>` however many lines below. Failing to
 *   carry that reads the lines the compiler comments out as live imports.
 * - A `"` string interpolates, and `Interp := '{' List '}'` (:2163) makes the
 *   interpolation body ordinary code: a `"` inside one opens a fresh string and
 *   a `#` opens a real comment. So literal state is a stack of frames, and an
 *   interpolation frame counts the plain `{ }` blocks written inside it or a
 *   map's `}` closes it early.
 * - A `'` means one of two things, and which one is decided by the character
 *   before it. `Ident := Alpha {Alnum} !Alnum ["'" {…} "'"]` (:1954) opens the
 *   quoted segment suffix only directly after an identifier's alphanumeric run,
 *   while `CharLit` is dispatched from prefix position alone (:3497-3501), where
 *   an expression may start. So a `'` after `[A-Za-z0-9_]` opens a suffix and a
 *   `'` anywhere else opens a char literal. The distinction is what lets a char
 *   literal be masked while a path keeps its suffix, so nothing here may fall
 *   back to treating the two alike.
 */

/** Whether the character can appear in an identifier, per `IsAlnum` (VerseGrammar.h:362). */
function isIdentifierChar(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

/**
 * Whether the frame holds text that stands in for nothing a statement says, and
 * so is replaced by spaces. Every literal but the quoted suffix, which is part
 * of the identifier it trails.
 */
function isMaskedLiteral(frame: LexFrame | undefined): boolean {
    return frame?.kind === "literal" && frame.quote !== "suffix";
}

/** What one line leaves behind for the line below it. */
export interface LexState {
    /** Block-comment nesting depth the line starts at. */
    depth: number;
    /**
     * Indentation of the `<#>` marker whose body the line is inside, or null
     * outside one.
     */
    markerIndent: number | null;
}

/** One literal or interpolation open at a point in a line. */
type LexFrame =
    /**
     * `suffix` is an identifier's quoted segment, `Economy.Shop'Loc'`, and is
     * kept in every output: masking it truncates the path to `Economy.Shop`, a
     * different module that exists. `char` is a char literal, which is masked,
     * because it is never part of a path and `'{'` and `'\{'` would otherwise
     * reach a brace counter as real braces.
     */
    | { kind: "literal"; quote: '"' | "suffix" | "char" }
    /**
     * The `{ ... }` blocks written inside the interpolation, which a `}` has to
     * close before one can close the interpolation itself. Without the count a
     * `}` ending a map or a block, `"a{map{1=>2}}b"`, reads as the end of the
     * interpolation and the string's remaining text is lexed as code.
     */
    | { kind: "interpolation"; braces: number };

/** How one line of a document reads, and what it leaves for the line below it. */
export interface LexedLine {
    /**
     * Block-comment nesting depth at the start of the line. Non-zero means the
     * line opened inside a `<# ... #>` and may not be read as code at all.
     */
    depthBefore: number;
    /** Block-comment nesting depth the next line starts at. */
    depth: number;
    /** Indentation of the open `<#>` marker for the next line, or null. */
    markerIndent: number | null;
    /**
     * Whether the line sits in the indented body of a `<#>` opened above it. The
     * whole line is comment text, but it is still lexed rather than skipped,
     * because a block comment opened inside a marker body survives the body's
     * end and swallows what follows.
     */
    insideIndentedComment: boolean;
    /** Whether the line holds a `<#>` marker, opening a body over the lines indented past it. */
    opensIndentedComment: boolean;
    /** Whether the line carries any text outside a comment. */
    hasCode: boolean;
    /**
     * Whether the line ended inside a literal or an interpolation. Nothing past
     * that point could be lexed, and the two consumers want opposite things
     * about it, so neither answer is baked in here - see the note on
     * {@link lexVerseLine}.
     */
    endedOpen: boolean;
    /**
     * The line's text with every comment removed and nothing put in its place,
     * so text on either side of one joins. That is what it is for: a comment
     * splicing a token apart, `us<##>ing { /A }`, rejoins into a `using` a
     * search of the whole line can find, and a missed `using` is the one error
     * its callers cannot survive.
     */
    codeWithoutComments: string;
    /**
     * `codeWithoutComments` with the contents of every `"` string and char
     * literal replaced by spaces, so a `using` written as literal text is not
     * offered as a statement the line makes, and a brace inside one is not
     * counted as a body's.
     *
     * Read this wherever a path is going to count as imported. The text of a
     * literal is data, not a statement, and recording a path from it both
     * suppresses an import the file needs and - because a path that counts as
     * pinned withholds the movable import of the same path from the rebuilt
     * block - deletes the real `using` the author wrote.
     *
     * Spaces rather than nothing, so the text on either side of a literal does
     * not join into a token neither side wrote. `codeWithoutComments` removes
     * comments without replacement on purpose, for the opposite reason; the two
     * differ because a comment can splice a token apart and a literal cannot.
     */
    codeOutsideLiterals: string;
    /**
     * The whole line with every comment, `"` string and char literal replaced by
     * spaces, exactly as long as the line it replaces, so an offset into it
     * still addresses the original text.
     *
     * A quoted suffix is left standing, unlike in `codeOutsideLiterals`, and
     * costs nothing: `IsIdentifierQuotable` (VerseGrammar.h:377) forbids `{`,
     * `}`, `"` and `\` inside one, so nothing a caller of this reads can hide
     * there.
     */
    masked: string;
}

/**
 * Reads one line, given what the lines above it left open.
 *
 * A line that ends inside a literal is reported through `endedOpen` rather than
 * resolved here, because the two readers built on this want opposite fallbacks
 * and both are right. A masker must fail towards blanking: text it wrongly
 * offers as code becomes a declaration its caller edits as if it were real. A
 * scanner must fail towards keeping: a `using` it misses is read by its caller
 * as permission to remove an import. Deciding it here would silently impose one
 * of those on the other.
 *
 * @param line one line, with no line terminator. A trailing `\r` from a CRLF
 *   document is harmless and counts as trailing whitespace.
 * @param trackLiterals false reads a `#` as a comment opener wherever it sits,
 *   which is what a caller re-lexing an `endedOpen` line passes.
 */
export function lexVerseLine(line: string, state: LexState, trackLiterals: boolean = true): LexedLine {
    const depthBefore = state.depth;
    const indent = indentOf(line, 0);
    const blank = line.trim().length === 0;

    // A marker's body runs while lines stay indented past it; a blank line does
    // not end it. The comparison is on widths where the compiler extends the
    // opener's whitespace prefix byte-wise (`Line`, VerseGrammar.h:1666-1690);
    // the two agree on any consistently indented file, and a line that mixes
    // tabs and spaces inside one body is error S89 rather than a case the
    // language admits.
    let markerIndent = state.markerIndent;
    if (markerIndent !== null && !blank && indent <= markerIndent) {
        markerIndent = null;
    }
    // A block comment opened above outranks a marker body: the body's text is
    // already inside it, and it is the `#>` that ends the region.
    const insideIndentedComment = markerIndent !== null && depthBefore === 0;

    let nesting = depthBefore;
    let hasCode = false;
    let codeWithoutComments = "";
    let codeOutsideLiterals = "";
    let masked = "";
    let opensIndentedComment = false;
    // Whether a `#` opened a line comment earlier on this line. Per-line, since
    // a line comment ends with its line - but what it opened need not, so this
    // says only that the text left is trivia, never that it holds no opener.
    let insideLineComment = false;
    let i = 0;

    // What is open at this point, innermost last, and empty at code scope. A
    // stack rather than one quote because interpolation alternates the two:
    // `"a{F("b")}c"` writes a string inside the interpolation of a string.
    //
    // Kept across the `nesting > 0` branch, because a block comment written
    // inside a string does not end it: `"a<#c#>#b"` is the string `"a#b"`.
    const open: LexFrame[] = [];

    /** Records one character as comment text: blanked in `masked`, absent from both code strings. */
    const commentChar = (): void => {
        masked += " ";
    };

    while (i < line.length) {
        // Comment text, whether from a block comment opened above, from the body
        // of a `<#>`, or from a `#` earlier on this line. Scanned rather than
        // skipped so a `<#` inside it still opens a block that outlives the
        // region, which is what the compiler does at every place
        // (VerseGrammar.h:2115-2137).
        if (nesting > 0 || insideIndentedComment || insideLineComment) {
            if (line.startsWith("<#>", i)) {
                // Already comment text, so this opens nothing. Tested before
                // `<#` or its first two characters read as a block opener that
                // never closes.
                commentChar();
                commentChar();
                commentChar();
                i += 3;
                continue;
            }
            if (line.startsWith("<#", i) || line.startsWith("#>", i)) {
                nesting = line[i] === "<" ? nesting + 1 : Math.max(0, nesting - 1);
                commentChar();
                commentChar();
                i += 2;
                continue;
            }
            commentChar();
            i += 1;
            continue;
        }

        const innermost = trackLiterals ? open[open.length - 1] : undefined;

        if (line.startsWith("<#>", i)) {
            if (innermost?.kind === "literal") {
                // Three characters of literal text rather than a marker. At
                // `EPlace::String` the `<#>` arm falls past `IndCmt()` to
                // `Next(3)` and plain text, so only the three named scopes open
                // a body here. Consumed whole, so the `<#` test below does not
                // read its first two characters as a block opener - which a
                // bare `<#` in a literal genuinely is, since `BlockCmt()` is
                // dispatched at every place.
                const marker = line.slice(i, i + 3);
                const spaced = isMaskedLiteral(innermost);
                codeWithoutComments += marker;
                codeOutsideLiterals += spaced ? "   " : marker;
                masked += spaced ? "   " : marker;
                hasCode = true;
                i += 3;
                continue;
            }

            // The rest of the marker's own line is comment text, and holds no
            // opener of its own: at `EPlace::IndCmt` a `<#>` nests another
            // indented comment rather than a block.
            opensIndentedComment = true;
            for (; i < line.length; i++) {
                commentChar();
            }
            break;
        }

        // Inside an interpolation this is code scope again, so a `#` there ends
        // the line as one at the head of it would. A `#` inside any literal is
        // content: a `"` string and a char literal both hold it, and
        // `IsIdentifierQuotable` admits a bare `#` in a quoted suffix.
        //
        // The tail keeps being lexed rather than consumed here: the comment ends
        // with the line, but a `<#` written in it opens a block that does not.
        // The `#` itself is taken first, so a line opening `#>` cannot also be
        // read as closing a block - `LineCmt := '#' !'>'` (:2016) declines to
        // open a comment on one at all, and outside a block comment it is error
        // S05, so there is no depth for it to close.
        if (line[i] === "#" && innermost?.kind !== "literal") {
            insideLineComment = true;
            commentChar();
            i += 1;
            continue;
        }

        if (line.startsWith("<#", i)) {
            nesting += 1;
            commentChar();
            commentChar();
            i += 2;
            continue;
        }

        if (innermost?.kind === "literal") {
            // An escape and the character it escapes are one unit, or `"a\"b"`
            // closes at the quote it escapes and the rest of the line is read as
            // code. `\{` is the same rule, and is what keeps an escaped brace
            // from opening an interpolation - and, in a char literal, what keeps
            // `'\{'` from reaching a brace counter as a real brace.
            //
            // A quoted suffix has no escapes: `IsIdentifierQuotable` excludes
            // `\` outright, so a backslash there ends the suffix as far as the
            // compiler is concerned and is read here as ordinary text.
            if (line[i] === "\\" && innermost.quote !== "suffix") {
                const unit = line.slice(i, i + 2);
                codeWithoutComments += unit;
                codeOutsideLiterals += " ".repeat(unit.length);
                masked += " ".repeat(unit.length);
                i += 2;
                continue;
            }

            const closes = innermost.quote === '"' ? line[i] === '"' : line[i] === "'";
            if (closes) {
                open.pop();
            } else if (line[i] === "{" && innermost.quote === '"') {
                // Only a `"` string interpolates. A char literal is one
                // character or one escape, so the `{` of `'{'` is content, and a
                // suffix cannot hold a brace at all.
                open.push({ kind: "interpolation", braces: 0 });
            }
        } else if (trackLiterals) {
            if (line[i] === '"') {
                open.push({ kind: "literal", quote: '"' });
            } else if (line[i] === "'") {
                // Which of the two a `'` opens is decided by the character
                // before it, and by nothing else: `Ident` reaches for its quoted
                // suffix only straight after the identifier's alphanumeric run,
                // where `CharLit` is only ever dispatched from prefix position.
                open.push({ kind: "literal", quote: isIdentifierChar(line[i - 1]) ? "suffix" : "char" });
            } else if (innermost?.kind === "interpolation") {
                if (line[i] === "{") {
                    innermost.braces += 1;
                } else if (line[i] === "}") {
                    if (innermost.braces > 0) {
                        innermost.braces -= 1;
                    } else {
                        open.pop();
                    }
                }
            }
        }

        if (!/\s/.test(line[i])) {
            hasCode = true;
        }
        codeWithoutComments += line[i];

        // The two masked outputs disagree about a literal's delimiters, and each
        // keeps the answer its readers already had. `codeOutsideLiterals` asks
        // only about the frame open before this character, so an opening `"`
        // survives to tell a reader of that string a literal began there.
        // `masked` blanks the delimiters too, because it is read as a stand-in
        // for the original text and a lone quote there is not part of any
        // statement.
        //
        // A quoted suffix is masked in neither: it is part of an identifier, and
        // blanking it turns `Economy.Shop'Loc'` into a path naming a different
        // module that exists.
        const wasInMaskedLiteral = isMaskedLiteral(innermost);
        const isInMaskedLiteral = isMaskedLiteral(open[open.length - 1]);
        codeOutsideLiterals += wasInMaskedLiteral ? " " : line[i];
        masked += wasInMaskedLiteral || isInMaskedLiteral ? " " : line[i];
        i += 1;
    }

    return {
        depthBefore,
        depth: nesting,
        markerIndent: opensIndentedComment ? indent : markerIndent,
        insideIndentedComment,
        opensIndentedComment,
        hasCode,
        endedOpen: open.length > 0,
        codeWithoutComments,
        codeOutsideLiterals,
        masked,
    };
}

/**
 * Leading whitespace width from an offset into the text, each tab counted as
 * four spaces so mixed indentation compares.
 *
 * The one width model. The compiler extends the opening line's whitespace
 * prefix byte for byte instead (`Line`, VerseGrammar.h:1666-1690) and errors S89
 * on a line that indents inconsistently, so comparing widths agrees with it on
 * every file that compiles - but two width models do not agree with each other,
 * and a `<#>` body must end on one line rather than two. Nothing may add a
 * second.
 */
export function indentOf(content: string, lineStart: number): number {
    let width = 0;
    for (let i = lineStart; i < content.length; i++) {
        if (content[i] === " ") {
            width += 1;
        } else if (content[i] === "\t") {
            width += 4;
        } else {
            break;
        }
    }
    return width;
}
