import * as fs from "fs";
import * as path from "path";

/**
 * Ground-truth regression tests for the checked-in precompiled digest data
 * (`src/data/*.json`), regenerated from the 41.30 digests by `npm run parse-digest`.
 *
 * These read the build artifacts directly and assert that the identifiers from
 * issue #97 resolve to the correct module paths. If any assertion fails, the
 * shared parser (`digestParsing.ts`) or the bundled digests are wrong - do not
 * weaken these expectations.
 */
interface PrecompiledDigest {
    sourceBuild: string;
    entries: Record<string, { identifier: string; modulePath: string; type: string; isPublic: boolean }[]>;
    moduleIndex: Record<string, string[]>;
}

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const EXPECTED_BUILD = "++Fortnite+Release-41.30-CL-56430492";

function loadDigest(fileName: string): PrecompiledDigest {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
}

const fortnite = loadDigest("Fortnite.digest.json");
const verse = loadDigest("Verse.digest.json");
const unrealEngine = loadDigest("UnrealEngine.digest.json");

describe("precompiled digest data (41.30)", () => {
    it("was generated from the 41.30 build", () => {
        expect(fortnite.sourceBuild).toBe(EXPECTED_BUILD);
        expect(verse.sourceBuild).toBe(EXPECTED_BUILD);
        expect(unrealEngine.sourceBuild).toBe(EXPECTED_BUILD);
    });

    it("resolves Fortnite device classes to /Fortnite.com/Devices", () => {
        for (const id of ["creative_device", "button_device", "trigger_device"]) {
            expect(fortnite.entries[id]).toBeDefined();
            expect(fortnite.entries[id][0].modulePath).toBe("/Fortnite.com/Devices");
        }
    });

    it("resolves agent and player to /Verse.org/Simulation", () => {
        expect(verse.entries["agent"][0].modulePath).toBe("/Verse.org/Simulation");
        expect(verse.entries["player"][0].modulePath).toBe("/Verse.org/Simulation");
    });

    it("resolves vector3 to /Verse.org/SpatialMath", () => {
        expect(verse.entries["vector3"][0].modulePath).toBe("/Verse.org/SpatialMath");
    });

    it("keeps both SpatialMath homes of the identifiers they share (issue #375)", () => {
        // The two SpatialMath modules are a live migration in the 41.30 data:
        // both are importable and their vector3 types are distinct, so serving
        // only one silently picks for the user. Each file records its own home;
        // the loader is what puts the two together.
        for (const id of ["Distance", "vector3", "rotation", "transform"]) {
            expect(unrealEngine.entries[id].map((declaration) => declaration.modulePath)).toEqual(["/UnrealEngine.com/Temporary/SpatialMath"]);
            expect(verse.entries[id].map((declaration) => declaration.modulePath)).toEqual(["/Verse.org/SpatialMath"]);
        }
    });

    it("records a module-scope overload once per module, not once per declaration", () => {
        // ToString is declared four times across two Verse modules. One entry
        // per declaration would offer the same import several times over.
        expect(verse.entries["ToString"].map((declaration) => declaration.modulePath)).toEqual(["/Verse.org/Verse", "/Verse.org/SpatialMath"]);
    });

    it("indexes button_device under the /Fortnite.com/Devices module", () => {
        const members = fortnite.moduleIndex["/Fortnite.com/Devices"];
        expect(members).toBeDefined();
        expect(members).toContain("button_device");
    });

    it("carries the 41.30 rename of the LLM conversation API to AI", () => {
        // 41.30 renamed the `llm_*` surface in /UnrealEngine.com/Conversations to
        // `ai_*` and replaced the generic voice set with Fortnite character voices.
        // Regenerating from an older digest would silently restore the old names.
        for (const id of ["ai_session", "ai_error", "ai_description"]) {
            expect(unrealEngine.entries[id]).toBeDefined();
            expect(unrealEngine.entries[id][0].modulePath).toBe("/UnrealEngine.com/Conversations");
        }
        for (const gone of ["llm_session", "llm_prompt_error", "llm_description", "lily_voice"]) {
            expect(unrealEngine.entries[gone]).toBeUndefined();
        }
        expect(unrealEngine.entries["peely_voice"]).toBeDefined();
        expect(unrealEngine.entries["peely_voice"][0].modulePath).toBe("/UnrealEngine.com/Conversations");
    });

    it("records parametric types but not their members (no leak)", () => {
        // Parametric type heads must be recorded as types, with their members kept
        // out of the importable entries (issue #97 follow-up).
        for (const id of ["subscribable", "listenable", "event", "result"]) {
            expect(verse.entries[id]).toBeDefined();
            expect(verse.entries[id][0].type).toBe("class");
        }
        for (const leaked of ["Subscribe", "Signal", "GetSuccess"]) {
            expect(verse.entries[leaked]).toBeUndefined();
        }
        for (const leaked of ["Entitlement", "Quantity", "Change", "ActivationTriggeredEvent"]) {
            expect(fortnite.entries[leaked]).toBeUndefined();
        }
    });

    it("records parametric types whose parameter list nests parentheses", () => {
        // These four heads constrain their parameter with `subtype(...)`, so a
        // parameter list matched at a fixed nesting depth ends at the wrong `)`
        // and reads the head as a function.
        for (const id of ["chat_channel", "voice_channel", "agent_group_interface", "agent_group"]) {
            expect(verse.entries[id]).toBeDefined();
            expect(verse.entries[id][0].type).toBe("class");
        }
    });

    it("keeps the members of nested-paren parametric types out of module scope", () => {
        // Every one of these is an ordinary identifier a user could write, so a
        // phantom entry turns their own unknown-identifier error into a spurious
        // high-confidence import.
        for (const leaked of ["Name", "Group"]) {
            expect(verse.entries[leaked]).toBeUndefined();
            expect(verse.moduleIndex["/Verse.org/Chat"]).not.toContain(leaked);
        }
        for (const leaked of ["GetMemberMap", "AddMember", "RemoveMember", "AddMemberEvent", "RemoveMemberEvent", "MemberInfoChangeEvent"]) {
            expect(verse.entries[leaked]).toBeUndefined();
            expect(verse.moduleIndex["/Verse.org/AgentGroup"]).not.toContain(leaked);
        }
    });
});
