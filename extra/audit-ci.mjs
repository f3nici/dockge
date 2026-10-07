// Fails when a runtime dependency has a high or critical advisory, like
// `npm audit --omit=dev --audit-level=high`, except for the advisories listed
// in ALLOWED below. npm audit has no way to ignore a single advisory itself.
//
// Uses only Node built-ins: the CI audit job does not run `npm ci`.
import { spawnSync } from "node:child_process";

// Every entry needs a reason it cannot be reached, and should be removed as
// soon as a fixed version is published.
const ALLOWED = {
    // braces: stack exhaustion on deeply nested patterns. Every version is
    // affected and no fix exists. It is only reachable through
    // @inventage/envsubst -> globby -> fast-glob -> micromatch -> braces, and
    // Dockge only calls replaceVariablesSync from envsubst, which never globs.
    "GHSA-vfj7-8cjw-p6xm": "braces, not reachable from Dockge",
};

const FAIL_LEVELS = new Set([ "high", "critical" ]);

const result = spawnSync("npm", [ "audit", "--omit=dev", "--json" ], {
    encoding: "utf8",
    shell: process.platform === "win32",
});

let report;
try {
    report = JSON.parse(result.stdout);
} catch (e) {
    console.error("Could not parse npm audit output");
    console.error(result.stdout || result.stderr);
    process.exit(2);
}

if (report.error) {
    console.error("npm audit failed:", report.error.summary || report.error);
    process.exit(2);
}

// Each package lists the advisories against it as objects in `via`; strings in
// `via` only name the vulnerable dependency it pulls in, so skip those.
const blocking = new Map();
const allowed = new Map();
for (const [ name, vuln ] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vuln.via) {
        if (typeof via !== "object" || !FAIL_LEVELS.has(via.severity)) {
            continue;
        }
        const id = via.url.split("/").pop();
        const line = `${via.severity.padEnd(8)} ${name}  ${via.title}  ${via.url}`;
        (ALLOWED[id] ? allowed : blocking).set(id, line);
    }
}

for (const [ id, line ] of allowed) {
    console.log(`allowed  ${line}\n         (${ALLOWED[id]})`);
}

const unused = Object.keys(ALLOWED).filter((id) => !allowed.has(id));
for (const id of unused) {
    console.log(`note: ${id} is allowed but no longer reported; remove it from ALLOWED`);
}

if (blocking.size > 0) {
    console.error(`\n${blocking.size} high or critical advisories in runtime dependencies:`);
    for (const line of blocking.values()) {
        console.error(`  ${line}`);
    }
    console.error("\nRun `npm audit --omit=dev` for details.");
    process.exit(1);
}

console.log("No blocking advisories in runtime dependencies.");
