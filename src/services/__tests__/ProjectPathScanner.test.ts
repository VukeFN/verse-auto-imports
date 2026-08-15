import { ProjectPathScanner } from "../ProjectPathScanner";
import { ProjectPathNode } from "../../types";

/**
 * Regression tests for issue #282: the scanner's module pattern ended at `:`,
 * so a module written in either of the other two styles Verse gives a macro
 * body was dropped from the declaration cache entirely - the fall-through
 * variable pattern matched the `:` of `:=` and its guard then skipped the line
 * for naming `module`, leaving every reader of the cache blind to it.
 *
 * extractDeclarations is pure, so these run without the VS Code runtime.
 */
describe("ProjectPathScanner.extractDeclarations module forms", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declare = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse");

    const declareAll = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse", { includePrivate: true });

    const moduleNames = (source: string): string[] =>
        declare(source)
            .filter((node) => node.type === "module")
            .map((node) => node.name);

    it("records a module whose brace opens on the declaration line", () => {
        expect(moduleNames("Inventory := module{}\n")).toEqual(["Inventory"]);
        expect(moduleNames("Inventory := module { }\n")).toEqual(["Inventory"]);
    });

    it("records a module whose brace opens on the following line", () => {
        expect(moduleNames("Inventory := module\n{\n    Count<public>:int = 0\n}\n")).toEqual(["Inventory"]);
    });

    it("records the module at the head of a dotted declaration", () => {
        // Only the head: the scan is line-anchored, so the second declaration
        // on the line is out of its reach either way.
        expect(moduleNames("Inventory := module. Item := module{}\n")).toEqual(["Inventory"]);
    });

    it("accepts the `>` terminator its sibling in ImportPathConverter accepts", () => {
        expect(moduleNames("Inventory := module>\n")).toEqual(["Inventory"]);
    });

    it("still records the colon form, and nests what a braced module contains", () => {
        expect(moduleNames("Inventory := module:\n    Count:int = 0\n")).toEqual(["Inventory"]);

        const nested = declare("Inventory := module {\n    Item := class {}\n}\n");
        expect(nested.map((node) => [node.type, node.fullPath])).toEqual([
            ["module", "Inventory"],
            ["class", "Inventory.Item"],
        ]);
    });

    it("nests the members of a next-line brace module", () => {
        const nested = declare("Inventory := module\n{\n    Item := class {}\n}\n");
        expect(nested.map((node) => [node.type, node.fullPath])).toEqual([
            ["module", "Inventory"],
            ["class", "Inventory.Item"],
        ]);
    });

    it("closes a next-line brace module at its closing brace", () => {
        const source = "Inventory := module\n{\n    Item := class {}\n}\nLoose := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item", "Loose"]);
    });

    it("still waits for the brace across the blank lines and comments Verse allows before it", () => {
        const source = "Inventory := module\n\n# opening below\n{\n    Item := class {}\n}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("closes a module whose declaration line opened no body and no brace followed", () => {
        // Not valid Verse, so this pins degradation rather than a shape a user
        // can compile: the wait lasts one line, so a module missing its body
        // cannot swallow the rest of the file.
        const source = "Inventory := module\nLoose := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Loose"]);
    });

    it("keeps reading the visibility specifier attached to the name", () => {
        const [declared] = declare("Inventory<public> := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true, sourceLine: 1 });

        expect(moduleNames("Hidden<private> := module {}\n")).toEqual([]);
    });

    it("skips a module whose visibility entry runs past its keyword", () => {
        expect(moduleNames("Systems<scoped{ModuleA, ModuleB}> := module {}\n")).toEqual([]);
        expect(moduleNames("Systems<epic_internal> := module {}\n")).toEqual([]);
        expect(moduleNames("Systems<final><scoped{ModuleA}> := module {}\n")).toEqual([]);
    });

    it("reads a visibility padded inside its brackets", () => {
        const [declared] = declare("Inventory<  public  > := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true });
    });

    it("does not read a following specifier as the visibility entry's tail", () => {
        const [declared] = declare("Inventory<public><native> := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true });
    });

    it("keeps a module carrying a named scope alias, which reads as no specifier", () => {
        // Pins the limit rather than endorsing it: `SharedScope := scoped{A, B}`
        // makes the specifier an ordinary identifier, indistinguishable from
        // <final> or any other non-visibility attribute without resolving the
        // alias, so the module is still offered as an import candidate that
        // does not compile.
        expect(moduleNames("Systems<SharedScope> := module {}\n")).toEqual(["Systems"]);
        expect(moduleNames("Systems<scoped_X> := module {}\n")).toEqual(["Systems"]);
    });

    it("drops a skipped module's descendants along with it", () => {
        // Every segment from the root has to be accessible for an import to
        // compile, so what a skipped module contains is exactly as unreachable
        // as the module itself. Recording the subtree without its enclosing
        // segment would offer a path that does not exist, and would collide
        // with a genuine top-level module of the same name.
        expect(declare("Systems<scoped{ModuleA}> := module:\n    Inner<public> := module:\n")).toEqual([]);
        expect(declare("Systems<private> := module:\n    Inner<public> := module:\n")).toEqual([]);
    });

    it("drops a skipped module's grandchildren too", () => {
        expect(declare("Systems<private> := module:\n    Inner<public> := module:\n        Deep<public> := class {}\n")).toEqual([]);
    });

    it("drops the subtree of a skipped module whose body opens on the next line", () => {
        // The brace form reaches the skip through a different route than the
        // colon form: the module has to survive its own opening brace before
        // the skip can hold its subtree at all.
        const source =
            "Systems<scoped{ModuleA}> := module\n{\n    Inner<public> := module\n    {\n        Deep<public> := class {}\n    }\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("nests a kept module's subtree through a next-line brace body", () => {
        const source = "Systems<public> := module\n{\n    Inner<public> := module\n    {\n        Deep<public> := class {}\n    }\n}\nLoose<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Inner", "Systems.Inner.Deep", "Loose"]);
    });

    it("records a sibling declared after a skipped module closes", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n\nInventory<public> := module:\n    Item<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("resumes the enclosing module after a skipped one nested in it closes", () => {
        // The skipped entry is popped back to a kept parent rather than to an
        // empty stack, so a wrong pop bound shows up here as a missing `Outer.`
        // prefix instead of as a dropped declaration.
        const source = "Outer<public> := module:\n    Hidden<private> := module:\n        Deep<public> := class {}\n    Kept<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Kept"]);
    });

    it("keeps a skipped module's subtree, nested, when includePrivate lifts the skip", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n        Deep<public> := class {}\n";
        expect(declareAll(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Inner", "Systems.Inner.Deep"]);
    });

    it("does not read a keyword that merely starts with module as a declaration", () => {
        expect(moduleNames("Inventory := modulex\n")).toEqual([]);
    });

    // Verse delimits a braced body by its braces alone, so its members may sit
    // at or left of the declaration's own indent - the Book of Verse writes it
    // that way in a compile-validated example. Closing such a module on
    // indentation lets its first member pop it, which promotes the whole body
    // to file scope: paths one segment short under a kept parent, and under a
    // skipped one a subtree the compiler rejects, offered beside any genuine
    // top-level module of the same name.
    describe("braced module bodies", () => {
        it("nests the members of a same-line brace body written at the module's own indent", () => {
            const source = "Systems<public> := module{\nB<public> := module:\n    X<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Systems.B.X", "Loose"]);
        });

        it("nests the members of a next-line brace body written at the module's own indent", () => {
            const source = "Systems<public> := module\n{\nB<public> := module:\n    X<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Systems.B.X", "Loose"]);
        });

        it("nests members written left of the declaration's own indent", () => {
            const source = "Outer<public> := module:\n    Inner<public> := module{\nX<public> := class {}\n    }\n    Kept<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Inner", "Outer.Inner.X", "Outer.Kept"]);
        });

        it("drops the subtree of a skipped same-line brace module written at its own indent", () => {
            const source = "Systems<scoped{ModuleA}> := module{\nB<public> := module:\n    X<public> := class {}\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
        });

        it("drops the subtree of a skipped next-line brace module written at its own indent", () => {
            const source = "Systems<scoped{ModuleA}> := module\n{\nB<public> := module:\n    X<public> := class {}\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
        });

        it("closes each of a nested colon and brace module by its own rule", () => {
            // Both directions at once: a braced body holding a colon module,
            // that colon body holding a braced one. A rule leaking from either
            // to the other shows up here as a lost or a surplus segment.
            const source = "A<public> := module{\nB<public> := module:\n    C<public> := module{\nD<public> := class {}\n    }\n    E<public> := class {}\n}\nF<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["A", "A.B", "A.B.C", "A.B.C.D", "A.B.E", "F"]);
        });

        it("keeps a brace written as a char literal out of the depth", () => {
            // Masking cannot blank a char literal, because a single quote opens
            // an identifier's quoted suffix too. A brace cannot appear in such
            // a suffix, so one between quotes is always a literal, and counting
            // it would hold the module open for the rest of the file.
            const held = "Systems<public> := module{\nOpen<public>:char = '{'\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(held).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Open", "Systems.B", "Loose"]);

            const closed = "Systems<public> := module{\nShut<public>:char = '}'\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(closed).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Shut", "Systems.B", "Loose"]);
        });

        it("keeps the brace of a using clause out of the depth that closes the module holding it", () => {
            // A braced `using` clause spans lines and is skipped a line at a
            // time, so counting its `}` without its `{` would close the module
            // around it one brace early.
            const source = "Systems<public> := module{\nusing{\n    /Verse.org/Simulation\n}\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Loose"]);
        });

        // A colon module written left of the braced declaration it sits inside
        // reads as open on indentation at every line indented past it, so
        // closing only from the top of the stack stops there and never reaches
        // the braced entry whose `}` has already passed. The braced entry then
        // prefixes everything after it, and a `fullPath` one or more segments
        // too long names a module that does not exist at that path.
        describe("a closed braced body is left by the modules it shields", () => {
            it("returns a sibling to the enclosing module when the braced body it follows was written left of its declaration", () => {
                const source = "Outer := module:\n    A := module{\nB := module:\n    Q:int = 1\n    }\n    C := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.A", "Outer.A.B", "Outer.A.B.Q", "Outer.C"]);
            });

            it("returns the sibling through two colon levels above the brace", () => {
                const source = "L1 := module:\n    L2 := module:\n        A := module{\nB := module:\n    Q:int = 1\n        }\n        C := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["L1", "L1.L2", "L1.L2.A", "L1.L2.A.B", "L1.L2.A.B.Q", "L1.L2.C"]);
            });

            it("returns the sibling where it is written past the closed body's own indent", () => {
                // The truncation is driven by the depth alone, so a sibling
                // indented deeper than the body it follows still leaves it.
                const source = "Outer := module:\n    A := module{\nB := module:\n    Q:int = 1\n    }\n        C := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.A", "Outer.A.B", "Outer.A.B.Q", "Outer.C"]);
            });

            it("returns the sibling the same way when the brace opened the body on the next line", () => {
                const source = "Outer := module:\n    Inner := module\n    {\nMember := module:\n    Q:int = 1\n    }\n    Kept := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Inner", "Outer.Inner.Member", "Outer.Inner.Member.Q", "Outer.Kept"]);
            });

            it("closes one braced body of several without closing those still open around it", () => {
                const source = "Systems := module{\nB := module:\n    C := module{\nD := module:\n        Z:int = 1\n    }\n    E := module {}\n}\nSibling := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Systems.B.C", "Systems.B.C.D", "Systems.B.C.D.Z", "Systems.B.E", "Sibling"]);
            });

            it("closes the inner body where the shielding module's own body ended at column zero", () => {
                const source = "A := module{\nB := module:\n    C := module{\nD := module:\n    Q:int = 1\n}\n    E := module {}\n}\nZ := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["A", "A.B", "A.B.C", "A.B.C.D", "A.B.C.D.Q", "A.B.E", "Z"]);
            });

            it("takes two colon levels along when the braced body holding them closes", () => {
                // The other direction of the same cut: everything the closed
                // body contained goes with it in one truncation, and the
                // declaration after it starts from the file again.
                const source = "Outer := module{\n    C := module:\n        D := module:\n            Q:int = 1\n}\nAfter := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.C", "Outer.C.D", "Outer.C.D.Q", "After"]);
            });

            it("keeps a module open whose brace depth a stray closing brace drove below zero", () => {
                // A `}` ahead of any declaration makes the depth negative, so a
                // module opened after it records a negative close depth. The
                // truncation test has to keep holding there, rather than firing
                // at the outermost entry for every later line.
                const source = "}\nOuter := module{\nInner := module:\n    Q:int = 1\n}\nAfter := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Inner", "Outer.Inner.Q", "After"]);
            });

            it("leaves a braced module a stray closing brace ended before the next one opens", () => {
                const source = "A := module{\nX:int = 1\n}\n}\nB := module{\nY:int = 1\n}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["A", "A.X", "B", "B.Y"]);
            });
        });

        // A skipped module the colon form delimits is held open by indentation
        // alone, and a braced body opened inside it may write its members back
        // at that indent - which pops the skipped entry unless the braced body
        // has an entry of its own carrying the depth it closes at. Without one
        // the scan believes it is at file scope while still inside the subtree,
        // and offers its modules as top-level candidates: paths the compiler
        // rejects at their first segment, colliding with any genuine top-level
        // module of the same name.
        describe("a braced body inside a skipped module", () => {
            it("holds the skipped module open across a member written back at its indent", () => {
                const source = "Systems<private> := module:\n    Inner := module{\nX := module {}\n    }\nInventory := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory"]);
            });

            it("holds it open for a scoped module the same way", () => {
                const source = "Systems<scoped{ModuleA}> := module:\n    Inner := module{\nX := module {}\n    }\nInventory := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory"]);
            });

            it("holds it open where the brace opened the body on the next line", () => {
                const source = "Systems<private> := module:\n    Inner := module\n    {\nX := module {}\n    }\nInventory := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory"]);
            });

            it("returns a sibling after the skipped body to file scope, its own members included", () => {
                // A sibling recorded without its members, or with a `Systems.`
                // prefix, is the same wrong pop bound reported the other way up.
                const source = "Systems<private> := module:\n    Inner := module{\nX := module {}\n    }\nInventory := module:\n    Item := class {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
            });

            it("keeps dropping the colon-only form, which indentation alone already bounded", () => {
                const source = "Systems<private> := module:\n    Inner := module:\n        X := module:\n            Deep := class {}\nInventory := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory"]);
            });

            it("returns a kept parent's sibling to the parent rather than to file scope", () => {
                // The other harm the untracked body caused: the scan reached
                // file scope inside the subtree, so a declaration after it
                // rejoined at no prefix instead of at the module it sits in.
                const source = "Keep := module:\n    Systems<private> := module:\n        Inner := module{\nX := module {}\n        }\n    Kept := class {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual(["Keep", "Keep.Kept"]);
            });

            it("runs an unclosed body inside the skipped module to the file end", () => {
                // Not valid Verse, so this pins degradation rather than a shape
                // a user can compile: the body no brace closed costs the
                // declarations after it, which is what the kept path already
                // does, rather than offering them at a path that does not exist.
                const source = "Systems<private> := module:\n    Inner := module{\nX := module {}\nInventory := module {}\n";
                expect(declare(source).map((node) => node.fullPath)).toEqual([]);
            });
        });
    });
});

/**
 * The class, struct and interface patterns ended at their keyword with no word
 * boundary, and everything after it is optional, so each matched the prefix of
 * any identifier beginning with one of those words.
 *
 * A declaration recorded as a type is what tells a dotted suggestion where the
 * module path ends, so a call misread as a class makes every segment after it
 * address members of a type that does not exist.
 */
describe("ProjectPathScanner.extractDeclarations declaration keyword boundary", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const typed = (source: string): Array<{ name: string; type: string }> => scanner.extractDeclarations(source, "Content/Inventory.verse").map((node) => ({ name: node.name, type: node.type }));

    it.each([
        ["class", "Items", "Items := classify_items(Source)\n"],
        ["struct", "Layout", "Layout := structure_of(Source)\n"],
        ["interface", "Bridge", "Bridge := interfaces_for(Source)\n"],
    ])("does not read a call to a function named after `%s` as a type declaration", (_keyword, name, source) => {
        // Recorded as the variable it is, rather than dropped: the line really
        // does declare the name.
        expect(typed(source)).toEqual([{ name, type: "variable" }]);
    });

    it.each([
        ["class", "Item", "Item := class:\n"],
        ["struct", "Point", "Point := struct:\n"],
        ["interface", "Usable", "Usable := interface:\n"],
    ])("still records the `%s` declaration the boundary sits after", (keyword, name, source) => {
        expect(typed(source)).toEqual([{ name, type: keyword }]);
    });

    it("still records a type whose keyword carries specifiers", () => {
        expect(typed("Item := class<final>(base):\n")).toEqual([{ name: "Item", type: "class" }]);
    });
});
