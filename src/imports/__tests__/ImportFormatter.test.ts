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
