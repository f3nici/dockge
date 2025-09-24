/*
 * Common utilities for backend and frontend
 */

// Init dayjs
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);

export interface LooseObject {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
}

export interface BaseRes {
    ok: boolean;
    msg?: string;
}

let randomBytes : (numBytes: number) => Uint8Array;
initRandomBytes();

async function initRandomBytes() {
    if (typeof window !== "undefined" && window.crypto) {
        randomBytes = function randomBytes(numBytes: number) {
            const bytes = new Uint8Array(numBytes);
            for (let i = 0; i < numBytes; i += 65536) {
                window.crypto.getRandomValues(bytes.subarray(i, i + Math.min(numBytes - i, 65536)));
            }
            return bytes;
        };
    } else {
        randomBytes = (await import("node:crypto")).randomBytes;
    }
}

export const ALL_ENDPOINTS = "##ALL_DOCKGE_ENDPOINTS##";

export const UNKNOWN = 0;
export const CREATED_FILE = 1;
export const CREATED_STACK = 2;
export const RUNNING = 3;
export const EXITED = 4;
export const RUNNING_AND_EXITED = 5;
export const UNHEALTHY = 6;

// Stack Status
export class StackStatusInfo {

    private static INFOS_BY_ID = new Map<number, StackStatusInfo>();
    private static DEFAULT = new StackStatusInfo("?", [], "secondary", "secondary");
    static ALL: StackStatusInfo[] = [];

    static {
        this.addInfo(new StackStatusInfo("unhealthy", [ UNHEALTHY ], "danger", "danger"));
        this.addInfo(new StackStatusInfo("active", [ RUNNING ], "primary", "primary"));
        this.addInfo(new StackStatusInfo("partially", [ RUNNING_AND_EXITED ], "info", "info"));
        this.addInfo(new StackStatusInfo("exited", [ EXITED ], "warning", "warning"));
        this.addInfo(new StackStatusInfo("inactive", [ CREATED_FILE, CREATED_STACK ], "dark", "secondary"));
    }

    private static addInfo(info: StackStatusInfo) {
        for (const id of info.statusIds) {
            this.INFOS_BY_ID.set(id, info);
        }
        this.ALL.push(info);
    }

    static get(statusId: number) {
        return this.INFOS_BY_ID.get(statusId) ?? this.DEFAULT;
    }

    constructor(readonly label: string, readonly statusIds: number[], readonly badgeColor: string, readonly textColor: string ) {}
}

export class StackFilter {
    agents = new StackFilterCategory<string>("agent");
    status = new StackFilterCategory<string>("status");
    attributes = new StackFilterCategory<string>("attribute");

    categories = [ this.agents, this.status, this.attributes ];

    isFilterSelected() {
        for (const category of this.categories) {
            if (category.isFilterSelected()) {
                return true;
            }
        }
        return false;
    }

    clear() {
        for (const category of this.categories) {
            category.selected.clear();
        }
    }
}

export class StackFilterCategory<T> {
    options: Record<string, T> = {};
    selected: Set<T> = new Set();

    constructor(readonly label: string) { }

    hasOptions() {
        return Object.keys(this.options).length > 0;
    }

    isFilterSelected() {
        if (this.selected.size === 0) {
            return false;
        }

        for (const ov of Object.values(this.options)) {
            if (this.selected.has(ov)) {
                return true;
            }
        }

        return false;
    }

    toggleSelected(value: T) {
        if (this.selected.has(value)) {
            this.selected.delete(value);
        } else {
            this.selected.add(value);
        }
    }
}

export const isDev = process.env.NODE_ENV === "development";
export const TERMINAL_COLS = 105;
export const TERMINAL_ROWS = 10;
export const PROGRESS_TERMINAL_ROWS = 8;

export const COMBINED_TERMINAL_COLS = 58;
export const COMBINED_TERMINAL_ROWS = 20;

export const ERROR_TYPE_VALIDATION = 1;

export const acceptedComposeFileNames = [
    "compose.yaml",
    "docker-compose.yaml",
    "docker-compose.yml",
    "compose.yml",
];

/**
 * Generate a decimal integer number from a string
 * @param str Input
 * @param length Default is 10 which means 0 - 9
 */
export function intHash(str : string, length = 10) : number {
    // A simple hashing function (you can use more complex hash functions if needed)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash += str.charCodeAt(i);
    }
    // Normalize the hash to the range [0, 10]
    return (hash % length + length) % length; // Ensure the result is non-negative
}

/**
 * Delays for specified number of seconds
 * @param ms Number of milliseconds to sleep for
 */
export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRecord(obj: unknown): obj is Record<string, unknown> {
    return typeof obj === "object" && obj !== null;
}

export function getNested<T>(
    obj: unknown,
    keys: string[]
): T | undefined {
    let current = obj;
    for (const key of keys) {
        if (!isRecord(current) || !(key in current)) {
            return undefined;
        }
        current = current[key];
    }
    return current as T;
}

/**
 * Generate a random alphanumeric string of fixed length
 * @param length Length of string to generate
 * @returns string
 */
export function genSecret(length = 64) {
    let secret = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charsLength = chars.length;
    for ( let i = 0; i < length; i++ ) {
        secret += chars.charAt(getCryptoRandomInt(0, charsLength - 1));
    }
    return secret;
}

/**
 * Get a random integer suitable for use in cryptography between upper
 * and lower bounds.
 * @param min Minimum value of integer
 * @param max Maximum value of integer
 * @returns Cryptographically suitable random integer
 */
export function getCryptoRandomInt(min: number, max: number):number {
    // synchronous version of: https://github.com/joepie91/node-random-number-csprng

    const range = max - min;
    if (range >= Math.pow(2, 32)) {
        console.log("Warning! Range is too large.");
    }

    let tmpRange = range;
    let bitsNeeded = 0;
    let bytesNeeded = 0;
    let mask = 1;

    while (tmpRange > 0) {
        if (bitsNeeded % 8 === 0) {
            bytesNeeded += 1;
        }
        bitsNeeded += 1;
        mask = mask << 1 | 1;
        tmpRange = tmpRange >>> 1;
    }

    const bytes = randomBytes(bytesNeeded);
    let randomValue = 0;

    for (let i = 0; i < bytesNeeded; i++) {
        randomValue |= bytes[i] << 8 * i;
    }

    randomValue = randomValue & mask;

    if (randomValue <= range) {
        return min + randomValue;
    } else {
        return getCryptoRandomInt(min, max);
    }
}

export function getComposeTerminalName(endpoint : string, stack : string) {
    return "compose-" + endpoint + "-" + stack;
}

export function getCombinedTerminalName(endpoint : string, stack : string) {
    return "combined-" + endpoint + "-" + stack;
}

export function getContainerTerminalName(endpoint : string, stackName : string, container : string, shell: string, index : number) {
    return "container-terminal-" + endpoint + "-" + stackName + "-" + container + "-" + shell + "-" + index;
}

export function getContainerLogName(endpoint : string, stackName : string, container : string, index : number) {
    return "container-log-" + endpoint + "-" + container;
}

export function getAgentMaintenanceTerminalName(endpoint : string) {
    return "agent-maintenance-" + endpoint;
}

/**
 * Possible Inputs:
 * ports:
 *   - "3000"
 *   - "3000-3005"
 *   - "8000:8000"
 *   - "9090-9091:8080-8081"
 *   - "49100:22"
 *   - "8000-9000:80"
 *   - "127.0.0.1:8001:8001"
 *   - "127.0.0.1:5000-5010:5000-5010"
 *   - "6060:6060/udp"
 * @param input
 * @param hostname
 */
export function parseDockerPort(input : string, hostname : string) {
    let port;
    let display;

    const parts = input.split("/");
    const part1 = parts[0];
    let protocol = parts[1] || "tcp";

    // Split the last ":"
    const lastColon = part1.lastIndexOf(":");

    if (lastColon === -1) {
        // No colon, so it's just a port or port range
        // Check if it's a port range
        const dash = part1.indexOf("-");
        if (dash === -1) {
            // No dash, so it's just a port
            port = part1;
        } else {
            // Has dash, so it's a port range, use the first port
            port = part1.substring(0, dash);
        }

        display = part1;

    } else {
        // Has colon, so it's a port mapping
        let hostPart = part1.substring(0, lastColon);
        display = hostPart;

        // Check if it's a port range
        const dash = part1.indexOf("-");

        if (dash !== -1) {
            // Has dash, so it's a port range, use the first port
            hostPart = part1.substring(0, dash);
        }

        // Check if it has a ip (ip:port)
        const colon = hostPart.indexOf(":");

        if (colon !== -1) {
            // Has colon, so it's a ip:port
            hostname = hostPart.substring(0, colon);
            port = hostPart.substring(colon + 1);
        } else {
            // No colon, so it's just a port
            port = hostPart;
        }
    }

    let portInt = parseInt(port);

    if (portInt == 443) {
        protocol = "https";
    } else if (protocol === "tcp") {
        protocol = "http";
    }

    return {
        url: protocol + "://" + hostname + ":" + portInt,
        display: display,
    };
}
