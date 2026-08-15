import { classifyLines, LINE_SPLIT } from "../../imports/ImportScanner";
import { countBraces, maskCommentsAndStrings } from "../verseText";

/**
 * One probe corpus read by every entry point built on the lexer, so a rule
 * learned in one of them cannot quietly go unlearned in the other.
 *
 * Each probe is a construct the two readers used to disagree about, and each
 * assertion is made twice: once that the readers agree with each other, and once
 * that what they agree on is right. The first half is what a future divergence
 * trips over - a rule added to one reader and not the other fails here even
 * where nobody thought to write the case down.
 *
 * Sentinels carry the expectation. `L<n>` marks text that is a statement the
 * file makes; `D<n>` marks text that is comment or literal content and must
 * reach no reader that decides what the file imports or declares. Both readers
 * answer that same question - `maskCommentsAndStrings` for the declaration
 * scans, `codeOutsideLiterals` for the import scan - so both are held to it.
 */

/** The sentinels a reader left standing, in source order. */
function surviving(text: string): string[] {
    return [...text.matchAll(/\b[LD]\d+\b/g)].map((match) => match[0]);
}

/** What each reader makes of the source, reduced to the sentinels it left as statement text. */
function readers(source: string): { masker: string[]; scanner: string[] } {
    return {
        masker: surviving(maskCommentsAndStrings(source)),
        scanner: surviving(
            classifyLines(source.split(LINE_SPLIT))
                .map((line) => line.codeOutsideLiterals)
                .join("\n"),
        ),
    };
}

interface Probe {
    /** What the construct is, phrased as the rule it tests. */
    name: string;
    source: string;
    /** The sentinels that are statement text, in source order. Everything else must be gone. */
    live: string[];
}

const probes: Probe[] = [
    {
        // The masker had no `'` state at all, so the `#` ended the line.
        name: "a `#` inside a char literal is content",
        source: "Hash := '#'; L1 := 1\n",
        live: ["L1"],
    },
    {
        // The masker read this `"` as opening a string that swallowed the rest.
        name: 'a `"` inside a char literal opens no string',
        source: "Quote := '\"'; L1 := 1\n",
        live: ["L1"],
    },
    {
        // `'\{'` is a char literal holding a brace, not a brace. The escape put
        // it past the paired-quote special case countBraces used to carry.
        name: "an escaped brace in a char literal delimits nothing",
        source: "Brace := '\\{'; L1 := 1\n",
        live: ["L1"],
    },
    {
        // An interpolation body is ordinary code, so the inner `"` opens a fresh
        // string rather than closing the outer one. Reading it flat left the `#`
        // at code scope, commenting out the rest of the line.
        name: "a `#` inside a string nested in an interpolation is content",
        source: 'Label := "a{F("#")}b"; L1 := 1\n',
        live: ["L1"],
    },
    {
        // A bare `#` is legal inside a quoted segment suffix, where it is part
        // of the path rather than a comment opener.
        name: "a `#` inside a quoted segment suffix is part of the identifier",
        source: "using { Economy.Shop'a#b' }\nL1 := 1\n",
        live: ["L1"],
    },
    {
        name: "a `#` inside a string is content, and the rest of the line is code",
        source: 'Tag := "a#b"; L1 := 1\n',
        live: ["L1"],
    },
    {
        // `"a<#c#>#b"` is the string `"a#b"`: a block comment beats a string
        // literal, and the literal survives across it.
        name: "a block comment written inside a string is removed, and the string survives it",
        source: 'Tag := "a<# D1 #>b"; L1 := 1\n',
        live: ["L1"],
    },
    {
        name: "an escaped quote does not close the string it is written in",
        source: 'Quote := "he said \\" D1 "; L1 := 1\n',
        live: ["L1"],
    },
    {
        // Only the masker leaked here: blankCommentRange read the `<#` of a
        // `<#>` as a block opener, so everything below the body stayed comment.
        name: "a `<#>` inside a marker body opens no block comment",
        source: "<#>\n    D1 <#> D2\nL1 := 1\n",
        live: ["L1"],
    },
    {
        // Both readers leaked here, in the same direction: inside a block
        // comment a `<#>` is three characters of text, so the `#>` that follows
        // is the one that closes the block.
        name: "a `<#>` inside a block comment opens no nested block",
        source: "<# D1 <#> D2 #>\nL1 := 1\n",
        live: ["L1"],
    },
    {
        // The other direction of the same rule, and the one already pinned: a
        // `<#` in a marker body is a real opener and outlives the body.
        name: "a `<#` inside a marker body outlives the body",
        source: "<#>\n    D1 <# D2\nD3 := 1 #>\nL1 := 1\n",
        live: ["L1"],
    },
    {
        // Two indent models ended the body on different lines: a tab counted as
        // one column in the scanner and four in the masker.
        name: "a marker body indented with a tab ends where a two-space line meets it",
        source: "\t<#>\n\t\tD1 := 1\n  L1 := 1\n",
        live: ["L1"],
    },
    {
        name: "a marker body runs through a blank line",
        source: "<#>\n    D1 := 1\n\n    D2 := 1\nL1 := 1\n",
        live: ["L1"],
    },
    {
        name: "a declaration inside a string is not a declaration",
        source: 'Snippet := "D1 := module {}"\nL1 := 1\n',
        live: ["L1"],
    },
    {
        // An unterminated literal is the one place the two readers are allowed
        // to differ, so the sentinel after it is not asserted here; the line
        // below it must reach both regardless.
        name: "an unterminated string does not carry past its line",
        source: 'Broken := "oops\nL1 := 1\n',
        live: ["L1"],
    },
];

describe("verse lexer probe corpus", () => {
    describe.each(probes)("$name", ({ source, live }) => {
        it("both readers agree on which text is a statement", () => {
            const { masker, scanner } = readers(source);

            expect(masker).toEqual(scanner);
        });

        it("and what they agree on is the language's answer", () => {
            const { masker, scanner } = readers(source);

            expect(masker).toEqual(live);
            expect(scanner).toEqual(live);
        });
    });
});

describe("verse lexer probe corpus, brace depth", () => {
    // countBraces reads masked text, so every brace reaching it is a body's.
    // Each source below balances, and a literal brace counted as real leaves the
    // depth stranded for the rest of the file.
    it.each([
        ["a brace in a char literal", "Body := module:\n    Brace := '{'\n"],
        ["an escaped brace in a char literal", "Body := module:\n    Brace := '\\{'\n"],
        ["a brace in a string", 'Body := module:\n    Text := "{"\n'],
        ["a brace in a comment", "Body := module:\n    Note := 1 # {\n"],
        ["a balanced braced body", "Body := module {\n    Field := 1\n}\n"],
        ["an interpolation holding a map", 'Body := module:\n    Text := "a{map{1=>2}}b"\n'],
    ])("returns to zero across %s", (_name, source) => {
        const masked = maskCommentsAndStrings(source);

        expect(countBraces(masked, 0, masked.length, 0)).toBe(0);
    });
});

describe("verse lexer probe corpus, comments splicing a token", () => {
    it("rejoins a token a comment was written into, which only codeWithoutComments may do", () => {
        // Nothing is put in a removed comment's place, so `us<##>ing` rejoins
        // into a `using` a search of the line can find. codeOutsideLiterals
        // carries the same join; the masker deliberately does not, because it
        // keeps offsets and cannot close a gap.
        const [line] = classifyLines(["us<# note #>ing { /A }"]);

        expect(line.codeWithoutComments).toBe("using { /A }");
        expect(line.codeOutsideLiterals).toBe("using { /A }");
        expect(line.kind).toBe("code");
    });
});
