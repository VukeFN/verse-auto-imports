import * as fs from "fs";
import * as path from "path";
import { detectEol, ImportDocumentEditor } from "../ImportDocumentEditor";
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

    // A comment after the `using:` defeats a `$` anchored on the raw line, which
    // put the line straight back on the mangling path: rebuilt as
    // `using { /X } # note`, with Economy.Shop stranded below it.
    it("leaves a using: pair alone when a comment trails the opener", () => {
        const input = ["using { /X }; using: # note", "    Economy.Shop", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
    });

    // The `using:` opens nothing here, so there is no pair to read - but the
    // line is still not reproducible from the path before the `;`, and
    // rebuilding it deletes the `; using:` the author wrote.
    it("leaves the line alone when such a using: opens no indented path", () => {
        const input = ["using { /X }; using:", "", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBeNull();
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

describe("ImportDocumentEditor.addImportsToDocument", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

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
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.text).toContain("/Verse.org/Simulation");
        expect(insert!.text).toContain("/Fortnite.com/Devices");

        const deletes = operations.filter((op) => op.kind === "delete");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].range!.start.line).toBe(0);
        expect(deletes[0].range!.end.line).toBe(2);
    });

    it("recognizes an import that already exists as an indented pair and makes no edit", async () => {
        const input = ["using:", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("adds an import that exists only inside a block comment, above the comment", async () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "my_device := class(creative_device):", "    Button : button_device = button_device{}"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].position).toEqual({ line: 0, character: 0 });
        expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n\n");
    });

    it("adds a new import without rebuilding an import line that opens a block comment", async () => {
        // Merging into that line would rewrite it from its path alone and drop
        // the `<#`, making the disabled import below it live again.
        const input = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "", "code()"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].position).toEqual({ line: 0, character: 0 });
        expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n\n");
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
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert!.text).not.toContain("/Verse.org/Random");

        const deletes = operations.filter((op) => op.kind === "delete");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].range!.start.line).toBe(0);
        expect(deletes[0].range!.end.line).toBe(1);
    });

    // The auto-import path, which users reach without invoking a command. It
    // rebuilds a block through createBlockReplacementEdit rather than through
    // buildOrganizedContent, and reads trailing comments off that block alone.
    it("keeps the comment trailing an existing import when a new one joins its block", async () => {
        const input = ["using { /Zebra } # network only", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Apple }"]);

        expect(success).toBe(true);
        const replace = appliedOperations(0).find((op) => op.kind === "replace");
        expect(replace!.text).toBe("using { /Apple }\nusing { /Zebra } # network only\n");
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
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert!.text).toContain("using { /Zebra } # network only");
    });

    it("does not add an import under an unclosed opener that ends the buffer", async () => {
        // The opener is anchored, so the new import is written above it rather
        // than into the comment it would otherwise open over that import.
        const input = ["hello := 1", "using { /A } <#"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(true);
        // Pinned to the exact edit rather than to "no `<#` anywhere": a delete
        // operation carries no text, so an assertion over every operation's
        // text passes vacuously and would hold for an edit that writes nothing.
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].text).toBe("using { /B }\n\n");
        expect(operations[0].position!.line).toBe(0);
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
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(3);
        expect(replace!.text).toContain("/Fortnite.com/Random");
        expect(replace!.text).toContain("/Verse.org/Simulation");
        expect(replace!.text).toContain("/Fortnite.com/Devices");

        // Nothing is inserted above the header comment.
        const insertsAtTop = operations.filter((op) => op.kind === "insert" && op.position!.line === 0);
        expect(insertsAtTop).toHaveLength(0);
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
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(3);
        expect(replace!.text).toContain("/Fortnite.com/Random");
        expect(replace!.text).toContain("/Verse.org/Simulation");

        const insertsAtTop = operations.filter((op) => op.kind === "insert" && op.position!.line === 0);
        expect(insertsAtTop).toHaveLength(0);
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
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.text).toBe("using { Economy.Shop }\nusing { Features }\n");
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
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(0);
        expect(replace!.text).toBe("using { Economy.Shop }\nusing { Features }\n");

        // The new import is not appended after the block.
        const insertsAfterBlock = operations.filter((op) => op.kind === "insert" && op.position!.line === 1);
        expect(insertsAfterBlock).toHaveLength(0);
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
        const operations = appliedOperations(0);

        // No block is rewritten; the existing import line stays as-is.
        expect(operations.some((op) => op.kind === "replace")).toBe(false);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(1);
        expect(insert!.text).toBe("using { Features }\n");
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
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(2);
        expect(replaces[0].text).toBe("using { Features }\nusing { Economy.Shop }\n");
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
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(2);
        expect(replaces[0].text).toBe("using { /Verse.org/Simulation }\nusing { Features }\n");
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
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(0);
        expect(replaces[0].text).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n");
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
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(2);

        // The absolute path joins the block of absolute paths, the dotted
        // reference the block holding its provider.
        expect(replaces[0].range!.start.line).toBe(0);
        expect(replaces[0].text).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n");
        expect(replaces[1].range!.start.line).toBe(2);
        expect(replaces[1].text).toBe("using { Features }\nusing { Economy.Shop }\n");

        // Blocks are disjoint, so the two replacements cannot overlap.
        expect(replaces[0].range!.end.line).toBeLessThanOrEqual(replaces[1].range!.start.line);
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
        const operations = appliedOperations(0);
        expect(operations.some((op) => op.kind === "replace")).toBe(false);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(3);
        expect(insert!.text).toBe("using { Economy.Shop }\n");
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
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(3);
        expect(insert!.text).toBe("using { Economy.Shop }\n");
    });

    // The line after the last import does not exist in a document with no
    // trailing newline, and VS Code clamps a position past the end onto the end
    // of the last line - splicing the two statements into one unreadable line.
    it("preserve + grouping none + sort OFF: appends onto a block that ends the document", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["code()", "using { /A }"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /B }"]);

        expect(success).toBe(true);
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(1);
        expect(insert!.position!.character).toBe("using { /A }".length);
        expect(insert!.text).toBe("\nusing { /B }");
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
        const replace = appliedOperations(0).find((op) => op.kind === "replace");
        expect(replace!.text).toBe("using { Economy.Shop }\r\nusing { Features }\r\n");
    });

    it("writes CRLF endings into a CRLF document when inserting a new block at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = "hello := 1\r\nworld := 2\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert!.text).toBe("using { /Fortnite.com/Random }\r\n\r\n");
    });

    it("writes CRLF endings into a CRLF document when consolidating at the top", async () => {
        mockConfig({ "behavior.preserveImportLocations": false });
        const input = "using { /Verse.org/Simulation }\r\n\r\nhello := 1\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert!.text).toBe("using { /Fortnite.com/Devices }\r\nusing { /Verse.org/Simulation }\r\n");
    });

    it("preserve + digestFirst: inserts at the top when the file has no existing imports", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = ["hello := 1", "world := 2"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(0);
        expect(insert!.text).toContain("/Fortnite.com/Random");

        expect(operations.some((op) => op.kind === "replace")).toBe(false);
        expect(operations.some((op) => op.kind === "delete")).toBe(false);
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
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(1);
            expect(operations[0].kind).toBe("insert");
            // Line 2, not line 1: the line below the marker is the comment's
            // own body, and an import at column 0 there both lands inside the
            // comment and truncates the rest of what the author wrote.
            expect(operations[0].position).toEqual({ line: 2, character: 0 });
            expect(operations[0].text).toBe("using { Economy.Shop }\n\n");
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
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(1);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].position).toEqual({ line: 3, character: 0 });
            expect(operations[0].text).toBe("using { Economy.Shop }\n\n");
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
            const operations = appliedOperations(0);
            // The block at line 0 would have taken it, above the provider.
            expect(operations.some((op) => op.kind === "replace")).toBe(false);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(4);
            expect(insert!.text).toBe("using { Economy.Shop }\n\n");
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
            const operations = appliedOperations(0);
            // Nothing forbids that block, so the ordinary merge still happens
            // rather than a standalone line.
            expect(operations.some((op) => op.kind === "insert")).toBe(false);

            const replace = operations.find((op) => op.kind === "replace");
            expect(replace).toBeDefined();
            expect(replace!.range!.start.line).toBe(3);
            expect(replace!.text).toBe("using { /Verse.org/Simulation }\nusing { Economy.Shop }\n");
        });

        it("writes a new provider above the anchored consumer that depends on it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop } <#> note", "    body", "", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            // Merging into the block below would put the provider under the
            // anchored consumer, which is the same breakage the other way up.
            expect(operations.some((op) => op.kind === "replace")).toBe(false);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(0);
            expect(insert!.text).toBe("using { Features }\n\n");
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

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            expect(operations.some((op) => op.kind === "insert")).toBe(false);

            const replace = operations.find((op) => op.kind === "replace");
            expect(replace).toBeDefined();
            expect(replace!.range!.start.line).toBe(0);
            expect(replace!.text).toBe("using { /Verse.org/Simulation }\nusing { Features }\n");
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
            const insert = appliedOperations(0).find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(4);
            expect(insert!.text).toBe("using { Economy.Shop }\n");
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

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const insert = appliedOperations(0).find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(0);
            expect(insert!.text).toBe("using { Features }\n\n");
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

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const insert = appliedOperations(0).find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(2);
            expect(insert!.text).toBe("using { Features }\n\n");
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
            const operations = appliedOperations(0);
            expect(operations.some((op) => op.kind === "insert")).toBe(false);

            const replace = operations.find((op) => op.kind === "replace");
            expect(replace).toBeDefined();
            expect(replace!.range!.start.line).toBe(2);
            expect(replace!.text).toBe("using { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\n");
        });

        it("digestFirst with two existing groups: keeps a new consumer out of the group above the anchored provider", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { /Verse.org/Simulation }", "", "using { Other }", "", "using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            // The local group at line 2 would have taken it, above the provider.
            expect(operations.some((op) => op.kind === "replace")).toBe(false);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(6);
            expect(insert!.text).toBe("using { Economy.Shop }\n");
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
            const inserts = appliedOperations(0).filter((op) => op.kind === "insert");
            expect(inserts).toHaveLength(2);

            // The absolute path is only needed above the anchored consumer.
            expect(inserts[0].position!.line).toBe(0);
            expect(inserts[0].text).toBe("using { /Fortnite.com/Devices }\n\n");

            // The dotted one needs `Features` above it, so it goes below.
            expect(inserts[1].position!.line).toBe(4);
            expect(inserts[1].text).toBe("using { Zone.Area }\n\n");
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

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);

            // The existing block is rebuilt where it stands, without the
            // displaced path in it.
            const replace = operations.find((op) => op.kind === "replace");
            expect(replace).toBeDefined();
            expect(replace!.range!.start.line).toBe(2);
            expect(replace!.text).toBe("using { /Verse.org/Simulation }\n");

            // The provider goes above the anchored consumer that needs it.
            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(0);
            expect(insert!.text).toBe("using { Features }\n");
        });

        it("digestFirst: writes the new group below the anchored provider, not at the top", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "digestFirst",
            });
            const input = ["using { Features } <#> note", "    body", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            const insert = appliedOperations(0).find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(2);
            expect(insert!.text).toBe("using { Economy.Shop }\n\n");
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
            const operations = appliedOperations(0);
            // The block at line 0 would have taken it, above the provider.
            expect(operations.some((op) => op.kind === "replace")).toBe(false);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(3);
            expect(insert!.text).toBe("using { Economy.Shop }\n\n");
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
            const operations = appliedOperations(0);
            // Nothing forbids that block, so the ordinary merge still happens
            // rather than a standalone line.
            expect(operations.some((op) => op.kind === "insert")).toBe(false);

            const replace = operations.find((op) => op.kind === "replace");
            expect(replace).toBeDefined();
            expect(replace!.range!.start.line).toBe(1);
            expect(replace!.text).toBe("using { /Verse.org/Simulation }\nusing { Economy.Shop }\n");
        });

        it("writes a new provider above the pinned consumer that depends on it", async () => {
            mockConfig({
                "behavior.preserveImportLocations": true,
                "behavior.importGrouping": "none",
                "behavior.sortImportsAlphabetically": true,
            });
            const input = ["using { Economy.Shop }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            // Merging into the block below would put the provider under the
            // pinned consumer, which is the same breakage the other way up.
            expect(operations.some((op) => op.kind === "replace")).toBe(false);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(0);
            expect(insert!.text).toBe("using { Features }\n\n");
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
            const insert = appliedOperations(0).find((op) => op.kind === "insert");
            expect(insert).toBeDefined();
            expect(insert!.position!.line).toBe(3);
            expect(insert!.text).toBe("using { Economy.Shop }\n");
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
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(1);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].position).toEqual({ line: 0, character: 0 });
            expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n");
        });

        it("still hoists a consumer written above the pinned line", async () => {
            mockConfig(consolidating);
            const input = ["using { Economy.Shop }", "using { Features }; MyVal := 5", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            // Position is the question, not presence: hoisting this one lands
            // it above the pinned line, which is where it already was.
            const insert = operations.find((op) => op.kind === "insert");
            expect(insert!.text).toBe("using { /Fortnite.com/Devices }\nusing { Economy.Shop }\n");

            const deletes = operations.filter((op) => op.kind === "delete");
            expect(deletes).toHaveLength(1);
            expect(deletes[0].range!.start.line).toBe(0);
            expect(deletes[0].range!.end.line).toBe(1);
        });

        it("writes a new consumer below the pinned provider instead of into the block", async () => {
            mockConfig(consolidating);
            const input = ["using { Features }; MyVal := 5", "using { /Verse.org/Simulation }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);

            const inserts = operations.filter((op) => op.kind === "insert");
            expect(inserts).toHaveLength(2);
            expect(inserts[0].position).toEqual({ line: 0, character: 0 });
            expect(inserts[0].text).toBe("using { /Verse.org/Simulation }\n");
            expect(inserts[1].position!.line).toBe(1);
            expect(inserts[1].text).toBe("using { Economy.Shop }\n");

            // The hoisted import still leaves its line, or the file imports it
            // twice.
            const deletes = operations.filter((op) => op.kind === "delete");
            expect(deletes).toHaveLength(1);
            expect(deletes[0].range).toEqual({ start: { line: 1, character: 0 }, end: { line: 2, character: 0 } });
        });

        it("still consolidates a new provider the pinned consumer below it may need", async () => {
            mockConfig(consolidating);
            const input = ["using { /A }", "code()", "using { Economy.Shop }; X := 1"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            // The block itself sits above the pinned consumer, so nothing is
            // gained by writing the provider on a line of its own further down.
            expect(operations).toHaveLength(2);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].position).toEqual({ line: 0, character: 0 });
            expect(operations[0].text).toBe("using { /A }\nusing { Features }\n");
            expect(operations[1].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
        });

        it("keeps both copies of a path written on either side of the pinned line", async () => {
            mockConfig(consolidating);
            const input = ["using { Economy.Shop }", "using { Features }; X := 1", "using { Economy.Shop }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            // Grounding is keyed on the path: hoisting the copy above the
            // pinned line while the block declines to re-emit the path would
            // delete the one line that had to keep it.
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(1);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n");
        });

        it("splits the delete around a grounded import rather than taking its line with the block", async () => {
            mockConfig(consolidating);
            const input = ["using { Features }; MyVal := 5", "using { /A }", "using { Economy.Shop }", "using { /B }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);

            const insert = operations.find((op) => op.kind === "insert");
            expect(insert!.text).toBe("using { /A }\nusing { /B }\nusing { /Fortnite.com/Devices }\n");

            // One block, two runs: deleting it whole would take the grounded
            // line with it while nothing re-emits that path, losing the import.
            const deletes = operations.filter((op) => op.kind === "delete").sort((a, b) => a.range!.start.line - b.range!.start.line);
            expect(deletes).toHaveLength(2);
            expect(deletes[0].range).toEqual({ start: { line: 1, character: 0 }, end: { line: 2, character: 0 } });
            expect(deletes[1].range).toEqual({ start: { line: 3, character: 0 }, end: { line: 4, character: 0 } });
        });

        it("grounds against a provider pinned by the comment it anchors, past the comment body", async () => {
            mockConfig(consolidating);
            const input = ["using { Features } <#> why this is here", "    it brings Economy into scope", "using { Economy.Shop }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(1);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n");
        });

        it("consolidates a file with nothing pinned exactly as before", async () => {
            mockConfig(consolidating);
            const input = ["using { /B }", "using { /A }", "code()"].join("\n");

            const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /C }"]);

            expect(success).toBe(true);
            const operations = appliedOperations(0);
            expect(operations).toHaveLength(2);
            expect(operations[0].kind).toBe("insert");
            expect(operations[0].position).toEqual({ line: 0, character: 0 });
            expect(operations[0].text).toBe("using { /A }\nusing { /B }\nusing { /C }\n");
            expect(operations[1].kind).toBe("delete");
            expect(operations[1].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 2, character: 0 } });
        });
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
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].position!.line).toBe(1);
    });

    // This runs right after both writers, so an LF blank line here would put
    // back the mixed endings they now avoid.
    it("inserts a CRLF blank line in a CRLF document", async () => {
        const input = "using { /Top }\r\ncode()\r\n";

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input, vscode.EndOfLine.CRLF));

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations[0].text).toBe("\r\n");
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
