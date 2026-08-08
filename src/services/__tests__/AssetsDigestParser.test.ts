import { AssetsDigestParser } from "../AssetsDigestParser";

/**
 * Unit tests for the pure line-parsing logic of AssetsDigestParser.
 *
 * These exercise AssetsDigestParser.parseDigestContent directly, so they run
 * under Jest without the VS Code runtime or filesystem access.
 */
describe("AssetsDigestParser.parseDigestContent", () => {
    describe("41.10 declaration shapes", () => {
        // Recorded from a live 41.10 Assets.digest.verse (issue #63). The
        // declaration shapes are verbatim; only the project path is a placeholder.
        const digest = [
            "image1<scoped {/mygame@fortnite.com/mygame}>:texture = external {}",
            "TestSphere_asset<scoped {/mygame@fortnite.com/mygame}>:mesh = external {}",
            "TestVFX_asset<scoped {/mygame@fortnite.com/mygame}>:particle_system = external {}",
            "TestMaterial<scoped {/mygame@fortnite.com/mygame}> := class<scoped {/mygame@fortnite.com/mygame}>(material):",
            "TestSphere<scoped {/mygame@fortnite.com/mygame}> := class<final><scoped {/mygame@fortnite.com/mygame}>(mesh_component):",
            "TestVFX<scoped {/mygame@fortnite.com/mygame}> := class<public>(particle_system_component):",
        ].join("\n");

        it("parses every recorded 41.10 asset name", () => {
            const names = AssetsDigestParser.parseDigestContent(digest);

            expect(names).toEqual(["image1", "TestSphere_asset", "TestVFX_asset", "TestMaterial", "TestSphere", "TestVFX"]);
        });

        it("parses the material class with a scoped specifier on the class keyword", () => {
            const names = AssetsDigestParser.parseDigestContent("TestMaterial<scoped {/mygame@fortnite.com/mygame}> := class<scoped {/mygame@fortnite.com/mygame}>(material):");

            expect(names).toContain("TestMaterial");
        });

        it("parses a class with stacked specifiers on the class keyword (<final><scoped {...}>)", () => {
            const names = AssetsDigestParser.parseDigestContent("TestSphere<scoped {/mygame@fortnite.com/mygame}> := class<final><scoped {/mygame@fortnite.com/mygame}>(mesh_component):");

            expect(names).toEqual(["TestSphere"]);
        });

        it("parses texture, mesh, and niagara instance declarations", () => {
            const names = AssetsDigestParser.parseDigestContent(
                [
                    "image1<scoped {/mygame@fortnite.com/mygame}>:texture = external {}",
                    "TestSphere_asset<scoped {/mygame@fortnite.com/mygame}>:mesh = external {}",
                    "TestVFX_asset<scoped {/mygame@fortnite.com/mygame}>:particle_system = external {}",
                ].join("\n"),
            );

            expect(names).toEqual(["image1", "TestSphere_asset", "TestVFX_asset"]);
        });
    });

    describe("pre-41.10 declaration shapes (older UEFN versions still supported)", () => {
        it("parses the legacy public/internal/private class and struct forms", () => {
            const names = AssetsDigestParser.parseDigestContent(["Foo<public> := class:", "Bar<internal> := struct:", "Baz<private> := class(parent):"].join("\n"));

            expect(names).toEqual(["Foo", "Bar", "Baz"]);
        });

        it("parses declarations that carry no specifier", () => {
            const names = AssetsDigestParser.parseDigestContent("PlainAsset := class(material):");

            expect(names).toEqual(["PlainAsset"]);
        });
    });

    describe("broadened specifier set", () => {
        it("accepts the protected specifier", () => {
            const names = AssetsDigestParser.parseDigestContent("Widget<protected> := class:");

            expect(names).toEqual(["Widget"]);
        });

        it("accepts the scoped specifier without arguments", () => {
            const names = AssetsDigestParser.parseDigestContent("Gadget<scoped> := struct:");

            expect(names).toEqual(["Gadget"]);
        });

        it("accepts stacked specifiers on the declared name", () => {
            const names = AssetsDigestParser.parseDigestContent("Thing<native><public> := class:");

            expect(names).toEqual(["Thing"]);
        });
    });

    describe("negative cases", () => {
        it("ignores module declarations", () => {
            const names = AssetsDigestParser.parseDigestContent(["Folder1<public> := module:", "SomeModule := module:"].join("\n"));

            expect(names).toEqual([]);
        });

        it("ignores comments, blank lines, and using statements", () => {
            const names = AssetsDigestParser.parseDigestContent(["# a comment", "", "   ", "using { /Verse.org/Simulation }"].join("\n"));

            expect(names).toEqual([]);
        });

        it("ignores constant assignments that are not external asset instances", () => {
            const names = AssetsDigestParser.parseDigestContent("MaxCount<public>:int = 5");

            expect(names).toEqual([]);
        });

        it("does not pick up indented class members that share the instance shape", () => {
            const digest = [
                "TestMaterial<scoped {/x/Y}> := class<scoped {/x/Y}>(material):",
                "    BaseColor<public>:texture = external {}",
                "    GetColor<public>()<transacts>:vector3 = external {}",
            ].join("\n");

            const names = AssetsDigestParser.parseDigestContent(digest);

            expect(names).toEqual(["TestMaterial"]);
        });

        it("resumes parsing module-scope assets after a class body closes", () => {
            const digest = [
                "Folder1<public> := module:",
                "    image2<scoped {/x/Y}>:texture = external {}",
                "    TestMaterial<scoped {/x/Y}> := class<scoped {/x/Y}>(material):",
                "        BaseColor<public>:texture = external {}",
                "    image3<scoped {/x/Y}>:texture = external {}",
            ].join("\n");

            const names = AssetsDigestParser.parseDigestContent(digest);

            expect(names).toEqual(["image2", "TestMaterial", "image3"]);
        });
    });
});
