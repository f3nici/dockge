import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/stack", () => ({
    Stack: {
        getStackList: vi.fn(),
    },
}));

// Which stack Dockge runs in is looked up from docker, which a unit test has
// no business asking
vi.mock("../backend/self-stack", () => ({
    SelfStack: {
        isSelfStack: vi.fn(async () => false),
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
import { SelfStack } from "../backend/self-stack";
import { AutoUpdateRunOptions } from "../common/types";

const getStackListMock = vi.mocked(Stack.getStackList);
const isSelfStackMock = vi.mocked(SelfStack.isSelfStack);

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
        imageChecksOptedOut: false,
        refreshImageUpdateStatus: vi.fn(async () => {}),
        update: vi.fn(async () => 0),
        ...overrides,
    };
}

/**
 * Run auto update over the given stacks and report which ones were pulled.
 * @param stacks The stacks the instance holds
 * @param options Anything that should differ from an auto update run that
 * updates every stack without a preference
 */
async function runOver(stacks: ReturnType<typeof fakeStack>[], options: Partial<AutoUpdateRunOptions> = {}) {
    getStackListMock.mockResolvedValue(new Map(stacks.map((stack) => [ stack.name, stack ])) as never);

    const server = { sendStackList: vi.fn() };
    const manager = new AutoUpdateManager(server as never);

    const updated = await manager.runNow({
        defaultBehaviour: "update",
        pruneAfterUpdate: false,
        ...options,
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
        // No skopeo, a registry refusing us: nothing is flagged, and that must
        // not read as "up to date"
        const unchecked = fakeStack("unchecked", { imageCheckConclusive: false });

        expect(await runOver([ unchecked ])).toEqual([ "unchecked" ]);
    });

    it("leaves a stack alone when the only unchecked service asked not to be checked", async () => {
        // dockge.imageupdates.check=false is an instruction, not a failed
        // lookup: the services that were checked are up to date, so there is
        // nothing to pull
        const partial = fakeStack("partial", { imageChecksOptedOut: true });

        expect(await runOver([ partial ])).toEqual([]);
        expect(partial.update).not.toHaveBeenCalled();
    });

    it("still pulls an opted-out stack when a checked service is behind", async () => {
        const partial = fakeStack("partial-behind", {
            imageChecksOptedOut: true,
            imageUpdatesAvailable: true,
        });

        expect(await runOver([ partial ])).toEqual([ "partial-behind" ]);
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

describe("AutoUpdateManager.runNow, the stack Dockge runs in", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isSelfStackMock.mockImplementation(async (name: string) => name === "dockge");
    });

    it("updates it after every other stack", async () => {
        const order: string[] = [];
        const record = (name: string) => vi.fn(async () => {
            order.push(name);
            return 0;
        });

        // Listed first, but updating it restarts Dockge, which would cut the
        // rest of the run short
        const self = fakeStack("dockge", {
            imageUpdatesAvailable: true,
            update: record("dockge"),
        });
        const other = fakeStack("other", {
            imageUpdatesAvailable: true,
            update: record("other"),
        });

        expect(await runOver([ self, other ])).toEqual([ "other", "dockge" ]);
        expect(order).toEqual([ "other", "dockge" ]);
    });

    it("leaves it alone when it is up to date", async () => {
        const self = fakeStack("dockge");

        expect(await runOver([ self ])).toEqual([]);
        expect(self.update).not.toHaveBeenCalled();
    });
});

describe("AutoUpdateManager.runNow options", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isSelfStackMock.mockResolvedValue(false);
    });

    it("updates stacks that are not taking part when updating all of them", async () => {
        const optedOut = fakeStack("opted-out", {
            autoUpdate: false,
            imageUpdatesAvailable: true,
        });

        expect(await runOver([ optedOut ], { all: true })).toEqual([ "opted-out" ]);
    });

    it("still leaves stopped stacks alone when updating all of them", async () => {
        const stopped = fakeStack("stopped", {
            isStarted: false,
            imageUpdatesAvailable: true,
        });

        expect(await runOver([ stopped ], { all: true })).toEqual([]);
    });

    it("tells each update what started the run, for the history", async () => {
        const viaApi = fakeStack("via-api", { imageUpdatesAvailable: true });
        await runOver([ viaApi ], { trigger: "api" });
        expect(viaApi.update).toHaveBeenCalledWith(undefined, false, false, "api");

        const scheduled = fakeStack("scheduled", { imageUpdatesAvailable: true });
        await runOver([ scheduled ]);
        expect(scheduled.update).toHaveBeenCalledWith(undefined, false, false, "scheduled");
    });
});
