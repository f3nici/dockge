import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { Stack } from "../backend/stack";
import { DockgeServer } from "../backend/dockge-server";

describe("compose override file", () => {
    let stacksDir : string;
    let server : DockgeServer;

    const stackDir = () => path.join(stacksDir, "demo");
    const write = (name : string, content : string) => fs.writeFileSync(path.join(stackDir(), name), content);
    const exists = (name : string) => fs.existsSync(path.join(stackDir(), name));

    beforeEach(() => {
        stacksDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-override-"));
        fs.mkdirSync(path.join(stacksDir, "demo"));
        write("compose.yaml", "services:\n  web:\n    image: nginx\n");

        server = { stacksDir } as DockgeServer;
        Stack.invalidateCache("demo");
    });

    afterEach(() => {
        fs.rmSync(stacksDir, {
            recursive: true,
            force: true,
        });
    });

    const stack = () => new Stack(server, "demo");

    it("reports no override for a stack that has none", () => {
        expect(stack().composeOverrideYAML).toBe("");
    });

    it("names the file it would create", () => {
        expect(stack().composeOverrideFileName).toBe("compose.override.yaml");
    });

    it("reads an override the stack already has", () => {
        write("compose.override.yaml", "services:\n  web:\n    ports:\n      - 8080:80\n");

        expect(stack().composeOverrideYAML).toContain("8080:80");
    });

    it("keeps the name an existing override already uses", () => {
        // Docker compose accepts several, and writing a second one would mean
        // two override files in the same directory
        write("docker-compose.override.yml", "services: {}\n");

        const s = stack();
        expect(s.composeOverrideFileName).toBe("docker-compose.override.yml");
        expect(s.composeOverrideYAML).toBe("services: {}\n");
    });

    it("writes the override to disk", async () => {
        await stack().saveComposeOverride("services:\n  web:\n    ports:\n      - 9090:80\n");

        expect(fs.readFileSync(path.join(stackDir(), "compose.override.yaml"), "utf-8")).toContain("9090:80");
    });

    it("writes back to the name the stack already used", async () => {
        write("docker-compose.override.yml", "services: {}\n");

        await stack().saveComposeOverride("services:\n  web:\n    ports:\n      - 9090:80\n");

        expect(exists("compose.override.yaml")).toBe(false);
        expect(fs.readFileSync(path.join(stackDir(), "docker-compose.override.yml"), "utf-8")).toContain("9090:80");
    });

    it("removes the file when the content is cleared", async () => {
        write("compose.override.yaml", "services: {}\n");

        await stack().saveComposeOverride("");

        // An empty file left behind would still be merged by docker compose
        expect(exists("compose.override.yaml")).toBe(false);
    });

    it("removes the file when only whitespace is left", async () => {
        write("compose.override.yaml", "services: {}\n");

        await stack().saveComposeOverride("   \n  \n");

        expect(exists("compose.override.yaml")).toBe(false);
    });

    it("does nothing surprising when clearing a stack that had no override", async () => {
        await expect(stack().saveComposeOverride("")).resolves.toBeUndefined();
        expect(exists("compose.override.yaml")).toBe(false);
    });

    it("refuses YAML that does not parse", async () => {
        await expect(stack().saveComposeOverride("services:\n  web:\n   - : :\n")).rejects.toThrow();
        expect(exists("compose.override.yaml")).toBe(false);
    });

    it("reads back what it just wrote", async () => {
        const s = stack();
        await s.saveComposeOverride("services:\n  web:\n    ports:\n      - 9090:80\n");

        expect(s.composeOverrideYAML).toContain("9090:80");
        expect(stack().composeOverrideYAML).toContain("9090:80");
    });

    it("refuses to write into a directory Dockge does not manage", async () => {
        const missing = new Stack(server, "not-there");

        await expect(missing.saveComposeOverride("services: {}\n")).rejects.toThrow();
    });
});
