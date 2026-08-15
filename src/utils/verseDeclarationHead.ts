/**
 * The one matcher for the head of a Verse declaration.
 *
 * Every reader in the extension that has to decide "does this line declare a
 * name, and what kind" goes through this, so the head grammar is learned in one
 * place. Nothing outside this file may re-decide what a declared name, a
 * specifier group, a parameter list or a declaration keyword looks like.
 *
 * No VS Code dependencies, so importing this from a pure module is safe.
 *
 * **This is a recognizer, not a validator.** It answers what the parser accepts
 * and encodes no attribute allowlist, because attribute legality is a later
 * semantic phase: `M := module<castable>:` parses and then fails as
 * `assert_semantic_error(3604)` (book `Tests/Castable.versetest:29`), while
 * `enum<open>` and `enum<persistable>` are ordinary. A caller wanting only what
 * compiles must apply that itself.
 *
 * **Comments and literals are the caller's problem.** This takes a trimmed line
 * and reads every character of it as code, so a caller whose input may hold a
 * comment or a string must mask first - `ProjectPathScanner` does, and the two
 * digest parsers rely on their input being machine-generated instead. The cost
 * of not masking is a paren or a keyword inside a string literal on the head
 * line being read as structure.
 *
 * The rules below are the compiler's, taken from `VerseGrammar.h` in the
 * VerseCompiler source rather than from any matcher here. Line references are to
 * that file.
 *
 * - **Specifier groups stack without bound, and the production is shared by
 *   every target.** A `<...>` group becomes an `EMode::With` call appended by
 *   `Target.UpdateLastCall`, which then re-enters through `Invoke` to read the
 *   next one (:2796-2807). Nothing bounds the count and nothing is specific to
 *   one keyword, so `struct<concrete><computes><persistable><uht_comparable>`
 *   (shipped in `Verse.digest.verse`) and `enum<open><persistable>` (book
 *   `Tests/CompatibilityConstraints.versetest:1147`, `assert_valid`) are the
 *   same rule as a single group.
 * - **A parameter list holds general expressions and nests to any depth**, so it
 *   is walked for its matching `)` rather than matched by a regex: `Paren :=
 *   '(' List ')' Space`, and a parameter may itself be an invocation carrying
 *   another paren group. Any fixed depth would hold only until a digest refresh
 *   exceeded it. `GetComponent<public>(component_type:castable_subtype(component))<transacts>:`
 *   is the shape that breaks a `\([^)]*\)`.
 * - **A macro body opens in any of the three styles Verse gives a macro**, so a
 *   declaration keyword ends at `:`, `{` or `.` - or at the line end, which is
 *   how a next-line brace reaches a reader that sees one line at a time.
 *   Anything else after the keyword means the line does not declare that type.
 */

/** The keywords that declare a module or a named type. The one alternation. */
export const DECLARATION_KEYWORDS = ["module", "class", "struct", "interface", "enum"] as const;

export type DeclarationKeyword = (typeof DECLARATION_KEYWORDS)[number];

/**
 * What may end a declaration keyword. `:`, `{` and `.` are the three body
 * styles; `>` is not Verse and matches only the literal `M := module>`, kept
 * because the other spelling of the module grammar outside this file -
 * `moduleDeclarations`' `MODULE_DECLARATION` - accepts it, and dropping it here
 * alone would put this matcher out of step with it. Parity is partial either
 * way: that one ends at `module\s*[:>{.]`, so it does not admit the keyword
 * specifiers this does.
 */
const BODY_TERMINATORS = new Set([":", "{", ".", ">"]);

/** A declared name and the specifier groups written on it. */
const NAME_HEAD_RE = /^(\w+)((?:<[^>]+>)*)/;

/** A run of specifier groups, possibly empty. */
const SPECIFIERS_RE = /^((?:<[^>]+>)*)/;

const KEYWORD_RE = new RegExp(`^(${DECLARATION_KEYWORDS.join("|")})\\b`);

/**
 * A Verse declaration head, as far as the operator that follows it.
 *
 * The grammar, once:
 * `[Receiver '.'] Name Specifiers* [ParamList] Specifiers* Operator [Keyword Specifiers* [SuperList] [Terminator]]`
 */
export interface DeclarationHead {
    name: string;
    /** The specifier groups written on the name, verbatim ("<native><public>"), or "". */
    specifiers: string;
    /**
     * The parameter list with its parentheses, or null where the head carries
     * none. Also null where a `(` opened one that the line never closed, which
     * {@link DeclarationHead.operator} reports as `(` instead.
     */
    params: string | null;
    /** What follows the head: `:=` declares, `:` types, `(` is an unclosed parameter list. */
    operator: ":=" | ":" | "(";
    /**
     * The index just past {@link DeclarationHead.operator}, so a caller can read
     * the declaration's right-hand side without re-deriving where the head
     * ended.
     */
    end: number;
    /** The declaration keyword after `:=`, or null where none follows one. */
    keyword: DeclarationKeyword | null;
    /** The specifier groups written on the keyword, verbatim, or "". */
    keywordSpecifiers: string;
    /**
     * What ended the keyword, or null where the line did. Null is what tells a
     * caller a braced body is still to open on a later line; it is meaningful
     * only where {@link DeclarationHead.keyword} is set.
     */
    bodyTerminator: string | null;
    /**
     * The receiver of a receiver-style extension method, with its parentheses
     * (`(Prop:creative_prop)`), or null. Whether such a head declares an
     * importable name is the caller's policy, and the two digest parsers and the
     * project scan deliberately answer it differently.
     */
    receiver: string | null;
}

/**
 * The index just past the `)` matching the `(` at `start`, or -1 where the line
 * never closes it.
 *
 * @param start Index of the opening `(`.
 */
function skipParenGroup(line: string, start: number): number {
    let depth = 0;
    for (let index = start; index < line.length; index++) {
        if (line[index] === "(") {
            depth++;
        } else if (line[index] === ")") {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return -1;
}

/** The index of the first non-space character at or after `from`. */
function skipSpace(line: string, from: number): number {
    let index = from;
    while (index < line.length && (line[index] === " " || line[index] === "\t")) {
        index++;
    }
    return index;
}

/**
 * The declaration head the line opens with, or null where it opens with
 * something that declares no name.
 *
 * @param line One line, trimmed, with comments and literals already masked if
 * the caller's input can hold them.
 */
export function matchDeclarationHead(line: string): DeclarationHead | null {
    let cursor = 0;
    let receiver: string | null = null;

    if (line[0] === "(") {
        const afterReceiver = skipParenGroup(line, 0);
        if (afterReceiver === -1 || line[afterReceiver] !== ".") {
            return null;
        }
        receiver = line.slice(0, afterReceiver);
        cursor = afterReceiver + 1;
    }

    const nameHead = line.slice(cursor).match(NAME_HEAD_RE);
    if (!nameHead) {
        return null;
    }
    const name = nameHead[1];
    const specifiers = nameHead[2];
    cursor += nameHead[0].length;

    const head = (rest: Partial<DeclarationHead> & Pick<DeclarationHead, "operator" | "end">): DeclarationHead => ({
        name,
        specifiers,
        params: null,
        keyword: null,
        keywordSpecifiers: "",
        bodyTerminator: null,
        receiver,
        ...rest,
    });

    let params: string | null = null;
    cursor = skipSpace(line, cursor);
    if (line[cursor] === "(") {
        const afterParams = skipParenGroup(line, cursor);
        if (afterParams === -1) {
            // An unclosed list is a signature continuing on the line below. The
            // head is still a declaration, and reporting the bare `(` is what
            // lets a caller record it as a function rather than lose it.
            return head({ operator: "(", end: cursor + 1 });
        }
        params = line.slice(cursor, afterParams);
        cursor = afterParams;
    }

    // Effect specifiers, between the parameter list and the operator. Consumed
    // rather than reported: no caller reads them, and the visibility a caller
    // does read is on the name.
    cursor = skipSpace(line, cursor);
    cursor += line.slice(cursor).match(SPECIFIERS_RE)![0].length;

    cursor = skipSpace(line, cursor);
    let operator: DeclarationHead["operator"];
    if (line.startsWith(":=", cursor)) {
        operator = ":=";
        cursor += 2;
    } else if (line[cursor] === ":") {
        operator = ":";
        cursor += 1;
    } else {
        return null;
    }

    const end = cursor;
    if (operator !== ":=") {
        return head({ params, operator, end });
    }

    cursor = skipSpace(line, cursor);
    const keywordMatch = line.slice(cursor).match(KEYWORD_RE);
    if (!keywordMatch) {
        return head({ params, operator, end });
    }
    const keyword = keywordMatch[1] as DeclarationKeyword;
    let afterKeyword = cursor + keywordMatch[0].length;

    afterKeyword = skipSpace(line, afterKeyword);
    const keywordSpecifiers = line.slice(afterKeyword).match(SPECIFIERS_RE)![0];
    afterKeyword += keywordSpecifiers.length;

    // A superclass or interface list sits between the keyword and its body.
    afterKeyword = skipSpace(line, afterKeyword);
    if (line[afterKeyword] === "(") {
        const afterSuper = skipParenGroup(line, afterKeyword);
        if (afterSuper === -1) {
            return head({ params, operator, end });
        }
        afterKeyword = afterSuper;
    }

    afterKeyword = skipSpace(line, afterKeyword);
    if (afterKeyword === line.length) {
        return head({ params, operator, end, keyword, keywordSpecifiers, bodyTerminator: null });
    }
    if (!BODY_TERMINATORS.has(line[afterKeyword])) {
        // The keyword opens no body here, so the line declares no type of that
        // kind - it is an ordinary declaration whose value happens to start with
        // the word. Falling through rather than matching is what keeps
        // `Items := classify_items(X)` from recording a class.
        return head({ params, operator, end });
    }
    return head({ params, operator, end, keyword, keywordSpecifiers, bodyTerminator: line[afterKeyword] });
}
