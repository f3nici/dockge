import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "url";
import {
    ValidationError,
    callbackError,
    callbackResult,
    fileExists,
} from "../backend/util-server";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";

describe("ValidationError", () => {
    it("is an Error carrying the given message", () => {
        const error = new ValidationError("bad input");
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("bad input");
    });
});

describe("callbackError", () => {
    it("flags validation errors with the validation error type", () => {
        const callback = vi.fn();
        callbackError(new ValidationError("nope"), callback);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: "nope",
            msgi18n: true,
        });
    });

    it("passes through a generic error message", () => {
        const callback = vi.fn();
        callbackError(new Error("boom"), callback);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            msg: "boom",
            msgi18n: true,
        });
    });

    it("does nothing useful when the callback is not a function", () => {
        expect(() => callbackError(new Error("boom"), undefined)).not.toThrow();
    });
});

describe("callbackResult", () => {
    it("forwards the result to the callback", () => {
        const callback = vi.fn();
        callbackResult({ ok: true }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true });
    });

    it("does nothing when the callback is not a function", () => {
        expect(() => callbackResult({ ok: true }, null)).not.toThrow();
    });
});

describe("fileExists", () => {
    it("resolves to true for an existing file", async () => {
        const thisFile = fileURLToPath(import.meta.url);
        await expect(fileExists(thisFile)).resolves.toBe(true);
    });

    it("resolves to false for a missing file", async () => {
        await expect(fileExists("/definitely/not/here/at/all.txt")).resolves.toBe(false);
    });
});
