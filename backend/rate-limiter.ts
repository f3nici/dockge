// "limit" is bugged in Typescript, use "limiter-es6-compat" instead
// See https://github.com/jhurliman/node-rate-limiter/issues/80
import { RateLimiter, RateLimiterOpts } from "limiter-es6-compat";
import { log } from "./log";

export interface KumaRateLimiterOpts extends RateLimiterOpts {
    errorMessage : string;

    /**
     * Ceiling on what everybody put together may spend per interval.
     *
     * The per-client budget alone is not a limit when the client picks its own
     * key: getClientIP() returns the leftmost X-Forwarded-For value when
     * trustProxy is on, which the caller supplies, so a forged header would
     * otherwise mint an unlimited series of fresh budgets. Set well above what
     * a real deployment spends, so it only ever bites a machine that is
     * cycling through keys.
     */
    globalTokensPerInterval? : number;
}

export type KumaRateLimiterCallback = (err : object) => void;

/**
 * Most keys the bucket map will hold.
 *
 * Forged keys are the reason there is a ceiling at all: without one, an
 * attacker rotating X-Forwarded-For grows this map for as long as they keep
 * asking. The least recently used entries go first, so a real client's budget
 * is only dropped once the map is full of something else - and dropping it is
 * safe anyway, since the global limiter still applies.
 */
const MAX_BUCKETS = 10000;

class KumaRateLimiter {

    errorMessage : string;
    private config : KumaRateLimiterOpts;

    /**
     * One bucket per client, so that one caller spending its budget cannot
     * spend anybody else's.
     */
    private buckets : Map<string, { limiter : RateLimiter, lastUsed : number }> = new Map();

    /**
     * The ceiling across every client. Only consulted once a request has
     * already cleared its own bucket, so a client that is being refused cannot
     * drain what everybody else is drawing on.
     */
    private globalLimiter : RateLimiter;

    /**
     * How long an idle bucket is kept. A bucket idle for longer than its own
     * refill interval is indistinguishable from a fresh one, so it is dropped
     * rather than held.
     */
    private bucketTtlMs : number;

    private lastSweep = 0;

    /**
     * @param {object} config Rate limiter configuration object
     */
    constructor(config : KumaRateLimiterOpts) {
        this.errorMessage = config.errorMessage;
        this.config = config;
        this.bucketTtlMs = KumaRateLimiter.intervalMs(config.interval);
        this.globalLimiter = new RateLimiter({
            ...config,
            tokensPerInterval: config.globalTokensPerInterval ?? config.tokensPerInterval * 10,
        });
    }

    /**
     * The refill interval in milliseconds, for whichever form it was given in.
     * @param interval As accepted by limiter-es6-compat
     */
    private static intervalMs(interval : RateLimiterOpts["interval"]) : number {
        if (typeof(interval) === "number") {
            return interval;
        }

        switch (interval) {
            case "second":
            case "sec":
                return 1000;
            case "minute":
            case "min":
                return 60 * 1000;
            case "hour":
            case "hr":
                return 60 * 60 * 1000;
            case "day":
                return 24 * 60 * 60 * 1000;
            default:
                return 60 * 1000;
        }
    }

    /**
     * Drop buckets nothing has used for longer than their refill interval, and
     * keep the map under {@link MAX_BUCKETS}.
     *
     * Swept on a timer rather than on every call: sweeping per request is O(n)
     * over a map an attacker controls the size of, which is quadratic work for
     * exactly the traffic the ceiling exists to survive.
     */
    private sweep() {
        const now = Date.now();

        if (now - this.lastSweep < this.bucketTtlMs) {
            return;
        }

        this.lastSweep = now;
        const cutoff = now - this.bucketTtlMs;

        for (const [ key, bucket ] of this.buckets) {
            if (bucket.lastUsed < cutoff) {
                this.buckets.delete(key);
            }
        }
    }

    /**
     * The bucket belonging to one client, created on first use.
     * @param key Who is being limited, normally their IP address
     */
    private bucketFor(key : string) : RateLimiter {
        this.sweep();

        let bucket = this.buckets.get(key);

        if (bucket) {
            bucket.lastUsed = Date.now();
            // Re-inserted so iteration order stays least-recently-used first
            this.buckets.delete(key);
            this.buckets.set(key, bucket);
            return bucket.limiter;
        }

        // Map is full of live buckets: drop the least recently used to make room
        while (this.buckets.size >= MAX_BUCKETS) {
            const oldest = this.buckets.keys().next();
            if (oldest.done) {
                break;
            }
            this.buckets.delete(oldest.value);
        }

        bucket = {
            limiter: new RateLimiter(this.config),
            lastUsed: Date.now(),
        };
        this.buckets.set(key, bucket);

        return bucket.limiter;
    }

    /**
     * Callback for pass
     * @callback passCB
     * @param {object} err Too many requests
     */

    /**
     * Should the request be passed through
     *
     * Both budgets have to allow it: the caller's own, and the ceiling across
     * everybody. The caller's is checked first, so a client that is already
     * being refused does not spend from the shared ceiling.
     * @param callback Callback function to call with decision
     * @param {number} num Number of tokens to remove
     * @param {string} key Who to charge the request to. Requests that cannot be
     * attributed share one bucket rather than skipping the limit entirely.
     * @returns {Promise<boolean>} Should the request be allowed?
     */
    async pass(callback : KumaRateLimiterCallback, num = 1, key = "") {
        const refuse = () => {
            if (callback) {
                callback({
                    ok: false,
                    msg: this.errorMessage,
                });
            }
            return false;
        };

        const remainingRequests = await this.bucketFor(key).removeTokens(num);
        log.info("rate-limit", `remaining requests for ${key || "unknown"}: ${remainingRequests}`);

        if (remainingRequests < 0) {
            return refuse();
        }

        const remainingGlobal = await this.globalLimiter.removeTokens(num);

        if (remainingGlobal < 0) {
            log.warn("rate-limit", "The overall rate limit has been reached, so this request is refused even though "
                + `${key || "the caller"} still had budget of its own. This normally means a client is cycling through addresses.`);
            return refuse();
        }

        return true;
    }

    /**
     * Remove a given number of tokens from one client's bucket, without
     * consulting the ceiling.
     * @param {number} num Number of tokens to remove
     * @param {string} key Who to charge the request to
     * @returns {Promise<number>} Number of remaining tokens
     */
    async removeTokens(num = 1, key = "") {
        return await this.bucketFor(key).removeTokens(num);
    }

    /**
     * How many client buckets are currently held. For tests.
     */
    get bucketCount() : number {
        return this.buckets.size;
    }

    /**
     * Forget every bucket and refill the ceiling. For tests, so one case cannot
     * exhaust another's budget.
     */
    reset() {
        this.buckets.clear();
        this.lastSweep = 0;
        this.globalLimiter = new RateLimiter({
            ...this.config,
            tokensPerInterval: this.config.globalTokensPerInterval ?? this.config.tokensPerInterval * 10,
        });
    }
}

export { KumaRateLimiter, MAX_BUCKETS };

/**
 * Login attempts, budgeted per client address and capped overall.
 *
 * Not one shared bucket: with a single global budget, anybody who could reach
 * the login page could spend it and lock every legitimate user out, while a
 * guess spread over many addresses was not slowed down at all.
 *
 * Not per-client alone either. The key is the client's address as
 * getClientIP() reports it, and behind trustProxy that comes from
 * X-Forwarded-For, which the client writes: the ceiling is what stops a forged
 * header turning "20 attempts a minute" into as many as the attacker likes.
 */
export const loginRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 20,
    interval: "minute",
    fireImmediately: true,
    globalTokensPerInterval: 200,
    errorMessage: "Too frequently, try again later."
});
