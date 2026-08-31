import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { KumaRateLimiter, loginRateLimiter } from "../backend/rate-limiter";

/**
 * A limiter with a budget small enough to exhaust in a test.
 * @param tokens How many requests are allowed per minute
 */
function makeLimiter(tokens : number) {
    return new KumaRateLimiter({
        tokensPerInterval: tokens,
        interval: "minute",
        fireImmediately: true,
        errorMessage: "Too frequently, try again later.",
    });
}

describe("KumaRateLimiter", () => {
    beforeEach(() => {
        loginRateLimiter.reset();
    });

    it("lets a client through while it still has budget", async () => {
        const limiter = makeLimiter(2);
        const callback = vi.fn();

        await expect(limiter.pass(callback, 1, "10.0.0.1")).resolves.toBe(true);
        expect(callback).not.toHaveBeenCalled();
    });

    it("refuses a client that has spent its budget", async () => {
        const limiter = makeLimiter(2);
        const callback = vi.fn();

        await limiter.pass(callback, 1, "10.0.0.1");
        await limiter.pass(callback, 1, "10.0.0.1");

        await expect(limiter.pass(callback, 1, "10.0.0.1")).resolves.toBe(false);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            msg: "Too frequently, try again later.",
        });
    });

    // The point of the per-client budget: with one shared bucket, anybody who
    // could reach the login page could spend it and lock everybody else out.
    it("does not let one client spend another client's budget", async () => {
        const limiter = makeLimiter(2);
        const callback = vi.fn();

        await limiter.pass(callback, 1, "10.0.0.1");
        await limiter.pass(callback, 1, "10.0.0.1");
        await expect(limiter.pass(callback, 1, "10.0.0.1")).resolves.toBe(false);

        // A different address is untouched by the first one's spending
        await expect(limiter.pass(callback, 1, "10.0.0.2")).resolves.toBe(true);
        await expect(limiter.pass(callback, 1, "10.0.0.2")).resolves.toBe(true);
        await expect(limiter.pass(callback, 1, "10.0.0.2")).resolves.toBe(false);
    });

    it("keeps unattributable requests in one bucket rather than skipping the limit", async () => {
        const limiter = makeLimiter(1);
        const callback = vi.fn();

        await expect(limiter.pass(callback)).resolves.toBe(true);
        await expect(limiter.pass(callback)).resolves.toBe(false);
    });

    it("tracks each client separately without being reset in between", async () => {
        const limiter = makeLimiter(1);
        const callback = vi.fn();

        for (const ip of [ "10.0.0.1", "10.0.0.2", "10.0.0.3" ]) {
            await expect(limiter.pass(callback, 1, ip)).resolves.toBe(true);
            await expect(limiter.pass(callback, 1, ip)).resolves.toBe(false);
        }
    });

    it("ships a login limiter that is budgeted per client", async () => {
        const callback = vi.fn();

        // Spend the whole configured allowance for one address
        for (let i = 0; i < 20; i++) {
            await expect(loginRateLimiter.pass(callback, 1, "10.0.0.9")).resolves.toBe(true);
        }
        await expect(loginRateLimiter.pass(callback, 1, "10.0.0.9")).resolves.toBe(false);

        // Another user's login is not collateral damage
        await expect(loginRateLimiter.pass(callback, 1, "10.0.0.10")).resolves.toBe(true);
    });
});
