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
 *   text inside a block comment, a line comment or a literal. It advances
 *   block-comment depth nowhere.
 *
 *   Its tail is a line comment, not a region holding nothing: `IndCmt` lexes it
 *   with `Text<EPlace::LineCmt>` and reaches `Ind()` only once that returns
 *   (:2040-2048), so a `<#` there opens a block and the body waits for it. The
 *   body's indentation then comes from the line `Ind()` runs on (:1637), which
 *   is the line that closed the block rather than the marker's own.
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
 *
 *   The comment itself outlives that block rather than ending at it. `Text`
 *   resumes where `BlockCmt()` returned, so the comment ends at the `Ending` of
 *   whatever line the `#>` sits on and the tail of that line is comment too. A
 *   marker body resumes the same way after a block opened inside it.
 * - A `"` string interpolates, and `Interp := '{' List '}'` (:2163) makes the
 *   interpolation body ordinary code: a `"` inside one opens a fresh string and
 *   a `#` opens a real comment. So literal state is a stack of frames, and an
 *   interpolation frame counts the plain `{ }` blocks written inside it or a
 *   map's `}` closes it early.
 *
 *   That body being ordinary code also lets it span lines, which is the one
 *   literal state a newline does not end: at String place `Text` stops dead at
 *   the newline (:2083-2105) and `Quote` then requires the closing `"` (:3224),
 *   so an open `"` at a line end is error S32 while an open interpolation is
 *   just a list still being read. `openFrames` is that distinction.
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
    /**
     * The literal and interpolation frames open where the line starts, innermost
     * last, and empty at code scope. Seed it from the line above's
     * {@link LexedLine.openFrames}, or leave it empty to read every line from
     * code scope.
     */
    openFrames: LexFrame[];
    /**
     * The line comment still open where the line starts, or null. Non-null only
     * while a block comment opened in that comment's text is unclosed, so a line
     * carrying one always starts inside that block, and its text resumes exactly
     * where the depth returns to 0.
     */
    lineComment: OpenLineComment | null;
}

/**
 * A `#` or `<#>` whose comment text a block comment opened inside it has
 * interrupted.
 *
 * Both are lexed as `Text<EPlace::LineCmt>`, where `Text`'s `<` arm dispatches
 * `BlockCmt()` and resumes after it returns (VerseGrammar.h:2116-2126), so the
 * comment runs on below the line that opened it and ends at the `Ending` of
 * whatever line closes the block.
 */
export interface OpenLineComment {
    /**
     * Whether ending the comment opens a `<#>` marker body. `IndCmt` reaches
     * `Ind()` only once the marker's tail returns (VerseGrammar.h:2040-2048), so
     * a `<#` written in that tail defers the body rather than cancelling it.
     */
    opensMarker: boolean;
}

/** One literal or interpolation open at a point in a line. */
export type LexFrame =
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
    /**
     * Whether a `<#>` marker's body begins below this line, over the lines
     * indented past this one.
     *
     * Not always the line the `<#>` sits on. A `<#` in the marker's tail defers
     * the body until that block closes, and `Ind()` then takes the body's
     * indentation from the line it runs on (VerseGrammar.h:1635-1644), which is
     * the line the `#>` closed on.
     */
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
     * The frames the next line starts inside, innermost last, and empty where
     * nothing carries.
     *
     * Only an interpolation carries, because only an interpolation legally spans
     * a line: `Interp := '{' List '}'` (:2163) makes its body an ordinary list,
     * while `Text` at String place stops at a newline (:2083-2105) and `Quote`
     * then requires the closing `"` (:3224), so a `"` still open where the line
     * ends is error S32 rather than a string continuing below. Carrying that one
     * would let a single stray quote blank the rest of the file.
     *
     * Read this, not `endedOpen`, to decide what carries. `endedOpen` is true
     * for a carried interpolation as well, so the two are not interchangeable:
     * an empty stack under a true `endedOpen` is the unterminated literal.
     */
    openFrames: LexFrame[];
    /**
     * The line comment the next line starts inside, or null. Seed
     * {@link LexState.lineComment} from this, or the lines a comment reaches
     * through a block opened in it read as code.
     */
    lineComment: OpenLineComment | null;
    /**
     * Index into the line of the first comment opener on it, or -1 when it
     * holds none. 0 when the line opens already inside a comment, whose opener
     * is above it.
     *
     * An offset into the original text, which neither code string can supply:
     * `codeWithoutComments` removes comments without replacement, so on a line
     * with an interior comment it is shorter than the offset it would be read
     * as, and `masked` blanks literals as well and so cannot tell trivia from
     * literal text.
     *
     * Only a split at `depthBefore` 0 may be taken from this. A line that
     * begins inside a comment reports 0 and can still close it and carry live
     * code - `#> using { /A }` at depth 1 - so a caller slicing on the offset
     * there reads a whole statement as annotation.
     */
    commentStart: number;
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
 * A line that ends inside an *unterminated* literal is reported through
 * `endedOpen` rather than resolved here, because the two readers built on this
 * want opposite fallbacks and both are right. A masker must fail towards
 * blanking: text it wrongly offers as code becomes a declaration its caller
 * edits as if it were real. A scanner must fail towards keeping: a `using` it
 * misses is read by its caller as permission to remove an import. Deciding it
 * here would silently impose one of those on the other.
 *
 * Which of those two a line ended inside is settled here, through `openFrames`,
 * because the language answers it: an interpolation may span lines and a string
 * may not. `endedOpen` does not carry that answer - it is true of both - so a
 * reader deciding what to resume must read `openFrames` instead. The two are
 * still separate signals: the scanner takes its fallback on `endedOpen`,
 * declining to lex past a point it cannot classify, whether or not the state
 * there was one it could have carried.
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
    //
    // Only where the line begins at code scope. Inside a block comment the
    // body's dedent bookkeeping does not run at all: a body measures its lines
    // through `Scan := Space {Line}` (:1757-1772), reached only from
    // `Text<EPlace::IndCmt>`'s newline case (:2088-2094), where
    // `Text<EPlace::BlockCmt>` takes a newline with `NewLine` instead
    // (:2096-2100). So a dedented line inside the block ends nothing, and
    // clearing on it strands the body's remaining text as code.
    let markerIndent = state.markerIndent;
    if (markerIndent !== null && depthBefore === 0 && !blank && indent <= markerIndent) {
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
    // The line comment open at this point: carried in from above, or opened by a
    // `#` or `<#>` on this line. It says only that the text left is trivia,
    // never that it holds no opener.
    let lineComment = state.lineComment;
    // Already inside one when the line begins, so the opener is above it and
    // every character from the first is trivia.
    let commentStart = depthBefore > 0 || insideIndentedComment ? 0 : -1;
    let i = 0;

    // What is open at this point, innermost last, and empty at code scope. A
    // stack rather than one quote because interpolation alternates the two:
    // `"a{F("b")}c"` writes a string inside the interpolation of a string.
    //
    // Kept across the `nesting > 0` branch, because a block comment written
    // inside a string does not end it: `"a<#c#>#b"` is the string `"a#b"`.
    //
    // Copied frame by frame rather than aliased, or this line's pushes and its
    // interpolation brace counts would land in the caller's own state object.
    // A caller that never reassigns `openFrames` is relying on it staying as it
    // set it - both scanner states below hold an empty stack they never write
    // back, and aliasing would leak every line's literals into the next through
    // the array they thought was inert.
    //
    // Empty with tracking off, whatever the caller carried: that mode reads a
    // `#` as a comment opener wherever it sits, which is a caller saying it does
    // not believe the literal state here.
    const open: LexFrame[] = trackLiterals ? state.openFrames.map((frame) => ({ ...frame })) : [];

    /** Records one character as comment text: blanked in `masked`, absent from both code strings. */
    const commentChar = (): void => {
        masked += " ";
    };

    /** Records that trivia opens here, keeping the first opener when the line holds several. */
    const opensComment = (): void => {
        if (commentStart === -1) {
            commentStart = i;
        }
    };

    // Both of these resume the moment a block comment opened inside them closes,
    // rather than surrendering the rest of the line to it: `Text` continues
    // where it left off after `BlockCmt()` returns (:2116-2126), at line-comment
    // place and marker-body place alike. So each is asked of the depth here, not
    // of the depth the line began at.
    //
    // Depth 0 is the whole of it because only code scope opens either: both
    // openers sit past the branch below, which claims every character at a depth
    // above 0. A `#` inside a block comment does open a line comment in the
    // grammar, but its text and the block's are both trivia, so nothing here can
    // tell the two apart and nothing needs to.
    const inLineComment = (): boolean => lineComment !== null && nesting === 0;
    const inMarkerBody = (): boolean => markerIndent !== null && nesting === 0;

    while (i < line.length) {
        // Comment text, whether from a block comment opened above, from the body
        // of a `<#>`, or from a `#` or `<#>` still open here. Scanned rather than
        // skipped so a `<#` inside it still opens a block that outlives the
        // region, which is what the compiler does at every place
        // (VerseGrammar.h:2115-2137).
        if (nesting > 0 || inMarkerBody() || inLineComment()) {
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

            // The rest of the marker's own line is comment text, but not text
            // that holds nothing: `IndCmt` lexes that tail with
            // `Text<EPlace::LineCmt>` (:2040-2047), the same place a `#` opens,
            // so a `<#` there opens a block exactly as one in a line comment
            // does. Lexed on below rather than swallowed here, and the body
            // deferred until the tail ends, or the block's lines read as code.
            lineComment = { opensMarker: true };
            opensComment();
            commentChar();
            commentChar();
            commentChar();
            i += 3;
            continue;
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
            lineComment = { opensMarker: false };
            opensComment();
            commentChar();
            i += 1;
            continue;
        }

        if (line.startsWith("<#", i)) {
            nesting += 1;
            opensComment();
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

    // A line comment ends with its line - `LineCmt := '#' !'>' {Text} Ending`
    // (:2016), and `Text` stops dead at a newline at that place (:2088-2105) -
    // unless a block opened in its text is still open, which is the one thing
    // that carries it below. It then ends at the `Ending` of the line the `#>`
    // sits on, so the tail of that line is still the comment's.
    const heldOpen = lineComment !== null && nesting > 0;
    // `IndCmt` reaches `Ind()` only once its tail returns (:2044-2048), and
    // `Ind()` takes the body's indentation from the line it runs on
    // (`Context.BlockInd = Cursor.LineStart`, :1637). With no block in the tail
    // that is the marker's own line; with one it is the line that closed it.
    const opensIndentedComment = lineComment !== null && lineComment.opensMarker && !heldOpen;

    return {
        depthBefore,
        depth: nesting,
        markerIndent: opensIndentedComment ? indent : markerIndent,
        insideIndentedComment,
        opensIndentedComment,
        hasCode,
        endedOpen: open.length > 0,
        openFrames: open[open.length - 1]?.kind === "interpolation" ? open : [],
        lineComment: heldOpen ? lineComment : null,
        commentStart,
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
