import { describe, it, expect } from "vitest";
import {
    SHAKE256_LENGTH,
    generatePasswordHash,
    needRehashPassword,
    shake256,
    verifyPassword,
} from "../backend/password-hash";

describe("password hashing", () => {
    it("generates a bcrypt hash that verifies against the original password", async () => {
        const hash = await generatePasswordHash("super-secret");
        expect(hash).not.toBe("super-secret");
        expect(await verifyPassword("super-secret", hash)).toBe(true);
    });

    it("rejects an incorrect password", async () => {
        const hash = await generatePasswordHash("super-secret");
        expect(await verifyPassword("wrong-password", hash)).toBe(false);
    });

    it("produces a different hash each time (salted)", async () => {
        expect(await generatePasswordHash("same")).not.toBe(await generatePasswordHash("same"));
    });

    it("never asks for a rehash", async () => {
        expect(needRehashPassword(await generatePasswordHash("x"))).toBe(false);
    });
});

describe("shake256", () => {
    it("returns an empty string for empty input", () => {
        expect(shake256("", SHAKE256_LENGTH)).toBe("");
    });

    it("returns a deterministic hex string of the requested length", () => {
        const hash = shake256("dockge", SHAKE256_LENGTH);
        expect(hash).toMatch(/^[0-9a-f]+$/);
        // hex string length is twice the byte length
        expect(hash).toHaveLength(SHAKE256_LENGTH * 2);
        expect(hash).toBe(shake256("dockge", SHAKE256_LENGTH));
    });

    it("returns different hashes for different inputs", () => {
        expect(shake256("a", SHAKE256_LENGTH)).not.toBe(shake256("b", SHAKE256_LENGTH));
    });
});
