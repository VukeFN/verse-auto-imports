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

    it("returns entries in document order with correct spans across mixed styles", () => {
        const lines = ["using { /A }", "using:", "    /B", "using. /C"];
        expect(scanModuleImports(lines)).toEqual([
            { path: "/A", startLine: 0, endLine: 0 },
            { path: "/B", startLine: 1, endLine: 2 },
            { path: "/C", startLine: 3, endLine: 3 },
        ]);
    });
});
