import { allUsingPaths, classifyLines, scanConvertibleImports, scanModuleImports } from "../ImportScanner";

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

    it("collects an import whose line opens a comment over the lines below it", () => {
        expect(allUsingPaths(["using { /A } <#> note", "    body", "code()"])).toEqual(["/A"]);
    });

    it("reads the dot syntax", () => {
        expect(allUsingPaths(["using. /A", "code()"])).toEqual(["/A"]);
    });

    it("strips a trailing comment from the path", () => {
        expect(allUsingPaths(["using { /A } # why", "code()"])).toEqual(["/A"]);
    });
});

describe("scanModuleImports", () => {
    it("collects a braced import at column 0 with a single-line span", () => {
        expect(scanModuleImports(["using { /Verse.org/Simulation }", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("collects a dotted-style import", () => {
        expect(scanModuleImports(["using. /Verse.org/Simulation"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("consumes the indented using: pair as one two-line entry", () => {
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 1, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("keeps a trailing comment out of the path but on the entry, in all three styles", () => {
        // Out of `path`, which is re-emitted inside the braces and would be
        // corrupted by it, and onto `trailingComment`, which is what a writer
        // puts back after rebuilding the line.
        expect(scanModuleImports(["using { /Verse.org/Simulation } # keep me"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "# keep me" },
        ]);
        expect(scanModuleImports(["using. /Verse.org/Simulation # keep me"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "# keep me" },
        ]);
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation # keep me", "code()"])).toEqual([
            { path: "/Verse.org/Simulation", startLine: 0, endLine: 1, anchorsCommentBelow: false, trailingComment: "# keep me" },
        ]);
    });

    it("skips a using: line whose indented next line is nothing but a comment", () => {
        expect(scanModuleImports(["using:", "    # just a note", "code()"])).toEqual([]);
    });

    it("collects dot-notation module references", () => {
        expect(scanModuleImports(["using { Gadgets.Tools }"])).toEqual([{ path: "Gadgets.Tools", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" }]);
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
        expect(scanModuleImports(["using { Features }"])).toEqual([{ path: "Features", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("skips local-scope using inside a function body", () => {
        const lines = ["F():void =", "    using { LocalVar }", "    code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("skips a using: line whose next line is not an indented path", () => {
        expect(scanModuleImports(["using:", "code()"])).toEqual([]);
    });

    it("handles CRLF line endings", () => {
        expect(scanModuleImports(["using { /A }\r", "code()\r"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("skips an import commented out with a block comment", () => {
        const lines = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("resumes scanning after a block comment closes", () => {
        const lines = ["<#", "using { /Old/Path }", "#>", "using { /Verse.org/Simulation }", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 3, endLine: 3, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("skips an import inside a block comment opened and closed on one line", () => {
        expect(scanModuleImports(["<# using { /Old/Path } #>", "using { /A }"])).toEqual([{ path: "/A", startLine: 1, endLine: 1, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("keeps an import whose line opens a block comment after it, and flags it", () => {
        const lines = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "using { /B }"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<# disabled below" },
            { path: "/B", startLine: 3, endLine: 3, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("does not flag an import whose trailing block comment closes on the same line", () => {
        // Nothing below the line is comment body, so rebuilding it only loses
        // the annotation text - the documented behavior of stripTrailingComment.
        expect(scanModuleImports(["using { /A } <# note #>", "using { /B }"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "<# note #>" },
            { path: "/B", startLine: 1, endLine: 1, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("does not flag an import whose trailing line comment mentions <#", () => {
        expect(scanModuleImports(["using { /A } # opens with <#", "using { /B }"])).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "# opens with <#" },
            { path: "/B", startLine: 1, endLine: 1, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("flags an indented pair whose path line opens a block comment", () => {
        // The opener is on the second line of the statement, so the flag has to
        // be read at endLine rather than startLine.
        const lines = ["using:", "    /A <# disabled below", "using { /Old/Path }", "#>", "using { /B }"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 1, anchorsCommentBelow: true, trailingComment: "<# disabled below" },
            { path: "/B", startLine: 4, endLine: 4, anchorsCommentBelow: false, trailingComment: "" },
        ]);
    });

    it("flags an unclosed opener whether or not a line sits below it today", () => {
        // The flag used to be read off the line below, so an opener ending the
        // buffer was left rewritable as swallowing nothing - and which a file
        // got turned on whether it ended with a newline. Now that a rebuild
        // carries the opener through rather than dropping it, "swallows nothing
        // today" stops being safe: sorted above another import, it swallows it.
        expect(scanModuleImports(["using { /A } <#"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<#" }]);
        expect(scanModuleImports(["using { /A } <#", ""])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<#" }]);
    });

    it("does not flag a statement whose own text closes every block it opens", () => {
        // Depth returns to 0 on the line, so nothing below it is comment body
        // and the trailing text travels with the statement safely.
        expect(scanModuleImports(["using { /A } <# note #>", "code()"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "<# note #>" }]);
    });

    it("flags an import whose line carries an indented comment marker", () => {
        // `<#>` opens a comment whose body is the lines below it indented past
        // it. Rebuilding the line moves the marker away from that body, and
        // leaves the body behind as indented lines at file scope.
        const lines = ["using { /A } <#> why this is here", "    it brings the module into scope", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<#> why this is here" }]);
    });

    it("flags an indented pair whose path line carries an indented comment marker", () => {
        const lines = ["using:", "    /A <#> why", "        the body of the marker's comment", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 1, anchorsCommentBelow: true, trailingComment: "<#> why" }]);
    });

    it("flags a marker with no body below it, unlike an unclosed block opener", () => {
        // The `<#` carve-out above is safe because a file ending at that line
        // can never grow a body. A marker's body is whatever sits indented
        // below it, so a rebuild that moves the line hands it one it never had.
        expect(scanModuleImports(["using { /A } <#> note", "code()"])).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<#> note" }]);
    });

    it("treats block comments as nesting, so an inner close does not resume scanning", () => {
        const lines = ["<#", "<#", "using { /Inner }", "#>", "using { /Outer }", "#>", "using { /Live }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Live", startLine: 6, endLine: 6, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("flags an import whose trailing opener is closed by a nested block below", () => {
        // The outer `<#` is still open on the line after the statement, so the
        // import stays anchored even though an inner `#>` appears first.
        const lines = ["using { /A } <# outer", "<# inner #>", "using { /Old/Path }", "#>", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: true, trailingComment: "<# outer" }]);
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
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 2, endLine: 2, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("does not treat a <# inside a line comment as a block opener", () => {
        const lines = ["# a block comment opens with <#", "using { /Verse.org/Simulation }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 1, endLine: 1, anchorsCommentBelow: false, trailingComment: "" }]);
    });

    it("returns entries in document order with correct spans across mixed styles", () => {
        const lines = ["using { /A }", "using:", "    /B", "using. /C"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0, anchorsCommentBelow: false, trailingComment: "" },
            { path: "/B", startLine: 1, endLine: 2, anchorsCommentBelow: false, trailingComment: "" },
            { path: "/C", startLine: 3, endLine: 3, anchorsCommentBelow: false, trailingComment: "" },
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
