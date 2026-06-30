import { describe, it, expect } from "vitest";
import {
    SHAKE256_LENGTH,
    generatePasswordHash,
    needRehashPassword,
    shake256,
    verifyPassword,
} from "../backend/password-hash";

describe("password hashing", () => {
    it("generates a bcrypt hash that verifies against the original password", () => {
        const hash = generatePasswordHash("super-secret");
        expect(hash).not.toBe("super-secret");
        expect(verifyPassword("super-secret", hash)).toBe(true);
    });

    it("rejects an incorrect password", () => {
        const hash = generatePasswordHash("super-secret");
        expect(verifyPassword("wrong-password", hash)).toBe(false);
    });

    it("produces a different hash each time (salted)", () => {
        expect(generatePasswordHash("same")).not.toBe(generatePasswordHash("same"));
    });

    it("never asks for a rehash", () => {
        expect(needRehashPassword(generatePasswordHash("x"))).toBe(false);
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
