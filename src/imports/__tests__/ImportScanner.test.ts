import { allUsingPaths, classifyLines, rewritableImports, scanConvertibleImports, scanModuleImports } from "../ImportScanner";

describe("allUsingPaths", () => {
    it("collects a file-scope import the same way scanModuleImports does", () => {
        expect(allUsingPaths(["using { /A }", "using { Features }", "using { Economy.Shop }", "code()"])).toEqual(["/A", "Features", "Economy.Shop"]);
    });

    // The whole reason this exists: scanModuleImports skips indented lines, so
    // an import in a module body is invisible to it.
    it("collects a dotted import indented inside a module body, which scanModuleImports skips", () => {
        const lines = ["using { /A }", "MyModule := module:", "    using { Economy.Shop }", "code()"];
        expect(allUsingPaths(lines)).toEqual(["/A", "Economy.Shop"]);
        expect(scanModuleImports(lines).map((imp) => imp.path)).toEqual(["/A"]);
    });

    // A bare `using` inside a module body is a module import, but only the
    // enclosing construct says so - indentation alone cannot tell it from a
    // function body. Reporting it regardless is what stops a caller reading the
    // file as import-free above that line.
    it("collects a bare import indented inside a module body", () => {
        expect(allUsingPaths(["using { /A }", "MyModule := module:", "    using { Features }", "code()"])).toEqual(["/A", "Features"]);
    });

    it("collects a bare indented pair inside a module body", () => {
        expect(allUsingPaths(["using { /A }", "MyModule := module:", "    using:", "        Features", "code()"])).toEqual(["/A", "Features"]);
    });

    // No module-import classification, so a local-scope using is reported too.
    // The caller judges by rank, and a bare path counts against it either way.
    it("collects a local-scope using in a function body", () => {
        expect(allUsingPaths(["using { /A }", "F():void =", "    using { LocalVar }", "    code()"])).toEqual(["/A", "LocalVar"]);
    });

    it("reads an indented pair once, from the path line", () => {
        expect(allUsingPaths(["using:", "    /A", "code()"])).toEqual(["/A"]);
    });

    it("ignores an import inside a block comment", () => {
        expect(allUsingPaths(["<#", "using { /Old }", "#>", "using { /A }", "code()"])).toEqual(["/A"]);
    });

    it("ignores an import inside the indented body of a marker", () => {
        expect(allUsingPaths(["using { /A } <#> disabled", "    using { Economy.Shop }", "code()"])).toEqual(["/A"]);
    });

    // A missed `using` is the one error this must not make: the caller reads an
    // empty answer as permission to remove an import. So a statement is not
    // required to open its line - a line closing a block comment can carry a
    // live one after the `#>`, and so can one behind closed inline trivia.
    it("collects a using written after the #> that closes a block comment", () => {
        expect(allUsingPaths(["<#", "note", "#> using { Economy.Shop }", "using { /A }", "code()"])).toEqual(["Economy.Shop", "/A"]);
    });

    it("collects a using written after a closed inline comment", () => {
        expect(allUsingPaths(["<# note #> using { Economy.Shop }", "using { /A }", "code()"])).toEqual(["Economy.Shop", "/A"]);
    });

    it("does not read an identifier that merely starts with using", () => {
        expect(allUsingPaths(["usingFoo := 1", "usings := 3", "usingMap := map{Economy.Shop => 1}", "using { /A }", "code()"])).toEqual(["/A"]);
    });

    it("collects an import whose line opens a comment over the lines below it", () => {
        expect(allUsingPaths(["using { /A } <#> note", "    body", "code()"])).toEqual(["/A"]);
    });

    it("reads the dot syntax", () => {
        expect(allUsingPaths(["using. /A", "code()"])).toEqual(["/A"]);
    });

    // `;` separates definitions in a scope exactly as a newline does, so a line
    // can write two statements. Reporting only the first is what let an
    // absolute path hide a dotted one beside it and read as safe to withhold.
    it("collects both statements a line separated by a semicolon writes", () => {
        expect(allUsingPaths(["using { /X }; using { Economy.Shop }", "code()"])).toEqual(["/X", "Economy.Shop"]);
    });

    it("collects three statements sharing a line, in written order", () => {
        expect(allUsingPaths(["using { /X }; using { Features }; using { Economy.Shop }", "code()"])).toEqual(["/X", "Features", "Economy.Shop"]);
    });

    // A dotted statement has no closing delimiter, so it used to swallow what
    // followed it into its path and report `/X; using { Economy.Shop }`. The
    // path it really imports has to be reported in its own right, or a writer
    // adds a second copy of it.
    it("reports both statements when the first of them is dotted", () => {
        expect(allUsingPaths(["using. /X; using { Economy.Shop }", "code()"])).toEqual(["/X", "Economy.Shop"]);
    });

    it("reports both statements when a dotted one is written second", () => {
        expect(allUsingPaths(["using { Economy.Shop }; using. /X", "code()"])).toEqual(["Economy.Shop", "/X"]);
    });

    it("collects a second statement written after a braced one in a module body", () => {
        expect(allUsingPaths(["using { /A }", "MyModule := module:", "    using { /X }; using { Economy.Shop }", "code()"])).toEqual(["/A", "/X", "Economy.Shop"]);
    });

    // The one shape whose second half lives on the next line. Requiring the
    // `using:` to be the whole of its line dropped the path below it, leaving a
    // line of nothing but absolute paths - which the caller reads as permission
    // to withhold an import the pair was resolving against.
    it("collects the path below a using: opened after a semicolon", () => {
        expect(allUsingPaths(["using { /X }; using:", "    Economy.Shop", "code()"])).toEqual(["/X", "Economy.Shop"]);
    });

    it("collects the path below a using: opened after a semicolon in a module body", () => {
        expect(allUsingPaths(["using { /A }", "MyModule := module:", "    using { /X }; using:", "        Economy.Shop", "code()"])).toEqual(["/A", "/X", "Economy.Shop"]);
    });

    it("reports the statements on the line when a using: opens no indented path", () => {
        expect(allUsingPaths(["using { /X }; using:", "code()"])).toEqual(["/X"]);
    });

    it("does not read an identifier that merely ends with using: as an opener", () => {
        expect(allUsingPaths(["Xusing:", "    Economy.Shop", "using { /A }"])).toEqual(["/A"]);
    });

    it("does not read a second statement out of a comment sharing the line", () => {
        expect(allUsingPaths(["using { /X } # see using { Economy.Shop }", "code()"])).toEqual(["/X"]);
    });

    // Only a `using` beginning a token is a statement. `Housing` holds those
    // five letters, and the dotted pattern needs no space after its `.`, so
    // offering every occurrence invented `Data` as a second path.
    it("invents no second path from an identifier that merely contains using", () => {
        expect(allUsingPaths(["using { Housing.Data }", "code()"])).toEqual(["Housing.Data"]);
        expect(allUsingPaths(["using { A_using.B }", "code()"])).toEqual(["A_using.B"]);
    });

    it("strips a trailing comment from the path", () => {
        expect(allUsingPaths(["using { /A } # why", "code()"])).toEqual(["/A"]);
    });

    // The other half of searching the line's code: a line that carries code and
    // then names a using in its trivia writes no import, so the trivia must not
    // report one.
    it("does not read a using named in the trivia of a code line", () => {
        expect(allUsingPaths(["code() # see using { /B }", "using { /A }"])).toEqual(["/A"]);
    });

    // The statement need not be the first thing on its line either. Reporting
    // only a statement that opens the line is the miss this must never make.
    it("collects a using written after other code on the same line", () => {
        expect(allUsingPaths(["F():void =", "    Foo(); using { LocalVar }", "using { /A }"])).toEqual(["LocalVar", "/A"]);
    });

    it("collects a using written after code and a closed inline comment", () => {
        expect(allUsingPaths(["X := 1 <# note #> using { Economy.Shop }", "using { /A }"])).toEqual(["Economy.Shop", "/A"]);
    });

    // Whether Verse reads `us<# c #>ing` as one token is not settled by its test
    // corpus - comments sit between tokens throughout Roundtrip/Comments, and
    // the one splicing case is string contents. Reporting is the side to be
    // wrong on: a false path only makes the caller more cautious, where a missed
    // one is the error it cannot survive.
    it("reports a using whose token a comment splits, rather than risking a miss", () => {
        expect(allUsingPaths(["us<# c #>ing { /B }", "using { /A }"])).toEqual(["/B", "/A"]);
    });

    // A bare `#` inside a literal is content, not a comment opener: both
    // `" # "` and `'#'` are literals the language's own test suite compiles.
    // Ending the scan there hides every statement written after it on the line.
    it("collects a using written after a string literal holding a #", () => {
        expect(allUsingPaths(['X := "a#b"; using { Economy.Shop }', "using { /A }", "code()"])).toEqual(["Economy.Shop", "/A"]);
    });

    it("collects a using written after a char literal holding a #", () => {
        expect(allUsingPaths(["C := '#'; using { Features }", "using { /A }"])).toEqual(["Features", "/A"]);
    });

    it("does not end a string literal at an escaped quote", () => {
        expect(allUsingPaths(['X := "a\\"#b"; using { Economy.Shop }', "using { /A }"])).toEqual(["Economy.Shop", "/A"]);
    });

    // The other half of the rule, and the one that was already right: a
    // `<# ... #>` written inside a string really is a comment there, since
    // "abc<#def#>ghi" is the string "abcghi".
    it("still reads a block comment written inside a string literal as a comment", () => {
        expect(allUsingPaths(['X := "a<# using { /B } #>c"', "using { /A }"])).toEqual(["/A"]);
    });

    // A line may legitimately end inside a string, because an interpolation
    // block spans lines. Nothing can be lexed past that point, so such a line is
    // read with literals ignored - which is what keeps a `using` named after its
    // `#` the comment text it is.
    it("does not read a using out of the trailing comment of a line whose literal never closes", () => {
        expect(allUsingPaths(['X := "ab{ # see using { /B }', "using { /A }"])).toEqual(["/A"]);
    });

    // A string's `{ ... }` interpolation holds code, so a `"` inside one opens a
    // fresh string: `"abc {"def"} ghi"` is `"abc def ghi"`. Reading that quote
    // as the close of the string around it puts the `#` after it back at code
    // scope, and the live `using` following it is lost with the rest of the line.
    it("collects a using written after a string whose interpolation holds a quoted #", () => {
        expect(allUsingPaths(['X := "a{F("#")}b"; using { /A }'])).toEqual(["/A"]);
    });

    it("collects a using written after a string holding a plain interpolation", () => {
        expect(allUsingPaths(['X := "abc {"def"} ghi"; using { Economy.Shop }', "using { /A }"])).toEqual(["Economy.Shop", "/A"]);
    });

    // `"{"{"{3}"}"}"` is the string "3": interpolation nests as deeply as it is
    // written, so one flag for "inside a literal" cannot describe it.
    it("collects a using written after nested interpolations", () => {
        expect(allUsingPaths(['X := "{"{"{3}#"}"}"; using { /A }'])).toEqual(["/A"]);
    });

    // A `}` closing a block written inside an interpolation does not close the
    // interpolation. Read as the end of it, the string's closing quote is taken
    // for an opening one and the `#` after it ends the line at code scope.
    it("keeps a string open across a block written inside its interpolation", () => {
        expect(allUsingPaths(['X := "a{F({1=>2}, "#")}b"; using { /A }'])).toEqual(["/A"]);
    });

    // `\{` is an escaped brace, so it opens no interpolation and the `#` after
    // it is still string content.
    it("does not open an interpolation at an escaped brace", () => {
        expect(allUsingPaths(['X := "a\\{#b"; using { /A }'])).toEqual(["/A"]);
    });

    // A char literal is one character or one escape and takes no interpolation,
    // so the `{` of `'{'` is content and the literal closes at the next quote.
    // The `"#"` after it is what tells the two readings apart: taking the `{`
    // for an interpolation leaves the quotes paired the other way round.
    it("does not open an interpolation inside a char literal", () => {
        expect(allUsingPaths(["C := '{'; X := \"#\"; using { Features }"])).toEqual(["Features"]);
    });

    // The interpolation is code scope, so a `#` written directly in one opens a
    // comment as it would anywhere else. This narrows what the scanner reads:
    // the `using` here really is inside that comment, because the comment runs
    // to the end of the line and the interpolation is still open at it.
    it("reads a # written directly in an interpolation as a comment opener", () => {
        expect(allUsingPaths(['X := "a{M{1=>2}#}b"; using { /A }'])).toEqual([]);
    });
});

describe("scanModuleImports", () => {
    it("collects a braced import at column 0 with a single-line span", () => {
        expect(scanModuleImports(["using { /Verse.org/Simulation }", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("collects a dotted-style import", () => {
        expect(scanModuleImports(["using. /Verse.org/Simulation"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    // The classification read the dotted content to end of line, so this one
    // was `Features; MyVal := 5` - no path, no identifier, no import. The line
    // was skipped whole and nothing recorded that the file imports Features, so
    // a diagnostic asking for it wrote a second copy above a line already
    // making that import.
    it("records a bare dotted import that shares its line with a definition, pinned", () => {
        expect(scanModuleImports(["using. Features; MyVal := 5", "", "code()"])).toEqual([
            { path: "Features", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    it("consumes the indented using: pair as one two-line entry", () => {
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    // Read as a whole line the tail is not a `using:` at all, so the line used
    // to fall through to the single-statement branch: one entry for the path
    // before the `;`, spanning one line, and rewritable. Organizing then rebuilt
    // that line from that path alone, deleting the `; using:` and leaving
    // Economy.Shop stranded in the body as a bare indented expression.
    it("consumes a using: pair opened after a semicolon, pinning both paths", () => {
        expect(scanModuleImports(["using { /X }; using:", "    Economy.Shop", "", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // The same pair opened after a bare dotted import, which the classification
    // has to admit before this branch can see it: gated on the line read whole,
    // the opener was skipped and its indented path was left in the body as a
    // bare expression, imported by nothing.
    it("consumes a using: pair opened after a bare dotted import, pinning both paths", () => {
        expect(scanModuleImports(["using. Features; using:", "    Economy.Shop", "", "code()"])).toEqual([
            { path: "Features", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // Both paths still count as imported - that is what stops a writer adding
    // either one a second time - but neither may be rebuilt or moved, because
    // no writer can reproduce the span from one path.
    it("offers no rewritable import for a pair opened after a semicolon", () => {
        expect(rewritableImports(scanModuleImports(["using { /X }; using:", "    Economy.Shop", "", "code()"]))).toEqual([]);
    });

    // The line the fix keys on has to keep meaning what it did: a pair opening
    // its own line is one entry spanning both lines, and still rewritable.
    it("leaves the plain indented pair rewritable", () => {
        expect(rewritableImports(scanModuleImports(["using:", "    Economy.Shop", "code()"]))).toEqual([
            { path: "Economy.Shop", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    // The tail is tested against the line's code, not its raw text. A `$`
    // anchored on the raw line is defeated by any comment after the `using:`,
    // which puts the line straight back on the branch that rebuilds it from the
    // path before the `;`.
    it("consumes a pair opened after a semicolon when a comment trails the opener", () => {
        expect(scanModuleImports(["using { /X }; using: # note", "    Economy.Shop", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "# note" },
            { path: "Economy.Shop", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // The mirror error of searching the raw line: this one ends in `using:`
    // inside a comment, and reading that as an opener records the comment text
    // below it as an import path.
    it("does not read a using: written inside a comment as opening a pair", () => {
        expect(scanModuleImports(["using { /A } <# note about using:", "    still comment", "#>", "code()"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<# note about using:" },
        ]);
    });

    // The `using:` opens nothing usable, but the line still writes a statement
    // no rebuild can reproduce, so it is pinned rather than handed to the
    // single-statement branch - which would rebuild it and delete the
    // `; using:`.
    it("pins a pair opened after a semicolon whose using: opens no indented path", () => {
        expect(scanModuleImports(["using { /X }; using:", "code()"])).toEqual([{ path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" }]);
        expect(scanModuleImports(["using { /X }; using:", "    # just a note", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // This branch has first refusal, so a line ending in `using:` never reaches
    // the one that counts what a line writes. Reading only the head recorded
    // `/X` and the indented path and left `/Y` out - not data loss, since the
    // line is pinned, but a writer asked for `/Y` then writes a second copy of a
    // path the file already imports.
    it("records every statement written before the pair a line opens", () => {
        expect(scanModuleImports(["using { /X }; using { /Y }; using:", "    Economy.Shop", "", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "/Y", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // A `using:` following something that is not a `using` writes no import
    // this scanner may touch: isModuleImport rejects the line, so it is skipped
    // whole and left exactly as written.
    it("skips a using: opened after a statement that is not a using", () => {
        expect(scanModuleImports(["X := 1; using:", "    Economy.Shop", "code()"])).toEqual([]);
    });

    // The classification reads a line from its head, so this one was rejected
    // and skipped whole. Nothing recorded that the file imports the path, and a
    // diagnostic asking for it wrote a second copy above a line already making
    // the import. `allUsingPaths` saw it throughout, so only deduplication was
    // affected.
    it("records a using written after a definition on its line, pinned", () => {
        expect(scanModuleImports(["X := 1; using { /Verse.org/Random }", "code()"])).toEqual([
            { path: "/Verse.org/Random", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    it("records a dotted using written after a definition on its line", () => {
        expect(scanModuleImports(["X := 1; using. /Verse.org/Random", "code()"])).toEqual([
            { path: "/Verse.org/Random", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    it("records every using written after a definition, in written order", () => {
        expect(scanModuleImports(["X := 1; using { /X }; using { Economy.Shop }", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // The definition sharing the line is what no rebuild from a path can
    // reproduce, so the entry counts as present and nothing more. A writer
    // handed it would rebuild the line as a bare import and delete `X := 1`.
    it("offers no rewritable import for a using written after a definition", () => {
        expect(rewritableImports(scanModuleImports(["X := 1; using { /Verse.org/Random }", "code()"]))).toEqual([]);
    });

    // Read from the line's code, so a path named in a comment is not an import.
    // Searching the raw text records `/A` as present and the file never gets the
    // import a diagnostic asked for.
    it("records nothing for a using written in a comment after a definition", () => {
        expect(scanModuleImports(["X := 1 # using { /A }", "code()"])).toEqual([]);
    });

    // Indented lines are skipped before the classification runs, and have to
    // stay that way: a `using` in a module body is module-scoped, and counting
    // it as present suppresses the file-level import the diagnostic asked for.
    it("skips a using written after a definition inside a module body", () => {
        expect(scanModuleImports(["MyModule := module:", "    X := 1; using { /A }", "code()"])).toEqual([]);
    });

    // Literal text is data, not a statement. Recorded as an import it counts as
    // present, which both withholds the path from a file that needs it and -
    // since a pinned path is withheld from the rebuilt block - deletes the real
    // `using` the author wrote elsewhere in the file.
    it("records nothing for a using written inside a string literal", () => {
        expect(scanModuleImports(['Hint := "using { /A }"', "code()"])).toEqual([]);
    });

    it("records nothing for a using written inside a char literal", () => {
        expect(scanModuleImports(["Hint := 'using { /A }'", "code()"])).toEqual([]);
    });

    // The same rule on a line that is itself an import: the statement counts,
    // the literal beside it does not.
    it("records only the statement a line writes beside a literal naming a path", () => {
        expect(scanModuleImports(['using { /A }; Hint := "using { /B }"', "code()"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // An interpolation is code scope again, so a `using` written in one is a
    // statement the line really does make and stays recorded.
    it("records a using written inside a string interpolation", () => {
        expect(scanModuleImports(['X := "a{using { /A }}b"', "code()"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" }]);
    });

    // extractPathFromImport reads the statement at the head of what it is given
    // and reports nothing about the rest, so the line used to be recorded as
    // `/X` alone, spanning one line and rewritable. Organizing rebuilt it from
    // that path and Economy.Shop was gone - a well-formed import block importing
    // one path fewer than the file had, with nothing left behind to say so.
    it("records both statements a line carrying two writes, pinning both", () => {
        expect(scanModuleImports(["using { /X }; using { Economy.Shop }", "", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // Both count as imported, so nothing writes either one again, and neither
    // may be moved, because a rebuild from one path deletes the other. The two
    // entries share a span; only a reader of the unfiltered scan ever sees that.
    it("offers no rewritable import for a line carrying two statements", () => {
        expect(rewritableImports(scanModuleImports(["using { /X }; using { Economy.Shop }", "", "code()"]))).toEqual([]);
    });

    // The count is taken from the line's code. Searching the raw text finds the
    // `using` in this trailing comment as well, and pinning on that would refuse
    // to organize an ordinary single-statement line for the words after its `#`.
    it("leaves a single statement rewritable when its comment mentions another using", () => {
        expect(rewritableImports(scanModuleImports(["using { /A } # see using { /B }", "code()"]))).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# see using { /B }" },
        ]);
    });

    // `using` is a substring of ordinary identifiers, and the dotted pattern
    // needs no space after its `.`, so offering every occurrence reads
    // `Housing.Data` as `Housing.Data` and then `Data` - two statements, on a
    // line that writes one. Pinning on that count stops the file being organized
    // at all, for a module whose name merely ends in those five letters.
    it("leaves a single statement rewritable when its path holds the word using", () => {
        expect(rewritableImports(scanModuleImports(["using { Housing.Data }", "code()"]))).toEqual([
            { path: "Housing.Data", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
        expect(rewritableImports(scanModuleImports(["using { /Verse.org/Housing.Sim }", "code()"]))).toEqual([
            { path: "/Verse.org/Housing.Sim", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
        expect(rewritableImports(scanModuleImports(["using { A_using.B }", "code()"]))).toEqual([
            { path: "A_using.B", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    // Two statements, the first dotted. The line was pinned before, but under
    // the swallowed path `/X; using { Economy.Shop }` - so `/X` did not count as
    // imported and a writer was free to add a second copy of it.
    it("pins a line whose dotted statement precedes another, under both real paths", () => {
        expect(scanModuleImports(["using. /X; using { Economy.Shop }", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
            { path: "Economy.Shop", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    // The shape the two guards used to miss together: one `using` on the line,
    // so counting them says one, and nothing left over, because the greedy
    // capture had already taken it. The entry was rewritable, and organizing
    // rebuilt the line from that path into `using { /X; MyVal := 5 }` - the
    // definition folded inside the braces, and the file no longer compiled.
    it("pins a line that writes a definition after its dotted import", () => {
        expect(scanModuleImports(["using. /X; MyVal := 5", "", "code()"])).toEqual([{ path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" }]);
    });

    it("offers no rewritable import for a line that writes a definition after its dotted import", () => {
        expect(rewritableImports(scanModuleImports(["using. /X; MyVal := 5", "", "code()"]))).toEqual([]);
    });

    it("pins a dotted import followed by a bare separator", () => {
        expect(rewritableImports(scanModuleImports(["using. /X;", "code()"]))).toEqual([]);
    });

    // Ending the capture at the `'` would record `Economy.Shop`, a module that
    // exists and is not the one this line imports - so a writer asked for
    // `Economy.Shop` would read the file as already importing it and withhold
    // the import the compiler asked for.
    it("records the whole path of a dotted import carrying a quoted suffix", () => {
        expect(rewritableImports(scanModuleImports(["using. Economy.Shop'Loc'", "code()"]))).toEqual([
            { path: "Economy.Shop'Loc'", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
        expect(allUsingPaths(["using. Economy.Shop'Loc'", "code()"])).toEqual(["Economy.Shop'Loc'"]);
    });

    // allUsingPaths reads an empty answer as permission to remove an import, so
    // a content it cannot lex must still report a path rather than none.
    it("records the whole path of a dotted import carrying a qualifier", () => {
        expect(scanModuleImports(["using. (/A:)B.C", "code()"]).map((imp) => imp.path)).toEqual(["(/A:)B.C"]);
        expect(allUsingPaths(["using. (/A:)B.C", "code()"])).toEqual(["(/A:)B.C"]);
    });

    // The dotted capture ends at the first character a content cannot hold, so
    // a comment cannot enter the path and the statement stays rewritable.
    it("leaves an ordinary dotted import rewritable, with and without a comment", () => {
        expect(rewritableImports(scanModuleImports(["using. /Verse.org/Simulation", "code()"]))).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
        expect(rewritableImports(scanModuleImports(["using. /Verse.org/Simulation # keep me", "code()"]))).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# keep me" },
        ]);
    });

    // The line writes one `using`, so counting them says one and the line was
    // recorded as rewritable. Organizing rebuilt it from `/X` and the definition
    // was gone, under an import block well-formed enough to say nothing.
    it("pins a line that writes a definition after its import", () => {
        expect(scanModuleImports(["using { /X }; MyVal := 5", "", "code()"])).toEqual([
            { path: "/X", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: true, trailingComment: "" },
        ]);
    });

    it("offers no rewritable import for a line that writes a definition after its import", () => {
        expect(rewritableImports(scanModuleImports(["using { /X }; MyVal := 5", "", "code()"]))).toEqual([]);
    });

    // What is left over is read from the line's code. A trailing comment is left
    // over on the raw text, and pinning on that refuses to organize every
    // annotated import in the file.
    it("leaves a single statement rewritable when a semicolon sits in its trailing comment", () => {
        expect(rewritableImports(scanModuleImports(["using { /A } # note; and more", "code()"]))).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# note; and more" },
        ]);
    });

    // The separator is never searched for, only the text after the statement,
    // so a `;` the braces enclose is part of the path rather than a second
    // statement. A `;` in a string literal is covered by the same property
    // without a case of its own: it can only ever sit inside leftover text,
    // never be what decides there is any.
    it("leaves a single statement rewritable when a semicolon sits inside its braces", () => {
        expect(rewritableImports(scanModuleImports(["using { /X;Y }", "code()"]))).toEqual([
            { path: "/X;Y", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    // Nothing follows the separator, so the rebuild would lose only the `;`
    // itself. Pinned anyway: the cost is a line left as written, where trimming
    // the separator away first means being right about which ones mean nothing.
    it("pins a line whose import is followed by a bare separator", () => {
        expect(rewritableImports(scanModuleImports(["using { /X };", "code()"]))).toEqual([]);
    });

    it("keeps a trailing comment out of the path but on the entry, in all three styles", () => {
        // Out of `path`, which is re-emitted inside the braces and would be
        // corrupted by it, and onto `trailingComment`, which is what a writer
        // puts back after rebuilding the line.
        expect(scanModuleImports(["using { /Verse.org/Simulation } # keep me"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# keep me" },
        ]);
        expect(scanModuleImports(["using. /Verse.org/Simulation # keep me"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# keep me" },
        ]);
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation # keep me", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# keep me" },
        ]);
    });

    it("skips a using: line whose indented next line is nothing but a comment", () => {
        expect(scanModuleImports(["using:", "    # just a note", "code()"])).toEqual([]);
    });

    it("collects dot-notation module references", () => {
        expect(scanModuleImports(["using { Gadgets.Tools }"])).toEqual([{ path: "Gadgets.Tools", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("skips indented using lines (module-scoped imports)", () => {
        const lines = ["Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("collects a bare identifier at column 0 as a module import (folder-relative)", () => {
        // A module `using` is only legal at file level or module-definition
        // body level; local-scope `using{instance}` is only legal inside a
        // function body. So a bare `using { X }` at column 0 can only be a
        // same-directory folder-module import, never a local-scope using.
        expect(scanModuleImports(["using { Features }"])).toEqual([{ path: "Features", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("skips local-scope using inside a function body", () => {
        const lines = ["F():void =", "    using { LocalVar }", "    code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("skips a using: line whose next line is not an indented path", () => {
        expect(scanModuleImports(["using:", "code()"])).toEqual([]);
    });

    it("handles CRLF line endings", () => {
        expect(scanModuleImports(["using { /A }\r", "code()\r"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("skips an import commented out with a block comment", () => {
        const lines = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("resumes scanning after a block comment closes", () => {
        const lines = ["<#", "using { /Old/Path }", "#>", "using { /Verse.org/Simulation }", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 3, endLine: 3, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("skips an import inside a block comment opened and closed on one line", () => {
        expect(scanModuleImports(["<# using { /Old/Path } #>", "using { /A }"])).toEqual([
            { path: "/A", startLine: 1, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("keeps an import whose line opens a block comment after it, and flags it", () => {
        const lines = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "using { /B }"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<# disabled below" },
            { path: "/B", startLine: 3, endLine: 3, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("does not flag an import whose trailing block comment closes on the same line", () => {
        // Nothing below the line is comment body, so rebuilding it only loses
        // the annotation text - the documented behavior of stripTrailingComment.
        expect(scanModuleImports(["using { /A } <# note #>", "using { /B }"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "<# note #>" },
            { path: "/B", startLine: 1, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("does not flag an import whose trailing line comment mentions <#", () => {
        expect(scanModuleImports(["using { /A } # opens with <#", "using { /B }"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "# opens with <#" },
            { path: "/B", startLine: 1, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("flags an indented pair whose path line opens a block comment", () => {
        // The opener is on the second line of the statement, so the flag has to
        // be read at endLine rather than startLine.
        const lines = ["using:", "    /A <# disabled below", "using { /Old/Path }", "#>", "using { /B }"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 1, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<# disabled below" },
            { path: "/B", startLine: 4, endLine: 4, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });

    it("flags an unclosed opener whether or not a line sits below it today", () => {
        // The flag used to be read off the line below, so an opener ending the
        // buffer was left rewritable as swallowing nothing - and which a file
        // got turned on whether it ended with a newline. Now that a rebuild
        // carries the opener through rather than dropping it, "swallows nothing
        // today" stops being safe: sorted above another import, it swallows it.
        expect(scanModuleImports(["using { /A } <#"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<#" }]);
        expect(scanModuleImports(["using { /A } <#", ""])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<#" }]);
    });

    it("does not flag a statement whose own text closes every block it opens", () => {
        // Depth returns to 0 on the line, so nothing below it is comment body
        // and the trailing text travels with the statement safely.
        expect(scanModuleImports(["using { /A } <# note #>", "code()"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "<# note #>" },
        ]);
    });

    it("flags an import whose line carries an indented comment marker", () => {
        // `<#>` opens a comment whose body is the lines below it indented past
        // it. Rebuilding the line moves the marker away from that body, and
        // leaves the body behind as indented lines at file scope.
        const lines = ["using { /A } <#> why this is here", "    it brings the module into scope", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<#> why this is here" }]);
    });

    it("flags an indented pair whose path line carries an indented comment marker", () => {
        const lines = ["using:", "    /A <#> why", "        the body of the marker's comment", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 1, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<#> why" }]);
    });

    it("flags a marker with no body below it, unlike an unclosed block opener", () => {
        // The `<#` carve-out above is safe because a file ending at that line
        // can never grow a body. A marker's body is whatever sits indented
        // below it, so a rebuild that moves the line hands it one it never had.
        expect(scanModuleImports(["using { /A } <#> note", "code()"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<#> note" },
        ]);
    });

    it("treats block comments as nesting, so an inner close does not resume scanning", () => {
        const lines = ["<#", "<#", "using { /Inner }", "#>", "using { /Outer }", "#>", "using { /Live }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Live", startLine: 6, endLine: 6, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("flags an import whose trailing opener is closed by a nested block below", () => {
        // The outer `<#` is still open on the line after the statement, so the
        // import stays anchored even though an inner `#>` appears first.
        const lines = ["using { /A } <# outer", "<# inner #>", "using { /Old/Path }", "#>", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, rebuildLosesText: false, trailingComment: "<# outer" }]);
    });

    it("skips an indented using: pair commented out as a block", () => {
        const lines = ["<#", "using:", "    /Old/Path", "#>", "code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("does not treat the indented comment marker <#> as a block opener", () => {
        // `<#>` opens an indented comment whose body is the indented lines
        // below it, which are skipped anyway. Reading it as `<#` would open a
        // block that never closes and hide every import in the rest of the file.
        const lines = ["<#> disabled for now", "    using { /Old/Path }", "using { /Verse.org/Simulation }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 2, endLine: 2, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("does not treat a <# inside a line comment as a block opener", () => {
        const lines = ["# a block comment opens with <#", "using { /Verse.org/Simulation }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 1, endLine: 1, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" }]);
    });

    it("returns entries in document order with correct spans across mixed styles", () => {
        const lines = ["using { /A }", "using:", "    /B", "using. /C"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
            { path: "/B", startLine: 1, endLine: 2, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
            { path: "/C", startLine: 3, endLine: 3, anchorsCommentBelow: false, rebuildLosesText: false, trailingComment: "" },
        ]);
    });
});

describe("scanConvertibleImports", () => {
    it("returns a live top-level import with its statement text and line", () => {
        expect(scanConvertibleImports(["using { /Old/Path }", "", "code()"])).toEqual([{ statement: "using { /Old/Path }", line: 0 }]);
    });

    it("keeps the dotted style, which converts the same way as the braced one", () => {
        expect(scanConvertibleImports(["using. /Old/Path"])).toEqual([{ statement: "using. /Old/Path", line: 0 }]);
    });

    // Conversion rewrites the whole line around the path it reads, so a line
    // carrying a definition after its dotted import must not be offered one.
    it("excludes a dotted import that shares its line with a definition", () => {
        expect(scanConvertibleImports(["using. /Old/Path; MyVal := 5", "", "code()"])).toEqual([]);
    });

    it("keeps a bare-identifier import, which is a folder module at file scope", () => {
        // The line-by-line detection this replaces classified a bare identifier
        // as a local-scope using and skipped it, so a real same-directory import
        // got no lens. At column 0 it can only be a module import.
        expect(scanConvertibleImports(["using { Features }", "", "code()"])).toEqual([{ statement: "using { Features }", line: 0 }]);
    });

    it("excludes an import inside a block comment", () => {
        // The lens used to appear here, and acting on it edited a line inside
        // the comment.
        const lines = ["<#", "using { /Old/Path }", "#>", "", "code()"];
        expect(scanConvertibleImports(lines)).toEqual([]);
    });

    it("excludes a module-scoped import indented inside a module body", () => {
        const lines = ["MyModule := module:", "    using { /Old/Path }", "", "code()"];
        expect(scanConvertibleImports(lines)).toEqual([]);
    });

    it("excludes an import whose own line opens a block comment", () => {
        // Rebuilding the line from its path alone would drop the opener and
        // resurrect the region below it.
        const lines = ["using { /A } <#", "using { /Old/Path }", "#>", "code()"];
        expect(scanConvertibleImports(lines)).toEqual([]);
    });

    it("excludes an import whose own line carries an indented comment marker", () => {
        // Conversion replaces the whole line, so the marker would land at
        // whatever the converted statement is and the body below it would be
        // read against a marker that is no longer above it.
        const lines = ["using { /A } <#> why", "    the body", "code()"];
        expect(scanConvertibleImports(lines)).toEqual([]);
    });

    it("excludes the indented style, which no conversion path can rewrite", () => {
        // Every conversion identifies an import by one line of statement text
        // and replaces that one line; this statement spans two.
        expect(scanConvertibleImports(["using:", "    /Old/Path", "code()"])).toEqual([]);
    });

    it("keeps the live imports of a file that also holds excluded ones", () => {
        const lines = ["using { /Live/One }", "<#", "using { /Commented }", "#>", "using:", "    /Indented", "using { /Live/Two }", "MyModule := module:", "    using { /Scoped }"];
        expect(scanConvertibleImports(lines)).toEqual([
            { statement: "using { /Live/One }", line: 0 },
            { statement: "using { /Live/Two }", line: 6 },
        ]);
    });

    it("strips the carriage return of a CRLF file split on newlines alone", () => {
        // The CodeLens provider and the converter both split on "\n", so a CRLF
        // document leaves "\r" on every line. The statement text has to match
        // what a conversion looks for, which is the trimmed line.
        expect(scanConvertibleImports(["using { /A }\r", "code()\r"])).toEqual([{ statement: "using { /A }", line: 0 }]);
    });
});

describe("classifyLines", () => {
    const kinds = (lines: string[]) => classifyLines(lines).map((classification) => classification.kind);

    it("separates code, line comments and blank lines", () => {
        expect(kinds(["code()", "# a note", "", "   ", "using { /A }"])).toEqual(["code", "comment", "blank", "blank", "code"]);
    });

    it("reads every line of a block comment as comment, blank ones included", () => {
        expect(kinds(["<#", "still a comment", "", "#>", "code()"])).toEqual(["comment", "comment", "comment", "comment", "code"]);
    });

    it("calls a line that opens a block comment after code what it is: code", () => {
        expect(kinds(["using { /A } <# disabled below", "using { /Old }", "#>"])).toEqual(["code", "comment", "comment"]);
    });

    it("calls a line that closes a block comment and then runs code, code", () => {
        expect(kinds(["<#", "note", "#> code()"])).toEqual(["comment", "comment", "code"]);
    });

    it("reads an indented comment marker as a comment, trailing text included", () => {
        expect(kinds(["<#> the marker is not a block opener", "code()"])).toEqual(["comment", "code"]);
    });

    it("does not mistake a block opener inside a line comment for one", () => {
        expect(kinds(["# see <# below", "code()"])).toEqual(["comment", "code"]);
    });

    it("keeps a # inside a string literal in the line's code", () => {
        expect(classifyLines(['X := "a#b"; using { /A }'])[0].code).toBe('X := "a#b"; using { /A }');
    });

    it("keeps a # inside a char literal in the line's code", () => {
        expect(classifyLines(["C := '#'; using { /A }"])[0].code).toBe("C := '#'; using { /A }");
    });

    // A block comment opened inside a string does not end the string:
    // "a<#c#>#b" is the string "a#b", so the `#` after the `#>` is content too.
    it("keeps a string open across a block comment written inside it", () => {
        expect(classifyLines(['X := "a<#c#>#b"; using { /A }'])[0].code).toBe('X := "a#b"; using { /A }');
    });

    // The quote opening a string inside an interpolation does not close the
    // string around it, so the `#` between them is still content and the code
    // keeps everything the line writes after the literal.
    it("keeps a # inside a string nested in an interpolation in the line's code", () => {
        expect(classifyLines(['X := "a{F("#")}b"; using { /A }'])[0].code).toBe('X := "a{F("#")}b"; using { /A }');
    });

    it("marks only the lines a block comment was opened above", () => {
        expect(classifyLines(["<#", "note", "#>", "code()"]).map((classification) => classification.insideBlockComment)).toEqual([false, true, true, false]);
    });

    // "Indented comments begin with a `<#>` on its own line; everything
    // indented by four spaces on subsequent lines becomes part of the comment."
    it("reads the indented body of a marker as part of its comment", () => {
        expect(kinds(["<#> Copyright 2026 MyGame", "    all rights reserved", "using { /A }"])).toEqual(["comment", "comment", "code"]);
    });

    it("keeps an indented comment open across a blank line inside it", () => {
        expect(kinds(["<#> Notes", "    the first paragraph", "", "    the second paragraph", "using { /A }"])).toEqual(["comment", "comment", "blank", "comment", "code"]);
    });

    it("ends an indented comment at the first line not indented past its marker", () => {
        expect(kinds(["<#> Notes", "    the body", "code()", "    indented code"])).toEqual(["comment", "comment", "code", "code"]);
    });

    it("does not read a same-indent sibling as the body of a marker inside a module", () => {
        expect(kinds(["M := module:", "    <#> doc", "    using { /Verse.org/Random }"])).toEqual(["code", "comment", "code"]);
    });

    it("marks an indented comment body as continuing the comment above it", () => {
        expect(classifyLines(["<#> Notes", "    the body", "using { /A }"]).map((classification) => classification.continuesCommentAbove)).toEqual([false, true, false]);
    });

    it("leaves block-comment depth tracking unchanged across an indented comment body", () => {
        // The body affects `kind` only: what the import scanner sees through
        // insideBlockComment has to stay exactly what it saw before.
        expect(classifyLines(["<#> Notes", "    opens <#", "code()", "#>", "code()"]).map((classification) => classification.insideBlockComment)).toEqual([false, false, true, true, false]);
    });
});
