import { describe, it, expect, vi, beforeEach } from "vitest";

// The model talks to the database through redbean's R. Only the UPDATE matters
// here, so it is stubbed and inspected rather than run.
const { exec } = vi.hoisted(() => {
    return { exec: vi.fn() };
});

vi.mock("redbean-node", () => {
    return { R: { exec } };
});

import jwt from "jsonwebtoken";
import { User, JWT_EXPIRES_IN } from "../backend/models/user";
import { verifyPassword } from "../backend/password-hash";

/**
 * A User without going through redbean's bean machinery.
 * @returns A bean-shaped object carrying the model's methods
 */
function makeUser() {
    const user = Object.create(User.prototype);
    user.id = 7;
    user.username = "someone";
    user.password = "$2a$10$previoushash";
    return user;
}

describe("User.resetPassword", () => {
    beforeEach(() => {
        exec.mockReset();
    });

    it("leaves a hash on the bean, never the password itself", async () => {
        const user = makeUser();

        await user.resetPassword("correct horse battery staple");

        // The bean is what a later R.store() would write back, and what
        // createJWT() hashes into the token, so a plaintext here is a real leak
        expect(user.password).not.toBe("correct horse battery staple");
        expect(user.password.startsWith("$2")).toBe(true);
        await expect(verifyPassword("correct horse battery staple", user.password)).resolves.toBe(true);
    });

    it("keeps the bean and the database in step", async () => {
        const user = makeUser();

        await user.resetPassword("another password");

        expect(exec).toHaveBeenCalledTimes(1);
        const [ sql, params ] = exec.mock.calls[0];
        expect(sql).toMatch(/UPDATE .user. SET password/);
        // The hash that was stored is the hash the bean carries: a token minted
        // from this bean has to match what loginByToken reads back
        expect(params[0]).toBe(user.password);
        expect(params[1]).toBe(7);
    });

    it("returns the stored hash from the static helper", async () => {
        const hash = await User.resetPassword(7, "yet another password");

        expect(hash.startsWith("$2")).toBe(true);
        await expect(verifyPassword("yet another password", hash)).resolves.toBe(true);
    });
});

describe("User.createJWT", () => {
    // The token is a bearer credential that lives in the browser's localStorage
    // when "remember me" is on. Without an expiry, a copy lifted from there
    // stayed usable for good: only a password change or a reset of the JWT
    // secret ever invalidated one.
    it("gives the token a lifetime", () => {
        const user = makeUser();

        const decoded = jwt.decode(User.createJWT(user, "test-secret")) as Record<string, number>;

        expect(decoded.exp).toBeTypeOf("number");
        expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });

    it("expires the token after the configured window", () => {
        const user = makeUser();

        const decoded = jwt.decode(User.createJWT(user, "test-secret")) as Record<string, number>;

        expect(JWT_EXPIRES_IN).toBe("30d");
        expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
    });

    it("is rejected once it has expired", () => {
        const expired = jwt.sign({ username: "someone" }, "test-secret", { expiresIn: "-1s" });

        expect(() => jwt.verify(expired, "test-secret")).toThrow(jwt.TokenExpiredError);
    });

    // Tokens minted before the expiry existed carry no "exp" claim at all, and
    // jwt.verify() accepts a token without one, so upgrading does not sign
    // everybody out.
    it("still accepts a token issued before expiries existed", () => {
        const legacy = jwt.sign({ username: "someone" }, "test-secret");

        expect(() => jwt.verify(legacy, "test-secret")).not.toThrow();
    });
});
