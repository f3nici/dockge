import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/stack", () => ({
    Stack: {
        getStackList: vi.fn(),
    },
}));

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { AutoUpdateManager, AUTO_UPDATE_DEFAULT_CRON } from "../backend/auto-update";
import { resolveAutoUpdate } from "../common/util-common";
import { Stack } from "../backend/stack";

const getStackListMock = vi.mocked(Stack.getStackList);

/**
 * A stack as the auto update run sees it.
 * @param name Stack name
 * @param overrides Anything that should differ from a running, up to date,
 * auto-updating stack
 */
function fakeStack(name: string, overrides: Record<string, unknown> = {}) {
    return {
        name,
        isManagedByDockge: true,
        isStarted: true,
        autoUpdate: true,
        imageUpdatesAvailable: false,
        recreateNecessary: false,
        servicesMissing: false,
        imageCheckConclusive: true,
        refreshImageUpdateStatus: vi.fn(async () => {}),
        update: vi.fn(async () => 0),
        ...overrides,
    };
}

/**
 * Run auto update over the given stacks and report which ones were pulled.
 * @param stacks The stacks the instance holds
 */
async function runOver(stacks: ReturnType<typeof fakeStack>[]) {
    getStackListMock.mockResolvedValue(new Map(stacks.map((stack) => [ stack.name, stack ])) as never);

    const server = { sendStackList: vi.fn() };
    const manager = new AutoUpdateManager(server as never);

    const updated = await manager.runNow({
        defaultBehaviour: "update",
        pruneAfterUpdate: false,
    });

    return updated;
}

describe("AutoUpdateManager.validateCron", () => {
    it("accepts the default weekly cron expression", () => {
        expect(() => AutoUpdateManager.validateCron(AUTO_UPDATE_DEFAULT_CRON)).not.toThrow();
    });

    it("accepts common cron expressions", () => {
        expect(() => AutoUpdateManager.validateCron("0 4 * * *")).not.toThrow();
        expect(() => AutoUpdateManager.validateCron("0 4 1 * *")).not.toThrow();
        expect(() => AutoUpdateManager.validateCron("*/15 * * * *")).not.toThrow();
    });

    it("throws on an invalid cron expression", () => {
        expect(() => AutoUpdateManager.validateCron("not a cron")).toThrow();
        expect(() => AutoUpdateManager.validateCron("99 99 * * *")).toThrow();
    });
});

describe("resolveAutoUpdate", () => {
    it("uses the stack's own preference when it has one", () => {
        expect(resolveAutoUpdate(true, "none")).toBe(true);
        expect(resolveAutoUpdate(true, "update")).toBe(true);
        expect(resolveAutoUpdate(false, "none")).toBe(false);
        // An explicit opt-out wins over a global "update everything"
        expect(resolveAutoUpdate(false, "update")).toBe(false);
    });

    it("falls back to the global default when the stack has no preference", () => {
        expect(resolveAutoUpdate(null, "none")).toBe(false);
        expect(resolveAutoUpdate(null, "update")).toBe(true);
    });
});

describe("AutoUpdateManager.runNow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("pulls a stack whose images have an update waiting", async () => {
        const behind = fakeStack("behind", { imageUpdatesAvailable: true });

        expect(await runOver([ behind ])).toEqual([ "behind" ]);
        expect(behind.update).toHaveBeenCalledOnce();
    });

    it("leaves a stack that is already on the current images alone", async () => {
        const current = fakeStack("current");

        expect(await runOver([ current ])).toEqual([]);
        // The check still runs, it is the pull of every service that does not
        expect(current.refreshImageUpdateStatus).toHaveBeenCalledOnce();
        expect(current.update).not.toHaveBeenCalled();
    });

    it("pulls a stack running an image other than the one its compose file names", async () => {
        const drifted = fakeStack("drifted", { recreateNecessary: true });

        expect(await runOver([ drifted ])).toEqual([ "drifted" ]);
    });

    it("pulls a stack that is missing a container its compose file asks for", async () => {
        const incomplete = fakeStack("incomplete", { servicesMissing: true });

        expect(await runOver([ incomplete ])).toEqual([ "incomplete" ]);
    });

    it("checks nothing for stacks that are not taking part", async () => {
        const optedOut = fakeStack("opted-out", { autoUpdate: false });
        const stopped = fakeStack("stopped", { isStarted: false });

        expect(await runOver([ optedOut, stopped ])).toEqual([]);
        expect(optedOut.refreshImageUpdateStatus).not.toHaveBeenCalled();
        expect(stopped.refreshImageUpdateStatus).not.toHaveBeenCalled();
    });

    it("pulls a stack whose check could not reach the registry", async () => {
        // No skopeo, a registry refusing us, checks switched off for a service:
        // nothing is flagged, and that must not read as "up to date"
        const unchecked = fakeStack("unchecked", { imageCheckConclusive: false });

        expect(await runOver([ unchecked ])).toEqual([ "unchecked" ]);
    });

    it("carries on after a stack fails to update", async () => {
        const broken = fakeStack("broken", {
            imageUpdatesAvailable: true,
            update: vi.fn(async () => {
                throw new Error("pull failed");
            }),
        });
        const fine = fakeStack("fine", { imageUpdatesAvailable: true });

        expect(await runOver([ broken, fine ])).toEqual([ "fine" ]);
    });
});
