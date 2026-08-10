import { findExplicitModuleDeclarations } from "../moduleDeclarations";
import { VisibilitySegment } from "../ModuleVisibilityPlanner";
import { FoundDeclaration, resolveVisibility } from "../visibilityResolution";

/** The declarations one file's text carries, bound to the directory it sits in. */
const declarationsIn = (file: string, directory: string, content: string): FoundDeclaration[] =>
    findExplicitModuleDeclarations(content).map((declaration) => ({
        path: [...(directory ? directory.split("/") : []), ...declaration.chain].join("/"),
        file,
        declaration,
    }));

const segments = (...names: [string, boolean][]): VisibilitySegment[] => names.map(([name, needsPublic]) => ({ name, needsPublic }));

describe("resolveVisibility", () => {
    it("writes the whole chain when nothing is declared yet", () => {
        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), []);

        expect(resolved.edits).toEqual([]);
        expect(resolved.chain).toEqual([
            { name: "Gadgets", specifier: undefined },
            { name: "Tools", specifier: "public" },
        ]);
        expect(resolved.conflicts).toEqual([]);
    });

    it("edits an existing declaration instead of writing a second part", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.chain).toEqual([]);
        expect(resolved.edits).toEqual([{ file: "file://a", path: "Gadgets/Tools", span: undefined, offset: 5, text: "<public>" }]);
    });

    it("rewrites every part of a module, since later parts must repeat the specifier", () => {
        const found = [...declarationsIn("file://a", "Gadgets", "Tools := module {}\n"), ...declarationsIn("file://b", "Gadgets", "Tools := module:\n    X:int = 1\n")];

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits.map((edit) => edit.file)).toEqual(["file://a", "file://b"]);
    });

    it("replaces a non-public specifier rather than stacking another", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<internal> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([{ file: "file://a", path: "Gadgets/Tools", span: { start: 5, end: 15 }, offset: 5, text: "<public>" }]);
    });

    it("does nothing for a module already declared public", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<public> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([]);
        expect(resolved.chain).toEqual([]);
    });

    it("repeats an existing parent specifier in the written chain, so the parts cannot disagree", () => {
        const found = declarationsIn("file://a", "", "Gadgets<internal> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.chain).toEqual([
            { name: "Gadgets", specifier: "internal" },
            { name: "Tools", specifier: "public" },
        ]);
    });

    it("reports a deliberate narrowing as a conflict rather than widening it", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<private> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Gadgets/Tools", keyword: "private" }]);
        expect(resolved.edits).toEqual([]);
    });

    it("addresses a segment by its full path, so a namesake elsewhere is not touched", () => {
        const found = declarationsIn("file://elsewhere", "Other", "Tools := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([]);
        expect(resolved.chain).toEqual([
            { name: "Gadgets", specifier: undefined },
            { name: "Tools", specifier: "public" },
        ]);
    });

    it("addresses segments below a shared prefix", () => {
        const found = declarationsIn("file://a", "A/B/C", "D := module {}\n");

        const resolved = resolveVisibility(["A", "B"], segments(["C", false], ["D", true]), found);

        expect(resolved.edits.map((edit) => edit.file)).toEqual(["file://a"]);
    });

    it("carries the shared prefix into the chain, which is written at the Content root", () => {
        // Without the prefix the block would declare /proj/Gadgets/Tools, a
        // module unrelated to the target under Systems.
        const resolved = resolveVisibility(["Systems"], segments(["Gadgets", false], ["Tools", true]), []);

        expect(resolved.chain).toEqual([
            { name: "Systems", specifier: undefined },
            { name: "Gadgets", specifier: undefined },
            { name: "Tools", specifier: "public" },
        ]);
    });

    it("repeats a prefix module's declared specifier, so the nesting part cannot disagree", () => {
        const found = declarationsIn("file://a", "", "Systems<public> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility(["Systems"], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.chain[0]).toEqual({ name: "Systems", specifier: "public" });
        // The prefix is reachable already, so nothing about it is rewritten.
        expect(resolved.edits).toEqual([]);
    });

    it("names the module path on each edit, for the report to the user", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits.map((edit) => edit.path)).toEqual(["Gadgets/Tools"]);
    });

    it("trims the chain to the deepest module it actually has to write", () => {
        const found = declarationsIn("file://a", "Gadgets/Deep", "Tools := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Deep", true], ["Tools", true]), found);

        // Deep still needs writing, Tools is edited in place, so the chain stops
        // at Deep rather than carrying a redundant Tools part.
        expect(resolved.chain).toEqual([
            { name: "Gadgets", specifier: undefined },
            { name: "Deep", specifier: "public" },
        ]);
        expect(resolved.edits.map((edit) => edit.text)).toEqual(["<public>"]);
    });
});
