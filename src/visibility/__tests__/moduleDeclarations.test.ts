import { findExplicitModuleDeclarations } from "../moduleDeclarations";

describe("findExplicitModuleDeclarations", () => {
    it("finds the colon form", () => {
        const declarations = findExplicitModuleDeclarations("Tools := module:\n    X:int = 1\n");

        expect(declarations).toHaveLength(1);
        expect(declarations[0]).toMatchObject({ name: "Tools", chain: ["Tools"], line: 1 });
        expect(declarations[0].visibility).toBeUndefined();
    });

    it("finds the brace form, opened on the same line or the next", () => {
        const declarations = findExplicitModuleDeclarations("A := module {}\nB := module\n{\n}\n");

        expect(declarations.map((declaration) => declaration.name)).toEqual(["A", "B"]);
    });

    it("finds the dotted form and nests what follows it on the line", () => {
        const declarations = findExplicitModuleDeclarations("Inventory := module. Item := module {}\n");

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Inventory"], ["Inventory", "Item"]]);
    });

    it("captures a visibility specifier and its span", () => {
        const content = "Tools<public> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility).toEqual({ start: 5, end: 13, keyword: "public" });
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<public>");
    });

    it("picks the visibility out of a stacked specifier block", () => {
        const content = "Tools<internal><final> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility?.keyword).toBe("internal");
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<internal>");
    });

    it("spans the whole of a scoped specifier, module list included", () => {
        const content = "Tools<scoped{ModuleA, ModuleB}> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility?.keyword).toBe("scoped");
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<scoped{ModuleA, ModuleB}>");
    });

    it("captures epic_internal, which read as a bare declaration would get a second specifier stacked beside it", () => {
        const content = "Tools<epic_internal> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility?.keyword).toBe("epic_internal");
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<epic_internal>");
    });

    it("reads a named access level, which no keyword list can reach", () => {
        const content = "Tools<SharedScope> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility?.keyword).toBe("SharedScope");
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<SharedScope>");
    });

    it("prefers a keyword entry to a bare identifier stacked beside it", () => {
        const content = "Tools<final><public> := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(declaration.visibility?.keyword).toBe("public");
        expect(content.slice(declaration.visibility!.start, declaration.visibility!.end)).toBe("<public>");
    });

    it("leaves an entry carrying arguments alone, since a named access level is written bare", () => {
        const [declaration] = findExplicitModuleDeclarations("Tools<available{MinUploadedAtFNVersion := 3000}> := module {}\n");

        expect(declaration.visibility).toBeUndefined();
    });

    it("points the insertion point at the end of the name when there is no specifier", () => {
        const content = "Tools := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(content.slice(0, declaration.insertionPoint)).toBe("Tools");
    });

    it("keeps a quoted suffix, which is part of the identifier and of the path", () => {
        const [declaration] = findExplicitModuleDeclarations("Tools'v2' := module {}\n");

        expect(declaration.name).toBe("Tools'v2'");
    });

    it("nests by indentation", () => {
        const declarations = findExplicitModuleDeclarations("Outer := module:\n    Inner := module:\n        Deep := module {}\nSibling := module {}\n");

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Outer"], ["Outer", "Inner"], ["Outer", "Inner", "Deep"], ["Sibling"]]);
    });

    it("closes a module when indentation returns to its level", () => {
        const declarations = findExplicitModuleDeclarations("Outer := module:\n    Inner := module {}\n    Other := module {}\n");

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Outer"], ["Outer", "Inner"], ["Outer", "Other"]]);
    });

    it("nests a braced module's members where they sit at or left of its own indent", () => {
        const content = "Systems<scoped{ModuleA}> := module{\nB<public> := module:\n    X<public> := module {}\n}\nLater := module {}\n";

        const declarations = findExplicitModuleDeclarations(content);

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Systems"], ["Systems", "B"], ["Systems", "B", "X"], ["Later"]]);
    });

    it("nests the same way when the brace opens the body on the next line", () => {
        const content = "Systems := module\n{\nB := module:\n    X:int = 1\n}\nLater := module {}\n";

        const declarations = findExplicitModuleDeclarations(content);

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Systems"], ["Systems", "B"], ["Later"]]);
    });

    it("keeps the chain of braces opened on one line", () => {
        const declarations = findExplicitModuleDeclarations("M := module{ N := module{\n}}\n");

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["M"], ["M", "N"]]);
    });

    it("holds a braced module open through a colon module written at its indent", () => {
        const content = "Outer := module:\n    Inner := module{\n    Leaf := module:\n        Y:int = 1\n    }\nSibling := module:\n";

        const declarations = findExplicitModuleDeclarations(content);

        expect(declarations.map((declaration) => declaration.chain)).toEqual([["Outer"], ["Outer", "Inner"], ["Outer", "Inner", "Leaf"], ["Sibling"]]);
    });

    it("leaves a single-quoted brace out of the depth that closes a module", () => {
        // A quoted suffix cannot hold a brace, so one between quotes delimits
        // nothing; counting it would strand the depth for the rest of the file.
        const held = "Systems := module{\nOpen:char = '{'\nB := module:\n    X:int = 1\n}\nLater := module {}\n";
        expect(findExplicitModuleDeclarations(held).map((declaration) => declaration.chain)).toEqual([["Systems"], ["Systems", "B"], ["Later"]]);

        const closed = "Systems := module{\nShut:char = '}'\nB := module:\n    X:int = 1\n}\nLater := module {}\n";
        expect(findExplicitModuleDeclarations(closed).map((declaration) => declaration.chain)).toEqual([["Systems"], ["Systems", "B"], ["Later"]]);
    });

    it("skips a declaration inside a line comment", () => {
        expect(findExplicitModuleDeclarations("# Ghost := module {}\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("reports one-based lines", () => {
        const declarations = findExplicitModuleDeclarations("\n\nTools := module {}\n");

        expect(declarations[0].line).toBe(3);
    });

    it("does not match a name that only starts with module", () => {
        expect(findExplicitModuleDeclarations("Inventory := modulex\n")).toEqual([]);
    });
});
