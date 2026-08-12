import { describe, it, expect } from "vitest";
import { AutoUpdateManager, AUTO_UPDATE_DEFAULT_CRON } from "../backend/auto-update";
import { resolveAutoUpdate } from "../common/util-common";

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
