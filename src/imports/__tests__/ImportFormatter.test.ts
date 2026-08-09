import { ImportFormatter } from "../ImportFormatter";

describe("ImportFormatter.isModuleImport", () => {
    it("default mode: a bare identifier is not a module import", () => {
        expect(ImportFormatter.isModuleImport("using { Features }")).toBe(false);
    });

    it("atFileScope: a bare identifier is a module import", () => {
        expect(ImportFormatter.isModuleImport("using { Features }", undefined, { atFileScope: true })).toBe(true);
    });

    it("a slash-form relative path is never a module import, in either mode", () => {
        expect(ImportFormatter.isModuleImport("using { Sub/Deep }")).toBe(false);
        expect(ImportFormatter.isModuleImport("using { Sub/Deep }", undefined, { atFileScope: true })).toBe(false);
    });

    it("a parent-relative path keeps its pre-existing dot-rule classification (out of scope to change)", () => {
        // `../UI/MainMenu` contains a dot (from `..`), so the pre-existing
        // content rule classifies it as a module import. The atFileScope flag
        // only adds bare-identifier recognition and never removes anything, so
        // the classification is identical in both modes. Special handling of
        // `../` forms is explicitly out of scope, and the default mode must stay
        // byte-for-byte unchanged, so this behavior is left as-is.
        expect(ImportFormatter.isModuleImport("using { ../UI/MainMenu }")).toBe(true);
        expect(ImportFormatter.isModuleImport("using { ../UI/MainMenu }", undefined, { atFileScope: true })).toBe(true);
    });

    it("an absolute path is a module import in both modes", () => {
        expect(ImportFormatter.isModuleImport("using { /Verse.org/Simulation }")).toBe(true);
        expect(ImportFormatter.isModuleImport("using { /Verse.org/Simulation }", undefined, { atFileScope: true })).toBe(true);
    });

    it("a dotted reference is a module import in both modes", () => {
        expect(ImportFormatter.isModuleImport("using { Economy.Shop }")).toBe(true);
        expect(ImportFormatter.isModuleImport("using { Economy.Shop }", undefined, { atFileScope: true })).toBe(true);
    });

    it("atFileScope: recognizes a bare identifier uniformly across all three syntactic styles", () => {
        expect(ImportFormatter.isModuleImport("using { Features }", undefined, { atFileScope: true })).toBe(true);
        expect(ImportFormatter.isModuleImport("using. Features", undefined, { atFileScope: true })).toBe(true);
        expect(ImportFormatter.isModuleImport("using:", "    Features", { atFileScope: true })).toBe(true);
    });

    // A bare identifier is the only dotted content the swallowed definition
    // changes the answer for: read to end of line the content was
    // `Features; MyVal := 5`, which is neither a path nor an identifier, so the
    // line classified as no import at all and the scanner skipped it whole. The
    // absolute and dot-notation forms keep the `/` or the `.` that decides them.
    it("atFileScope: a bare dotted import sharing its line with a definition is a module import", () => {
        expect(ImportFormatter.isModuleImport("using. Features; MyVal := 5", undefined, { atFileScope: true })).toBe(true);
        expect(ImportFormatter.isModuleImport("using. /Verse.org/Simulation; MyVal := 5", undefined, { atFileScope: true })).toBe(true);
        expect(ImportFormatter.isModuleImport("using. Economy.Shop; MyVal := 5", undefined, { atFileScope: true })).toBe(true);
    });

    // Ending the capture at the statement must not promote a local-scope using:
    // outside file scope a bare identifier is an instance, whatever follows it.
    it("default mode: a local-scope dotted using sharing its line stays a local-scope using", () => {
        expect(ImportFormatter.isModuleImport("using. Instance; MyVal := 5")).toBe(false);
    });
});

describe("ImportFormatter.stripTrailingComment", () => {
    it("removes a line comment and its leading whitespace", () => {
        expect(ImportFormatter.stripTrailingComment("/Verse.org/Simulation # keep me")).toBe("/Verse.org/Simulation");
    });

    it("removes a block comment, including the opening angle bracket", () => {
        expect(ImportFormatter.stripTrailingComment("/Verse.org/Simulation <# keep me #>")).toBe("/Verse.org/Simulation");
    });

    it("leaves content without a comment untouched apart from trimming", () => {
        expect(ImportFormatter.stripTrailingComment("  /Verse.org/Simulation  ")).toBe("/Verse.org/Simulation");
    });

    it("returns an empty string when the content is only a comment", () => {
        expect(ImportFormatter.stripTrailingComment(" # just a note")).toBe("");
    });
});

describe("ImportFormatter.extractTrailingComment", () => {
    it("returns a line comment without the whitespace ahead of it", () => {
        expect(ImportFormatter.extractTrailingComment("using { /Verse.org/Simulation } # network only")).toBe("# network only");
    });

    it("returns a block comment from its opening angle bracket", () => {
        expect(ImportFormatter.extractTrailingComment("using { /A } <# keep me #>")).toBe("<# keep me #>");
    });

    it("returns an indented comment marker with the text after it", () => {
        expect(ImportFormatter.extractTrailingComment("using { /A } <#> why this is here")).toBe("<#> why this is here");
    });

    it("returns an empty string when there is no comment", () => {
        expect(ImportFormatter.extractTrailingComment("using { /A }")).toBe("");
    });

    it("recomposes the original with stripTrailingComment, which splits at the same point", () => {
        const content = "/Verse.org/Simulation # keep me";
        expect(`${ImportFormatter.stripTrailingComment(content)} ${ImportFormatter.extractTrailingComment(content)}`).toBe(content);
    });
});

describe("ImportFormatter trailing comments on import statements", () => {
    let formatter: ImportFormatter;

    beforeEach(() => {
        formatter = new ImportFormatter();
    });

    // A trailing comment used to be captured as part of the path by the greedy
    // dot-syntax pattern, so re-emitting the import produced
    // `using { /X # note }` — the `#` opens a line comment that swallows the
    // closing brace, leaving a statement that no longer parses.
    it("dot syntax: does not carry a trailing comment into the extracted path", () => {
        expect(formatter.extractPathFromImport("using. /Verse.org/Simulation # keep me")).toBe("/Verse.org/Simulation");
    });

    it("braced syntax: does not carry a trailing comment into the extracted path", () => {
        expect(formatter.extractPathFromImport("using { /Verse.org/Simulation } # keep me")).toBe("/Verse.org/Simulation");
    });

    it("dot syntax: a trailing block comment is stripped too", () => {
        expect(formatter.extractPathFromImport("using. /Verse.org/Simulation <# keep me #>")).toBe("/Verse.org/Simulation");
    });

    it("self-heals an already-corrupted statement with the comment inside the braces", () => {
        expect(formatter.extractPathFromImport("using { /Verse.org/Simulation # keep me }")).toBe("/Verse.org/Simulation");
    });

    it("returns null when the statement carries no path, only a comment", () => {
        expect(formatter.extractPathFromImport("using. # just a note")).toBeNull();
    });

    it("a rewritten dot-syntax import with a trailing comment emits a well-formed statement", () => {
        const path = formatter.extractPathFromImport("using. /Verse.org/Simulation # keep me");
        expect(formatter.groupAndFormatImports([path as string], false, true, "none")).toEqual(["using { /Verse.org/Simulation }"]);
    });

    // The braced pattern used to be tried first and unanchored, so on a dotted
    // statement it matched inside the trailing comment and won the path - the
    // comment being stripped only afterwards, from that wrong capture.
    it("dot syntax: a trailing comment holding `using { X }` does not hijack the path", () => {
        expect(formatter.extractPathFromImport("using. Economy.Shop # was using { Inventory }")).toBe("Economy.Shop");
    });

    it("dot syntax: a full path survives a trailing comment holding `using { X }`", () => {
        expect(formatter.extractPathFromImport("using. /mygame@fortnite.com/mygame/Economy/Shop # see using { Vendor }")).toBe("/mygame@fortnite.com/mygame/Economy/Shop");
    });

    // isDigestImport routes anything containing "using" through here, which a
    // bare path can satisfy as a substring - "Housing" ends in one. Anchoring
    // means no match, so its `|| importPath` fallback keeps the real path
    // instead of the tail the unanchored dotted pattern used to capture.
    it("a bare path whose segment ends in `using` is not read as a dotted statement", () => {
        expect(formatter.extractPathFromImport("/mygame@fortnite.com/mygame/Housing.Shop")).toBeNull();
    });

    it("reports the code written after a braced statement", () => {
        expect(formatter.textAfterImport("using { /mygame@fortnite.com/mygame/Economy/Shop }; MyVal := 5")).toBe("; MyVal := 5");
    });

    it("reports nothing after a braced statement that is the whole line", () => {
        expect(formatter.textAfterImport("using { /Verse.org/Simulation }")).toBe("");
    });

    // The dotted capture used to run to end of line, so a statement sharing a
    // line was swallowed into the path and nothing was left over to report -
    // and the line read as rewritable.
    it("reports the code written after a dotted statement, which has no closing delimiter", () => {
        expect(formatter.textAfterImport("using. /Verse.org/Simulation; MyVal := 5")).toBe("; MyVal := 5");
    });

    it("reports nothing after a dotted statement that is the whole line", () => {
        expect(formatter.textAfterImport("using. /Verse.org/Simulation")).toBe("");
    });

    // Every character a dotted content may hold, so the capture cannot end
    // early on an ordinary path: `.` and `-` in a label, `@` before the account,
    // `/` between segments, `_` and a digit in an identifier.
    it("carries a whole path through the dotted capture", () => {
        expect(formatter.extractPathFromImport("using. /mygame@fortnite.com/my-game_2/Economy.Shop")).toBe("/mygame@fortnite.com/my-game_2/Economy.Shop");
        expect(formatter.textAfterImport("using. /mygame@fortnite.com/my-game_2/Economy.Shop")).toBe("");
    });

    // A quoted segment suffix admits nearly every printable character, `;` and
    // a space included, so ending the capture at the `'` would report
    // `Economy.Shop` - a different module that exists, which a writer asked for
    // that module would then read as already imported.
    it("carries a quoted segment suffix through the dotted capture", () => {
        expect(formatter.extractPathFromImport("using. Economy.Shop'Loc'")).toBe("Economy.Shop'Loc'");
        expect(formatter.textAfterImport("using. Economy.Shop'Loc'")).toBe("");
        expect(formatter.extractPathFromImport("using. /a/b'; x := 5'")).toBe("/a/b'; x := 5'");
    });

    it("carries a qualified path through the dotted capture", () => {
        expect(formatter.extractPathFromImport("using. (/A/M:)M")).toBe("(/A/M:)M");
        expect(formatter.textAfterImport("using. (/A/M:)M")).toBe("");
    });

    // Neither branch matches an unbalanced `'`, so the capture ends before it.
    // The path is then a prefix of the real one, which is why the remainder has
    // to be left over: leftover text is what pins the line against a rebuild.
    it("ends the capture before content it cannot lex, leaving the remainder over", () => {
        expect(formatter.extractPathFromImport("using. /a/b'c")).toBe("/a/b");
        expect(formatter.textAfterImport("using. /a/b'c")).toBe("'c");
    });

    it("reports nothing for a line that writes no statement", () => {
        expect(formatter.textAfterImport("MyVal := 5")).toBe("");
    });

    it("a trailing comment does not change module-import classification", () => {
        // Without stripping, the `.` in a comment such as `# see Foo.Bar` made a
        // bare local-scope using look like a dotted module import.
        expect(ImportFormatter.isModuleImport("using. Instance # see Foo.Bar")).toBe(false);
        expect(ImportFormatter.isModuleImport("using. /Verse.org/Simulation # note")).toBe(true);
        expect(ImportFormatter.isModuleImport("using:", "    Features # note", { atFileScope: true })).toBe(true);
    });
});

describe("ImportFormatter.sortImportsByRank", () => {
    let formatter: ImportFormatter;

    beforeEach(() => {
        formatter = new ImportFormatter();
    });

    it("orders absolute paths before bare identifiers before dotted references", () => {
        expect(formatter.sortImportsByRank(["Economy.Shop", "/Verse.org/Simulation", "Features"])).toEqual(["/Verse.org/Simulation", "Features", "Economy.Shop"]);
    });

    it("keeps bare identifiers in their original input order", () => {
        expect(formatter.sortImportsByRank(["Zeta", "Economy.Shop", "Alpha"])).toEqual(["Zeta", "Alpha", "Economy.Shop"]);
    });

    it("alphabetizes absolute paths among themselves", () => {
        expect(formatter.sortImportsByRank(["/Verse.org/Simulation", "/Fortnite.com/Devices"])).toEqual(["/Fortnite.com/Devices", "/Verse.org/Simulation"]);
    });

    it("alphabetizes dotted references among themselves", () => {
        expect(formatter.sortImportsByRank(["Systems.Economy", "Features.Economy"])).toEqual(["Features.Economy", "Systems.Economy"]);
    });
});

describe("ImportFormatter.groupAndFormatImports", () => {
    let formatter: ImportFormatter;

    beforeEach(() => {
        formatter = new ImportFormatter();
    });

    it("digestFirst with sorting: local group orders the bare import before the dotted import that depends on it", () => {
        const result = formatter.groupAndFormatImports(["/Verse.org/Simulation", "Economy.Shop", "Features"], false, true, "digestFirst");
        expect(result).toEqual(["using { /Verse.org/Simulation }", "", "using { Features }", "using { Economy.Shop }"]);
    });

    it("grouping none with sorting: absolute paths first (alpha), then bare (input order), then dotted (alpha)", () => {
        const result = formatter.groupAndFormatImports(["Systems.Economy", "/Verse.org/Simulation", "Zeta", "/Fortnite.com/Devices", "Alpha", "Features.Economy"], false, true, "none");
        expect(result).toEqual(["using { /Fortnite.com/Devices }", "using { /Verse.org/Simulation }", "using { Zeta }", "using { Alpha }", "using { Features.Economy }", "using { Systems.Economy }"]);
    });

    it("grouping none without sorting: leaves the original order untouched", () => {
        const result = formatter.groupAndFormatImports(["Zeta", "Economy.Shop", "/Verse.org/Simulation"], false, false, "none");
        expect(result).toEqual(["using { Zeta }", "using { Economy.Shop }", "using { /Verse.org/Simulation }"]);
    });

    it("digestFirst without sorting: leaves the original order untouched within each group", () => {
        const result = formatter.groupAndFormatImports(["Zeta", "/Verse.org/Simulation", "Economy.Shop"], false, false, "digestFirst");
        expect(result).toEqual(["using { /Verse.org/Simulation }", "", "using { Zeta }", "using { Economy.Shop }"]);
    });

    it("localFirst with sorting: local group precedes the digest group", () => {
        const result = formatter.groupAndFormatImports(["/Verse.org/Simulation", "Economy.Shop", "Features"], false, true, "localFirst");
        expect(result).toEqual(["using { Features }", "using { Economy.Shop }", "", "using { /Verse.org/Simulation }"]);
    });

    // An out-of-enum value reaches here from a hand-edited settings.json, a case
    // mismatch, a workspace settings file carried from an older version, or a
    // future rename of an enum member. Dropping every import would silently
    // delete the user's source, so an unrecognised value degrades to "none".
    it.each(["typo", "digestfirst", "", "None"])("an unrecognised grouping value %p falls back to ungrouped output instead of dropping imports", (grouping) => {
        const paths = ["/Verse.org/Simulation", "Features", "Features.Economy"];
        const result = formatter.groupAndFormatImports(paths, false, false, grouping);
        expect(result).toEqual(["using { /Verse.org/Simulation }", "using { Features }", "using { Features.Economy }"]);
    });

    it("an unrecognised grouping value still honours sorting", () => {
        const result = formatter.groupAndFormatImports(["Economy.Shop", "/Verse.org/Simulation", "Features"], false, true, "typo");
        expect(result).toEqual(["using { /Verse.org/Simulation }", "using { Features }", "using { Economy.Shop }"]);
    });
});
