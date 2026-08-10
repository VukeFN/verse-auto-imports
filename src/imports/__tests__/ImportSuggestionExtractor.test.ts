import { ImportSuggestionExtractor } from "../ImportSuggestionExtractor";
import { ImportFormatter } from "../ImportFormatter";
import * as vscode from "vscode";

describe("ImportSuggestionExtractor", () => {
    let extractor: ImportSuggestionExtractor;
    let formatter: ImportFormatter;
    let outputChannel: vscode.OutputChannel;

    const diag = (message: string): vscode.Diagnostic => ({ message }) as vscode.Diagnostic;

    beforeEach(() => {
        outputChannel = vscode.window.createOutputChannel("test");
        formatter = new ImportFormatter();
        extractor = new ImportSuggestionExtractor(outputChannel, formatter);
    });

    describe("extractImportSuggestions", () => {
        it("should parse 'Did you forget to specify using { /Path }' into a high-confidence suggestion", async () => {
            const errorMessage = "This identifier is unknown. Did you forget to specify using { /Verse.org/Simulation }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { /Verse.org/Simulation }");
            expect(suggestions[0].source).toBe("error_message");
            expect(suggestions[0].confidence).toBe("high");
            expect(suggestions[0].modulePath).toBe("/Verse.org/Simulation");
        });

        it("should parse 'Unknown identifier with inline suggestion' into a high-confidence suggestion", async () => {
            const errorMessage = "Unknown identifier `player`. Did you forget to specify using { /Verse.org/Simulation }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { /Verse.org/Simulation }");
            expect(suggestions[0].confidence).toBe("high");
            expect(suggestions[0].description).toBe("Import player from /Verse.org/Simulation");
        });

        it("should ignore 'set' assignment suggestions", async () => {
            const errorMessage = "This variable can only be modified with 'set'. Did you mean to write 'set Foo.Bar = 1'?";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(0);
        });

        it("should return one suggestion per qualified option in a 'Did you mean any of' list", async () => {
            const errorMessage = "Unknown identifier `thing`. Did you mean any of:\nModuleA.thing\nModuleB.thing";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { ModuleA }", "using { ModuleB }"]);
            expect(suggestions.every((s) => s.confidence === "high")).toBe(true);
        });

        it("should drop bare identifier options from 'Did you mean any of' lists", async () => {
            // Real compiler shape (Script Error 3506): the option list echoes a
            // local definition (`item`) that is not importable.
            const errorMessage = "Unknown identifier `item`. Did you mean any of:\nInventoryModule.item\nitem";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { InventoryModule }");
            expect(suggestions.map((s) => s.importStatement)).not.toContain("using { item }");
        });

        it("should return nothing when every 'Did you mean any of' option is a bare identifier", async () => {
            const errorMessage = "Unknown identifier `item`. Did you mean any of:\nitem\nother";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(0);
        });

        it("should return one suggestion per path in a 'Did you forget to specify one of' list", async () => {
            const errorMessage = "Unknown identifier `thing`. Did you forget to specify one of:\nusing { /GameA/Combat }\nusing { /GameB/Combat }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { /GameA/Combat }", "using { /GameB/Combat }"]);
            expect(suggestions.every((s) => s.confidence === "high")).toBe(true);
        });

        it("should return one suggestion per path in a 'could be one of many types' message", async () => {
            const errorMessage = "Identifier vector3 could be one of many types: (/Verse.org/SpatialMath:)vector3 or (/UnrealEngine.com/Temporary/SpatialMath:)vector3";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { /Verse.org/SpatialMath }", "using { /UnrealEngine.com/Temporary/SpatialMath }"]);
        });

        it("should infer the module path from a single 'Did you mean Module.Member' suggestion", async () => {
            // The asset-import case: the import must not embed the asset name
            const errorMessage = "Unknown identifier `image2`. Did you mean Folder1.image2";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { Folder1 }");
            expect(suggestions[0].confidence).toBe("high");
        });

        it("should prefer a configured ambiguous mapping over the inferred 'Did you mean' path", async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
                get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                    if (key === "behavior.ambiguousImports") {
                        return { player: "/Verse.org/Simulation" };
                    }
                    return defaultValue;
                }),
                update: jest.fn().mockResolvedValue(undefined),
            });
            const errorMessage = "Unknown identifier `player`. Did you mean SomeModule.player";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { /Verse.org/Simulation }");
            expect(suggestions[0].description).toBe("Configured import for player");
        });

        it("should resolve a bare unknown identifier from a configured ambiguous mapping", async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
                get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                    if (key === "behavior.ambiguousImports") {
                        return { vector3: "/UnrealEngine.com/Temporary/SpatialMath" };
                    }
                    return defaultValue;
                }),
                update: jest.fn().mockResolvedValue(undefined),
            });

            const suggestions = await extractor.extractImportSuggestions("Unknown identifier `vector3`");

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].importStatement).toBe("using { /UnrealEngine.com/Temporary/SpatialMath }");
            expect(suggestions[0].description).toBe("Configured import for vector3");
        });

        it("should return nothing for a bare unknown identifier when no ambiguous mapping is configured", async () => {
            const suggestions = await extractor.extractImportSuggestions("Unknown identifier `vector3`");

            expect(suggestions).toHaveLength(0);
        });

        it("should return nothing for messages without import-related content", async () => {
            const suggestions = await extractor.extractImportSuggestions("Expected expression after operator");

            expect(suggestions).toHaveLength(0);
        });

        it("should drop a 'Did you mean' suggestion with trailing sentence punctuation", async () => {
            // Regression #130: the trailing period used to create an empty last
            // segment, so the split went one level too deep and produced
            // `using { Economy.Shop }` where `using { Economy }` is correct.
            const errorMessage = "Unknown identifier `Shop`. Did you mean Economy.Shop.";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(0);
        });

        it("should drop a 'Did you mean' suggestion that is prose rather than a path", async () => {
            // Regression #130: this used to produce `using { to use Bar }`
            const errorMessage = "Unknown identifier `Foo`. Did you mean to use Bar.Baz instead?";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(0);
        });

        it("should drop a prose 'Did you mean' suggestion without an unknown-identifier prefix", async () => {
            // Regression #130: this used to produce `using { Self }`
            const errorMessage = "This call is invalid. Did you mean Self.Widget?";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions).toHaveLength(0);
        });

        it("should offer every candidate when a message mixes an option list with a using list", async () => {
            // The compiler joins the two lists inline, so the last same-package
            // path shares its line with the joiner.
            const errorMessage =
                "Unknown identifier `Thing`.\nUsed inside module /mygame@fortnite.com/mygame/Scripts.\n Did you mean any of: \nRel1.Thing\nRel2.Thing or did you forget to specify one of:\nusing { /GameA/M }\nusing { /GameB/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { Rel2 }", "using { /GameA/M }", "using { /GameB/M }"]);
        });

        it("should offer both candidates when a message mixes a single suggestion with a single using path", async () => {
            const errorMessage = "Unknown identifier `Thing`.\nUsed inside module /mygame@fortnite.com/mygame/Scripts.\n Did you mean Rel1.Thing or did you forget to specify using { /GameA/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { /GameA/M }"]);
        });

        it("should offer every candidate when an option list is mixed with a single using path", async () => {
            const errorMessage = "Unknown identifier `Thing`. Did you mean any of: \nRel1.Thing\nRel2.Thing or did you forget to specify using { /GameA/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { Rel2 }", "using { /GameA/M }"]);
        });

        it("should offer every candidate when a single suggestion is mixed with a using list", async () => {
            const errorMessage = "Unknown identifier `Thing`. Did you mean Rel1.Thing or did you forget to specify one of:\nusing { /GameA/M }\nusing { /GameB/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { /GameA/M }", "using { /GameB/M }"]);
        });

        it("should read a mixed message the same way whichever case the joiner uses", async () => {
            const errorMessage = "Unknown identifier `Thing`. Did you mean Rel1.Thing or Did you forget to specify using { /GameA/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { /GameA/M }"]);
        });

        it("should read a mixed message with both lists the same way whichever case the joiner uses", async () => {
            const errorMessage = "Unknown identifier `Thing`. Did you mean any of: \nRel1.Thing\nRel2.Thing or Did you forget to specify one of:\nusing { /GameA/M }\nusing { /GameB/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Rel1 }", "using { Rel2 }", "using { /GameA/M }", "using { /GameB/M }"]);
        });

        it("should keep the using path of a mixed message whose same-package option is a bare identifier", async () => {
            const errorMessage = "Unknown identifier `Thing`. Did you mean Thing or did you forget to specify using { /GameA/M }";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { /GameA/M }"]);
        });

        it("should drop prose lines trailing a 'Did you mean any of' option list", async () => {
            // Regression #130: the trailing sentence used to become an option
            const errorMessage = "Unknown identifier `Combat`. Did you mean any of: \nSystems.Combat\nFeatures.Combat\nUsed inside module /mygame@fortnite.com/mygame/Scripts.";

            const suggestions = await extractor.extractImportSuggestions(errorMessage);

            expect(suggestions.map((s) => s.importStatement)).toEqual(["using { Systems }", "using { Features }"]);
        });
    });

    describe("extractImportsFromDiagnostics", () => {
        it("should ignore 'set' assignment suggestions instead of extracting garbage paths", () => {
            // Regression: the greedy "Did you mean" fallback used to extract
            // "to write 'set Foo" from this message.
            const paths = extractor.extractImportsFromDiagnostics([diag("This variable can only be modified with 'set'. Did you mean to write 'set Foo.Bar = 1'?")]);

            expect(paths).toEqual([]);
        });

        it("should extract the path from a single 'Did you forget to specify' message", () => {
            const paths = extractor.extractImportsFromDiagnostics([diag("This identifier is unknown. Did you forget to specify using { /Verse.org/Simulation }")]);

            expect(paths).toEqual(["/Verse.org/Simulation"]);
        });

        it("should extract the path from an unknown identifier with inline suggestion", () => {
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `player`. Did you forget to specify using { /Verse.org/Simulation }")]);

            expect(paths).toEqual(["/Verse.org/Simulation"]);
        });

        it("should not bulk-add the candidates of a 'Did you forget to specify one of' message", () => {
            // Ambiguous candidates need a user choice via the quick-fix menu;
            // importing all of them at once would create a name collision.
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `thing`. Did you forget to specify one of:\nusing { /GameA/Combat }\nusing { /GameB/Combat }")]);

            expect(paths).toEqual([]);
        });

        it("should not bulk-add the candidates of a 'could be one of many types' message", () => {
            const paths = extractor.extractImportsFromDiagnostics([
                diag("Identifier vector3 could be one of many types: (/Verse.org/SpatialMath:)vector3 or (/UnrealEngine.com/Temporary/SpatialMath:)vector3"),
            ]);

            expect(paths).toEqual([]);
        });

        it("should not add candidates from a 'Did you mean any of' list", () => {
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `thing`. Did you mean any of:\nModuleA.thing\nModuleB.thing")]);

            expect(paths).toEqual([]);
        });

        it("should not bulk-add the candidates of a message mixing an option list with a using list", () => {
            const paths = extractor.extractImportsFromDiagnostics([
                diag("Unknown identifier `Thing`. Did you mean any of: \nRel1.Thing\nRel2.Thing or did you forget to specify one of:\nusing { /GameA/M }\nusing { /GameB/M }"),
            ]);

            expect(paths).toEqual([]);
        });

        it("should not bulk-add the candidates of a message mixing a single suggestion with a single using path", () => {
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `Thing`. Did you mean Rel1.Thing or did you forget to specify using { /GameA/M }")]);

            expect(paths).toEqual([]);
        });

        it("should add the one path of a mixed message whose same-package option is a bare identifier", () => {
            // One importable candidate left is unambiguous, so Optimize adds it -
            // the same treatment a "Did you mean any of" list gets when its only
            // other option is a bare local definition.
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `Thing`. Did you mean Thing or did you forget to specify using { /GameA/M }")]);

            expect(paths).toEqual(["/GameA/M"]);
        });

        it("should not bulk-add the using path of a mixed message whose joiner capitalizes 'Did'", () => {
            // This spelling reaches UNKNOWN_WITH_SUGGESTION, which reads the
            // joined tail as the whole message and offers the using path alone.
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `Thing`. Did you mean Rel1.Thing or Did you forget to specify using { /GameA/M }")]);

            expect(paths).toEqual([]);
        });

        it("should extract the inferred module path from a 'Did you mean Module.Member' message", () => {
            // The asset-import case: `using { Folder1 }`, never `using { Folder1.image2 }`
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `image2`. Did you mean Folder1.image2")]);

            expect(paths).toEqual(["Folder1"]);
        });

        it("should not extract a path from a 'Did you mean' suggestion with trailing punctuation", () => {
            // Regression #130: this used to add "Economy.Shop" instead of "Economy"
            const paths = extractor.extractImportsFromDiagnostics([diag("Unknown identifier `Shop`. Did you mean Economy.Shop.")]);

            expect(paths).toEqual([]);
        });

        it("should deduplicate paths across diagnostics and skip unrelated ones", () => {
            const paths = extractor.extractImportsFromDiagnostics([
                diag("Unknown identifier `button_device`. Did you forget to specify using { /Fortnite.com/Devices }"),
                diag("Unknown identifier `creative_device`. Did you forget to specify using { /Fortnite.com/Devices }"),
                diag("This variable can only be modified with 'set'. Did you mean to write 'set Foo.Bar = 1'?"),
                diag("Expected expression after operator"),
            ]);

            expect(paths).toEqual(["/Fortnite.com/Devices"]);
        });
    });
});
