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
        // An empty span at the end of the name is the insertion of a specifier
        // where the declaration carries none.
        expect(resolved.edits).toEqual([{ file: "file://a", path: "Gadgets/Tools", span: { start: 5, end: 5 }, text: "<public>" }]);
    });

    it("edits a declaration nested in a braced module whose members sit at its own indent", () => {
        const found = declarationsIn("file://a", "Gadgets", "Systems := module{\nTools := module:\n    X:int = 1\n}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Systems", false], ["Tools", true]), found);

        // A chain here would be a second part of a module that is already
        // declared, written under a path this declaration does not carry.
        expect(resolved.chain).toEqual([]);
        expect(resolved.edits).toEqual([{ file: "file://a", path: "Gadgets/Systems/Tools", span: { start: 24, end: 24 }, text: "<public>" }]);
    });

    it("rewrites the real declaration of a module following a braced body written left of its declaration", () => {
        const content = "Outer := module:\n    Inner := module{\nMember := module:\n    Q:int = 1\n    }\n    Kept<internal> := module {}\n";
        const found = declarationsIn("file://a", "Gadgets", content);

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Outer", false], ["Kept", true]), found);

        expect(resolved.chain).toEqual([]);
        expect(resolved.edits).toHaveLength(1);
        expect(resolved.edits[0]).toMatchObject({ file: "file://a", path: "Gadgets/Outer/Kept", text: "<public>" });
        // The specifier that is really there is rewritten. A second part
        // declaring a different one is ErrSemantic_MismatchedPartialAttributes.
        expect(content.slice(resolved.edits[0].span.start, resolved.edits[0].span.end)).toBe("<internal>");
    });

    it("rewrites every part of a module, since later parts must repeat the specifier", () => {
        const found = [...declarationsIn("file://a", "Gadgets", "Tools := module {}\n"), ...declarationsIn("file://b", "Gadgets", "Tools := module:\n    X:int = 1\n")];

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits.map((edit) => edit.file)).toEqual(["file://a", "file://b"]);
    });

    it("replaces a non-public specifier rather than stacking another", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<internal> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([{ file: "file://a", path: "Gadgets/Tools", span: { start: 5, end: 15 }, text: "<public>" }]);
    });

    it("reports a named access level rather than stacking a specifier beside it", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<SharedScope> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([]);
        expect(resolved.conflicts).toEqual([{ path: "Gadgets/Tools", keyword: "SharedScope", reason: "widen" }]);
    });

    it("does nothing for a module already declared public", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<public> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.edits).toEqual([]);
        expect(resolved.chain).toEqual([]);
    });

    it("reports a parent the chain would have to repeat, rather than writing a second definition of it", () => {
        const found = declarationsIn("file://a", "", "Gadgets<internal> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Gadgets", keyword: "internal", reason: "repeat" }]);
        // The chain still carries what a write would have put in the file, as
        // the narrowed path does. The conflict is what stops it.
        expect(resolved.chain).toEqual([
            { name: "Gadgets", specifier: "internal" },
            { name: "Tools", specifier: "public" },
        ]);
    });

    it("reports a repeat of a bare declaration, which carries no keyword to name", () => {
        const found = declarationsIn("file://a", "", "Gadgets := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        // The compiler's duplicate-definition check turns on the existing
        // declaration being explicit, not on either part's specifier, so a bare
        // repeat is a second definition exactly as an attributed one is.
        expect(resolved.conflicts).toEqual([{ path: "Gadgets", reason: "repeat" }]);
        expect(resolved.conflicts[0].keyword).toBeUndefined();
    });

    it("says nothing about a repeat the trim drops, since an unwritten part defines nothing", () => {
        const found = declarationsIn("file://a", "", "Gadgets := module:\n    Tools := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.chain).toEqual([]);
        expect(resolved.conflicts).toEqual([]);
        expect(resolved.edits.map((edit) => edit.path)).toEqual(["Gadgets/Tools"]);
    });

    it("reports a deliberate narrowing as a conflict rather than widening it", () => {
        const found = declarationsIn("file://a", "Gadgets", "Tools<private> := module {}\n");

        const resolved = resolveVisibility([], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Gadgets/Tools", keyword: "private", reason: "widen" }]);
        expect(resolved.edits).toEqual([]);
    });

    it("reports a scoped module the chain would nest through, rather than repeating a specifier it cannot reproduce", () => {
        const found = declarationsIn("file://a", "", "Systems<scoped{ModuleA, ModuleB}> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Systems", false], ["Deep", true], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Systems", keyword: "scoped", reason: "nest" }]);
        // `<scoped>` alone is not the declared specifier and does not compile;
        // the nesting part is written bare, and the conflict stops it anyway.
        expect(resolved.chain[0]).toEqual({ name: "Systems" });
        expect(resolved.edits).toEqual([]);
    });

    it("reports an epic_internal module the chain would nest through", () => {
        const found = declarationsIn("file://a", "", "Systems<epic_internal> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Systems", false], ["Deep", true], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Systems", keyword: "epic_internal", reason: "nest" }]);
        expect(resolved.chain[0]).toEqual({ name: "Systems" });
    });

    it("reports a private module the chain would nest through, which used to be nested into silently", () => {
        const found = declarationsIn("file://a", "", "Systems<private> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility([], segments(["Systems", false], ["Deep", true], ["Tools", true]), found);

        // A part repeating `<private>` compiles, and for an importer in the
        // declaring scope it resolves the error too, which is why this one went
        // unnoticed. It is refused because declaring new public modules inside
        // a private boundary is a decision for whoever drew it.
        expect(resolved.conflicts).toEqual([{ path: "Systems", keyword: "private", reason: "nest" }]);
    });

    it("leaves a scoped module alone when no written chain nests through it", () => {
        const found = [
            ...declarationsIn("file://a", "", "Systems<scoped{ModuleA, ModuleB}> := module:\n    X:int = 1\n"),
            ...declarationsIn("file://b", "Systems", "Deep := module:\n    Tools := module {}\n"),
        ];

        const resolved = resolveVisibility([], segments(["Systems", false], ["Deep", true], ["Tools", true]), found);

        // Everything below Systems is declared already, so nothing is written
        // through it and its narrowing is nobody's business.
        expect(resolved.conflicts).toEqual([]);
        expect(resolved.chain).toEqual([]);
        expect(resolved.edits.map((edit) => edit.path)).toEqual(["Systems/Deep", "Systems/Deep/Tools"]);
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

    it("reports a repeat of a prefix module, which a written part defines a second time whether or not it is reachable", () => {
        const found = declarationsIn("file://a", "", "Systems<public> := module:\n    X:int = 1\n");

        const resolved = resolveVisibility(["Systems"], segments(["Gadgets", false], ["Tools", true]), found);

        expect(resolved.conflicts).toEqual([{ path: "Systems", keyword: "public", reason: "repeat" }]);
        // The specifier is still repeated in the chain the conflict describes:
        // a part that disagreed would be a second defect, not a remedy.
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
