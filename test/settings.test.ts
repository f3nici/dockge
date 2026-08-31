import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// A stand-in for the setting table. `key` is unique across every type, which is
// the whole reason setSettings has to refuse some writes.
type Row = { key : string, value : string, type : string | null };

const { rows, findOne, store, dispense } = vi.hoisted(() => {
    const rows : Row[] = [];
    return {
        rows,
        findOne: vi.fn(async (_table : string, _sql : string, params : string[]) => {
            return rows.find((row) => row.key === params[0]) ?? null;
        }),
        store: vi.fn(async (bean : Row) => {
            if (!rows.includes(bean)) {
                rows.push(bean);
            }
        }),
        dispense: vi.fn(() => ({
            key: "",
            value: "",
            type: null,
        } as Row)),
    };
});

vi.mock("redbean-node", () => ({
    R: {
        findOne,
        store,
        dispense,
        getCell: vi.fn(),
        getAll: vi.fn(async () => []),
    },
}));

import { Settings } from "../backend/settings";

describe("Settings.setSettings", () => {
    beforeEach(() => {
        rows.length = 0;
        Settings.deleteCache([ "owned", "shared", "other" ]);
    });

    it("writes keys that are free or already its own", async () => {
        await expect(Settings.setSettings("general", { owned: "yes" })).resolves.toBeUndefined();

        expect(rows.find((row) => row.key === "owned")?.value).toBe("\"yes\"");
    });

    // The uniqueness of `key` is what stops a settings write reaching something
    // like jwtSecret, so the refusal itself is correct - but a caller told
    // nothing went on to report a success it did not have.
    it("raises the keys it refused to write", async () => {
        rows.push({
            key: "shared",
            value: "\"from notifications\"",
            type: "notifications",
        });

        await expect(Settings.setSettings("general", {
            owned: "yes",
            shared: "hijacked",
        })).rejects.toThrow(/"shared"/);

        // The value that was already there is untouched
        expect(rows.find((row) => row.key === "shared")?.value).toBe("\"from notifications\"");
    });

    // Writing what fits and then reporting failure is the worst of both: the
    // caller is told it did not happen while some of it did, and skips the work
    // it does after a successful save.
    it("writes nothing at all when one key conflicts", async () => {
        rows.push({
            key: "shared",
            value: "\"from notifications\"",
            type: "notifications",
        });

        await expect(Settings.setSettings("general", {
            owned: "yes",
            shared: "hijacked",
        })).rejects.toThrow();

        expect(rows.find((row) => row.key === "owned")).toBeUndefined();
    });
});

describe("Settings.setSettings conflicts", () => {
    beforeEach(() => {
        rows.length = 0;
        Settings.deleteCache([ "owned", "shared", "credentials" ]);
    });

    it("saves normally when nothing is in the way", async () => {
        await expect(Settings.setSettings("registry", { credentials: [] })).resolves.toBeUndefined();
        expect(rows.find((row) => row.key === "credentials")?.type).toBe("registry");
    });

    // Registry logins were the case that made this necessary: the manager
    // updated itself in memory and reported "Saved" while the row never
    // persisted, so the logins vanished at the next restart.
    it("throws rather than let the caller report a save that did not happen", async () => {
        rows.push({
            key: "credentials",
            value: "\"squatted\"",
            type: "general",
        });

        await expect(Settings.setSettings("registry", { credentials: [] }))
            .rejects.toThrow(/could not save "credentials"/i);
    });

    it("names every key it could not write", async () => {
        rows.push({
            key: "shared",
            value: "1",
            type: "notifications",
        });
        rows.push({
            key: "owned",
            value: "1",
            type: "notifications",
        });

        await expect(Settings.setSettings("general", {
            shared: "a",
            owned: "b",
        })).rejects.toThrow(/"shared", "owned"/);
    });
});
