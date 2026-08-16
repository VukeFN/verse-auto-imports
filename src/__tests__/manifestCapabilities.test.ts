import * as fs from "fs";
import * as path from "path";

/**
 * An undeclared `untrustedWorkspaces` disables the extension entirely in
 * Restricted Mode, and an undeclared `virtualWorkspaces` defaults to enabled
 * where the diagnostics-driven core cannot work. Both must stay declared.
 */
describe("manifest workspace capabilities", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

    it("supports untrusted workspaces", () => {
        expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
    });

    it("declares virtual workspaces unsupported, with a reason", () => {
        expect(manifest.capabilities.virtualWorkspaces.supported).toBe(false);
        expect(typeof manifest.capabilities.virtualWorkspaces.description).toBe("string");
        expect(manifest.capabilities.virtualWorkspaces.description.length).toBeGreaterThan(0);
    });
});
