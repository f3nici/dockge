import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { Stack } from "../backend/stack";

/**
 * Reaches the lock, which is protected because nothing outside Stack.save()
 * should be taking it.
 */
class TestableStack extends Stack {
    static run<T>(stackName : string, fn : () => Promise<T>) : Promise<T> {
        return Stack["withSaveLock"](stackName, fn);
    }

    static get lockCount() : number {
        return Stack["saveLocks"].size;
    }
}

/**
 * A job that records when it starts and finishes, so overlap is visible.
 * @param log Where to record
 * @param name What to record it as
 * @param ms How long the job takes
 */
function job(log : string[], name : string, ms = 10) {
    return async () => {
        log.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`${name}:end`);
        return name;
    };
}

describe("Stack save lock", () => {
    // Unique temp file names stopped two saves deleting each other's scratch
    // files, but .env and the compose file are shared whatever the temp files
    // are called: one save's failure cleanup could remove the .env another was
    // validating against. They have to not overlap at all.
    it("runs two saves of one stack one after the other", async () => {
        const order : string[] = [];

        await Promise.all([
            TestableStack.run("web", job(order, "first")),
            TestableStack.run("web", job(order, "second")),
        ]);

        expect(order).toEqual([ "first:start", "first:end", "second:start", "second:end" ]);
    });

    it("lets different stacks save at the same time", async () => {
        const order : string[] = [];

        await Promise.all([
            TestableStack.run("web", job(order, "web")),
            TestableStack.run("db", job(order, "db")),
        ]);

        // Both started before either finished
        expect(order.slice(0, 2).sort()).toEqual([ "db:start", "web:start" ]);
    });

    // A save that throws must not leave the stack locked for the life of the
    // process.
    it("does not wedge the stack when a save fails", async () => {
        const order : string[] = [];

        const failing = TestableStack.run("web", async () => {
            order.push("failing:start");
            throw new Error("validation failed");
        });

        await expect(failing).rejects.toThrow("validation failed");

        await expect(TestableStack.run("web", job(order, "next"))).resolves.toBe("next");
        expect(order).toEqual([ "failing:start", "next:start", "next:end" ]);
    });

    it("propagates each save's own result to its own caller", async () => {
        const results = await Promise.allSettled([
            TestableStack.run("web", async () => "ok"),
            TestableStack.run("web", async () => {
                throw new Error("second failed");
            }),
            TestableStack.run("web", async () => "third"),
        ]);

        expect(results[0]).toMatchObject({
            status: "fulfilled",
            value: "ok",
        });
        expect(results[1]).toMatchObject({ status: "rejected" });
        expect(results[2]).toMatchObject({
            status: "fulfilled",
            value: "third",
        });
    });

    it("forgets the lock once a stack is idle again", async () => {
        await TestableStack.run("web", async () => "done");

        // Let the cleanup callback run
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(TestableStack.lockCount).toBe(0);
    });
});
