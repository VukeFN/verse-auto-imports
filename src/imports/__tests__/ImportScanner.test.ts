import { scanModuleImports } from "../ImportScanner";

describe("scanModuleImports", () => {
    it("collects a braced import at column 0 with a single-line span", () => {
        expect(scanModuleImports(["using { /Verse.org/Simulation }", "code()"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 0 }]);
    });

    it("collects a dotted-style import", () => {
        expect(scanModuleImports(["using. /Verse.org/Simulation"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 0 }]);
    });

    it("consumes the indented using: pair as one two-line entry", () => {
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation", "code()"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 1 }]);
    });

    it("strips a trailing comment from a scanned import path, in all three styles", () => {
        expect(scanModuleImports(["using { /Verse.org/Simulation } # keep me"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 0 }]);
        expect(scanModuleImports(["using. /Verse.org/Simulation # keep me"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 0 }]);
        expect(scanModuleImports(["using:", "    /Verse.org/Simulation # keep me", "code()"])).toEqual([{ path: "/Verse.org/Simulation", startLine: 0, endLine: 1 }]);
    });

    it("skips a using: line whose indented next line is nothing but a comment", () => {
        expect(scanModuleImports(["using:", "    # just a note", "code()"])).toEqual([]);
    });

    it("collects dot-notation module references", () => {
        expect(scanModuleImports(["using { Gadgets.Tools }"])).toEqual([{ path: "Gadgets.Tools", startLine: 0, endLine: 0 }]);
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
        expect(scanModuleImports(["using { Features }"])).toEqual([{ path: "Features", startLine: 0, endLine: 0 }]);
    });

    it("skips local-scope using inside a function body", () => {
        const lines = ["F():void =", "    using { LocalVar }", "    code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("skips a using: line whose next line is not an indented path", () => {
        expect(scanModuleImports(["using:", "code()"])).toEqual([]);
    });

    it("handles CRLF line endings", () => {
        expect(scanModuleImports(["using { /A }\r", "code()\r"])).toEqual([{ path: "/A", startLine: 0, endLine: 0 }]);
    });

    it("skips an import commented out with a block comment", () => {
        const lines = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([]);
    });

    it("resumes scanning after a block comment closes", () => {
        const lines = ["<#", "using { /Old/Path }", "#>", "using { /Verse.org/Simulation }", "", "code()"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 3, endLine: 3 }]);
    });

    it("skips an import inside a block comment opened and closed on one line", () => {
        expect(scanModuleImports(["<# using { /Old/Path } #>", "using { /A }"])).toEqual([{ path: "/A", startLine: 1, endLine: 1 }]);
    });

    it("keeps an import whose line opens a block comment after it", () => {
        const lines = ["using { /A } <# disabled below", "using { /Old/Path }", "#>", "using { /B }"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0 },
            { path: "/B", startLine: 3, endLine: 3 },
        ]);
    });

    it("treats block comments as nesting, so an inner close does not resume scanning", () => {
        const lines = ["<#", "<#", "using { /Inner }", "#>", "using { /Outer }", "#>", "using { /Live }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Live", startLine: 6, endLine: 6 }]);
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
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 2, endLine: 2 }]);
    });

    it("does not treat a <# inside a line comment as a block opener", () => {
        const lines = ["# a block comment opens with <#", "using { /Verse.org/Simulation }"];
        expect(scanModuleImports(lines)).toEqual([{ path: "/Verse.org/Simulation", startLine: 1, endLine: 1 }]);
    });

    it("returns entries in document order with correct spans across mixed styles", () => {
        const lines = ["using { /A }", "using:", "    /B", "using. /C"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0 },
            { path: "/B", startLine: 1, endLine: 2 },
            { path: "/C", startLine: 3, endLine: 3 },
        ]);
    });
});
