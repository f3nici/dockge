import fs from "fs";
import path from "path";
import os from "os";
import { log } from "./log";
import { Settings } from "./settings";
import { RegistryCredential, RegistryCredentialInfo, RegistryRateLimit, RegistryTestResult } from "../common/types";
import { LooseObject } from "../common/util-common";

/** The registry Docker Hub is known by everywhere except in config.json */
export const DOCKER_HUB = "docker.io";

/**
 * The key Docker Hub credentials are stored under in a docker config.json. The
 * docker CLI still writes this legacy v1 URL, while skopeo looks the same
 * credentials up under "docker.io", so both keys are written.
 */
const DOCKER_HUB_CONFIG_KEY = "https://index.docker.io/v1/";

/** The host that actually serves the Docker Hub registry API */
const DOCKER_HUB_API_HOST = "registry-1.docker.io";

/**
 * Docker Hub's own repository for reading the rate limit. Pulling its manifest
 * with HEAD reports the limit headers without spending a pull.
 */
const RATE_LIMIT_REPOSITORY = "ratelimitpreview/test";

const REQUEST_TIMEOUT_MS = 15 * 1000;

const MANIFEST_ACCEPT = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
].join(", ");

/**
 * Registry logins for pulling images.
 *
 * Both ways Dockge talks to a registry are anonymous out of the box: `skopeo
 * inspect` when checking for image updates, and `docker compose pull` when
 * actually updating. Anonymous pulls from Docker Hub are limited per IP address
 * (100 per 6 hours at the time of writing), and every update check of every
 * image spends one of them, which is easy to exhaust on a host running a lot of
 * stacks. Logging in raises the limit and ties it to the account instead of the
 * IP.
 *
 * Credentials are kept in the settings table and mirrored into a docker
 * config.json inside the data directory, which is handed to skopeo with
 * `--authfile` and to the docker CLI through `DOCKER_CONFIG`.
 */
export class RegistryCredentialManager {

    static INSTANCE = new RegistryCredentialManager();

    private credentials : RegistryCredential[] = [];

    /** Directory holding the generated config.json, inside the data dir */
    private configDir = "";

    /**
     * The docker config.json that was in effect before Dockge pointed
     * DOCKER_CONFIG at its own directory. Its contents are carried over so a
     * user who mounted their own ~/.docker keeps whatever is in it.
     */
    private baseConfig : LooseObject = {};

    /** The directory {@link baseConfig} was read from */
    private baseConfigDir = "";

    /** DOCKER_CONFIG as it was on startup, restored when the last login is removed */
    private originalDockerConfigEnv? : string;

    /**
     * Whether the generated config.json is on disk. Pointing skopeo at a file
     * that is not there makes it fail outright, which would take remote update
     * checks down with it, so a failed write means going on without it.
     */
    private authFileReady = false;

    private initialized = false;

    /**
     * Read the stored logins and make them available to skopeo and docker.
     * @param dataDir Dockge's data directory
     */
    async init(dataDir : string) {
        this.configDir = path.resolve(dataDir, "docker-config");
        this.originalDockerConfigEnv = process.env.DOCKER_CONFIG;
        this.baseConfig = this.readBaseConfig();
        this.initialized = true;

        await this.loadSettings();
        this.writeAuthFile();
    }

    /** Load the stored credentials from the settings table */
    async loadSettings() {
        try {
            const settings = await Settings.getSettings("registry");
            this.credentials = this.parseCredentials(settings?.credentials);

            if (this.credentials.length > 0) {
                log.info("registry", `Loaded credentials for ${this.credentials.length} registry/registries`);
            }
        } catch (e) {
            log.error("registry", "Failed to load registry credentials: " + e);
            this.credentials = [];
        }
    }

    /**
     * The stored logins without their secrets, for the browser.
     */
    list() : RegistryCredentialInfo[] {
        return this.credentials.map((credential) => {
            return {
                registry: credential.registry,
                username: credential.username,
            };
        });
    }

    /**
     * Replace the stored logins.
     *
     * An entry with an empty password keeps the password already stored for
     * that registry, so the browser never has to send a secret back that it was
     * never given in the first place.
     * @param list The logins to store
     */
    async save(list : unknown) {
        if (!Array.isArray(list)) {
            throw new Error("Registry credentials must be a list");
        }

        const previous = this.credentials;
        const result : RegistryCredential[] = [];

        for (const entry of list) {
            if (!entry || typeof(entry) !== "object") {
                throw new Error("Each registry credential must be an object");
            }

            const raw = entry as LooseObject;
            const registry = RegistryCredentialManager.normalizeRegistry(String(raw.registry ?? ""));
            const username = String(raw.username ?? "").trim();
            let password = String(raw.password ?? "");

            if (!registry) {
                throw new Error("Registry is required");
            }

            if (!username) {
                throw new Error(`Username is required for ${registry}`);
            }

            if (result.some((existing) => existing.registry === registry)) {
                throw new Error(`Duplicate entry for ${registry}`);
            }

            if (!password) {
                const stored = previous.find((credential) => credential.registry === registry);
                if (!stored) {
                    throw new Error(`Password or access token is required for ${registry}`);
                }
                password = stored.password;
            }

            result.push({
                registry,
                username,
                password,
            });
        }

        // Stored first: a write that does not land must not leave this instance
        // running on logins that are gone at the next restart
        await Settings.setSettings("registry", { credentials: result });

        this.credentials = result;
        this.writeAuthFile();

        log.info("registry", `Saved credentials for ${result.length} registry/registries`);
    }

    /**
     * Extra arguments telling skopeo where to find the logins, empty when none
     * are stored.
     */
    skopeoAuthArgs() : string[] {
        if (!this.authFileReady || this.credentials.length === 0 || !this.configDir) {
            return [];
        }

        return [ "--authfile", this.authFilePath() ];
    }

    /**
     * Check one login against its registry, and report Docker Hub's remaining
     * pulls while at it.
     *
     * An empty password means "use the one already stored", the same as in
     * {@link save}, so the check can be run on an entry the browser only knows
     * the username of.
     * @param registry Registry host
     * @param username Username
     * @param password Password or access token
     */
    async test(registry : unknown, username : unknown, password : unknown) : Promise<RegistryTestResult> {
        const host = RegistryCredentialManager.normalizeRegistry(String(registry ?? ""));
        const user = String(username ?? "").trim();
        let secret = String(password ?? "");

        if (!host) {
            throw new Error("Registry is required");
        }

        if (!user) {
            throw new Error("Username is required");
        }

        if (!secret) {
            const stored = this.credentials.find((credential) => credential.registry === host);
            if (!stored) {
                throw new Error("Password or access token is required");
            }
            secret = stored.password;
        }

        if (host === DOCKER_HUB) {
            return this.checkDockerHub(user, secret);
        }

        return this.checkRegistry(host, user, secret);
    }

    /**
     * Docker Hub's pull limit as it currently applies to Dockge: for the stored
     * account when one is configured, anonymously otherwise.
     */
    async getDockerHubRateLimit() : Promise<RegistryRateLimit> {
        const stored = this.credentials.find((credential) => credential.registry === DOCKER_HUB);
        const rateLimit = await this.readDockerHubRateLimit(stored?.username, stored?.password);

        if (stored) {
            rateLimit.username = stored.username;
        }

        return rateLimit;
    }

    /**
     * Bring the many spellings of a registry down to the host name docker and
     * skopeo use, so "https://index.docker.io/v1/" and "docker.io" are one
     * entry rather than two.
     * @param registry Registry as typed by the user
     */
    static normalizeRegistry(registry : string) : string {
        let host = registry.trim().toLowerCase();

        if (!host) {
            return "";
        }

        host = host.replace(/^https?:\/\//, "");

        // Drop any path ("index.docker.io/v1/") and trailing slashes
        const indexOfSlash = host.indexOf("/");
        if (indexOfSlash >= 0) {
            host = host.substring(0, indexOfSlash);
        }

        if (host === "index.docker.io" || host === "registry-1.docker.io" || host === "registry.hub.docker.com") {
            return DOCKER_HUB;
        }

        return host;
    }

    /** Where the generated config.json lives */
    private authFilePath() : string {
        return path.join(this.configDir, "config.json");
    }

    /**
     * Whatever docker config.json was in effect before Dockge generated its
     * own, so entries Dockge does not manage survive.
     */
    private readBaseConfig() : LooseObject {
        const dir = this.originalDockerConfigEnv || path.join(os.homedir(), ".docker");

        // Never read back the file this class generates
        if (path.resolve(dir) === this.configDir) {
            return {};
        }

        this.baseConfigDir = path.resolve(dir);
        const file = path.join(dir, "config.json");

        try {
            if (!fs.existsSync(file)) {
                return {};
            }

            const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
            return (parsed && typeof(parsed) === "object") ? parsed : {};
        } catch (e) {
            log.warn("registry", `Could not read the existing docker config at ${file}: ${e}`);
            return {};
        }
    }

    /**
     * Write the stored logins into a docker config.json and point the docker
     * CLI at it.
     *
     * This happens even with no logins configured, because DOCKER_CONFIG is
     * also where the docker CLI keeps its own state: left pointing at the
     * default ~/.docker, buildx tries to create /root/.docker/buildx on every
     * `docker compose` call, which fails noisily wherever that path is not
     * writable (a read-only root filesystem, or a container not running as
     * root). Pointing it into the data directory, which Dockge must be able to
     * write to anyway, keeps that out of the user's way. Anything the original
     * config held is carried across, so this stays invisible either way.
     */
    private writeAuthFile() {
        if (!this.initialized) {
            return;
        }

        const auths : LooseObject = {
            ...(typeof(this.baseConfig.auths) === "object" ? this.baseConfig.auths : {}),
        };

        // Every key the logins are written under, so credential helpers can be
        // kept out of the way of exactly those registries
        const managedKeys : string[] = [];

        for (const credential of this.credentials) {
            const auth = {
                auth: Buffer.from(`${credential.username}:${credential.password}`, "utf-8").toString("base64"),
            };

            if (credential.registry === DOCKER_HUB) {
                // The docker CLI reads the legacy key, skopeo the host name
                auths[DOCKER_HUB_CONFIG_KEY] = auth;
                auths[DOCKER_HUB] = auth;
                managedKeys.push(DOCKER_HUB_CONFIG_KEY, DOCKER_HUB);
            } else {
                auths[credential.registry] = auth;
                managedKeys.push(credential.registry);
            }
        }

        const config : LooseObject = {
            ...this.baseConfig,
            auths,
        };

        if (managedKeys.length > 0) {
            // With no logins of our own, nothing can be shadowed, and the user's
            // own helpers are theirs to keep
            this.dropConflictingCredentialHelpers(config, managedKeys);
        }

        try {
            fs.mkdirSync(this.configDir, {
                recursive: true,
                mode: 0o700,
            });
            fs.writeFileSync(this.authFilePath(), JSON.stringify(config, null, 4), { mode: 0o600 });
            this.linkBaseConfigEntries();
            this.authFileReady = managedKeys.length > 0;
            process.env.DOCKER_CONFIG = this.configDir;

            log.debug("registry", `Wrote the docker config to ${this.authFilePath()}`);
        } catch (e) {
            this.authFileReady = false;

            if (managedKeys.length > 0) {
                // A login the user just asked us to save went nowhere, so say so
                log.error("registry", "Failed to write the docker config with the registry logins: " + e);
                throw e;
            }

            // Only the buildx redirect is lost, which is not worth failing a
            // startup over: carry on with whatever DOCKER_CONFIG was in effect
            this.restoreDockerConfigEnv();
            log.warn("registry", "Could not write the docker config, so docker keeps using its default: " + e);
        }
    }

    /**
     * Take out the credential helpers that would shadow the logins just
     * written.
     *
     * The docker CLI asks `credHelpers[registry]`, then `credsStore`, and only
     * reads `auths` when neither names a helper. A config carried over from a
     * Docker Desktop install ("credsStore": "desktop") would therefore send
     * every lookup to a helper binary that does not exist in Dockge's
     * container, and the logins would never be used.
     * @param config The config about to be written
     * @param managedKeys The auths keys Dockge wrote
     */
    private dropConflictingCredentialHelpers(config : LooseObject, managedKeys : string[]) {
        if (config.credsStore) {
            log.warn("registry", `Ignoring "credsStore": "${config.credsStore}" from the existing docker config, `
                + "as it would take precedence over the logins configured in Dockge");
            delete config.credsStore;
        }

        if (!config.credHelpers || typeof(config.credHelpers) !== "object") {
            return;
        }

        const credHelpers : LooseObject = { ...config.credHelpers };

        for (const key of managedKeys) {
            if (credHelpers[key]) {
                log.warn("registry", `Ignoring the credential helper "${credHelpers[key]}" configured for ${key}, `
                    + "as it would take precedence over the login configured in Dockge");
                delete credHelpers[key];
            }
        }

        config.credHelpers = credHelpers;
    }

    /**
     * Link everything else that lived next to the original config.json into the
     * generated directory.
     *
     * DOCKER_CONFIG points at a directory, not a file, so redirecting it also
     * moves where the CLI looks for `cli-plugins` (which is how `docker
     * compose` is found on some installs) and `contexts`. Linking them keeps
     * those working.
     */
    private linkBaseConfigEntries() {
        if (!this.baseConfigDir || !fs.existsSync(this.baseConfigDir)) {
            return;
        }

        let entries : string[];

        try {
            entries = fs.readdirSync(this.baseConfigDir);
        } catch (e) {
            log.warn("registry", `Could not read ${this.baseConfigDir}: ${e}`);
            return;
        }

        for (const entry of entries) {
            if (entry === "config.json") {
                continue;
            }

            const target = path.join(this.configDir, entry);

            try {
                // lstat rather than existsSync, so a link that has gone stale
                // still counts as "already handled"
                fs.lstatSync(target);
                continue;
            } catch (e) {
                // Not there yet, so link it below
            }

            try {
                fs.symlinkSync(path.join(this.baseConfigDir, entry), target);
            } catch (e) {
                log.warn("registry", `Could not link ${entry} from ${this.baseConfigDir}: ${e}`);
            }
        }
    }

    /** Undo the DOCKER_CONFIG override */
    private restoreDockerConfigEnv() {
        if (this.originalDockerConfigEnv === undefined) {
            delete process.env.DOCKER_CONFIG;
        } else {
            process.env.DOCKER_CONFIG = this.originalDockerConfigEnv;
        }
    }

    /**
     * Log in to Docker Hub and read the pull limit that comes with the account.
     * @param username Username
     * @param password Password or access token
     */
    private async checkDockerHub(username : string, password : string) : Promise<RegistryTestResult> {
        const token = await this.requestToken(
            "https://auth.docker.io/token",
            "registry.docker.io",
            `repository:${RATE_LIMIT_REPOSITORY}:pull`,
            username,
            password,
        );

        if (!token.ok) {
            return {
                ok: false,
                msg: token.msg,
            };
        }

        const rateLimit = await this.readRateLimitWithToken(DOCKER_HUB_API_HOST, token.token!, true);
        rateLimit.username = username;

        return {
            ok: true,
            msg: `Logged in to Docker Hub as ${username}.`,
            rateLimit,
        };
    }

    /**
     * Check a login against any other registry, using whichever of Basic auth
     * or a bearer token the registry asks for.
     * @param host Registry host
     * @param username Username
     * @param password Password or access token
     */
    private async checkRegistry(host : string, username : string, password : string) : Promise<RegistryTestResult> {
        const basic = "Basic " + Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
        let res : Response;

        try {
            res = await fetch(`https://${host}/v2/`, {
                headers: {
                    Authorization: basic,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            return {
                ok: false,
                msg: `Could not reach ${host}: ${e instanceof Error ? e.message : e}`,
            };
        }

        if (res.ok) {
            return {
                ok: true,
                msg: `Logged in to ${host} as ${username}.`,
            };
        }

        // The registry wants a token instead of Basic auth: get one with the
        // credentials, which fails if they are wrong
        const challenge = this.parseBearerChallenge(res.headers.get("www-authenticate"));
        if (res.status === 401 && challenge?.realm) {
            const token = await this.requestToken(challenge.realm, challenge.service, challenge.scope, username, password);

            if (!token.ok) {
                return {
                    ok: false,
                    msg: token.msg,
                };
            }

            return {
                ok: true,
                msg: `Logged in to ${host} as ${username}.`,
            };
        }

        if (res.status === 401 || res.status === 403) {
            return {
                ok: false,
                msg: `${host} rejected the credentials for ${username}.`,
            };
        }

        return {
            ok: false,
            msg: `${host} answered with HTTP ${res.status}.`,
        };
    }

    /**
     * Docker Hub's rate limit headers, read with the given login or
     * anonymously.
     * @param username Username, or undefined to check the anonymous limit
     * @param password Password or access token
     */
    private async readDockerHubRateLimit(username? : string, password? : string) : Promise<RegistryRateLimit> {
        const token = await this.requestToken(
            "https://auth.docker.io/token",
            "registry.docker.io",
            `repository:${RATE_LIMIT_REPOSITORY}:pull`,
            username,
            password,
        );

        if (!token.ok) {
            throw new Error(token.msg);
        }

        return this.readRateLimitWithToken(DOCKER_HUB_API_HOST, token.token!, !!username);
    }

    /**
     * Ask the registry for the pull limit headers. A HEAD on a manifest is what
     * Docker documents for this and does not count as a pull itself.
     * @param host Registry API host
     * @param token Bearer token
     * @param authenticated Whether the token was issued for an account
     */
    private async readRateLimitWithToken(host : string, token : string, authenticated : boolean) : Promise<RegistryRateLimit> {
        const rateLimit : RegistryRateLimit = {
            limit: null,
            remaining: null,
            windowSeconds: null,
            authenticated,
        };

        let res : Response;

        try {
            res = await fetch(`https://${host}/v2/${RATE_LIMIT_REPOSITORY}/manifests/latest`, {
                method: "HEAD",
                headers: {
                    Authorization: "Bearer " + token,
                    Accept: MANIFEST_ACCEPT,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            log.debug("registry", "Could not read the rate limit headers: " + e);
            return rateLimit;
        }

        // No headers at all means the account has no pull limit
        const limit = this.parseRateLimitHeader(res.headers.get("ratelimit-limit"));
        const remaining = this.parseRateLimitHeader(res.headers.get("ratelimit-remaining"));

        rateLimit.limit = limit.value;
        rateLimit.remaining = remaining.value;
        rateLimit.windowSeconds = limit.windowSeconds ?? remaining.windowSeconds;

        return rateLimit;
    }

    /**
     * Fetch a registry bearer token, optionally with a login.
     * @param realm Token endpoint
     * @param service Service the token is for
     * @param scope Scope to request
     * @param username Username, or undefined for an anonymous token
     * @param password Password or access token
     */
    private async requestToken(realm : string, service? : string, scope? : string, username? : string, password? : string)
        : Promise<{ ok : boolean, msg : string, token? : string }> {
        let url : URL;

        try {
            url = new URL(realm);
        } catch (e) {
            return {
                ok: false,
                msg: `The registry asked for a token from an invalid address: ${realm}`,
            };
        }

        // The realm comes from the registry, and the credentials are sent to
        // whatever it names, so plain http is refused rather than handing them
        // over in the clear
        if (url.protocol !== "https:") {
            return {
                ok: false,
                msg: `${url.host} asked for the credentials over ${url.protocol.replace(":", "")}, which would send them unencrypted.`,
            };
        }

        if (service) {
            url.searchParams.set("service", service);
        }

        if (scope) {
            url.searchParams.set("scope", scope);
        }

        const headers : LooseObject = {};
        if (username) {
            headers.Authorization = "Basic " + Buffer.from(`${username}:${password ?? ""}`, "utf-8").toString("base64");
        }

        let res : Response;

        try {
            res = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            return {
                ok: false,
                msg: `Could not reach ${url.host}: ${e instanceof Error ? e.message : e}`,
            };
        }

        if (res.status === 401 || res.status === 403) {
            return {
                ok: false,
                msg: username ? `The credentials for ${username} were rejected.` : "Anonymous access was rejected.",
            };
        }

        if (!res.ok) {
            return {
                ok: false,
                msg: `${url.host} answered with HTTP ${res.status}.`,
            };
        }

        let body : LooseObject;

        try {
            body = await res.json() as LooseObject;
        } catch (e) {
            return {
                ok: false,
                msg: `${url.host} returned a token that could not be read.`,
            };
        }

        const token = body.token || body.access_token;

        if (typeof(token) !== "string" || !token) {
            return {
                ok: false,
                msg: `${url.host} returned no token.`,
            };
        }

        return {
            ok: true,
            msg: "ok",
            token,
        };
    }

    /**
     * Read a "RateLimit-Limit: 100;w=21600" style header.
     * @param value Header value, if the registry sent one
     */
    private parseRateLimitHeader(value : string | null) : { value : number | null, windowSeconds : number | null } {
        if (!value) {
            return {
                value: null,
                windowSeconds: null,
            };
        }

        const [ amount, ...parameters ] = value.split(";");
        const parsedAmount = parseInt(amount.trim(), 10);

        let windowSeconds : number | null = null;
        for (const parameter of parameters) {
            const match = parameter.trim().match(/^w=(\d+)$/);
            if (match) {
                windowSeconds = parseInt(match[1], 10);
            }
        }

        return {
            value: Number.isNaN(parsedAmount) ? null : parsedAmount,
            windowSeconds,
        };
    }

    /**
     * Pick realm, service and scope out of a `WWW-Authenticate: Bearer ...`
     * header.
     * @param header The header value, if there was one
     */
    private parseBearerChallenge(header : string | null) : { realm : string, service? : string, scope? : string } | null {
        if (!header || !header.toLowerCase().startsWith("bearer ")) {
            return null;
        }

        const parameters : LooseObject = {};
        const pattern = /([a-z_]+)="([^"]*)"/gi;
        let match;

        while ((match = pattern.exec(header)) !== null) {
            parameters[match[1].toLowerCase()] = match[2];
        }

        if (!parameters.realm) {
            return null;
        }

        return {
            realm: parameters.realm,
            service: parameters.service,
            scope: parameters.scope,
        };
    }

    /**
     * Turn whatever is in the settings table into a usable credential list,
     * dropping entries that are not.
     * @param raw The stored value
     */
    private parseCredentials(raw : unknown) : RegistryCredential[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result : RegistryCredential[] = [];

        for (const entry of raw) {
            if (!entry || typeof(entry) !== "object") {
                continue;
            }

            const credential = entry as LooseObject;
            const registry = RegistryCredentialManager.normalizeRegistry(String(credential.registry ?? ""));
            const username = String(credential.username ?? "").trim();
            const password = String(credential.password ?? "");

            if (!registry || !username || !password) {
                continue;
            }

            if (result.some((existing) => existing.registry === registry)) {
                continue;
            }

            result.push({
                registry,
                username,
                password,
            });
        }

        return result;
    }
}
