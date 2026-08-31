// "limit" is bugged in Typescript, use "limiter-es6-compat" instead
// See https://github.com/jhurliman/node-rate-limiter/issues/80
import { RateLimiter, RateLimiterOpts } from "limiter-es6-compat";
import { log } from "./log";

export interface KumaRateLimiterOpts extends RateLimiterOpts {
    errorMessage : string;
}

export type KumaRateLimiterCallback = (err : object) => void;

/**
 * How long a per-client bucket is kept after it was last used.
 *
 * A bucket that has been idle for longer than its own refill interval is
 * indistinguishable from a fresh one, so dropping it costs nothing and stops
 * the map from growing once per address that has ever tried to log in.
 */
const BUCKET_TTL_MS = 60 * 60 * 1000;

class KumaRateLimiter {

    errorMessage : string;
    private config : KumaRateLimiterOpts;

    /**
     * One bucket per client, so that one caller spending its budget cannot
     * spend anybody else's.
     */
    private buckets : Map<string, { limiter : RateLimiter, lastUsed : number }> = new Map();

    /**
     * @param {object} config Rate limiter configuration object
     */
    constructor(config : KumaRateLimiterOpts) {
        this.errorMessage = config.errorMessage;
        this.config = config;
    }

    /**
     * The bucket belonging to one client, created on first use.
     *
     * Idle buckets are dropped on the way past. This runs on the login path,
     * which is not hot, and the map only holds clients seen in the last hour.
     * @param key Who is being limited, normally their IP address
     */
    private bucketFor(key : string) : RateLimiter {
        const now = Date.now();

        for (const [ bucketKey, bucket ] of this.buckets) {
            if (now - bucket.lastUsed > BUCKET_TTL_MS) {
                this.buckets.delete(bucketKey);
            }
        }

        let bucket = this.buckets.get(key);

        if (!bucket) {
            bucket = {
                limiter: new RateLimiter(this.config),
                lastUsed: now,
            };
            this.buckets.set(key, bucket);
        } else {
            bucket.lastUsed = now;
        }

        return bucket.limiter;
    }

    /**
     * Callback for pass
     * @callback passCB
     * @param {object} err Too many requests
     */

    /**
     * Should the request be passed through
     * @param callback Callback function to call with decision
     * @param {number} num Number of tokens to remove
     * @param {string} key Who to charge the request to. Requests that cannot be
     * attributed share one bucket rather than skipping the limit entirely.
     * @returns {Promise<boolean>} Should the request be allowed?
     */
    async pass(callback : KumaRateLimiterCallback, num = 1, key = "") {
        const remainingRequests = await this.removeTokens(num, key);
        log.info("rate-limit", `remaining requests for ${key || "unknown"}: ${remainingRequests}`);
        if (remainingRequests < 0) {
            if (callback) {
                callback({
                    ok: false,
                    msg: this.errorMessage,
                });
            }
            return false;
        }
        return true;
    }

    /**
     * Remove a given number of tokens
     * @param {number} num Number of tokens to remove
     * @param {string} key Who to charge the request to
     * @returns {Promise<number>} Number of remaining tokens
     */
    async removeTokens(num = 1, key = "") {
        return await this.bucketFor(key).removeTokens(num);
    }

    /**
     * Forget every bucket. For tests, so one case cannot exhaust another's budget.
     */
    reset() {
        this.buckets.clear();
    }
}

export { KumaRateLimiter };

/**
 * Login attempts, budgeted per client address.
 *
 * Deliberately not one shared bucket: with a single global budget, anybody who
 * could reach the login page could spend it and lock every legitimate user out,
 * while a guess spread over many addresses was not slowed down at all.
 */
export const loginRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 20,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later."
});
