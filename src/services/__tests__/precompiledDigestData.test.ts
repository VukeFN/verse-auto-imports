import * as fs from "fs";
import * as path from "path";

/**
 * Ground-truth regression tests for the checked-in precompiled digest data
 * (`src/data/*.json`), regenerated from the 41.10 digests by `npm run parse-digest`.
 *
 * These read the build artifacts directly and assert that the identifiers from
 * issue #97 resolve to the correct module paths. If any assertion fails, the
 * shared parser (`digestParsing.ts`) or the bundled digests are wrong - do not
 * weaken these expectations.
 */
interface PrecompiledDigest {
    sourceBuild: string;
    entries: Record<string, { identifier: string; modulePath: string; type: string; isPublic: boolean }>;
    moduleIndex: Record<string, string[]>;
}

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const EXPECTED_BUILD = "++Fortnite+Release-41.10-CL-55335788";

function loadDigest(fileName: string): PrecompiledDigest {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
}

const fortnite = loadDigest("Fortnite.digest.json");
const verse = loadDigest("Verse.digest.json");
const unrealEngine = loadDigest("UnrealEngine.digest.json");

describe("precompiled digest data (41.10)", () => {
    it("was generated from the 41.10 build", () => {
        expect(fortnite.sourceBuild).toBe(EXPECTED_BUILD);
        expect(verse.sourceBuild).toBe(EXPECTED_BUILD);
        expect(unrealEngine.sourceBuild).toBe(EXPECTED_BUILD);
    });

    it("resolves Fortnite device classes to /Fortnite.com/Devices", () => {
        for (const id of ["creative_device", "button_device", "trigger_device"]) {
            expect(fortnite.entries[id]).toBeDefined();
            expect(fortnite.entries[id].modulePath).toBe("/Fortnite.com/Devices");
        }
    });

    it("resolves agent and player to /Verse.org/Simulation", () => {
        expect(verse.entries["agent"].modulePath).toBe("/Verse.org/Simulation");
        expect(verse.entries["player"].modulePath).toBe("/Verse.org/Simulation");
    });

    it("resolves vector3 to /Verse.org/SpatialMath", () => {
        expect(verse.entries["vector3"].modulePath).toBe("/Verse.org/SpatialMath");
    });

    it("indexes button_device under the /Fortnite.com/Devices module", () => {
        const members = fortnite.moduleIndex["/Fortnite.com/Devices"];
        expect(members).toBeDefined();
        expect(members).toContain("button_device");
    });

    it("records parametric types but not their members (no leak)", () => {
        // Parametric type heads must be recorded as types, with their members kept
        // out of the importable entries (issue #97 follow-up).
        for (const id of ["subscribable", "listenable", "event", "result"]) {
            expect(verse.entries[id]).toBeDefined();
            expect(verse.entries[id].type).toBe("class");
        }
        for (const leaked of ["Subscribe", "Signal", "GetSuccess"]) {
            expect(verse.entries[leaked]).toBeUndefined();
        }
        for (const leaked of ["Entitlement", "Quantity", "Change", "ActivationTriggeredEvent"]) {
            expect(fortnite.entries[leaked]).toBeUndefined();
        }
    });
});
