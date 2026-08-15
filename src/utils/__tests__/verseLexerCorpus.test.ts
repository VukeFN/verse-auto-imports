import { allUsingPaths, classifyLines, LINE_SPLIT, scanModuleAliases, scanModuleImports } from "../../imports/ImportScanner";
import { ProjectPathScanner } from "../../services/ProjectPathScanner";
import { findExplicitModuleDeclarations } from "../../visibility/moduleDeclarations";
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
        // The `<#>` arm is reached at three places and a literal is not one of
        // them, so this is text rather than a marker. The line below must be
        // indented past it for the probe to bite: a marker wrongly opened at
        // column 0 is closed again by the very next line at column 0, which
        // hides the defect.
        name: "a `<#>` inside a string opens no body over the indented lines below it",
        source: 'Label := "a<#>b"\n    L1 := 1\n        L2 := 2\n',
        live: ["L1", "L2"],
    },
    {
        // The same marker one scope out, where it is a marker. Kept beside the
        // case above so the pair says which half of the rule each pins.
        name: "a `<#>` written outside a literal on the same shape does open one",
        source: 'Label := "ab" <#>\n    D1 := 1\n        D2 := 2\nL1 := 3\n',
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

/**
 * The same constructs through the readers built on the two entry points, since
 * those are where a lexing mistake is finally paid for: a dropped path is read
 * by its caller as permission to remove an import, and a declaration invented
 * out of comment text is one its caller edits as if it were real.
 *
 * The entry points above are where a divergence can originate; these pin that it
 * does not survive into an answer.
 */
describe("verse lexer probe corpus, the readers built on it", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;
    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declared = (source: string): string[] => scanner.extractDeclarations(source, "Content/Probe.verse").map((node) => node.fullPath);
    const paths = (source: string): string[] => allUsingPaths(source.split(LINE_SPLIT));

    it("keeps what a `<#>` inside a string does not comment out", () => {
        // Indented below the string, or a marker wrongly opened at column 0 is
        // closed again by the next line at column 0 and nothing is lost.
        const source = 'Label := "a<#>b"\n    Inner := module:\n        using { /Verse.org/Simulation }\n';

        expect(paths(source)).toEqual(["/Verse.org/Simulation"]);
        expect(declared(source)).toEqual(["Label", "Inner"]);
        expect(findExplicitModuleDeclarations(source).map((declaration) => declaration.name)).toEqual(["Inner"]);
    });

    it("drops what a `<#>` marker body really does comment out", () => {
        const source = "<#>\n    using { /Verse.org/Simulation }\n    Hidden := module {}\nReal := module {}\n";

        expect(paths(source)).toEqual([]);
        expect(declared(source)).toEqual(["Real"]);
        expect(findExplicitModuleDeclarations(source).map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("keeps a statement written after a char literal on the same line", () => {
        const source = "Hash := '#'; using { /Verse.org/Simulation }\nGfx := import(/A/B)\n";

        expect(paths(source)).toEqual(["/Verse.org/Simulation"]);
        expect([...scanModuleAliases(source.split(LINE_SPLIT))]).toEqual(["Gfx"]);
    });

    it("counts no path out of string text where a path counts as imported, and over-counts where it does not", () => {
        // The two readers face opposite ways on purpose, and this is the shape
        // that shows it. scanModuleImports decides what the file already
        // imports, so a path read out of string text withholds an import the
        // file needs; it reads codeOutsideLiterals. allUsingPaths decides
        // whether removing an import is safe, so its empty answer is what a
        // caller acts on; it reads codeWithoutComments and over-reports rather
        // than risk that.
        //
        // What disqualifies the first source is the blanked `using` keyword, not
        // the path after it: `{ }` in a string interpolates, so the
        // interpolation's body is code and `/Verse.org/Simulation }` survives
        // masking. The second source carries no braces and is masked whole. Both
        // are here because the contract is what each reader reports, not which
        // characters it blanked to get there.
        const interpolating = 'Snippet := "using { /Verse.org/Simulation }"\n';
        // The dotted style, so the second source carries no brace at all.
        const plain = 'Snippet := "using. /Verse.org/Simulation"\nOther := "Inner := module {}"\n';

        for (const source of [interpolating, plain]) {
            expect(scanModuleImports(source.split(LINE_SPLIT))).toEqual([]);
            expect(paths(source)).toEqual(["/Verse.org/Simulation"]);
            expect(findExplicitModuleDeclarations(source)).toEqual([]);
        }
    });
});
