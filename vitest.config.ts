import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Unit tests for the pure-logic modules in common/ and backend/.
        // Anything that needs a real database, docker or sockets is intentionally
        // out of scope here.
        include: [ "test/**/*.test.ts" ],
        environment: "node",
        globals: false,
        coverage: {
            provider: "v8",
            reporter: [ "text", "lcov" ],
            include: [
                "common/**/*.ts",
                "backend/utils/**/*.ts",
                "backend/password-hash.ts",
                "backend/util-server.ts",
            ],
        },
    },
});
