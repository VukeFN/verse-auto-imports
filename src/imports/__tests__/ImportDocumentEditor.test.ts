import * as fs from "fs";
import * as path from "path";
import { applyLineSplices, detectEol, ImportDocumentEditor, minimalSplice } from "../ImportDocumentEditor";
import { ImportFormatter } from "../ImportFormatter";
import * as vscode from "vscode";

describe("detectEol", () => {
    it("returns null for a text with no line break", () => {
        expect(detectEol("code()")).toBeNull();
    });

    it("detects LF", () => {
        expect(detectEol("a\nb\n")).toBe("\n");
    });

    it("detects CRLF", () => {
        expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    });

    it("takes the dominant ending in a mixed text", () => {
        expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
        expect(detectEol("a\nb\nc\r\n")).toBe("\n");
    });

    it("prefers LF on a tie", () => {
        expect(detectEol("a\r\nb\n")).toBe("\n");
    });
});

describe("applyLineSplices", () => {
    const lines = ["a", "b", "c", "d"];

    it("returns the lines unchanged with no splices", () => {
        expect(applyLineSplices(lines, [])).toEqual(["a", "b", "c", "d"]);
    });

    it("replaces a range", () => {
        expect(applyLineSplices(lines, [{ start: 1, endExclusive: 3, newLines: ["B"] }])).toEqual(["a", "B", "d"]);
    });

    it("inserts above the line equal bounds name", () => {
        expect(applyLineSplices(lines, [{ start: 2, endExclusive: 2, newLines: ["X"] }])).toEqual(["a", "b", "X", "c", "d"]);
    });

    it("appends with equal bounds at the array's length", () => {
        expect(applyLineSplices(lines, [{ start: 4, endExclusive: 4, newLines: ["X"] }])).toEqual(["a", "b", "c", "d", "X"]);
    });

    it("applies splices by position whatever order they arrive in", () => {
        const splices = [
            { start: 3, endExclusive: 4, newLines: ["D"] },
            { start: 0, endExclusive: 1, newLines: ["A"] },
        ];
        expect(applyLineSplices(lines, splices)).toEqual(["A", "b", "c", "D"]);
    });

    it("puts an insertion at the start of a replaced range first", () => {
        const splices = [
            { start: 1, endExclusive: 3, newLines: ["B"] },
            { start: 1, endExclusive: 1, newLines: ["X"] },
        ];
        expect(applyLineSplices(lines, splices)).toEqual(["a", "X", "B", "d"]);
    });

    it("keeps two insertions at one line in their given order", () => {
        const splices = [
            { start: 2, endExclusive: 2, newLines: ["X"] },
            { start: 2, endExclusive: 2, newLines: ["Y"] },
        ];
        expect(applyLineSplices(lines, splices)).toEqual(["a", "b", "X", "Y", "c", "d"]);
    });

    it("refuses overlapping splices", () => {
        const splices = [
            { start: 0, endExclusive: 2, newLines: ["A"] },
            { start: 1, endExclusive: 3, newLines: ["B"] },
        ];
        expect(applyLineSplices(lines, splices)).toBeNull();
    });

    it("refuses a splice reaching past the array", () => {
        expect(applyLineSplices(lines, [{ start: 3, endExclusive: 5, newLines: [] }])).toBeNull();
    });

    it("refuses inverted bounds", () => {
        expect(applyLineSplices(lines, [{ start: 2, endExclusive: 1, newLines: [] }])).toBeNull();
    });
});

describe("minimalSplice", () => {
    const apply = (before: string, after: string): string => {
        const splice = minimalSplice(before, after);
        if (splice === null) {
            return before;
        }
        return before.slice(0, splice.start) + splice.newText + before.slice(splice.end);
    };

    it("returns null for identical texts", () => {
        expect(minimalSplice("a\nb\n", "a\nb\n")).toBeNull();
    });

    it("replaces one changed line on line boundaries", () => {
        const splice = minimalSplice("a\nold\nc\n", "a\nnew\nc\n")!;
        expect(splice).toEqual({ start: 2, end: 6, newText: "new\n" });
    });

    it("inserts a line without touching its neighbours", () => {
        const splice = minimalSplice("a\nc\n", "a\nb\nc\n")!;
        expect(splice).toEqual({ start: 2, end: 2, newText: "b\n" });
    });

    it("inserts at the top of a file sharing no prefix", () => {
        const splice = minimalSplice("code()", "using { /A }\ncode()")!;
        expect(splice).toEqual({ start: 0, end: 0, newText: "using { /A }\n" });
    });

    it("appends to a document with no trailing newline without inventing one", () => {
        expect(apply("using { /A }\ncode()", "using { /A }\nusing { /B }\ncode()")).toBe("using { /A }\nusing { /B }\ncode()");
    });

    it("replaces to the end when the last line changes and has no newline", () => {
        const splice = minimalSplice("a\ncode(1)", "a\ncode(2)")!;
        expect(splice).toEqual({ start: 2, end: 9, newText: "code(2)" });
    });

    it("deletes a run of lines", () => {
        const splice = minimalSplice("a\nx\ny\nb\n", "a\nb\n")!;
        expect(splice).toEqual({ start: 2, end: 6, newText: "" });
    });

    it("covers the whole text when nothing is shared", () => {
        const splice = minimalSplice("x\ny\n", "p\nq\n")!;
        expect(splice.start).toBe(0);
        expect(splice.end).toBe(4);
        expect(splice.newText).toBe("p\nq\n");
    });

    it("never splits a CRLF pair", () => {
        const splice = minimalSplice("a\r\nold\r\nc\r\n", "a\r\nnew\r\nc\r\n")!;
        expect(splice).toEqual({ start: 3, end: 8, newText: "new\r\n" });
    });

    it("produces an edit for an ending-only normalization", () => {
        expect(apply("a\r\nb\n", "a\nb\n")).toBe("a\nb\n");
    });

    it("inserts into an empty text", () => {
        const splice = minimalSplice("", "using { /A }\n")!;
        expect(splice).toEqual({ start: 0, end: 0, newText: "using { /A }\n" });
    });

    it("round-trips a scattered multi-hunk change as one line-aligned range", () => {
        const before = "h\nusing { /A }\nbody\nusing { /B }\ntail\n";
        const after = "h\nusing { /A }\nusing { /B }\nbody\ntail\n";
        expect(apply(before, after)).toBe(after);
        const splice = minimalSplice(before, after)!;
        expect(before.slice(0, splice.start).endsWith("\n") || splice.start === 0).toBe(true);
    });
});

describe("ImportDocumentEditor.buildOrganizedContent", () => {
    let editor: ImportDocumentEditor;

    const curlyNoSort = {
        preferDotSyntax: false,
        sortAlphabetically: false,
        importGrouping: "none",
    };
    const curlySorted = { ...curlyNoSort, sortAlphabetically: true };

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
    });

    it("returns null when there are no imports and nothing to add", () => {
        expect(editor.buildOrganizedContent("foo := 1\nbar := 2", [], curlyNoSort)).toBeNull();
    });

    it("consolidates existing imports at the top with one blank line before code", () => {
        const input = "using { /A }\nusing { /B }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\nusing { /B }\n\ncode()");
    });

    it("deduplicates repeated imports", () => {
        const input = "using { /A }\nusing { /A }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    // A path read out of string text counted as a pinned import of that path,
    // and a pinned path is withheld from the block on the grounds that the line
    // holding it already makes the import. No line did, so organizing deleted
    // the file's only real `using { /A }` and left it importing one path fewer.
    it("keeps an import whose path a string literal elsewhere in the file names", () => {
        const input = 'using { /A }\nusing { /B }\nHint := "using { /A }"\ncode()';
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe('using { /A }\nusing { /B }\n\nHint := "using { /A }"\ncode()');
    });

    // The same loss reachable through a line that is itself an import, which is
    // the shape that could hit it before a `using` after a definition counted.
    it("keeps an import a literal on another import's line names", () => {
        const input = 'using { /A }\nusing { /B }; Hint := "using { /A }"\ncode()';
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toContain("using { /A }");
    });

    // Reading a path's quoted suffix as a char literal truncated it to the
    // module named before the `'`, which the file does import - so organizing
    // withheld that import as already made and deleted the line making it.
    it("keeps an import a quoted path suffix on another line truncates to", () => {
        const input = "using { /Verse.org/Random }\nX := 1; using. /Verse.org/Random'Loc'\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toContain("using { /Verse.org/Random }");
    });

    it("sorts alphabetically when enabled", () => {
        const input = "using { /Zebra }\nusing { /Apple }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /Apple }\nusing { /Zebra }\n\ncode()");
    });

    it("preserves original order when sorting is disabled", () => {
        const input = "using { /Zebra }\nusing { /Apple }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /Zebra }\nusing { /Apple }\n\ncode()");
    });

    // The commented-out import stays inert. It also stays where it was
    // written: it opens the file, so it is the file's header comment, and a
    // header belongs above the import block rather than pushed under it.
    it("leaves a commented-out import in the body instead of resurrecting it", () => {
        const input = "<#\nusing { /Old/Path }\n#>\nusing { /Verse.org/Simulation }\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("leaves a commented-out import below the block inert when it is not the header", () => {
        const input = "using { /Verse.org/Simulation }\n\n<#\nusing { /Old/Path }\n#>\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("returns null when the only import in the text is inside a block comment", () => {
        expect(editor.buildOrganizedContent("<#\nusing { /Old/Path }\n#>\n\ncode()", [], curlyNoSort)).toBeNull();
    });

    // Rebuilding an import line from its path alone drops everything trailing
    // on it. Where that trailing text is a `<#` opening the block below, the
    // drop turns a deliberately disabled import back into live code and leaves
    // its `#>` orphaned, so the line has to be left alone and organized around.
    it("leaves an import whose line opens a block comment where it is", () => {
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n"));
    });

    it("reproduces a document with an anchored import exactly, so organize can skip the edit", () => {
        const input = ["using { /B }", "", "using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("returns null when the only import is anchored and nothing is added", () => {
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    it("does not write a second copy of a path an anchored import already provides", () => {
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/A"], curlySorted)).toBeNull();
    });

    // An anchored import is a real import, and module imports have file scope,
    // so the path it names is in scope for the whole file however far down the
    // anchored line sits. A live import of that same path is therefore
    // redundant: hoisting it into the block leaves the file importing the path
    // twice, which is what these cover.
    it("drops a live import of a path an anchored <#> import already provides", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n"));
    });

    it("drops a live import of a path an anchored <# import already provides", () => {
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } <# disabled below", "using { /Old/Path }", "#>", "code()"].join("\n"));
    });

    it("still organizes the other imports when one of them duplicates an anchored path", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "using { /A }", "using { /B }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n"));
    });

    // A `using:` opening an indented pair after a `;` carries two paths across
    // two lines, which no rebuild from a single path can reproduce. The line
    // used to read as the path before the `;` alone, so organizing rewrote it as
    // `using { /X }` - deleting the `; using:` that opened the pair and leaving
    // Economy.Shop below as a bare indented expression that imports nothing.
    // Null is what leaves the document untouched: organizeImports skips the edit
    // entirely (#219).
    it("leaves a using: pair opened after a semicolon alone", () => {
        const input = ["using { /X }; using:", "    Economy.Shop", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    it("organizes the other imports around a using: pair opened after a semicolon", () => {
        const input = ["using { /X }; using:", "    Economy.Shop", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /X }; using:", "    Economy.Shop", "", "code()"].join("\n"));
    });

    it("does not write a second copy of a path such a pair already provides", () => {
        const input = ["using { /X }; using:", "    Economy.Shop", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/X"], curlySorted)).toBeNull();
        expect(editor.buildOrganizedContent(input, ["Economy.Shop"], curlySorted)).toBeNull();
    });

    // Counting the pair after a definition as present is what makes this
    // reachable: the movable copy is withheld rather than re-emitted, since the
    // pinned pair below it already imports that path. The same answer the pair
    // opened after a `using` gives for the same file.
    it("withholds a movable duplicate of a path a pair after a definition provides", () => {
        const input = ["using { /Verse.org/Random }", "X := 1; using:", "    /Verse.org/Random", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["X := 1; using:", "    /Verse.org/Random", "code()"].join("\n"));
    });

    // A comment after the `using:` defeats a `$` anchored on the raw line, which
    // put the line straight back on the mangling path: rebuilt as
    // `using { /X } # note`, with Economy.Shop stranded below it.
    it("leaves a using: pair alone when a comment trails the opener", () => {
        const input = ["using { /X }; using: # note", "    Economy.Shop", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    // The end of the pinning rule, asserted where it can be seen: a pair whose
    // path a comment separates from its opener is pinned, so the block is
    // rebuilt above it and the comment inside it survives. Were such a pair
    // ever rewritable, this rebuild would emit the path alone and the note
    // would be gone.
    it("keeps a comment written inside an indented pair", () => {
        const input = ["using { /B }", "using:", "    # note", "    /A", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using:", "    # note", "    /A", "", "code()"].join("\n"));
    });

    // The `using:` opens nothing here, so there is no pair to read - but the
    // line is still not reproducible from the path before the `;`, and
    // rebuilding it deletes the `; using:` the author wrote.
    it("leaves the line alone when such a using: opens no indented path", () => {
        const input = ["using { /X }; using:", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    // A pair's two lines have to stay adjacent to compile, and the entry
    // spanning both is the only thing holding a new import out from between
    // them: the statement before the `;` is recorded against the opener line
    // alone. So the pair is recorded even where its path is content the
    // classification declines - the path counts for nothing, the span for
    // everything. See ImportScanner's pairPathBelow.
    it("writes a new relative import below a pair whose path the content rule declines", () => {
        const input = ["using { /A }; using:", "    Foo'Loc'", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["using { /A }; using:", "    Foo'Loc'", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // Where the opener line is definition-headed the pair is declined on
    // content, so no entry spans the path line at all and the span above cannot
    // be what holds the import out. The statement before the `;` is pinned to
    // the opener line alone, and a floor taken from its own end leaves the path
    // line free.
    it("writes a new relative import below a pair a definition-headed line opens", () => {
        const input = ["X := 1; using { /A }; using:", "    Foo'Loc'", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["X := 1; using { /A }; using:", "    Foo'Loc'", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // The compiler takes the pair's path from the first line of code below the
    // opener, so a blank line between the two is inside the pair and not a gap
    // after it.
    it("writes a new relative import below a pair holding a blank line", () => {
        const input = ["X := 1; using { /A }; using:", "", "    Foo'Loc'", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["X := 1; using { /A }; using:", "", "    Foo'Loc'", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // A comment does not end an indented block at any indentation, so one
    // written back at column 0 is inside the pair rather than after it.
    it("writes a new relative import below a pair holding a comment at column 0", () => {
        const input = ["X := 1; using { /A }; using:", "# note", "    Foo'Loc'", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["X := 1; using { /A }; using:", "# note", "    Foo'Loc'", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // The opener opens a comment as well as a pair, so the rule that spans
    // comments would carry the span past the only line carrying the `using:`.
    // Asked in the other order the pair is never found and the import splits it.
    it("writes a new relative import below a pair whose opener also opens a comment", () => {
        const input = ["using { /A }; using: <#", "note #>", "    /B", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["using { /A }; using: <#", "note #>", "    /B", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    it("writes a new relative import below a pair whose opener opens a comment over several lines", () => {
        const input = ["X := 1; using { /A }; using: <#", "note", "#>", "    /B", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["X := 1; using { /A }; using: <#", "note", "#>", "    /B", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // Both halves of the span reach here: the pair carries it to the path line,
    // and the comment that line opens carries it to the end of the comment.
    it("writes a new relative import below a comment the pair's path line opens", () => {
        const input = ["X := 1; using { /A }; using:", "    Foo'Loc' <#", "note", "#>", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(
            ["X := 1; using { /A }; using:", "    Foo'Loc' <#", "note", "#>", "using { Gadgets.Tools }", "code()"].join("\n"),
        );
    });

    // The floor is the line a new import is written below, and a pinned line
    // that also opens a block owns the lines indented under it. Writing at
    // column 0 on the first of them ended the block before its body and left
    // that body indented under nothing.
    it("writes a new relative import below the body a pinned line opens, not into it", () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(["using { /A }; M := module:", "    Body<public>():int = 1", "using { Gadgets.Tools }", "code()"].join("\n"));
    });

    // The body's own trailing comment is part of it. A column-0 statement above
    // an indented comment leaves that comment opening an indented block at file
    // scope, which is not a shape the compiler is asked to accept anywhere.
    it("writes it below a comment trailing that body rather than between the two", () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "    # what the module is for", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(
            ["using { /A }; M := module:", "    Body<public>():int = 1", "    # what the module is for", "using { Gadgets.Tools }", "code()"].join("\n"),
        );
    });

    // Each hop re-anchors, so a pair inside the body is found from the body
    // line the first hop reached rather than from the pinned line itself.
    it("writes it below a body holding a pair of its own", () => {
        const input = ["using { /A }; M := module:", "    using:", "        Features", "    Body<public>():int = 1", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(
            ["using { /A }; M := module:", "    using:", "        Features", "    Body<public>():int = 1", "using { Gadgets.Tools }", "code()"].join("\n"),
        );
    });

    // A relative path was floored to the last line and written after it, inside
    // the comment - where the scan skips it, so the next compile added it
    // again. The absolute case above it never reached this: it raises no floor.
    it("does not write a newly added relative import into an unclosed opener that ends the buffer", () => {
        const input = ["code()", "using { /A } <#"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlySorted)).toBe(["using { Gadgets.Tools }", "", "code()", "using { /A } <#"].join("\n"));
    });

    // A blank line ends no block, so a comment written below one is as far
    // inside the body as one written directly under the last statement.
    it("writes it below a body's trailing comment even where a blank line separates the two", () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "", "    # what the module is for", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(
            ["using { /A }; M := module:", "    Body<public>():int = 1", "", "    # what the module is for", "using { Gadgets.Tools }", "code()"].join("\n"),
        );
    });

    // A comment at column 0 is prose about what follows rather than the body's
    // own, so the span stops above it and the import is written there.
    it("stops the span at a column-0 comment below the body", () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "# what the code below does", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlyNoSort)).toBe(
            ["using { /A }; M := module:", "    Body<public>():int = 1", "using { Gadgets.Tools }", "# what the code below does", "code()"].join("\n"),
        );
    });

    it("does not write it into the comment body an unclosed opener runs over", () => {
        const input = ["code()", "using { /A } <# note", "more note"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlySorted)).toBe(["using { Gadgets.Tools }", "", "code()", "using { /A } <# note", "more note"].join("\n"));
    });

    // The floor is the last line owned by the *lowest* pinned import, so an
    // unwritable one has to be passed over rather than take the whole floor
    // with it: dropping the maximum would carry the path above the provider
    // pinned higher up, which is the order the floor exists to keep.
    it("keeps the floor a pinned import above an unclosed opener raises", () => {
        const input = ["using { Features }; X := 1", "code()", "using { /B } <# note"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Features.Shop"], curlySorted)).toBe(["using { Features }; X := 1", "using { Features.Shop }", "code()", "using { /B } <# note"].join("\n"));
    });

    // A line writing two complete statements read as its first path alone, so
    // organizing rebuilt it as `using { /X }` and Economy.Shop was simply gone.
    // The output was a well-formed import block, which is what made the loss
    // silent - nothing was left stranded to signal it (#223).
    it("leaves a line carrying two statements alone", () => {
        const input = ["using { /X }; using { Economy.Shop }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    it("organizes the other imports around a line carrying two statements", () => {
        const input = ["using { /X }; using { Economy.Shop }", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /X }; using { Economy.Shop }", "", "code()"].join("\n"));
    });

    it("does not write a second copy of a path such a line already provides", () => {
        const input = ["using { /X }; using { Economy.Shop }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/X"], curlySorted)).toBeNull();
        expect(editor.buildOrganizedContent(input, ["Economy.Shop"], curlySorted)).toBeNull();
    });

    // A `;` separates definitions exactly as a newline does, so what follows the
    // import need not be an import. Counting `using` statements says one, and
    // organizing rebuilt the line from `/X` alone - MyVal simply gone, with a
    // well-formed import block left in its place.
    it("leaves a line that writes a definition after its import alone", () => {
        const input = ["using { /X }; MyVal := 5", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    it("organizes the other imports around a line that writes a definition after its import", () => {
        const input = ["using { /X }; MyVal := 5", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /X }; MyVal := 5", "", "code()"].join("\n"));
    });

    it("does not write a second copy of a path such a line already provides, next to a definition", () => {
        const input = ["using { /X }; MyVal := 5", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/X"], curlySorted)).toBeNull();
    });

    // The dotted style closes with nothing, so the definition after the `;` was
    // captured into the path and the line still read as one plain statement.
    // Organizing rebuilt it as `using { /X; MyVal := 5 }` - MyVal not deleted
    // this time but folded inside the braces, and the file stopped compiling.
    it("leaves a line that writes a definition after its dotted import alone", () => {
        const input = ["using. /X; MyVal := 5", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    it("organizes the other imports around a line that writes a definition after its dotted import", () => {
        const input = ["using. /X; MyVal := 5", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using. /X; MyVal := 5", "", "code()"].join("\n"));
    });

    // Under the swallowed path the line provided `/X; using { Economy.Shop }`
    // and no `/X`, so a writer asked for `/X` wrote a second copy of an import
    // the line was already making.
    it("does not write a second copy of a path a dotted statement provides beside another", () => {
        const input = ["using. /X; using { Economy.Shop }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/X"], curlySorted)).toBeNull();
        expect(editor.buildOrganizedContent(input, ["Economy.Shop"], curlySorted)).toBeNull();
    });

    // A bare folder-module name is the one dotted content the swallowed
    // definition stopped classifying as an import, so the line was skipped and
    // the path went unrecorded - and a writer asked for Features added a second
    // copy of an import the line was already making.
    it("does not write a second copy of a bare path a dotted statement provides beside a definition", () => {
        const input = ["using. Features; MyVal := 5", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Features"], curlySorted)).toBeNull();
    });

    it("leaves a line that writes a definition after its bare dotted import alone", () => {
        const input = ["using. Features; MyVal := 5", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    // A module whose name merely ends in those five letters writes one
    // statement, and organizing has to keep treating it as one. Counted by
    // every occurrence of `using`, this line reads as two, and the file stops
    // being organized at all - the import is left where it sits, splitting the
    // block in two.
    it("organizes an import whose path holds the word using", () => {
        const input = ["using { /Verse.org/Simulation }", "using { Housing.Data }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /Verse.org/Simulation }", "using { Housing.Data }", "", "code()"].join("\n"));
    });

    // The anchored line ends up below the rebuilt block, so dropping the copy
    // above it can leave a `using` without the import that brings its first
    // segment into scope - the ordering #91 and #129 fixed. Only an absolute
    // path needs nothing above it, so the duplicate is kept in any file that
    // holds a bare or dotted import anywhere.
    it("keeps a duplicate when a dotted import could resolve against it", () => {
        const input = ["using { /A } <#> note", "    body", "using { /A }", "using { Economy.Shop }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "", "using { /A } <#> note", "    body", "using { Economy.Shop }", "code()"].join("\n"));
    });

    it("keeps a duplicate of a bare anchored path when its dotted consumer is in the block", () => {
        const input = ["using { Features }", "using { Economy.Shop }", "using { Features } <#> note", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { Features }", "using { Economy.Shop }", "", "using { Features } <#> note", "    body", "code()"].join("\n"));
    });

    it("keeps a duplicate when the consumer is itself anchored above the provider", () => {
        const input = ["using { Features }", "using { Economy.Shop } <#> note", "    body", "using { Features } <#> other", "    other body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { Features }", "", "using { Economy.Shop } <#> note", "    body", "using { Features } <#> other", "    other body", "code()"].join("\n"),
        );
    });

    // A `using` sharing a line with comment trivia is invisible to the whole
    // scanner, so the file is outside its contract either way - but the drop
    // must not be what turns that into a deleted provider.
    it("keeps a duplicate when a using behind comment trivia could resolve against it", () => {
        const input = ["<# note #> using { Economy.Shop }", "using { /A }", "using { /A } <#> anchor", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "", "<# note #> using { Economy.Shop }", "using { /A } <#> anchor", "    body", "code()"].join("\n"));
    });

    // The same miss, made by a string literal rather than by comment trivia: a
    // bare `#` inside one is content, so the `using` after it is live code the
    // guard has to see.
    it("keeps a duplicate when a using behind a string literal could resolve against it", () => {
        const input = ['X := "a#b"; using { Economy.Shop }', "using { /A }", "using { /A } <#> anchor", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "", 'X := "a#b"; using { Economy.Shop }', "using { /A } <#> anchor", "    body", "code()"].join("\n"));
    });

    // scanModuleImports skips indented lines, so a module-body `using` is
    // invisible to it - a guard reading only the scanned imports would drop the
    // provider and leave this file with its consumer above it.
    it("keeps a duplicate when only a module-body dotted import could resolve against it", () => {
        const input = ["using { /A }", "MyModule := module:", "    using { Economy.Shop }", "using { /A } <#> note", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { /A }", "", "MyModule := module:", "    using { Economy.Shop }", "using { /A } <#> note", "    body", "code()"].join("\n"),
        );
    });

    // A bare `using` in a module body is a module import too, and only the
    // enclosing construct says so. Classifying it by indentation read this file
    // as import-free above the anchored line and deleted the provider.
    it("keeps a duplicate when only a module-body bare import could resolve against it", () => {
        const input = ["using { /A }", "MyModule := module:", "    using { Features }", "using { /A } <#> note", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { /A }", "", "MyModule := module:", "    using { Features }", "using { /A } <#> note", "    body", "code()"].join("\n"),
        );
    });

    it("keeps a duplicate when a module-body bare import is written as an indented pair", () => {
        const input = ["using { /A }", "MyModule := module:", "    using:", "        Features", "using { /A } <#> note", "    body", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { /A }", "", "MyModule := module:", "    using:", "        Features", "using { /A } <#> note", "    body", "code()"].join("\n"),
        );
    });

    // A bare path is not absolute either, so it is never the one withheld.
    it("keeps a duplicate of a bare anchored path even when every other import is absolute", () => {
        const input = ["using { Features } <#> note", "    body", "using { Features }", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "using { Features }", "", "using { Features } <#> note", "    body", "code()"].join("\n"));
    });

    // Telling a module body from a function body needs the enclosing construct,
    // and guessing wrong deletes a provider, so a local-scope using counts
    // against withholding too rather than being classified.
    it("keeps a duplicate when a function body holds a local-scope using", () => {
        const input = ["using { /A } <#> note", "    body", "using { /A }", "F():void =", "    using { LocalVar }", "    code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "", "using { /A } <#> note", "    body", "F():void =", "    using { LocalVar }", "    code()"].join("\n"));
    });

    // A commented-out import is not in scope, so it does not block withholding.
    it("drops a duplicate when the only non-absolute import is commented out", () => {
        const input = ["using { /A } <#> note", "    using { Economy.Shop }", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } <#> note", "    using { Economy.Shop }", "code()"].join("\n"));
    });

    // The dropped statement's own comments go with it. They annotate a
    // statement that no longer exists, and leaving them behind would strand
    // them above whatever code now follows.
    it("drops the comments written for a duplicate along with the duplicate", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "# needed for the timer", "using { /A } # and here too", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n"));
    });

    it("drops a whole comment run written for a duplicate, not just its last line", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "# the first line", "# the second line", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n"));
    });

    it("keeps an anchored indented pair intact instead of normalizing it to one line", () => {
        const input = ["using:", "    /A <# disabled below", "using { /Old/Path }", "#>", "using { /B }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using:", "    /A <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n"));
    });

    // A `<#>` marker is the same hazard with a different marker: its body is
    // the lines below it indented past it, so a rebuild that moves the line
    // strands that body as indented lines at file scope, where the file stops
    // parsing.
    it("leaves an import whose line carries an indented comment marker where it is", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "using { /B }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /B }", "", "using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n"));
    });

    it("returns null when the only import carries an indented comment marker", () => {
        const input = ["using { /A } <#> why this is here", "    it brings the module into scope", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    // The block is rebuilt above every pinned line, so hoisting a path a pinned
    // import brings into scope puts the consumer above its provider and the
    // file stops compiling. Both pin reasons reach it, so both are pinned here.
    describe("hoisting past an import pinned to its line", () => {
        it("leaves a dotted consumer below the pinned import opening a block comment over it", () => {
            const input = ["using { Features } <# note", "using { Old }", "#>", "using { Economy.Other }", "", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
        });

        // An absolute import exposes the public member modules of what it
        // imports under their bare names, so a bare reference below one can be
        // resolving through it.
        it("leaves a bare consumer below the pinned import carrying an indented comment marker", () => {
            const input = ["using { /A } <#> pinned", "    note", "using { Features }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
        });

        // The other pin reason: a `;` puts two statements on one span, so the
        // line may not be rebuilt from any one path.
        it("leaves a dotted consumer below the pinned import sharing its span with another statement", () => {
            const input = ["using { Features }; using:", "    Economy.Shop", "using { Economy.Other }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
        });

        // An added path has no line of its own to keep, so it is written below
        // the statement that constrains it - past the body of the comment that
        // pins it, which is where the marker's own body ends.
        it("writes an added consumer below the pinned provider instead of into the block", () => {
            const input = ["using { Features } <#> note", "    body", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, ["Economy.Other"], curlySorted)).toBe(["using { Features } <#> note", "    body", "using { Economy.Other }", "code()"].join("\n"));
        });

        // A pinned dotted import is a possible provider like any other: it can
        // bring the added path's first segment into scope. This call names no
        // diagnostic, so nothing shows it is the consumer instead, and the
        // added path stays below it.
        it("writes an added bare consumer below a pinned dotted import", () => {
            const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted)).toBe(["using { Economy.Shop } <#> note", "    body", "using { Features }", "code()"].join("\n"));
        });

        // The same file and the same added path as the test above, differing
        // only in the compiler having reported the failure on the pinned line -
        // which is the whole rule. Organizing is fed the paths the compiler
        // currently reports as missing, so it can be told which pinned import
        // is the consumer, and the provider a consumer needs goes above it.
        // Written below, the diagnostic that asked for it survives the edit.
        it("writes an added bare provider above a pinned dotted import the diagnostic reports on", () => {
            const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 0, character: 0 }]]]))).toBe(
                ["using { Features }", "", "using { Economy.Shop } <#> note", "    body", "code()"].join("\n"),
            );
        });

        // The evidence is read against the pinned import's own span, so a
        // diagnostic elsewhere in the file leaves the written order alone. A
        // pinned dotted import that already resolves is the common case - the
        // file compiled before the edit.
        it("leaves an added bare consumer below a pinned dotted import when the diagnostic points elsewhere", () => {
            const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 2, character: 0 }]]]))).toBe(
                ["using { Economy.Shop } <#> note", "    body", "using { Features }", "code()"].join("\n"),
            );
        });

        // The diagnostic is on the pinned line but at column 24, inside
        // `MyVal := 5` - the compiler reporting on the definition sharing the
        // line, not on the clause. Read line-wide, that evidence hoisted the
        // provider above the import that may bring its first segment into
        // scope, and a compiling file stopped compiling.
        it("leaves an added bare consumer below a pinned import when the diagnostic is about the statement beside it", () => {
            const input = ["using { Economy.Shop }; MyVal := 5", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 0, character: 24 }]]]))).toBe(
                ["using { Economy.Shop }; MyVal := 5", "using { Features }", "code()"].join("\n"),
            );
        });

        // The same line with the diagnostic inside the clause itself - the
        // narrowing must not cost the override its reach on a shared line.
        it("still writes the provider above a shared-line consumer the diagnostic reports inside", () => {
            const input = ["using { Economy.Shop }; MyVal := 5", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 0, character: 8 }]]]))).toBe(
                ["using { Features }", "", "using { Economy.Shop }; MyVal := 5", "code()"].join("\n"),
            );
        });

        // The diagnostic is on the pinned pair's opener line but at column 0,
        // inside `X := 1` - the compiler reporting on the definition, not on
        // the pair whose `using:` starts at column 8. Read span-wide, that
        // evidence hoisted the provider above the import that may bring its
        // first segment into scope, and a compiling file stopped compiling.
        it("leaves an added bare consumer below a pinned pair when the diagnostic is about the statement beside its opener", () => {
            const input = ["X := 1; using:", "    Economy.Shop", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 0, character: 0 }]]]))).toBe(
                ["X := 1; using:", "    Economy.Shop", "using { Features }", "code()"].join("\n"),
            );
        });

        // The same file with the diagnostic inside the `using:` opener itself -
        // the narrowing must not cost the override its reach on a pair.
        it("still writes the provider above a pinned pair the diagnostic reports on its opener", () => {
            const input = ["X := 1; using:", "    Economy.Shop", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 0, character: 8 }]]]))).toBe(
                ["using { Features }", "", "X := 1; using:", "    Economy.Shop", "code()"].join("\n"),
            );
        });

        // The path ends at column 16 and the span is half-open, so evidence
        // starting exactly there is past the pair, not inside it.
        it("takes no override from a diagnostic starting exactly at the end of a pair's path", () => {
            const input = ["X := 1; using:", "    Economy.Shop", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 1, character: 16 }]]]))).toBe(
                ["X := 1; using:", "    Economy.Shop", "using { Features }", "code()"].join("\n"),
            );
        });

        // A comment line inside the pair counts whole: it belongs to the
        // clause and holds no other statement for the evidence to be about.
        it("still writes the provider above a pair the diagnostic reports on a comment line inside it", () => {
            const input = ["X := 1; using:", "    # note", "    Economy.Shop", "code()"].join("\n");

            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted, new Map([["Features", [{ line: 1, character: 4 }]]]))).toBe(
                ["using { Features }", "", "X := 1; using:", "    # note", "    Economy.Shop", "code()"].join("\n"),
            );
        });

        // Only the paths the pinned import could provide are held back. An
        // absolute path needs nothing in scope, so the file is still organized
        // around what stays.
        it("still hoists the absolute imports past a pinned bare provider", () => {
            const input = ["using { Features } <#> note", "    body", "using { Economy.Other }", "using { /Zebra }", "using { /Apple }", "code()"].join("\n");
            const organized = ["using { /Apple }", "using { /Zebra }", "", "using { Features } <#> note", "    body", "using { Economy.Other }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(organized);
            expect(editor.buildOrganizedContent(organized, [], curlySorted)).toBe(organized);
        });

        // Hoisting only carries an import across the pinned lines above it, so
        // one already written above them all is sorted as it always was. Held
        // back on the presence of a pinned import rather than on crossing it,
        // this file would go untidied.
        it("still sorts the imports written above the pinned line", () => {
            const input = ["using { Features }", "using { /Zebra }", "using { /A }; X := 1", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /Zebra }", "using { Features }", "", "using { /A }; X := 1", "code()"].join("\n"));
        });

        // A stale diagnostic naming a path the buffer already imports is the
        // ordinary case, and what lands below a pinned line is compared against
        // nothing once it is out of the block.
        it("does not write an additional path the file already imports below a pinned line", () => {
            const input = ["using { Features }", "using { /A }; X := 1", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, ["Features"], curlySorted)).toBe(["using { Features }", "", "using { /A }; X := 1", "code()"].join("\n"));
        });

        it("writes a repeated additional path below the pinned provider once", () => {
            const input = ["using { Features } <#> note", "    body", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, ["Economy.Other", "Economy.Other"], curlySorted)).toBe(
                ["using { Features } <#> note", "    body", "using { Economy.Other }", "code()"].join("\n"),
            );
        });

        // The control for the cases above: written order survives because the
        // sort keeps it, not because a pinned line held anything back.
        it("keeps a dotted import above the bare one below it when no import is pinned", () => {
            const input = ["using { Economy.Other }", "using { Features }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { Economy.Other }", "using { Features }", "", "code()"].join("\n"));
        });
    });

    // Excluding an import with an ordinary trailing comment from rewriting
    // would stop it being sorted at all, so the comment travels through the
    // rebuild instead.
    it("keeps the comment trailing an import when the block is rebuilt around it", () => {
        const input = ["using { /Zebra } # network only", "using { /Apple }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /Apple }", "using { /Zebra } # network only", "", "code()"].join("\n"));
    });

    it("keeps the trailing comment of an import written in any of the three styles", () => {
        expect(editor.buildOrganizedContent("using { /B } # braced\nusing { /A }\ncode()", [], curlySorted)).toBe(["using { /A }", "using { /B } # braced", "", "code()"].join("\n"));
        expect(editor.buildOrganizedContent("using. /B # dotted\nusing { /A }\ncode()", [], curlySorted)).toBe(["using { /A }", "using { /B } # dotted", "", "code()"].join("\n"));
        expect(editor.buildOrganizedContent("using:\n    /B # indented\nusing { /A }\ncode()", [], curlySorted)).toBe(["using { /A }", "using { /B } # indented", "", "code()"].join("\n"));
    });

    it("keeps a trailing block comment that closes on its own line", () => {
        const input = ["using { /Zebra } <# network only #>", "using { /Apple }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /Apple }", "using { /Zebra } <# network only #>", "", "code()"].join("\n"));
    });

    it("reproduces a document whose imports carry trailing comments, so organize can skip the edit", () => {
        const input = ["using { /Apple }", "using { /Zebra } # network only", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps the trailing comment with its own import when another is added above it", () => {
        const input = ["using { /Zebra } # network only", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/Apple"], curlySorted)).toBe(["using { /Apple }", "using { /Zebra } # network only", "", "code()"].join("\n"));
    });

    it("keeps both comments when a duplicated path is deduplicated to one statement", () => {
        // Dropping either would delete text the author wrote, and a `#` comment
        // runs to the end of the line, so the pair still reads as one comment.
        const input = ["using { /A } # first", "using { /A } # second", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A } # first # second", "", "code()"].join("\n"));
    });

    // Restoring trailing text is what makes an unbalanced opener dangerous
    // wherever it sits. On the last line of a buffer it swallowed nothing while
    // a rebuild discarded it; carried through the rebuild and sorted upward, it
    // swallows every import written below it.
    it("does not sort an unclosed block opener up over the imports it would swallow", () => {
        const input = ["using { /Zebra }", "using { /Apple } <#"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /Zebra }", "", "using { /Apple } <#"].join("\n"));
    });

    it("does not write a newly added import under an unclosed opener that ends the buffer", () => {
        const input = ["code()", "using { /A } <#"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["using { /B }", "", "code()", "using { /A } <#"].join("\n"));
    });

    // A rebuild that emits the import block at line 0 and everything else
    // under it moves the file's header into the middle of the file and tears
    // an explanatory comment off the import it explains. Both are text the
    // author placed deliberately, and organize is not asked to move either.
    it("keeps a file header comment above the rebuilt import block", () => {
        const input = "# Copyright 2026 MyGame\n# Licensed MIT\n\nusing { /Verse.org/Simulation }\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps a comment written directly above the only import attached to it", () => {
        const input = "# Devices for the shop\nusing { /Fortnite.com/Devices }\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps the header above a block it also sorts", () => {
        const input = "# Copyright 2026 MyGame\n\nusing { /Zebra }\nusing { /Apple }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("# Copyright 2026 MyGame\n\nusing { /Apple }\nusing { /Zebra }\n\ncode()");
    });

    it("keeps a comment above the interior import it annotates", () => {
        const input = ["using { /Apple }", "# talks to the shop service", "using { /Zebra }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps a comment attached to its import when that import sorts upward", () => {
        const input = ["using { /Zebra }", "# talks to the shop service", "using { /Apple }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["# talks to the shop service", "using { /Apple }", "using { /Zebra }", "", "code()"].join("\n"));
    });

    it("hoists a comment along with the import it annotates from below the code", () => {
        const input = ["code_before()", "# needed for the timer", "using { /A }", "code_after()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe(["# needed for the timer", "using { /A }", "", "code_before()", "code_after()"].join("\n"));
    });

    it("leaves a comment separated from an import by a blank line in the body", () => {
        const input = ["using { /A }", "# loose note about what follows", "", "using { /B }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "using { /B }", "", "# loose note about what follows", "", "code()"].join("\n"));
    });

    // Moving part of a `<# ... #>` region would leave its opener behind to
    // swallow whatever followed it, so an attached block comment travels whole
    // or not at all.
    it("moves a whole block comment with the import below it", () => {
        const input = ["using { /B }", "<# why /A is needed", "the long version #>", "using { /A }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["<# why /A is needed", "the long version #>", "using { /A }", "using { /B }", "", "code()"].join("\n"));
    });

    // Line 0 is ambiguous: a file header and an annotation of the first import
    // are written identically. It is read as a header, which leaves the
    // comment exactly where the author put it. Reading it as an annotation
    // instead would carry a licence down into the middle of the block when the
    // import under it sorts away, which is the defect being fixed here.
    it("treats a comment on line 0 as the header, not as the first import's annotation", () => {
        const input = ["# devices for the shop", "using { /Fortnite.com/Devices }", "using { /Fortnite.com/Characters }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["# devices for the shop", "using { /Fortnite.com/Characters }", "using { /Fortnite.com/Devices }", "", "code()"].join("\n"));
    });

    it("attaches a comment below the header to its own import", () => {
        const input = ["# Copyright 2026 MyGame", "", "using { /Fortnite.com/Characters }", "# devices for the shop", "using { /Fortnite.com/Devices }", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    // The body of a `<#>` marker is every line below it indented past it, so
    // rebuilding the block between the marker and its body would empty the
    // comment and strand its text as indented lines at file scope.
    it("never splits an indented comment from its marker", () => {
        const input = ["<#> Copyright 2026 MyGame", "    all rights reserved", "using { /B }", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["<#> Copyright 2026 MyGame", "    all rights reserved", "using { /A }", "using { /B }", "", "code()"].join("\n"));
    });

    it("keeps an indented comment header above the block when a blank line follows it", () => {
        const input = ["<#> Copyright 2026 MyGame", "    all rights reserved", "", "using { /B }", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["<#> Copyright 2026 MyGame", "    all rights reserved", "", "using { /A }", "using { /B }", "", "code()"].join("\n"));
    });

    it("leaves an indented comment whole when a blank line inside it breaks the run above an import", () => {
        const input = ["<#> Notes", "    the first paragraph", "", "    the second paragraph", "using { /A }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["<#> Notes", "    the first paragraph", "", "    the second paragraph", "using { /A }", "", "code()"].join("\n"));
    });

    it("does not keep a leading run of blank lines as a header", () => {
        expect(editor.buildOrganizedContent("\n\nusing { /A }\ncode()", [], curlySorted)).toBe("using { /A }\n\ncode()");
        expect(editor.buildOrganizedContent("", ["/A"], curlySorted)).toBe("using { /A }\n");
    });

    it("keeps a CRLF header above the rebuilt block", () => {
        const input = "# Copyright 2026 MyGame\r\n\r\nusing { /B }\r\nusing { /A }\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("# Copyright 2026 MyGame\r\n\r\nusing { /A }\r\nusing { /B }\r\n\r\ncode()\r\n");
    });

    it("puts an added path into the block under the header rather than above it", () => {
        const input = "# Copyright 2026 MyGame\n\nusing { /Existing }\n\ncode()";
        expect(editor.buildOrganizedContent(input, ["/Added"], curlySorted)).toBe("# Copyright 2026 MyGame\n\nusing { /Added }\nusing { /Existing }\n\ncode()");
    });

    // A file opening with an opener that never closes is comment to its last
    // line, so the header ran to the end of the buffer and the added import was
    // written past it - inside the comment, where the scan cannot see it and
    // the next compile adds it again. The floor never gets a say here: nothing
    // is pinned, which is what separates this from the shape #454 covered.
    it("writes an added path above an unclosed opener that opens the file", () => {
        const input = ["<# note", "still note"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["using { /B }", "", "<# note", "still note"].join("\n"));
    });

    it("writes an added relative path above an unclosed opener that opens the file", () => {
        const input = ["<# note", "still note"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Gadgets.Tools"], curlySorted)).toBe(["using { Gadgets.Tools }", "", "<# note", "still note"].join("\n"));
    });

    // Only the run the opener swallowed stops being header. A licence closed
    // above it is still one, and starting from line 0 instead would write the
    // import above it.
    it("keeps a closed header above the import when an unclosed opener follows it", () => {
        const input = ["# Copyright 2026 MyGame", "<# unclosed", "more"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["# Copyright 2026 MyGame", "using { /B }", "", "<# unclosed", "more"].join("\n"));
    });

    it("steps back only to the opener that never closes, not to one that did", () => {
        const input = ["<# a", "b #>", "<# unclosed"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["<# a", "b #>", "using { /B }", "", "<# unclosed"].join("\n"));
    });

    // Reaching the end of the buffer is not itself the fault - a closed comment
    // leaves a writable line below it. The guard keys on the comment still
    // being open, so neither of these moves.
    it("still writes below a header of entirely closed comment", () => {
        const input = ["<# note #>", "# more"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["<# note #>", "# more", "using { /B }", ""].join("\n"));
    });

    // A `<#>` marker raises no block-comment depth, and a column-0 line ends
    // the indented block its body sits in, so the line below the body is real
    // code and the import belongs there.
    it("still writes below an indented comment whose body ends the buffer", () => {
        const input = ["<#> note", "    body"].join("\n");
        expect(editor.buildOrganizedContent(input, ["/B"], curlySorted)).toBe(["<#> note", "    body", "using { /B }", ""].join("\n"));
    });

    it("writes the preferred dot syntax", () => {
        const input = "using { /A }\ncode()";
        expect(
            editor.buildOrganizedContent(input, [], {
                ...curlyNoSort,
                preferDotSyntax: true,
            }),
        ).toBe("using. /A\n\ncode()");
    });

    it("normalizes the indented using: pair into a single-line import", () => {
        const input = "using:\n    /A\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("hoists an import scattered below code up into the block", () => {
        const input = "code_before()\nusing { /A }\ncode_after()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode_before()\ncode_after()");
    });

    it("merges additional paths with existing imports, deduped and sorted", () => {
        const input = "using { /Existing }\ncode()";
        expect(editor.buildOrganizedContent(input, ["/Added", "/Existing"], curlySorted)).toBe("using { /Added }\nusing { /Existing }\n\ncode()");
    });

    it("adds imports to a document that had none", () => {
        expect(editor.buildOrganizedContent("code()", ["/New"], curlyNoSort)).toBe("using { /New }\n\ncode()");
    });

    it("hoists a bare column-0 using into the block as a module import", () => {
        // A bare `using { X }` at column 0 can only be a module import (see
        // ImportScanner's header comment), so it is collected like any other
        // import rather than left in the body.
        const input = "using { /A }\nusing { Features }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\nusing { Features }\n\ncode()");
    });

    it("leaves a function-body local-scope using statement in the body", () => {
        const input = ["using { /A }", "F():void =", "    using { LocalVar }", "    code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe(["using { /A }", "", "F():void =", "    using { LocalVar }", "    code()"].join("\n"));
    });

    it("collapses extra blank lines left by removed top imports", () => {
        const input = "using { /A }\n\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("returns only the import block when the file is nothing but imports", () => {
        const input = "using { /B }\nusing { /A }";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /A }\nusing { /B }\n");
    });

    it("ignores blank additional paths", () => {
        const input = "using { /A }\ncode()";
        expect(editor.buildOrganizedContent(input, ["", "   "], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("keeps every relative import in input order, dotted and bare alike, never alphabetized", () => {
        const input = ["using { Economy.Shop }", "using { Zeta }", "using { Alpha }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { Economy.Shop }", "using { Zeta }", "using { Alpha }", "", "code()"].join("\n"));
    });

    // An added path has no written position of its own, and every import the
    // file already holds may be bringing its first segment into scope, so it
    // goes below all of them rather than wherever a name would put it.
    it("writes an additional relative path below the relative imports the file already holds", () => {
        const input = ["using { Economy.Shop }", "using { Zeta }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, ["Features"], curlySorted)).toBe(["using { Economy.Shop }", "using { Zeta }", "using { Features }", "", "code()"].join("\n"));
    });

    it("leaves a module-scoped using inside its module body", () => {
        const input = ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n"),
        );
    });

    // A CRLF document must come back CRLF throughout: joining with LF left the
    // body lines carrying their original "\r" and produced a mixed buffer.
    it("keeps CRLF endings when reorganizing a CRLF document", () => {
        const input = "using { /B }\r\nusing { /A }\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /A }\r\nusing { /B }\r\n\r\ncode()\r\n");
    });

    it("reproduces an already organized CRLF document exactly, so organize can skip the edit", () => {
        const input = "using { /A }\r\n\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps CRLF endings when adding a path to a CRLF document", () => {
        const input = "using { /Existing }\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, ["/Added"], curlySorted)).toBe("using { /Added }\r\nusing { /Existing }\r\n\r\ncode()\r\n");
    });

    it("keeps CRLF endings for a CRLF file that is nothing but imports", () => {
        expect(editor.buildOrganizedContent("using { /B }\r\nusing { /A }", [], curlySorted)).toBe("using { /A }\r\nusing { /B }\r\n");
    });

    it("uses the fallback ending when the text has no line break to detect one from", () => {
        expect(editor.buildOrganizedContent("code()", ["/New"], { ...curlyNoSort, fallbackEol: "\r\n" })).toBe("using { /New }\r\n\r\ncode()");
    });

    it("still writes LF for an LF document even when the fallback is CRLF", () => {
        expect(editor.buildOrganizedContent("using { /A }\ncode()", [], { ...curlyNoSort, fallbackEol: "\r\n" })).toBe("using { /A }\n\ncode()");
    });

    // A `Name := import(/Path)` alias is a definition, not an import, so it
    // belongs to the body and the block is rebuilt around it. Which is where it
    // ends up regardless - these pin it as a decision rather than an accident.
    describe("a file declaring module aliases", () => {
        it("leaves an alias between two imports in the body, written as it was", () => {
            const input = ["using { /Verse.org/Simulation }", "Utils := import(/MyGame/Utilities)", "using { /Fortnite.com/Devices }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
                ["using { /Fortnite.com/Devices }", "using { /Verse.org/Simulation }", "", "Utils := import(/MyGame/Utilities)", "code()"].join("\n"),
            );
        });

        it("keeps the comment written above an alias with the alias", () => {
            const input = ["using { /A }", "", "# what Utils is for", "Utils := import(/MyGame/Utilities)", "using { /B }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { /A }", "using { /B }", "", "# what Utils is for", "Utils := import(/MyGame/Utilities)", "code()"].join("\n"));
        });

        // An alias binds one name to one module and brings none of its members
        // into scope, so the file still needs the `using` and a diagnostic
        // asking for one is right to. Reading the alias as evidence the path is
        // imported is what would decline it.
        it("adds an import of a path the file only aliases", () => {
            const input = ["Utils := import(/MyGame/Utilities)", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, ["/MyGame/Utilities"], curlySorted)).toBe(["using { /MyGame/Utilities }", "", "Utils := import(/MyGame/Utilities)", "code()"].join("\n"));
        });

        // The combined form the book writes: the alias for qualified access,
        // the `using` for unqualified. Hoisting the `using` above the alias is
        // safe - the compiler binds every alias in its own deferred stage,
        // ahead of the one that resolves module `using` statements - so the
        // only requirement is that both survive.
        it("hoists a using of an alias above the alias without touching either", () => {
            const input = ["Graphics := import(/MyGame/Systems/Graphics)", "using { Graphics }", "code()"].join("\n");
            expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { Graphics }", "", "Graphics := import(/MyGame/Systems/Graphics)", "code()"].join("\n"));
        });
    });
});

interface RecordedOperation {
    kind: "insert" | "delete" | "replace";
    position?: { line: number; character: number };
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    text?: string;
}

function fakeDocument(text: string, eol: number = vscode.EndOfLine.LF): vscode.TextDocument {
    const lines = text.split(/\r?\n/);
    return {
        uri: { toString: () => "file:///test.verse" },
        getText: () => text,
        eol,
        lineCount: lines.length,
        lineAt: (index: number) => ({ range: { end: new vscode.Position(index, lines[index].length) } }),
    } as unknown as vscode.TextDocument;
}

function appliedOperations(call: number): RecordedOperation[] {
    const applyEditMock = vscode.workspace.applyEdit as unknown as jest.Mock;
    const edit = applyEditMock.mock.calls[call][0] as { operations: RecordedOperation[] };
    return edit.operations;
}

/**
 * The document text the recorded edit produces: every operation of one
 * applyEdit call replayed onto `input`. Ranges are coordinates in `input`, as
 * a WorkspaceEdit's are, so ops apply back-to-front; ties keep recorded order,
 * with an insertion at the start of a replaced range landing first, as VS Code
 * applies them.
 */
const appliedText = (input: string, call = 0): string => {
    const lineStarts = [0];
    for (let i = 0; i < input.length; i++) {
        if (input[i] === "\n") {
            lineStarts.push(i + 1);
        }
    }
    const offsetAt = (position: { line: number; character: number }): number => {
        const lineStart = lineStarts[Math.min(position.line, lineStarts.length - 1)];
        return Math.min(lineStart + position.character, input.length);
    };
    const spans = appliedOperations(call).map((op, index) => {
        if (op.kind === "insert") {
            const offset = offsetAt(op.position!);
            return { start: offset, end: offset, text: op.text ?? "", index };
        }
        return { start: offsetAt(op.range!.start), end: offsetAt(op.range!.end), text: op.kind === "replace" ? (op.text ?? "") : "", index };
    });
    spans.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    let result = input;
    for (let i = spans.length - 1; i >= 0; i--) {
        result = result.slice(0, spans[i].start) + spans[i].text + result.slice(spans[i].end);
    }
    return result;
};

describe("ImportDocumentEditor.addImportsToDocument", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    /**
     * The diagnostic-position argument addImportsToDocument takes, for one
     * statement the compiler reported at one position.
     *
     * A pinned import is read as the consumer of a new import only where a
     * diagnostic lands inside its own statement, so a call that omits this is
     * exercising the no-evidence path and expects the written order to hold.
     *
     * Character 0 is the head of the line: inside a clause that heads its
     * line, outside one written after a `;`.
     */
    const reportedOn = (statement: string, line: number, character = 0): ReadonlyMap<string, readonly { line: number; character: number }[]> => new Map([[statement, [{ line, character }]]]);

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        applyEditMock().mockClear();
    });

    it("consolidates an indented-style pair without losing its path or orphaning its line", async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.preserveImportLocations") {
                    return false;
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
        const input = ["using:", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\n\nhello := 1");
    });

    it("recognizes an import that already exists as an indented pair and makes no edit", async () => {
        const input = ["using:", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    // The pair's path is the first line of code below the opener, so a blank
    // line inside the pair does not end it. Scanned as the line directly below
    // the opener the import was invisible, and the file ended up importing the
    // same path twice.
    it("recognizes an import an indented pair provides across a blank line", async () => {
        const input = ["using:", "", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("recognizes an import an indented pair provides across a comment", async () => {
        const input = ["using:", "    # the path below", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    // The reported symptom. The braced classification needs the closing brace on
    // the line it reads, so the scan saw no import here at all: the path counted
    // as absent and the file ended up importing the same module twice.
    it("recognizes an import a braced clause provides across lines", async () => {
        const input = ["using{", "    /Verse.org/Simulation", "}", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("recognizes an import a braced clause opening on the line below provides", async () => {
        const input = ["using", "{", "    /Verse.org/Simulation", "}", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    // The commented-out copy stays inert and the live one is added anyway. It
    // goes below the comment rather than above it: the comment opens the file,
    // so it is the header, which is the same reading buildOrganizedContent
    // makes of this shape.
    it("adds an import that exists only inside a block comment, below the comment", async () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "my_device := class(creative_device):", "    Button : button_device = button_device{}"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe(
            "<#\nusing { /Fortnite.com/Devices }\n#>\n\nusing { /Fortnite.com/Devices }\n\nmy_device := class(creative_device):\n    Button : button_device = button_device{}",
        );
    });

    it("adds a new import without rebuilding an import line that opens a block comment", async () => {
        // Merging into that line would rewrite it from its path alone and drop
        // the `<#`, making the disabled import below it live again.
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\n\nusing { /A } <# disabled below\nusing { /Old/Path }\n#>\n\ncode()");
    });

    it("still counts an import whose line opens a block comment as already present", async () => {
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /A }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("dedupes a bare folder import that already exists at column 0 and makes no edit", async () => {
        const input = ["using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    // The scan rejected the line for not opening with `using`, so the path read
    // as absent and this wrote a second copy of an import the file already made.
    it("counts a using written after a definition on its line as already present", async () => {
        const input = ["X := 1; using { /Verse.org/Random }", "", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Random }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    // The same rejection, reaching the path through the pair the line opens
    // rather than through a complete statement on it.
    it("counts the path below a using: opened after a definition as already present", async () => {
        const input = ["X := 1; using:", "    /Verse.org/Random", "", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Random }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("leaves a module-scoped using inside its module body during consolidation", async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.preserveImportLocations") {
                    return false;
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
        const input = ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { /Top }\n\nUtilities := module:\n    using { /Verse.org/Random }\n\n    GenerateId<public>():int = 1");
    });

    // The auto-import path, which users reach without invoking a command. It
    // rebuilds a block through createBlockReplacementEdit rather than through
    // buildOrganizedContent, and reads trailing comments off that block alone.
    it("keeps the comment trailing an existing import when a new one joins its block", async () => {
        const input = ["using { /Zebra } # network only", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Apple }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Apple }\nusing { /Zebra } # network only\n\nhello := 1");
    });

    it("keeps that comment when consolidating every import at the top", async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.preserveImportLocations") {
                    return false;
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
        const input = ["using { /Zebra } # network only", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Apple }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Apple }\nusing { /Zebra } # network only\n\nhello := 1");
    });

    it("does not add an import under an unclosed opener that ends the buffer", async () => {
        // The opener is anchored, so the new import is written above it rather
        // than into the comment it would otherwise open over that import.
        const input = ["hello := 1", "using { /A } <#"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(true);
        // Pinned to the whole document rather than to "no `<#` above the new
        // import": that reading holds vacuously of an edit writing nothing.
        expect(appliedText(input)).toBe("using { /B }\n\nhello := 1\nusing { /A } <#");
    });

    // The same two shapes through the auto-import path, which reaches the floor
    // by a different route: placementLine rather than the grounded-extras
    // splice buildOrganizedContent uses.
    it("does not add a relative import into the body a pinned line opens", async () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Gadgets.Tools }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /A }; M := module:\n    Body<public>():int = 1\nusing { Gadgets.Tools }\n\ncode()");
    });

    it("does not add a relative import under an unclosed opener that ends the buffer", async () => {
        const input = ["hello := 1", "using { /A } <#"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Gadgets.Tools }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Gadgets.Tools }\n\nhello := 1\nusing { /A } <#");
    });

    it("adds it below a comment trailing the body a blank line separates from it", async () => {
        const input = ["using { /A }; M := module:", "    Body<public>():int = 1", "", "    # what the module is for", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Gadgets.Tools }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /A }; M := module:\n    Body<public>():int = 1\n\n    # what the module is for\nusing { Gadgets.Tools }\n\ncode()");
    });

    it("keeps the floor a pinned import above an unclosed opener raises", async () => {
        const input = ["using { Features }; X := 1", "code()", "using { /B } <# note"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features.Shop }"]);

        expect(success).toBe(true);
        // Below the provider that could be bringing `Features` into scope, not
        // at the top of the file: the unwritable span above the comment is
        // skipped on its own, and takes no other pinned import's floor with it.
        expect(appliedText(input)).toBe("using { Features }; X := 1\nusing { Features.Shop }\n\ncode()\nusing { /B } <# note");
    });

    function mockConfig(overrides: Record<string, unknown>): void {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key in overrides) {
                    return overrides[key];
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
    }

    it("preserve + digestFirst: replaces a single import block below a header in place, not at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe(
            "# Header comment line 1\n# Header comment line 2\n\nusing { /Fortnite.com/Devices }\nusing { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n\nhello := 1",
        );
    });

    it("preserve + localFirst: replaces a single import block below a header in place, not at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "localFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe(
            "# Header comment line 1\n# Header comment line 2\n\nusing { /Fortnite.com/Devices }\nusing { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n\nhello := 1",
        );
    });

    // Regrouping an ungrouped block writes the whole block, so localFirst gets
    // to move the digest import there. Below a relative import that may resolve
    // through it, the file stops compiling.
    it("preserve + localFirst: regrouping a block keeps the digest import above the relative ones", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "localFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("# Header comment line 1\n# Header comment line 2\n\nusing { /Verse.org/Simulation }\n\nusing { Economy.Shop }\nusing { Features }\n\nhello := 1");
    });

    // A file localFirst organized has two local blocks, one either side of the
    // digest one. A new absolute local import belongs in the upper one: sending
    // every local path to the last local block would put it below the digest
    // group the strategy exists to hoist it above.
    it("preserve + localFirst: a new absolute local import joins the block above the digest group, a relative one the block below", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "localFirst",
        });
        const input = ["using { /mygame@fortnite.com/mygame/Utils }", "", "using { /Verse.org/Simulation }", "", "using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /mygame@fortnite.com/mygame/Combat }", "using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe(
            "using { /mygame@fortnite.com/mygame/Combat }\nusing { /mygame@fortnite.com/mygame/Utils }\n\nusing { /Verse.org/Simulation }\n\nusing { Economy.Shop }\nusing { Features }\n\nhello := 1",
        );
    });

    it("preserve + digestFirst: a new bare local import lands after the dotted local import already in its block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "", "using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("# Header comment line 1\n# Header comment line 2\n\nusing { /Verse.org/Simulation }\n\nusing { Economy.Shop }\nusing { Features }\n\nhello := 1");
    });

    it("preserve + grouping none + sort on (default config): merges a new bare import into the existing block, below the import already there", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Economy.Shop }\nusing { Features }\n\nhello := 1");
    });

    it("preserve + grouping none + sort OFF: keeps the original append-after-block behavior and leaves existing lines untouched", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        // Appending after the block and merging into it write the same text
        // here, and the text is the observable contract.
        expect(appliedText(input)).toBe("using { Economy.Shop }\nusing { Features }\n\nhello := 1");
    });

    // A blank line between imports starts a second block, and rank-sorting only
    // the first block ordered a new import against that block alone - which put
    // a dotted consumer above the bare provider it needs in the block below.
    it("preserve + grouping none + sort on: a new dotted consumer joins the block holding its bare provider, not the first block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\n\nusing { Features }\nusing { Economy.Shop }\n\nhello := 1");
    });

    // The dotted import in the earlier block can be what brings the new import's
    // own name into scope, so the new one has no claim to be written above it.
    // Joining the earlier block would put it there.
    it("preserve + grouping none + sort on: a new bare import joins the last block, not the earlier one holding a dotted import", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { Economy.Shop }", "", "using { /Verse.org/Simulation }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Economy.Shop }\n\nusing { /Verse.org/Simulation }\nusing { Features }\n\nhello := 1");
    });

    it("preserve + grouping none + sort on: a new absolute import still joins the first block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n\nusing { /Fortnite.com/Devices }\n\nhello := 1");
    });

    it("preserve + grouping none + sort on: imports whose ranks want different blocks are merged into each block separately", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }", "using { Economy.Shop }"]);

        expect(success).toBe(true);
        // The absolute path joins the block of absolute paths, the dotted
        // reference the block holding its provider.
        expect(appliedText(input)).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n\nusing { Features }\nusing { Economy.Shop }\n\nhello := 1");
    });

    it("preserve + grouping none + sort OFF: appends after the last import block, not the first", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\n\nusing { Features }\nusing { Economy.Shop }\n\nhello := 1");
    });

    // Line 0 is the top of the file, not the top of the import block. Inserting
    // there because the block starts lower put the new import above the header
    // comment and left the file with two import regions that never merge.
    it("preserve + grouping none + sort OFF: appends after a block that opens below a header comment", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["# Copyright 2026 MyGame", "", "using { /Verse.org/Simulation }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("# Copyright 2026 MyGame\n\nusing { /Verse.org/Simulation }\nusing { Economy.Shop }\n\nhello := 1");
    });

    // A document with no trailing newline has no line below its last import for
    // the new one to occupy, so the new statement has to arrive carrying its own
    // line break - or the two of them end up spliced onto one unreadable line.
    it("preserve + grouping none + sort OFF: appends onto a block that ends the document", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["code()", "using { /A }"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("code()\nusing { /A }\nusing { /B }");
    });

    it("writes CRLF endings into a CRLF document when merging into an existing block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = "using { Economy.Shop }\r\n\r\nhello := 1\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { Features }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Economy.Shop }\r\nusing { Features }\r\n\r\nhello := 1\r\n");
    });

    it("writes CRLF endings into a CRLF document when inserting a new block at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = "hello := 1\r\nworld := 2\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Random }\r\n\r\nhello := 1\r\nworld := 2\r\n");
    });

    it("writes CRLF endings into a CRLF document when consolidating at the top", async () => {
        mockConfig({ "behavior.preserveImportLocations": false });
        const input = "using { /Verse.org/Simulation }\r\n\r\nhello := 1\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\r\nusing { /Verse.org/Simulation }\r\n\r\nhello := 1\r\n");
    });

    it("preserve + digestFirst: inserts at the top when the file has no existing imports", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = ["hello := 1", "world := 2"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Fortnite.com/Random }\n\nhello := 1\nworld := 2");
    });

    // The rule that a header stays above the block was held by the organize
    // path alone, so every add-path branch that writes at the top of a file
    // wrote at line 0. A file with a header and no import block reaches one of
    // these on every configuration, and the licence ended up in the middle of
    // the file.
    describe("adding to a headered file with no import block", () => {
        it("preserve + grouping none: writes the new import below the header", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["# Copyright 2026 MyGame", "", "hello := 1"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("# Copyright 2026 MyGame\n\nusing { /Fortnite.com/Devices }\n\nhello := 1");
        });

        // Grouping with no block of its own to regroup: the file's only import
        // is pinned, which is a block to no placement decision.
        it("preserve + digestFirst: writes below the header when the only import is pinned", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["# Copyright 2026 MyGame", "", "using { Economy.Shop } <#> note", "    body", "hello := 1"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("# Copyright 2026 MyGame\n\nusing { /Fortnite.com/Devices }\n\nusing { Economy.Shop } <#> note\n    body\nhello := 1");
        });

        it("consolidating: writes the consolidated block below the header", async () => {
            mockConfig({ "behavior.preserveImportLocations": false });
            const input = ["# Copyright 2026 MyGame", "", "using { /Verse.org/Simulation }", "", "hello := 1"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("# Copyright 2026 MyGame\n\nusing { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\n\nhello := 1");
        });

        // Every case above has code below the header. Where the header is an
        // opener that never closes it runs to the last line instead, and the
        // insert took insertImportLines' end-of-document branch - appending the
        // import after that line, inside the comment.
        it("writes above an opener that never closes, not past the last line", async () => {
            mockConfig({ "behavior.preserveImportLocations": true });
            const input = ["<# note", "still note"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /B }\n\n<# note\nstill note");
        });

        it("writes between a closed header and the unclosed opener below it", async () => {
            mockConfig({ "behavior.preserveImportLocations": true });
            const input = ["# Copyright 2026 MyGame", "<# unclosed", "more"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("# Copyright 2026 MyGame\nusing { /B }\n\n<# unclosed\nmore");
        });
    });

    // An import anchored by a comment marker belongs to no import block, so
    // every placement decision - all of which read the blocks - was blind to
    // it, and a new import could be written above the anchored import that
    // brings its first segment into scope. Verse resolves `using` sequentially,
    // so the "Unknown identifier" the import was added to fix survived it.
    describe("placement against an import anchored by a comment marker", () => {
        it("writes a new consumer below an anchored provider, past the indented comment it opens", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Features } <#> why this is here", "    it brings Economy into scope", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // Below the comment body, not between the marker and it: an import
            // at column 0 there both lands inside the comment and truncates the
            // rest of what the author wrote.
            expect(appliedText(input)).toBe("using { Features } <#> why this is here\n    it brings Economy into scope\nusing { Economy.Shop }\n\ncode()");
        });

        it("writes a new consumer below an anchored provider, past the block comment it leaves open", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Features } <# why this is here", "it brings Economy into scope", "#>", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features } <# why this is here\nit brings Economy into scope\n#>\nusing { Economy.Shop }\n\ncode()");
        });

        it("keeps a new consumer out of a block that sits above the anchored provider it needs", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // The block at line 0 would have taken it, above the provider.
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\n\nusing { Features } <#> note\n    body\nusing { Economy.Shop }\n\ncode()");
        });

        it("still merges a new consumer into a block that sits below the anchored provider", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Features } <#> note", "    body", "", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // Nothing forbids that block, so the ordinary merge still happens
            // rather than a standalone line.
            expect(appliedText(input)).toBe("using { Features } <#> note\n    body\n\nusing { /Verse.org/Simulation }\nusing { Economy.Shop }\ncode()");
        });

        it("writes a new provider above the anchored consumer that depends on it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop } <#> note", "    body", "", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0));

            expect(success).toBe(true);
            // Merging into the block below would put the provider under the
            // anchored consumer, which is the same breakage the other way up.
            expect(appliedText(input)).toBe("using { Features }\n\nusing { Economy.Shop } <#> note\n    body\n\nusing { /Verse.org/Simulation }\ncode()");
        });

        // The anchored consumer names the line the new import must stay above,
        // so it cannot also be read as an import the new one has to stay below.
        // Counted as both, its two bounds cross and every block is refused -
        // including this one, which lies wholly above the anchored line and
        // satisfies the bound that is real.
        it("merges into a block lying entirely above the anchored consumer rather than writing a standalone line", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 2));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\nusing { Features }\n\nusing { Economy.Shop } <#> note\n    body\ncode()");
        });

        it("sort OFF: appends below the anchored provider rather than after the last block", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": false,
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\n\nusing { Features } <#> note\n    body\nusing { Economy.Shop }\ncode()");
        });

        // The provider has to clear the anchored consumer, and an anchored
        // absolute path below that consumer says only that absolute paths are
        // written first. Honouring the preference over the requirement is how
        // the provider ended up under its consumer again, one bound further on.
        it("writes a new provider above the anchored consumer even when an anchored absolute path sits below it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop } <#> note", "    body", "using { /A } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features }\n\nusing { Economy.Shop } <#> note\n    body\nusing { /A } <#> note\n    body\ncode()");
        });

        // Directly above the statement that needs it, which is not the same
        // line as the top of the file - and only a fixture with something above
        // the anchored import can tell the two apart. Everything higher is
        // equally legal and strictly worse: it opens a third import region, and
        // at line 0 it puts the import above the file header.
        it("writes a new provider directly above the anchored consumer, not above the file header", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["# Copyright 2026 MyGame", "", "using { Economy.Shop } <#> note", "    body", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 2));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("# Copyright 2026 MyGame\n\nusing { Features }\n\nusing { Economy.Shop } <#> note\n    body\nusing { /Verse.org/Simulation }\ncode()");
        });

        // An anchored bare import does not constrain a new absolute one: an
        // absolute path needs nothing in scope, and a bare reference names a
        // module beside the file rather than anything an import provides. So
        // neither needs the other above it, and treating the rank order as a
        // requirement would refuse the block and fragment the file for nothing.
        it("still merges a new absolute import into a block below an anchored bare import", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Features } <#> why", "    body", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features } <#> why\n    body\nusing { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\ncode()");
        });

        it("digestFirst with two existing groups: keeps a new consumer out of the group above the anchored provider", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Other }", "", "using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // The local group at line 2 would have taken it, above the provider.
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\n\nusing { Other }\n\nusing { Features } <#> note\n    body\nusing { Economy.Shop }\ncode()");
        });

        // Two new paths of different ranks take their bounds from different
        // anchored imports, and one path's floor can sit below another's
        // ceiling. Written as one run under a merged bound there is no line the
        // group can legally occupy, and the consumer went above its provider.
        it("digestFirst: splits new imports whose bounds want different lines", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { Economy.Shop } <#> note", "    body", "using { Features } <#> why", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }", "using { Zone.Area }"]);

            expect(success).toBe(true);
            // The absolute path is only needed above the anchored consumer; the
            // dotted one needs `Features` above it, so it goes below.
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\n\nusing { Economy.Shop } <#> note\n    body\nusing { Features } <#> why\n    body\nusing { Zone.Area }\n\ncode()");
        });

        // The one branch that rewrites a block in place and inserts on its own
        // line in the same edit: the group is rebuilt where it stands, and the
        // path the anchored import keeps out of it is written separately.
        it("digestFirst: writes a displaced path on its own line while rebuilding the group in place", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { Economy.Shop } <#> note", "    body", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0));

            expect(success).toBe(true);
            // The existing block is rebuilt where it stands, without the
            // displaced path in it, and the provider goes above the anchored
            // consumer that needs it.
            expect(appliedText(input)).toBe("using { Features }\nusing { Economy.Shop } <#> note\n    body\nusing { /Verse.org/Simulation }\ncode()");
        });

        it("digestFirst: writes the new group below the anchored provider, not at the top", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features } <#> note\n    body\nusing { Economy.Shop }\n\ncode()");
        });
    });

    // The grouped writer chooses its block by group identity, and a mixed block
    // counts as neither group, so the pure block it settles on can have one
    // below it holding a relative import the new import may be resolving
    // through.
    describe("grouped placement against a relative import written in a later block", () => {
        it("digestFirst: keeps a new relative import out of the local group above a later relative import", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { Alpha }", "", "using { /Verse.org/Simulation }", "using { Beta.Gamma }", "", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Delta }"]);

            expect(success).toBe(true);
            // The local group at line 0 would have taken it, above Beta.Gamma.
            expect(appliedText(input)).toBe("using { Alpha }\n\nusing { /Verse.org/Simulation }\nusing { Beta.Gamma }\nusing { Delta }\n\ncode()");
        });

        it("localFirst: keeps a new relative import out of the local group above a later relative import", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "localFirst",
            });
            const input = ["using { Alpha }", "", "using { /Verse.org/Simulation }", "using { Beta.Gamma }", "", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Delta }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Alpha }\n\nusing { /Verse.org/Simulation }\nusing { Beta.Gamma }\nusing { Delta }\n\ncode()");
        });

        it("still merges a new relative import into its group when every block below holds only absolute imports", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "localFirst",
            });
            const input = ["using { Alpha }", "", "using { /Verse.org/Simulation }", "", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Delta }"]);

            expect(success).toBe(true);
            // Nothing below can be providing for it, so the group still takes
            // it rather than falling back to a standalone line.
            expect(appliedText(input)).toBe("using { Alpha }\nusing { Delta }\n\nusing { /Verse.org/Simulation }\n\ncode()");
        });

        it("still merges a new absolute import into the digest group above a later relative import", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Alpha }", "using { Beta.Gamma }", "", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            // An absolute path needs nothing in scope above it, so a relative
            // import below is not a provider it has to stay under.
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\n\nusing { Alpha }\nusing { Beta.Gamma }\n\ncode()");
        });
    });

    // The other reason an import stays on its line: another statement shares
    // the span, so rebuilding the line from the path alone would delete what
    // the author wrote beside it. It is out of every block for the same reason
    // an anchored import is, and it bounds placement the same way - but the
    // bounds were collected from the anchored ones alone, so a new import could
    // be written above the pinned line that brings its first segment into
    // scope.
    describe("placement against an import pinned by the statements sharing its span", () => {
        it("keeps a new consumer out of a block that sits above the pinned provider it needs", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { /Verse.org/Simulation }", "X := 1", "using { Features }; MyVal := 5", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // The block at line 0 would have taken it, above the provider.
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\nX := 1\nusing { Features }; MyVal := 5\nusing { Economy.Shop }\n\ncode()");
        });

        it("still merges a new consumer into a block that sits below the pinned provider", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Features }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // Nothing forbids that block, so the ordinary merge still happens
            // rather than a standalone line.
            expect(appliedText(input)).toBe("using { Features }; MyVal := 5\nusing { /Verse.org/Simulation }\nusing { Economy.Shop }\ncode()");
        });

        it("writes a new provider above the pinned consumer that depends on it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0));

            expect(success).toBe(true);
            // Merging into the block below would put the provider under the
            // pinned consumer, which is the same breakage the other way up.
            expect(appliedText(input)).toBe("using { Features }\n\nusing { Economy.Shop }; MyVal := 5\nusing { /Verse.org/Simulation }\ncode()");
        });

        // The same file and the same new import as the test above, differing
        // only in where the compiler reported the problem - which is the whole
        // rule. A pinned dotted import that already resolves is the common case,
        // since the file compiled before this edit, and there it may be what
        // brings the new import's own first segment into scope. Reading it as
        // the consumer on the strength of its path form puts the new import
        // above the provider it needs.
        it("writes a new import below a pinned dotted import when the diagnostic points elsewhere", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 2));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Economy.Shop }; MyVal := 5\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        // Regression for the diagnostic landing on the pinned line but inside
        // the statement beside the clause. The pinned import's own text ends at
        // column 22, and column 24 is `MyVal := 5` - the compiler reporting on
        // the definition, not on the import. Read line-wide, that evidence took
        // the override and the provider was written above the import that may
        // bring its first segment into scope, and a compiling file stopped
        // compiling.
        it("leaves a new import below a pinned consumer when the diagnostic is about the statement beside it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 24));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Economy.Shop }; MyVal := 5\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        // The same line, the diagnostic now inside the clause itself - column 8
        // is the `E` of Economy. The narrowing must not cost the override its
        // reach: a shared line whose own clause failed to resolve still forces
        // the provider above it.
        it("still writes the provider above a shared-line consumer the diagnostic reports inside", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 8));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features }\n\nusing { Economy.Shop }; MyVal := 5\nusing { /Verse.org/Simulation }\ncode()");
        });

        // A clause written after a definition starts at column 8, so the head
        // of its line is outside it. Both directions on one fixture: evidence
        // inside the clause takes the override, evidence on the definition at
        // the head of the line does not.
        it("reads the columns of a clause written after a definition", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using { Economy.Shop }", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 16));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features }\n\nX := 1; using { Economy.Shop }\nusing { /Verse.org/Simulation }\ncode()");
        });

        it("takes no override from a diagnostic on the definition preceding a clause", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using { Economy.Shop }", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 0));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("X := 1; using { Economy.Shop }\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        // The span is two lines and the compiler reports an unresolved path on
        // the path line, so the bound is the pinned import's end and not its
        // start. Narrowed to the start, this file takes no ceiling and the
        // provider is written below the statement that needs it.
        it("takes the ceiling from a diagnostic on the second line of a pinned indented pair", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Other }; using:", "    Economy.Shop", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 1));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features }\n\nusing { Other }; using:\n    Economy.Shop\nusing { /Verse.org/Simulation }\ncode()");
        });

        // Regression for the diagnostic landing on the opener line of a pinned
        // pair but inside the definition beside the clause. The `using:` starts
        // at column 8, and column 0 is `X := 1` - the compiler reporting on the
        // definition, not on the pair. Read span-wide, that evidence took the
        // override and the provider was written above the import that may
        // bring its first segment into scope, and a compiling file stopped
        // compiling.
        it("leaves a new import below a pinned pair when the diagnostic is about the statement beside its opener", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using:", "    Economy.Shop", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 0));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("X := 1; using:\n    Economy.Shop\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        // The same file with the diagnostic inside the `using:` opener itself -
        // column 8 is its `u`. The narrowing must not cost the override its
        // reach on the opener line.
        it("still writes the provider above a pinned pair the diagnostic reports on its opener", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using:", "    Economy.Shop", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 0, 8));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Features }\n\nX := 1; using:\n    Economy.Shop\nusing { /Verse.org/Simulation }\ncode()");
        });

        // The path text ends at column 16 and column 17 is inside the trailing
        // comment - evidence about nothing the pair imports. Refusing it is the
        // safe direction the whole predicate leans: a wrong override breaks a
        // compiling file.
        it("takes no override from a diagnostic past the path of a pinned pair", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using:", "    Economy.Shop # note", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 1, 17));

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("X := 1; using:\n    Economy.Shop # note\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        // The floor reaches past the pinned statement, because the `using:` at
        // the end of its line owns the line below it and no entry of its own
        // spans that line - the pair is declined on content. Taken from the
        // statement's own end, the floor leaves the path line free and the
        // import is written between the opener and the path it opens.
        it("writes a new import below the pair a pinned definition-headed line opens", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["X := 1; using { /A }; using:", "    Foo'Loc'", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("X := 1; using { /A }; using:\n    Foo'Loc'\nusing { Features }\n\ncode()");
        });

        // A caller that names no diagnostic has to be read as evidence of
        // nothing, not as evidence for the override: the override is what
        // breaks a compiling file when it is wrong.
        it("writes a new import below a pinned dotted import when no diagnostic is named", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { Economy.Shop }; MyVal := 5\nusing { /Verse.org/Simulation }\nusing { Features }\ncode()");
        });

        it("sort OFF: appends below the pinned provider rather than after the last block", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": false,
            });
            const input = ["using { /Verse.org/Simulation }", "X := 1", "using { Features }; MyVal := 5", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\nX := 1\nusing { Features }; MyVal := 5\nusing { Economy.Shop }\ncode()");
        });
    });

    // Consolidation writes its block above every pinned line, so it carried an
    // import across the pinned one that may bring its first segment into scope -
    // the hoist buildOrganizedContent already refuses. Verse resolves `using`
    // top-down, so the file stopped compiling.
    describe("consolidating past an import pinned to its line", () => {
        const consolidating = {
            "behavior.preserveImportLocations": false,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        };

        it("leaves a consumer written below a pinned provider on its line", async () => {
            mockConfig(consolidating);
            const input = ["using { Features }; X := 1", "using { Economy.Shop }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { Features }; X := 1\nusing { Economy.Shop }\ncode()");
        });

        it("still hoists a consumer written above the pinned line", async () => {
            mockConfig(consolidating);
            const input = ["using { Economy.Shop }", "using { Features }; MyVal := 5", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            // Position is the question, not presence: hoisting this one lands
            // it above the pinned line, which is where it already was.
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { Economy.Shop }\nusing { Features }; MyVal := 5\ncode()");
        });

        it("writes a new consumer below the pinned provider instead of into the block", async () => {
            mockConfig(consolidating);
            const input = ["using { Features }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            // The hoisted import leaves the line it was written on, or the
            // file imports it twice.
            expect(appliedText(input)).toBe("using { /Verse.org/Simulation }\nusing { Features }; MyVal := 5\nusing { Economy.Shop }\ncode()");
        });

        // The same shape as the test below, with no diagnostic naming the
        // pinned line. Nothing then shows the pinned dotted import is the
        // consumer, and it may be what brings the new path's first segment into
        // scope, so the new import is written below it rather than carried into
        // the block that consolidates above it.
        it("keeps a new import below the pinned dotted line when no diagnostic names it", async () => {
            mockConfig(consolidating);
            const input = ["using { /A }", "code()", "using { Economy.Shop }; X := 1", "more()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /A }\ncode()\nusing { Economy.Shop }; X := 1\nusing { Features }\nmore()");
        });

        it("still consolidates a new provider the pinned consumer below it may need", async () => {
            mockConfig(consolidating);
            const input = ["using { /A }", "code()", "using { Economy.Shop }; X := 1"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"], reportedOn("using { Features }", 2));

            expect(success).toBe(true);
            // The block itself sits above the pinned consumer, so nothing is
            // gained by writing the provider on a line of its own further down.
            expect(appliedText(input)).toBe("using { /A }\nusing { Features }\ncode()\nusing { Economy.Shop }; X := 1");
        });

        it("takes the floor over a pinned consumer sitting above it", async () => {
            mockConfig(consolidating);
            const input = ["using { Economy.Shop }; X := 1", "code()", "using { Features }; Y := 2", "more()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy }"]);

            expect(success).toBe(true);
            // The pinned consumer at line 0 could be what this import was added
            // for, and it is left unfixed: the line above it is also above the
            // pinned import that may bring this path's own first segment into
            // scope. A compiling file outranks a fixed diagnostic.
            expect(appliedText(input)).toBe("using { Economy.Shop }; X := 1\ncode()\nusing { Features }; Y := 2\nusing { Economy }\nmore()");
        });

        it("keeps both copies of a path written on either side of the pinned line", async () => {
            mockConfig(consolidating);
            const input = ["using { Economy.Shop }", "using { Features }; X := 1", "using { Economy.Shop }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            // Grounding is keyed on the path: hoisting the copy above the
            // pinned line while the block declines to re-emit the path would
            // delete the one line that had to keep it.
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { Economy.Shop }\nusing { Features }; X := 1\nusing { Economy.Shop }\ncode()");
        });

        it("splits the delete around a grounded import rather than taking its line with the block", async () => {
            mockConfig(consolidating);
            const input = ["using { Features }; MyVal := 5", "using { /A }", "using { Economy.Shop }", "using { /B }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            // One block, two runs: deleting it whole would take the grounded
            // line with it while nothing re-emits that path, losing the import.
            expect(appliedText(input)).toBe("using { /A }\nusing { /B }\nusing { /Fortnite.com/Devices }\nusing { Features }; MyVal := 5\nusing { Economy.Shop }\ncode()");
        });

        it("grounds against a provider pinned by the comment it anchors, past the comment body", async () => {
            mockConfig(consolidating);
            const input = ["using { Features } <#> why this is here", "    it brings Economy into scope", "using { Economy.Shop }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /Fortnite.com/Devices }\nusing { Features } <#> why this is here\n    it brings Economy into scope\nusing { Economy.Shop }\ncode()");
        });

        it("consolidates a file with nothing pinned exactly as before", async () => {
            mockConfig(consolidating);
            const input = ["using { /B }", "using { /A }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /C }"]);

            expect(success).toBe(true);
            expect(appliedText(input)).toBe("using { /A }\nusing { /B }\nusing { /C }\ncode()");
        });
    });
});

/**
 * Both writers read their own output back before applying it, so a composition
 * bug reaches the user as a refused edit rather than as text silently missing
 * from the file.
 *
 * The bug has to be injected: the point of the check is the bug nobody has
 * written yet, and a writer that is currently correct cannot demonstrate it.
 */
describe("ImportDocumentEditor rewrite verification", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        applyEditMock().mockClear();
    });

    it("refuses to organize when the rebuild loses a line of code", async () => {
        const input = "using { /B }\nusing { /A }\ncode()\nmore()";
        jest.spyOn(editor, "buildOrganizedContent").mockReturnValue("using { /A }\nusing { /B }\n\ncode()");

        const success = await editor.organizeImports(fakeDocument(input), []);

        expect(success).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("refuses to organize when the rebuild drops an import", async () => {
        const input = "using { /B }\nusing { /A }\ncode()";
        jest.spyOn(editor, "buildOrganizedContent").mockReturnValue("using { /A }\n\ncode()");

        const success = await editor.organizeImports(fakeDocument(input), []);

        expect(success).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("organizes as usual when the rebuild is sound", async () => {
        const input = "using { /B }\nusing { /A }\ncode()";

        const success = await editor.organizeImports(fakeDocument(input), []);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /A }\nusing { /B }\n\ncode()");
    });

    // The off-by-one the ticket names, on the path that has no output text to
    // read: a hoisted run reaching one line past its block deletes the code
    // line below it.
    it("refuses to add imports when a queued deletion reaches onto code", async () => {
        const input = "using { /A }\ncode()";
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === "behavior.preserveImportLocations" ? false : defaultValue)),
            update: jest.fn().mockResolvedValue(undefined),
        });
        jest.spyOn(editor as unknown as { hoistedRuns: () => Array<{ start: number; end: number }> }, "hoistedRuns").mockReturnValue([{ start: 0, end: 1 }]);

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("adds imports as usual when the queued edits touch nothing but imports", async () => {
        const input = "using { /A }\ncode()";

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /A }\nusing { /B }\ncode()");
    });

    // insertImportLines documents its past-the-end branch as the thing standing
    // between the writer and "one unreadable line where two belong". An
    // insertion carries no range, so nothing else here would notice.
    it("refuses to add imports when an insertion splices onto a line of code", async () => {
        type InsertImportLines = (edit: vscode.WorkspaceEdit, document: vscode.TextDocument, line: number, statements: string[], eol: string, blankLineAfter: boolean) => void;
        jest.spyOn(editor as unknown as { insertImportLines: InsertImportLines }, "insertImportLines").mockImplementation((edit, document, _line, statements, eol) => {
            edit.insert(document.uri, new vscode.Position(0, "code()".length), statements.join(eol) + eol);
        });

        const success = await editor.addImportsToDocument(fakeDocument("code()"), ["using { /B }"]);

        expect(success).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    /**
     * The guard refuses edits, so a false positive is the extension silently
     * ceasing to import. This is the net for that: every document shape the
     * writers treat differently, against every setting combination that picks a
     * different branch, all of which must still reach applyEdit.
     */
    describe("does not refuse a correct rewrite", () => {
        const documents: Array<[string, string]> = [
            ["an empty file", ""],
            ["no trailing newline", "using { /A }\ncode()"],
            ["a trailing newline", "using { /A }\ncode()\n"],
            ["CRLF", "using { /A }\r\ncode()\r\n"],
            ["only imports", "using { /A }\nusing { /B }"],
            ["no imports at all", "code()\nmore()"],
            ["a header comment", "# licence\n\nusing { /A }\n\ncode()"],
            ["an annotated import", "# why /A is here\nusing { /A }\n\ncode()"],
            ["an import pinned by a second statement", "X := 1; using { /A }\ncode()"],
            ["a commented-out import", "<#\nusing { /Old }\n#>\nusing { /A }\n\ncode()"],
            ["an indented using pair", "using{\n    /A\n}\ncode()"],
            ["a using inside a module body", "using { /A }\n\nM := module:\n    using { /B }\n    F():void = {}"],
            ["two gapped blocks", "using { /A }\n\nusing { Local.One }\n\ncode()"],
            ["a relative import under an absolute one", "using { /A }\nusing { Local.One }\n\ncode()"],
        ];

        const settings: Array<[string, Record<string, unknown>]> = [
            ["defaults", {}],
            ["consolidating", { "behavior.preserveImportLocations": false }],
            ["consolidating, unsorted", { "behavior.preserveImportLocations": false, "behavior.sortImportsAlphabetically": false }],
            ["grouped local first", { "behavior.importGrouping": "localFirst" }],
            ["grouped digest first, consolidating", { "behavior.importGrouping": "digestFirst", "behavior.preserveImportLocations": false }],
            ["dot syntax, consolidating", { "behavior.importSyntax": "dot", "behavior.preserveImportLocations": false }],
        ];

        /** Answers `overrides`, and the declared default for everything else. */
        function useSettings(overrides: Record<string, unknown>): void {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
                get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key in overrides ? overrides[key] : defaultValue)),
                update: jest.fn().mockResolvedValue(undefined),
            });
        }

        for (const [documentName, input] of documents) {
            for (const [settingsName, overrides] of settings) {
                it(`adds an import to ${documentName} with ${settingsName}`, async () => {
                    useSettings(overrides);

                    const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

                    expect(success).toBe(true);
                    expect(applyEditMock()).toHaveBeenCalled();
                });

                it(`organizes ${documentName} with ${settingsName}`, async () => {
                    useSettings(overrides);

                    await expect(editor.organizeImports(fakeDocument(input), ["/Fortnite.com/Devices"])).resolves.toBe(true);
                });
            }
        }
    });
});

/**
 * Regression for #385: the diagnostic evidence has to survive every hop from
 * the command to the rebuild. Dropped at any one of them, Optimize Imports
 * writes the provider below the consumer that needed it, saves the file, and
 * reports success on a diagnostic that still stands.
 */
describe("ImportDocumentEditor.organizeImports carries the diagnostic evidence", () => {
    let editor: ImportDocumentEditor;

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        (vscode.workspace.applyEdit as unknown as jest.Mock).mockClear();
    });

    it("writes the provider above the pinned consumer the diagnostic reports on", async () => {
        const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

        const success = await editor.organizeImports(fakeDocument(input), ["Features"], new Map([["Features", [{ line: 0, character: 0 }]]]));

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Features }\n\nusing { Economy.Shop } <#> note\n    body\ncode()");
    });

    it("leaves the written order alone when the evidence names a line elsewhere", async () => {
        const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

        const success = await editor.organizeImports(fakeDocument(input), ["Features"], new Map([["Features", [{ line: 2, character: 0 }]]]));

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Economy.Shop } <#> note\n    body\nusing { Features }\ncode()");
    });

    it("leaves the written order alone when the caller has no evidence at all", async () => {
        const input = ["using { Economy.Shop } <#> note", "    body", "code()"].join("\n");

        const success = await editor.organizeImports(fakeDocument(input), ["Features"]);

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { Economy.Shop } <#> note\n    body\nusing { Features }\ncode()");
    });
});

describe("ImportDocumentEditor.ensureEmptyLinesAfterImports", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        applyEditMock().mockClear();
    });

    it("does not enforce spacing after a module-scoped using", async () => {
        const input = ["using { /Top }", "", "M := module:", "    using { /Verse.org/Random }", "    F():void = {}", ""].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("does not enforce spacing after an import inside a block comment", async () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("still enforces spacing after the file-level import block", async () => {
        const input = ["using { /Top }", "code()"].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Top }\n\ncode()");
    });

    // This runs right after both writers, so an LF blank line here would put
    // back the mixed endings they now avoid.
    it("inserts a CRLF blank line in a CRLF document", async () => {
        const input = "using { /Top }\r\ncode()\r\n";

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input, vscode.EndOfLine.CRLF));

        expect(success).toBe(true);
        expect(appliedText(input)).toBe("using { /Top }\r\n\r\ncode()\r\n");
    });
});

/**
 * The save participant asks for the edits and hands them to VS Code instead of
 * applying them itself (#144), so the spacing decisions have to be answerable
 * without touching the document.
 */
describe("ImportDocumentEditor.computeEmptyLinesAfterImportsEdits", () => {
    let editor: ImportDocumentEditor;

    /** The setting as the manifest declares it, which is what the settings UI enforces. */
    function emptyLinesSetting(): { type: string; minimum: number; description: string } {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
        return manifest.contributes.configuration.properties["verseAutoImports.behavior.emptyLinesAfterImports"];
    }

    /** Answers emptyLinesAfterImports with `value`, defaults for everything else. */
    function mockEmptyLines(value: number): void {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === "behavior.emptyLinesAfterImports" ? value : defaultValue)),
            update: jest.fn().mockResolvedValue(undefined),
        });
    }

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        (vscode.workspace.applyEdit as unknown as jest.Mock).mockClear();
    });

    it("asks for an inserted blank line when the import block has none", () => {
        const edits = editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "code()"].join("\n")));

        expect(edits).toHaveLength(1);
        expect(edits[0].range.start.line).toBe(1);
        expect(edits[0].range.isEmpty).toBe(true);
        expect(edits[0].newText).toBe("\n");
    });

    it("asks for a deletion when the import block has too many blank lines", () => {
        const edits = editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "", "", "code()"].join("\n")));

        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe("");
        expect(edits[0].range.start.line).toBe(1);
        expect(edits[0].range.end.line).toBe(2);
    });

    it("asks for nothing when the spacing already matches", () => {
        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "", "code()"].join("\n")))).toEqual([]);
    });

    it("asks for nothing after a module-scoped using", () => {
        const input = ["using { /Top }", "", "M := module:", "    using { /Verse.org/Random }", "    F():void = {}", ""].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(input))).toEqual([]);
    });

    it("asks for nothing after an import inside a block comment", () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(input))).toEqual([]);
    });

    it("writes a CRLF blank line into a CRLF document", () => {
        const edits = editor.computeEmptyLinesAfterImportsEdits(fakeDocument("using { /Top }\r\ncode()\r\n", vscode.EndOfLine.CRLF));

        expect(edits[0].newText).toBe("\r\n");
    });

    // -1 is the opt-out: the file keeps whatever spacing it has. Both
    // directions matter - it must not take the blank lines the author wrote,
    // and it must not take the line of code below an import block with none.
    it("deletes nothing when the setting is negative", () => {
        mockEmptyLines(-1);

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "code()"].join("\n")))).toEqual([]);
    });

    it("keeps the blank lines the file already has when the setting is negative", () => {
        mockEmptyLines(-1);

        const input = ["using { /Top }", "", "", "", "code()"].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(input))).toEqual([]);
    });

    it("honours -1 only because package.json admits it, so the settings UI can offer it", () => {
        const setting = emptyLinesSetting();

        // Declared below the minimum, the opt-out is unreachable however well
        // the code above honours it: the settings UI refuses to store it.
        expect(setting.minimum).toBeLessThanOrEqual(-1);
        expect(setting.description).toContain("-1");
    });

    // A blank-line count is whole. Declared "number" the settings UI offered
    // 1.5, and the pass then asked for an edit that changed nothing on every
    // save (#242).
    it("declares the setting an integer, so the settings UI cannot offer a fraction", () => {
        expect(emptyLinesSetting().type).toBe("integer");
    });

    it("asks for nothing when a fractional setting rounds to the spacing the file already has", () => {
        mockEmptyLines(1.5);

        const input = ["using { /Top }", "", "", "code()"].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(input))).toEqual([]);
    });

    // The convergence itself: the first pass has to reach a state the second
    // pass leaves alone. 1.5 used to give a difference of 0.5 forever, since
    // the count of real blank lines can never equal it.
    it("converges on a fractional setting instead of editing on every pass", () => {
        mockEmptyLines(1.5);
        const edits = editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "", "code()"].join("\n")));

        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe("\n");

        mockEmptyLines(1.5);
        const settled = ["using { /Top }", "", "", "code()"].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(settled))).toEqual([]);
    });

    it("keeps the spacing a fraction just below the opt-out asks it to keep", () => {
        mockEmptyLines(-0.4);

        const input = ["using { /Top }", "", "", "", "code()"].join("\n");

        expect(editor.computeEmptyLinesAfterImportsEdits(fakeDocument(input))).toEqual([]);
    });

    it("never edits the document itself", () => {
        editor.computeEmptyLinesAfterImportsEdits(fakeDocument(["using { /Top }", "code()"].join("\n")));

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });
});

/**
 * Two writes on one document, overlapping - a quick fix arriving while a
 * debounced auto-import is in flight. Each writer reads, computes and applies
 * as three separate steps, so what these pin is that the second writer does
 * not read while the first is still applying.
 */
describe("ImportDocumentEditor write serialization", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    /**
     * Every read and every apply, in the order they happened. A read is
     * getText, which is the snapshot a writer computes its coordinates from.
     */
    let trace: string[];

    /** The applyEdit calls not yet let through, in the order they were made. */
    let pendingApplies: Array<() => void>;

    const input = ["using { /Verse.org/Simulation }", "", "hello := 1"].join("\n");

    /** A document that records its reads. */
    const tracedDocument = (uri: string): vscode.TextDocument =>
        ({
            ...fakeDocument(input),
            uri: { toString: () => uri },
            getText: () => {
                trace.push("read");
                return input;
            },
        }) as unknown as vscode.TextDocument;

    /** Lets the queued microtasks run without releasing any applyEdit. */
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
            await Promise.resolve();
        }
    };

    const releaseApplies = async (): Promise<void> => {
        while (pendingApplies.length > 0) {
            pendingApplies.shift()!();
            await settle();
        }
    };

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        trace = [];
        pendingApplies = [];
        applyEditMock().mockReset();
        applyEditMock().mockImplementation(() => {
            trace.push("apply");
            return new Promise<boolean>((resolve) => pendingApplies.push(() => resolve(true)));
        });
    });

    // The mock is shared across this file, and every other test here expects
    // an apply that resolves true on its own.
    afterEach(() => {
        applyEditMock().mockReset();
        applyEditMock().mockResolvedValue(true);
    });

    it("does not let a second write read the document while the first is applying", async () => {
        const document = tracedDocument("file:///test.verse");

        const first = editor.addImportsToDocument(document, ["using { /Fortnite.com/Devices }"]);
        const second = editor.organizeImports(document, ["/UnrealEngine.com/Temporary/SpatialMath"]);

        await settle();

        // Unserialized, the second writer runs on to its own applyEdit here,
        // off text the first one has not finished writing over.
        expect(trace).toEqual(["read", "apply"]);

        await releaseApplies();
        expect(await first).toBe(true);
        expect(await second).toBe(true);

        expect(trace.lastIndexOf("read")).toBeGreaterThan(trace.indexOf("apply"));
    });

    it("runs a write queued behind one whose apply rejected", async () => {
        const document = tracedDocument("file:///test.verse");

        applyEditMock().mockImplementationOnce(() => {
            trace.push("apply");
            return Promise.reject(new Error("apply rejected"));
        });

        const first = editor.addImportsToDocument(document, ["using { /Fortnite.com/Devices }"]);
        const second = editor.organizeImports(document, ["/UnrealEngine.com/Temporary/SpatialMath"]);

        await settle();
        await releaseApplies();

        expect(await first).toBe(false);
        expect(await second).toBe(true);
        expect(trace.filter((entry) => entry === "apply").length).toBeGreaterThan(1);
    });

    it("does not queue a write on one document behind a write on another", async () => {
        const one = tracedDocument("file:///one.verse");
        const other = tracedDocument("file:///other.verse");

        const first = editor.addImportsToDocument(one, ["using { /Fortnite.com/Devices }"]);
        const second = editor.addImportsToDocument(other, ["using { /Fortnite.com/Devices }"]);

        await settle();

        expect(trace).toEqual(["read", "apply", "read", "apply"]);

        await releaseApplies();
        expect(await first).toBe(true);
        expect(await second).toBe(true);
    });
});
