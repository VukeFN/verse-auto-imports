import { planVisibility, toContentSegments } from "../ModuleVisibilityPlanner";

const PROJECT = "/mygame@fortnite.com/mygame";

describe("toContentSegments", () => {
    it("strips the project prefix", () => {
        expect(toContentSegments(`${PROJECT}/Gadgets/Tools`, PROJECT)).toEqual(["Gadgets", "Tools"]);
    });

    it("returns an empty list for the project root itself", () => {
        expect(toContentSegments(PROJECT, PROJECT)).toEqual([]);
    });

    it("rejects a path outside the project", () => {
        expect(toContentSegments("/Fortnite.com/Devices", PROJECT)).toBeNull();
    });

    it("rejects a path shorter than the project prefix", () => {
        expect(toContentSegments("/mygame@fortnite.com", PROJECT)).toBeNull();
    });
});

describe("planVisibility", () => {
    it("leaves the first divergent segment alone and marks the rest", () => {
        // Gadgets is internal to the Content root, and the importer is a child
        // of that root, so Gadgets is already reachable. Only Tools is not.
        expect(planVisibility(["Gadgets", "Tools"], ["Scripts"])).toEqual({
            prefix: [],
            segments: [
                { name: "Gadgets", needsPublic: false },
                { name: "Tools", needsPublic: true },
            ],
        });
    });

    it("marks every segment below the first divergent one", () => {
        expect(planVisibility(["Gadgets", "Deep", "Tools"], ["Scripts"])).toEqual({
            prefix: [],
            segments: [
                { name: "Gadgets", needsPublic: false },
                { name: "Deep", needsPublic: true },
                { name: "Tools", needsPublic: true },
            ],
        });
    });

    it("keeps the shared ancestors as the prefix", () => {
        expect(planVisibility(["A", "B", "C", "D"], ["A", "B", "Other"])).toEqual({
            prefix: ["A", "B"],
            segments: [
                { name: "C", needsPublic: false },
                { name: "D", needsPublic: true },
            ],
        });
    });

    it("marks nothing when the target is a direct sibling of the importer", () => {
        // Tools is internal to the Content root and the importer is a child of
        // it, so the compiler cannot have raised this for the pair.
        expect(planVisibility(["Tools"], ["Scripts"])).toEqual({
            prefix: [],
            segments: [{ name: "Tools", needsPublic: false }],
        });
    });

    it("marks nothing when the importer already sits inside the target branch", () => {
        expect(planVisibility(["Gadgets"], ["Gadgets", "Inner"])).toEqual({
            prefix: ["Gadgets"],
            segments: [],
        });
    });

    it("marks nothing when the importer is the target", () => {
        expect(planVisibility(["Gadgets", "Tools"], ["Gadgets", "Tools"])).toEqual({
            prefix: ["Gadgets", "Tools"],
            segments: [],
        });
    });

    it("treats an importer at the Content root as reaching the first segment", () => {
        expect(planVisibility(["Gadgets", "Tools"], [])).toEqual({
            prefix: [],
            segments: [
                { name: "Gadgets", needsPublic: false },
                { name: "Tools", needsPublic: true },
            ],
        });
    });
});
