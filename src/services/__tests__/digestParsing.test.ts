import { parseDigestContent, rootDomainForDigestFile } from "../digestParsing";

/**
 * Unit tests for the pure digest-parsing logic shared by the build-time
 * precompiler and the runtime fallback parser.
 *
 * These exercise parseDigestContent / rootDomainForDigestFile directly, so they
 * run under Jest without the VS Code runtime or filesystem access. Fixtures
 * reproduce the real declaration shapes from the 41.10 digest files (issue #97).
 */
describe("rootDomainForDigestFile", () => {
    it("maps each bundled digest file to its root module domain", () => {
        expect(rootDomainForDigestFile("Fortnite.digest.verse")).toBe("/Fortnite.com");
        expect(rootDomainForDigestFile("UnrealEngine.digest.verse")).toBe("/UnrealEngine.com");
        expect(rootDomainForDigestFile("Verse.digest.verse")).toBe("/Verse.org");
    });

    it("is case-insensitive and returns empty for unknown files", () => {
        expect(rootDomainForDigestFile("FORTNITE.DIGEST.VERSE")).toBe("/Fortnite.com");
        expect(rootDomainForDigestFile("Assets.digest.verse")).toBe("");
    });
});

describe("parseDigestContent - module path resolution", () => {
    it("prefers an explicit '# Module import path:' comment over the root domain", () => {
        const digest = ["# Module import path: /Some.custom/Path", "Chat<public> := module:"].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["Chat"][0].modulePath).toBe("/Some.custom/Path");
    });

    it("resolves a comment-less top-level module against the file's root domain", () => {
        const digest = ["Devices<public> := module:", "    button_device<public> := class<concrete>(creative_device_base):"].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["Devices"][0].modulePath).toBe("/Fortnite.com/Devices");
        expect(entries["button_device"][0].modulePath).toBe("/Fortnite.com/Devices");
    });

    it("resolves a nested module from its own indented comment", () => {
        const digest = [
            "# Module import path: /Verse.org/Simulation",
            "Simulation<public> := module:",
            "    # Module import path: /Verse.org/Simulation/Tags",
            "    Tags<public> := module:",
            "        tag<public> := class<concrete>(base):",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["Simulation"][0].modulePath).toBe("/Verse.org/Simulation");
        expect(entries["Tags"][0].modulePath).toBe("/Verse.org/Simulation/Tags");
        expect(entries["tag"][0].modulePath).toBe("/Verse.org/Simulation/Tags");
    });

    it("resolves a scope-qualified module from its '(/path:)' prefix", () => {
        const digest = "(/Fortnite.com:)Assets<public> := module:";

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["Assets"][0].modulePath).toBe("/Fortnite.com/Assets");
    });

    it("applies a pending comment to the next module only, not a later comment-less module", () => {
        // The stale-path bug (issue #97): the movement_types comment must not leak
        // onto the later, comment-less Devices module.
        const digest = [
            "# Module import path: /Fortnite.com/AI/movement_types",
            "movement_types<public> := module:",
            "    Walking<public>:movement_type = external {}",
            "",
            "Devices<public> := module:",
            "    button_device<public> := class<concrete>(creative_device_base):",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["movement_types"][0].modulePath).toBe("/Fortnite.com/AI/movement_types");
        expect(entries["Devices"][0].modulePath).toBe("/Fortnite.com/Devices");
        expect(entries["button_device"][0].modulePath).toBe("/Fortnite.com/Devices");
    });

    it("attributes declarations to the parent module after a nested module's block ends", () => {
        const digest = ["Outer<public> := module:", "    Inner<public> := module:", "        inner_thing<public> := class<concrete>(base):", "    outer_thing<public> := class<concrete>(base):"].join(
            "\n",
        );

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["Inner"][0].modulePath).toBe("/Fortnite.com/Outer/Inner");
        expect(entries["inner_thing"][0].modulePath).toBe("/Fortnite.com/Outer/Inner");
        expect(entries["outer_thing"][0].modulePath).toBe("/Fortnite.com/Outer");
    });
});

describe("parseDigestContent - declaration recognition", () => {
    it("records '<native><public>' class and struct declarations", () => {
        const digest = [
            "Simulation<public> := module:",
            "    creative_device<native><public> := class<concrete>(creative_object_interface):",
            "    vector3<native><public> := struct<concrete><computes><persistable>:",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["creative_device"][0]).toMatchObject({
            modulePath: "/Verse.org/Simulation",
            type: "class",
            isPublic: true,
        });
        expect(entries["vector3"][0]).toMatchObject({
            modulePath: "/Verse.org/Simulation",
            type: "class",
            isPublic: true,
        });
    });

    it("ignores specifiers on the declaration keyword side when deciding publicness", () => {
        // <public> on the identifier makes it public; <epic_internal> on the class
        // keyword must neither grant nor revoke publicness.
        const digest = ["Simulation<public> := module:", "    agent<native><public> := class<unique><epic_internal>(entity):", "    internal_type<native> := class<epic_internal>(entity):"].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["agent"][0]).toMatchObject({ modulePath: "/Verse.org/Simulation", isPublic: true });
        expect(entries["internal_type"]).toBeUndefined();
    });

    it("skips class members (declarations indented inside a class body)", () => {
        const digest = [
            "Devices<public> := module:",
            "    button_device<public> := class<concrete>(creative_device_base):",
            "        Press<public>():void = external {}",
            "        Enabled<public>:logic = external {}",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["button_device"]).toBeDefined();
        expect(entries["Press"]).toBeUndefined();
        expect(entries["Enabled"]).toBeUndefined();
    });

    it("skips non-public declarations", () => {
        const digest = ["Devices<public> := module:", "    secret_device := class<concrete>(base):", "    hidden_var:logic = external {}"].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["secret_device"]).toBeUndefined();
        expect(entries["hidden_var"]).toBeUndefined();
    });

    it("records a parametric type head and skips its members", () => {
        // A parametric interface (`name<...>(t:type) := interface:`) whose parameter
        // list must not be misread as a function signature (issue #97 follow-up).
        const digest = ["Verse<public> := module:", "    subscribable<native><public>(t:type) := interface:", "        Subscribe<public>(Callback:type {_(:t):void})<transacts>:cancelable"].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["subscribable"][0]).toMatchObject({
            modulePath: "/Verse.org/Verse",
            type: "class",
            isPublic: true,
        });
        expect(entries["Subscribe"]).toBeUndefined();
    });

    it("pops a parametric type's body so following module-scope declarations attribute to the module", () => {
        const digest = [
            "Verse<public> := module:",
            "    event<native><public>(t:type) := class(signalable(t), awaitable(t)):",
            "        Await<public>()<suspends>:t = external {}",
            "    listenable<public>(payload:type) := interface(awaitable(payload)):",
            "        Length<public>:int = external {}",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["event"][0]).toMatchObject({ modulePath: "/Verse.org/Verse", type: "class" });
        expect(entries["listenable"][0]).toMatchObject({ modulePath: "/Verse.org/Verse", type: "class" });
        expect(entries["Await"]).toBeUndefined();
        expect(entries["Length"]).toBeUndefined();
    });

    it("records a parametric type head whose parameter list nests parentheses", () => {
        // A parameter constrained by `subtype(...)` closes a paren inside the
        // parameter list, so a list matched as `([^)]*)` ends at the wrong `)`.
        const digest = [
            "AgentGroup<public> := module:",
            "    agent_group<native><public>(member_info:subtype(member_info_interface)) := class<unique>(agent_group_interface(member_info)):",
            "        AddMember<public>(Agent:agent, MemberInfo:member_info)<transacts>:result(void, add_member_error) = external {}",
            "        AddMemberEvent<override><native><final>:listenable(tuple(agent, member_info)) = external {}",
        ].join("\n");

        const { entries, moduleIndex } = parseDigestContent(digest, "/Verse.org");

        expect(entries["agent_group"][0]).toMatchObject({
            modulePath: "/Verse.org/AgentGroup",
            type: "class",
            isPublic: true,
        });
        expect(entries["AddMember"]).toBeUndefined();
        expect(entries["AddMemberEvent"]).toBeUndefined();
        expect(moduleIndex["/Verse.org/AgentGroup"]).not.toContain("AddMember");
    });

    it("records a parametric type head whose parameter list nests parentheses more than one deep", () => {
        // The nesting depth is a property of the digest Epic ships, not of the
        // language, so the parameter list is walked rather than matched at a depth.
        const digest = ["Verse<public> := module:", "    deep<public>(t:subtype(container(payload(inner)))) := interface:", "        Unwrap<public>()<transacts>:t = external {}"].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["deep"][0]).toMatchObject({ modulePath: "/Verse.org/Verse", type: "class" });
        expect(entries["Unwrap"]).toBeUndefined();
    });

    it("still reads a function whose parameter list nests parentheses as a function", () => {
        // The balanced walk must not turn every nested-paren head into a type: only
        // `:=` plus a declaration keyword after the list makes one.
        const digest = ["Verse<public> := module:", "    MakeGroup<public>(Members:[]tuple(agent, int))<transacts>:agent_group = external {}"].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["MakeGroup"][0]).toMatchObject({ modulePath: "/Verse.org/Verse", type: "function" });
    });

    it("skips receiver-style extension methods", () => {
        const digest = ["Devices<public> := module:", "    (Target:agent).GetName<public>()<transacts>:string = external {}"].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["GetName"]).toBeUndefined();
    });
});

describe("parseDigestContent - deduplication and module index", () => {
    it("keeps every module that declares an identifier, in declaration order", () => {
        const digest = ["Devices<public> := module:", "    shared_thing<public> := class<concrete>(base):", "", "Other<public> := module:", "    shared_thing<public> := class<concrete>(base):"].join(
            "\n",
        );

        const { entries, moduleIndex } = parseDigestContent(digest, "/Fortnite.com");

        // Both modules can be imported to reach the name, so both are offered;
        // the first declared leads, because that is the one a caller taking a
        // single answer gets.
        expect(entries["shared_thing"].map((declaration) => declaration.modulePath)).toEqual(["/Fortnite.com/Devices", "/Fortnite.com/Other"]);
        expect(moduleIndex["/Fortnite.com/Devices"]).toContain("shared_thing");
        expect(moduleIndex["/Fortnite.com/Other"]).toContain("shared_thing");
    });

    it("keeps a name declared with different types in each module distinct", () => {
        // `Ease` is a variable in Fortnite's InterpolationTypes and a function
        // in Verse's Easing, and the quick-fix label names the type, so one
        // shared type across the paths would mislabel one of them.
        const digest = [
            "Devices<public> := module:",
            "    Ease<public>:interpolation_type = external {}",
            "",
            "Easing<public> := module:",
            "    Ease<public>(X:float)<reads>:float = external {}",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Fortnite.com");

        expect(entries["Ease"]).toEqual([
            expect.objectContaining({ modulePath: "/Fortnite.com/Devices", type: "variable" }),
            expect.objectContaining({ modulePath: "/Fortnite.com/Easing", type: "function" }),
        ]);
    });

    it("records a module-scope overload once, not once per declaration", () => {
        // `ToString` is declared four times in its own module in the shipped
        // Verse digest. One entry per declaration would offer the identical
        // import that many times.
        const digest = [
            "Verse<public> := module:",
            "    ToString<public>(X:int)<reads>:string = external {}",
            "    ToString<public>(X:float)<reads>:string = external {}",
            "    ToString<public>(X:logic)<reads>:string = external {}",
        ].join("\n");

        const { entries } = parseDigestContent(digest, "/Verse.org");

        expect(entries["ToString"].map((declaration) => declaration.modulePath)).toEqual(["/Verse.org/Verse"]);
    });

    it("accumulates every member of a re-opened module in the module index", () => {
        const digest = [
            "Devices<public> := module:",
            "    button_device<public> := class<concrete>(base):",
            "    creative_device<public> := class<concrete>(base):",
            "",
            "Devices<public> := module:",
            "    trigger_device<public> := class<concrete>(base):",
        ].join("\n");

        const { entries, moduleIndex } = parseDigestContent(digest, "/Fortnite.com");

        expect(moduleIndex["/Fortnite.com/Devices"]).toEqual(expect.arrayContaining(["button_device", "creative_device", "trigger_device"]));
        expect(Object.keys(entries)).toEqual(expect.arrayContaining(["button_device", "creative_device", "trigger_device"]));
    });
});
