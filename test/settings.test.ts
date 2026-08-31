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
        const skipped = await Settings.setSettings("general", { owned: "yes" });

        expect(skipped).toEqual([]);
        expect(rows.find((row) => row.key === "owned")?.value).toBe("\"yes\"");
    });

    // The uniqueness of `key` is what stops a settings write reaching something
    // like jwtSecret, so the refusal itself is correct - but a caller that is
    // told nothing goes on to report success it did not have.
    it("reports the keys it refused to write", async () => {
        rows.push({
            key: "shared",
            value: "\"from notifications\"",
            type: "notifications",
        });

        const skipped = await Settings.setSettings("general", {
            owned: "yes",
            shared: "hijacked",
        });

        expect(skipped).toEqual([ "shared" ]);
        // The value that was already there is untouched
        expect(rows.find((row) => row.key === "shared")?.value).toBe("\"from notifications\"");
        // and the writable key still went through
        expect(rows.find((row) => row.key === "owned")?.value).toBe("\"yes\"");
    });
});

describe("Settings.setSettingsStrict", () => {
    beforeEach(() => {
        rows.length = 0;
        Settings.deleteCache([ "owned", "shared", "credentials" ]);
    });

    it("saves normally when nothing is in the way", async () => {
        await expect(Settings.setSettingsStrict("registry", { credentials: [] })).resolves.toBeUndefined();
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

        await expect(Settings.setSettingsStrict("registry", { credentials: [] }))
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

        await expect(Settings.setSettingsStrict("general", {
            shared: "a",
            owned: "b",
        })).rejects.toThrow(/"shared", "owned"/);
    });
});
