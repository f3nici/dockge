import crypto from "node:crypto";
import { R } from "redbean-node";
import { ValidationError } from "./util-server";
import { log } from "./log";

/**
 * An API key as it is listed: everything but the key itself, which is only
 * ever shown once, when it is created.
 */
export interface ApiKeyInfo {
    id : number;
    name : string;

    /** The start of the key, to tell it apart from the others */
    prefix : string;

    /** Only allowed to read: GET requests */
    readOnly : boolean;

    createdAt : string;
    lastUsedAt : string | null;
}

/**
 * Who a request was made as, once its key checks out.
 */
export interface ApiCaller {
    /** The key's ID, or null for the key in DOCKGE_API_KEY */
    id : number | null;
    name : string;
    readOnly : boolean;
}

interface ApiKeyRow {
    id : number;
    name : string;
    key_hash : string;
    key_prefix : string;
    read_only : number | boolean;
    created_at : string;
    last_used_at : string | null;
}

const KEY_PREFIX = "dk_";
const DISPLAY_PREFIX_LENGTH = 10;

/**
 * last_used_at is written at most this often per key: Home Assistant polls
 * every few minutes, and a write per request would be most of the database
 * traffic it causes.
 */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

/**
 * The hash a key is stored and looked up by.
 *
 * A plain SHA-256 rather than a password hash: the keys are 256 random bits,
 * which leaves nothing to guess, and every API request has to check one.
 * @param key The key
 * @returns The hash, in hex
 */
export function hashApiKey(key : string) : string {
    return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * A new key: a prefix that makes it recognisable, then 32 random bytes.
 */
export function generateApiKey() : string {
    return KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/**
 * Compare two strings without giving away, by how long it takes, how much of
 * them matches.
 * @param a One
 * @param b The other
 */
function constantTimeEqual(a : string, b : string) : boolean {
    // Hashed first, so that the two are the same length whatever was sent
    return crypto.timingSafeEqual(Buffer.from(hashApiKey(a), "hex"), Buffer.from(hashApiKey(b), "hex"));
}

/**
 * @param row A row of the api_key table
 * @returns The key as it is listed
 */
function toInfo(row : ApiKeyRow) : ApiKeyInfo {
    return {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        readOnly: !!row.read_only,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

/**
 * The keys the REST API accepts.
 *
 * Besides the ones created in Settings, the key in the DOCKGE_API_KEY
 * environment variable is accepted with full access, the same as on
 * finder39/dockge, for setups that configure everything through the compose
 * file.
 */
export class ApiKeys {

    /** When each key's last_used_at was last written, by ID */
    protected static lastUsedWritten : Map<number, number> = new Map();

    /**
     * Create a key.
     * @param name What it is for
     * @param readOnly Only allow it to read
     * @returns The key, which is not stored and cannot be shown again, and how
     * it is listed
     */
    static async create(name : unknown, readOnly : unknown) : Promise<{ key : string, info : ApiKeyInfo }> {
        if (typeof name !== "string" || name.trim() === "" || name.trim().length > 64) {
            throw new ValidationError("The name must be 1 to 64 characters");
        }
        if (typeof readOnly !== "boolean") {
            throw new ValidationError("readOnly must be a boolean");
        }

        const key = generateApiKey();
        const createdAt = new Date().toISOString();

        const [ id ] = await R.knex("api_key").insert({
            name: name.trim(),
            key_hash: hashApiKey(key),
            key_prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
            read_only: readOnly,
            created_at: createdAt,
        });

        return {
            key,
            info: {
                id,
                name: name.trim(),
                prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
                readOnly,
                createdAt,
                lastUsedAt: null,
            },
        };
    }

    static async list() : Promise<ApiKeyInfo[]> {
        const rows = await R.knex("api_key").select("*").orderBy("id", "asc") as ApiKeyRow[];
        return rows.map(toInfo);
    }

    /**
     * Delete a key. Requests made with it are refused from then on.
     * @param id The key
     */
    static async revoke(id : unknown) {
        if (typeof id !== "number" || !Number.isInteger(id)) {
            throw new ValidationError("ID must be an integer");
        }

        const deleted = await R.knex("api_key").where("id", id).delete();
        ApiKeys.lastUsedWritten.delete(id);

        if (!deleted) {
            throw new ValidationError("API key not found");
        }
    }

    /**
     * Whether the API has any key at all. Without one it is off.
     */
    static async anyConfigured() : Promise<boolean> {
        if (process.env.DOCKGE_API_KEY) {
            return true;
        }
        const row = await R.knex("api_key").count("id as count").first() as { count : number } | undefined;
        return Number(row?.count ?? 0) > 0;
    }

    /**
     * Check a key sent with a request.
     * @param key The key, as sent
     * @returns Who the request is made as, or null when the key is not one
     */
    static async verify(key : string) : Promise<ApiCaller | null> {
        if (!key) {
            return null;
        }

        const envKey = process.env.DOCKGE_API_KEY;
        if (envKey && constantTimeEqual(key, envKey)) {
            return {
                id: null,
                name: "DOCKGE_API_KEY",
                readOnly: false,
            };
        }

        // Looked up by its hash, so there is nothing to compare character by
        // character here
        const row = await R.knex("api_key").where("key_hash", hashApiKey(key)).first() as ApiKeyRow | undefined;

        if (!row) {
            return null;
        }

        const now = Date.now();
        if (now - (ApiKeys.lastUsedWritten.get(row.id) ?? 0) >= LAST_USED_RESOLUTION_MS) {
            ApiKeys.lastUsedWritten.set(row.id, now);

            // Bookkeeping: a write that fails, the database being busy say,
            // must not turn away a request with a good key
            try {
                await R.knex("api_key").where("id", row.id).update({
                    last_used_at: new Date(now).toISOString(),
                });
            } catch (e) {
                log.warn("api", `Could not note when API key ${row.id} was last used: ${e}`);
            }
        }

        return {
            id: row.id,
            name: row.name,
            readOnly: !!row.read_only,
        };
    }
}
