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
import { ValidationError } from "../backend/util-server";

let root : string;
let stacksDir : string;
let outside : string;

/**
 * Just enough DockgeServer for the path checks, which only read stacksDir.
 */
function fakeServer() : DockgeServer {
    return { stacksDir } as unknown as DockgeServer;
}

describe("Stack.resolveStackDir", () => {
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-stack-path-"));
        stacksDir = path.join(root, "stacks");
        outside = path.join(root, "outside");
        fs.mkdirSync(stacksDir);
        fs.mkdirSync(outside);
    });

    afterEach(() => {
        fs.rmSync(root, {
            recursive: true,
            force: true,
        });
    });

    it("accepts an ordinary stack name", () => {
        expect(Stack.resolveStackDir(fakeServer(), "my-stack")).toBe(path.join(fs.realpathSync(stacksDir), "my-stack"));
    });

    it("accepts a stack that already exists", () => {
        fs.mkdirSync(path.join(stacksDir, "existing"));

        expect(Stack.resolveStackDir(fakeServer(), "existing")).toBe(path.join(fs.realpathSync(stacksDir), "existing"));
    });

    it("rejects a traversal out of the stacks directory", () => {
        expect(() => Stack.resolveStackDir(fakeServer(), "../outside")).toThrow(ValidationError);
        expect(() => Stack.resolveStackDir(fakeServer(), "../../etc")).toThrow(ValidationError);
        expect(() => Stack.resolveStackDir(fakeServer(), "a/../../outside")).toThrow(ValidationError);
    });

    it("rejects the stacks directory itself", () => {
        expect(() => Stack.resolveStackDir(fakeServer(), "")).toThrow(ValidationError);
        expect(() => Stack.resolveStackDir(fakeServer(), ".")).toThrow(ValidationError);
    });

    // path.join() treats a leading slash as just another separator, so an
    // absolute-looking name lands inside the stacks directory rather than at
    // the root. Containment holds; it is worth pinning down that it does.
    it("contains an absolute-looking name inside the stacks directory", () => {
        expect(Stack.resolveStackDir(fakeServer(), "/etc")).toBe(path.join(fs.realpathSync(stacksDir), "etc"));
    });

    // A lexical resolve only rules out "..", and says nothing about a symlink.
    // An entry inside stacksDir pointing elsewhere passed the old check and was
    // then written through.
    it("rejects a stack directory that is a symlink out of the stacks directory", () => {
        fs.symlinkSync(outside, path.join(stacksDir, "escape"));

        expect(() => Stack.resolveStackDir(fakeServer(), "escape")).toThrow(ValidationError);
    });

    it("rejects a stack reached through a symlinked parent", () => {
        fs.symlinkSync(outside, path.join(stacksDir, "escape"));

        expect(() => Stack.resolveStackDir(fakeServer(), "escape/child")).toThrow(ValidationError);
    });

    // The stacks directory is resolved the same way, so a deployment that mounts
    // it through a symlink still works normally.
    it("allows a stack when the stacks directory itself is a symlink", () => {
        const linkedStacksDir = path.join(root, "linked-stacks");
        fs.symlinkSync(stacksDir, linkedStacksDir);
        stacksDir = linkedStacksDir;

        expect(Stack.resolveStackDir(fakeServer(), "my-stack"))
            .toBe(path.join(fs.realpathSync(linkedStacksDir), "my-stack"));
    });

    it("allows a symlink that stays inside the stacks directory", () => {
        fs.mkdirSync(path.join(stacksDir, "real"));
        fs.symlinkSync(path.join(stacksDir, "real"), path.join(stacksDir, "alias"));

        expect(Stack.resolveStackDir(fakeServer(), "alias")).toBe(path.join(fs.realpathSync(stacksDir), "real"));
    });
});

// Resolving the name is only worth anything if the resolved value is what the
// reads and writes actually land on. It used to be checked and then thrown
// away, with Stack.path rebuilding an unvalidated path.join() for every
// operation - so a symlink could still be followed straight out of stacksDir.
describe("Stack.path", () => {
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-stack-path-"));
        stacksDir = path.join(root, "stacks");
        outside = path.join(root, "outside");
        fs.mkdirSync(stacksDir);
        fs.mkdirSync(outside);
    });

    afterEach(() => {
        fs.rmSync(root, {
            recursive: true,
            force: true,
        });
    });

    it("is the resolved directory the containment check validated", () => {
        const stack = new Stack(fakeServer(), "my-stack");

        expect(stack.path).toBe(Stack.resolveStackDir(fakeServer(), "my-stack"));
        expect(stack.path).toBe(path.join(fs.realpathSync(stacksDir), "my-stack"));
    });

    it("refuses to hand out a path for a stack that escapes the stacks directory", () => {
        fs.symlinkSync(outside, path.join(stacksDir, "escape"));

        // Thrown when the Stack is built, because the constructor takes the path
        expect(() => new Stack(fakeServer(), "escape")).toThrow(ValidationError);
    });

    it("resolves through a symlinked stacks directory rather than rebuilding it lexically", () => {
        const linkedStacksDir = path.join(root, "linked-stacks");
        fs.symlinkSync(stacksDir, linkedStacksDir);
        stacksDir = linkedStacksDir;

        const stack = new Stack(fakeServer(), "my-stack");

        // The lexical join would have kept the link in the path
        expect(stack.path).not.toContain("linked-stacks");
        expect(stack.path).toBe(path.join(fs.realpathSync(linkedStacksDir), "my-stack"));
    });

    // Taken once, in the constructor, so a symlink planted afterwards cannot
    // redirect operations that are already under way.
    it("does not re-resolve once it has been taken", () => {
        const stack = new Stack(fakeServer(), "later");
        const before = stack.path;

        fs.symlinkSync(outside, path.join(stacksDir, "later"));

        expect(stack.path).toBe(before);
        expect(stack.path.startsWith(fs.realpathSync(stacksDir) + path.sep)).toBe(true);
    });
});
