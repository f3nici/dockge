import { describe, it, expect } from "vitest";
import { AutoUpdateManager, AUTO_UPDATE_DEFAULT_CRON } from "../backend/auto-update";

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
