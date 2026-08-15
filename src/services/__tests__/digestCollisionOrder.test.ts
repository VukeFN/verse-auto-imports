import * as path from "path";
import * as vscode from "vscode";
import { DigestParser } from "../DigestParser";

/**
 * Which module leads a collision list, read from the checked-in digest data
 * rather than from fixtures.
 *
 * Position 0 is not merely first: ImportCodeActionProvider marks it
 * `isPreferred` and an `auto_first` strategy applies it with no prompt. Several
 * identifiers are declared by both a live module and a superseded one, so the
 * lead is a recommendation the extension makes on the user's behalf.
 *
 * These read the real `src/data` through the real loader, because a digest
 * refresh can move a name between modules - which the synthetic fixtures in
 * DigestParser.test.ts cannot catch.
 */
describe("collision lead in the bundled digest data", () => {
    const EXTENSION_PATH = path.resolve(__dirname, "..", "..", "..");
    const context = { extensionPath: EXTENSION_PATH } as unknown as vscode.ExtensionContext;
    const parser = new DigestParser(vscode.window.createOutputChannel("test"), context);

    const leadFor = async (identifier: string): Promise<string | undefined> => (await parser.lookupIdentifier(identifier))[0]?.modulePath;

    it("leads the SpatialMath surface with /Verse.org, not the Temporary home", async () => {
        for (const id of ["vector3", "rotation", "transform", "Distance"]) {
            expect(await leadFor(id)).toBe("/Verse.org/SpatialMath");
        }
    });

    it("leads the input surface with /Verse.org/Input, not /UnrealEngine.com/ControlInput", async () => {
        for (const id of ["GetPlayerInput", "player_input", "input_events"]) {
            expect(await leadFor(id)).toBe("/Verse.org/Input");
        }
    });

    it("leaves a /Fortnite.com lead alone", async () => {
        // Demoting UnrealEngine must not promote /Verse.org over /Fortnite.com:
        // a creator writing UI or Assets in UEFN means the Fortnite module.
        expect(await leadFor("UI")).toBe("/Fortnite.com/UI");
        expect(await leadFor("Assets")).toBe("/Fortnite.com/Assets");
        expect(await leadFor("Itemization")).toBe("/Fortnite.com/Itemization");
    });

    it("still offers every declaring module, led by the live one", async () => {
        const candidates = await parser.lookupIdentifier("vector3");

        expect(candidates.map((candidate) => candidate.modulePath)).toEqual(["/Verse.org/SpatialMath", "/UnrealEngine.com/Temporary/SpatialMath"]);
    });
});
