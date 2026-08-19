import { log } from "./log";
import childProcessAsync from "promisify-child-process";
import crypto from "crypto";
import { RegistryCredentialManager } from "./registry-credentials";

/**
 * How long a remote digest read from a registry stays usable.
 *
 * The same image is commonly referenced by several services and by several
 * stacks, and a single check sweep walks all of them back to back. Without this
 * every one of those references is its own trip to the registry, which is what
 * turns a routine check into a burst big enough to be rate limited. A few
 * minutes is far shorter than the check interval, so a scheduled check still
 * reads fresh digests; it only collapses the duplicates inside one sweep.
 */
const REMOTE_DIGEST_TTL_MS = 5 * 60 * 1000;

/**
 * How long to leave a registry alone after it has told us we are asking too
 * often.
 *
 * Carrying on through the rest of the images only deepens the hole: the
 * registry is already refusing, and every further request pushes the moment it
 * starts answering again further out.
 */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

export class ImageRepository {

    static INSTANCE = new ImageRepository();

    private imageInfos: Map<string, Map<string, ImageInfo>> = new Map();

    private warnedImages: Set<string> = new Set();

    private skopeoMissing = false;

    /**
     * Remote digests read recently, by image reference. Shared by every stack,
     * so an image used by ten services is looked up once.
     */
    private remoteDigests: Map<string, { digest: string, readAt: number }> = new Map();

    /**
     * Registries that answered with a rate limit error, and the time they may be
     * asked again.
     */
    private registryCooldowns: Map<string, number> = new Map();

    /**
     * The config digest last read for an image, and the manifest digest it was
     * read for. `updateImageInfos()` clears a stack's entries before every
     * check, so without this the config blob would be fetched again on every
     * poll for every image that has an update pending.
     */
    private remoteConfigDigests: Map<string, { manifestDigest: string, configDigest: string }> = new Map();

    resetStack(stack: string) {
        this.imageInfos.delete(stack);
    }

    /**
     * Check if an image reference is pinned to a specific digest.
     * Images with @sha256: are pinned and don't need update checks.
     */
    private isDigestPinned(image: string): boolean {
        return image.startsWith("sha256:") || image.includes("@sha256:");
    }

    async update(stack: string, service: string, image: string): Promise<ImageInfo> {
        let imageInfo = await this.updateLocal(stack, service, image);

        // Skip remote digest check for digest-pinned images
        // (they're explicitly pinned to a specific version, no update possible)
        if (!!imageInfo.localDigest && !this.isDigestPinned(image)) {
            const remoteDigest = await this.inspectRemoteDigest(image);

            // skopeo is not installed: keep what we know locally and give up
            if (remoteDigest === undefined) {
                return imageInfo;
            }

            // The config read for this exact manifest still describes it
            const cached = this.remoteConfigDigests.get(image);
            const knownConfigDigest = cached?.manifestDigest === remoteDigest ? cached.configDigest : "";

            imageInfo = new ImageInfo(remoteDigest, imageInfo.localDigest, imageInfo.localId, imageInfo.localDigests, knownConfigDigest);

            const manifestDiffers = !!remoteDigest && !imageInfo.localDigests.includes(remoteDigest);

            // A manifest digest that does not match is not proof of a new image:
            // registries, mirrors and pull-through caches can hand out a different
            // manifest for the very same content, which would leave the stack
            // flagged as updatable forever - pulling it changes nothing, so the
            // flag never clears. Before reporting an update, confirm it by
            // comparing the image configs, which are identical if and only if the
            // images really are.
            if (manifestDiffers && !knownConfigDigest) {
                const remoteConfigDigest = await this.inspectRemoteConfigDigest(image);
                imageInfo = new ImageInfo(remoteDigest, imageInfo.localDigest, imageInfo.localId, imageInfo.localDigests, remoteConfigDigest);

                if (remoteConfigDigest) {
                    this.remoteConfigDigests.set(image, {
                        manifestDigest: remoteDigest,
                        configDigest: remoteConfigDigest,
                    });
                }
            }

            if (manifestDiffers) {
                if (imageInfo.isImageUpdateAvailable()) {
                    log.debug("update", `Image '${image}': update available (local '${imageInfo.localDigest}' remote '${remoteDigest}')`);
                } else {
                    log.debug("update", `Image '${image}': manifest digest differs (local '${imageInfo.localDigest}' remote '${remoteDigest}') but the image config is unchanged, so there is no update`);
                }
            }

            this.updateInfo(stack, service, image, imageInfo);
        }

        return imageInfo;
    }

    /**
     * Forget the remembered remote digests, so the next check reads them from
     * the registries again. For the on-demand check, which somebody runs
     * precisely because they want to know what the registries have right now.
     */
    forgetRemoteDigests() {
        this.remoteDigests.clear();
    }

    /**
     * Whether remote update checks can run at all. False once skopeo has turned
     * out not to be installed, in which case nothing about the remote side of an
     * image is ever known.
     */
    remoteChecksAvailable(): boolean {
        return !this.skopeoMissing;
    }

    /**
     * Ask the registry for the digest of the manifest the image reference points at.
     *
     * `--raw` writes the manifest out byte for byte and its digest is the sha256
     * of those bytes, which is the same value `--format "{{ .Digest }}"` reports.
     * The difference is what it costs: the formatted inspect makes skopeo resolve
     * the image, which for a multi-arch tag means a second manifest request for
     * the matching platform plus a download of the config blob - five requests
     * where one manifest request would do, and two of them counted against the
     * registry's pull limit instead of one.
     * @param image Image reference, e.g. "caddy:2"
     * @returns The digest, or undefined when the remote side cannot be reached
     */
    private async inspectRemoteDigest(image: string): Promise<string | undefined> {
        const cached = this.remoteDigests.get(image);
        if (cached && Date.now() - cached.readAt < REMOTE_DIGEST_TTL_MS) {
            return cached.digest;
        }

        if (this.isRateLimited(image)) {
            return undefined;
        }

        let resRemote;
        try {
            // Registry logins, when configured, make these checks count against
            // the account's pull limit instead of the (much lower) anonymous one
            const authArgs = RegistryCredentialManager.INSTANCE.skopeoAuthArgs();

            // maxBuffer instead of encoding, so the manifest is kept as the raw
            // bytes its digest has to be taken over rather than decoded text
            resRemote = await childProcessAsync.spawn("skopeo", [ "inspect", "--raw", ...authArgs, "docker://" + image ], {
                maxBuffer: 4 * 1024 * 1024,
            });
        } catch (e) {
            // skopeo is optional: without it, remote update checks are skipped
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                if (!this.skopeoMissing) {
                    this.skopeoMissing = true;
                    log.warn("update", "skopeo binary not found, remote image update checks are disabled");
                }
                return undefined;
            }

            if (this.isRateLimitError(e)) {
                this.startCooldown(image, e);
                return undefined;
            }

            throw e;
        }

        if (!resRemote.stdout) {
            return "";
        }

        const digest = this.digestOf(resRemote.stdout);
        this.remoteDigests.set(image, {
            digest,
            readAt: Date.now(),
        });

        return digest;
    }

    /**
     * The digest of the remote image's config blob, which is what Docker reports
     * as the local image id. Two images with the same config digest have the same
     * layers and the same metadata, so they are the same image no matter how the
     * registry chose to wrap them in a manifest.
     *
     * skopeo picks the config of the instance matching the platform it runs on,
     * which is the platform Docker pulled as well.
     * @param image Image reference, e.g. "caddy:2"
     * @returns The config digest, or an empty string when it cannot be determined
     */
    private async inspectRemoteConfigDigest(image: string): Promise<string> {
        if (this.isRateLimited(image)) {
            return "";
        }

        try {
            // maxBuffer instead of encoding, so the output is kept as the raw
            // bytes the digest has to be taken over rather than decoded text
            const authArgs = RegistryCredentialManager.INSTANCE.skopeoAuthArgs();

            const res = await childProcessAsync.spawn("skopeo", [ "inspect", "--config", "--raw", ...authArgs, "docker://" + image ], {
                maxBuffer: 4 * 1024 * 1024,
            });

            if (!res.stdout) {
                return "";
            }

            return this.digestOf(res.stdout);
        } catch (e) {
            if (this.isRateLimitError(e)) {
                this.startCooldown(image, e);
                return "";
            }

            // Only used to rule out a false positive, so a failure here simply
            // leaves the manifest comparison to decide
            log.debug("update", "Image '" + image + "': could not read the remote image config: " + e);
            return "";
        }
    }

    /**
     * The sha256 digest of whatever skopeo wrote out, in the form registries
     * name their content by.
     * @param stdout Raw output of a skopeo --raw invocation
     */
    private digestOf(stdout: string | Buffer): string {
        const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout.toString(), "utf-8");
        return "sha256:" + crypto.createHash("sha256").update(raw).digest("hex");
    }

    /**
     * Whether a failed skopeo run failed because the registry is throttling us.
     * @param e The error the run rejected with
     */
    private isRateLimitError(e: unknown): boolean {
        const text = [
            (e as Error)?.message ?? "",
            String((e as { stderr?: unknown })?.stderr ?? ""),
        ].join(" ").toLowerCase();

        return text.includes("toomanyrequests")
            || text.includes("too many requests")
            || text.includes("rate limit");
    }

    /**
     * Whether the registry an image lives on is currently being left alone.
     * @param image Image reference
     */
    private isRateLimited(image: string): boolean {
        const registry = this.registryOf(image);
        const until = this.registryCooldowns.get(registry);

        if (until === undefined) {
            return false;
        }

        if (Date.now() >= until) {
            this.registryCooldowns.delete(registry);
            return false;
        }

        return true;
    }

    /**
     * Stop asking a registry for a while, and say so once.
     * @param image Image whose registry refused the request
     * @param e The error it refused with
     */
    private startCooldown(image: string, e: unknown) {
        const registry = this.registryOf(image);

        if (this.isRateLimited(image)) {
            return;
        }

        this.registryCooldowns.set(registry, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        log.warn("update", `Registry '${registry}' is rate limiting us, so update checks against it are paused for ${RATE_LIMIT_COOLDOWN_MS / 60000} minutes. Signing in to the registry in Settings raises the limit. (${e})`);
    }

    /**
     * The registry host an image reference points at, which is Docker Hub when
     * the reference does not name one.
     * @param ref Image reference
     */
    private registryOf(ref: string): string {
        const firstSegment = ref.split("/")[0];

        if (ref.includes("/") && (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost")) {
            return firstSegment.toLowerCase();
        }

        return "docker.io";
    }

    async updateLocal(stack: string, service: string, image: string): Promise<ImageInfo> {
        let imageInfo = this.getImageInfo(stack, service, image);

        // "docker image inspect" instead of "docker inspect": a container with
        // the same name as the image would otherwise shadow the image lookup
        const resLocal = await childProcessAsync.spawn("docker", [ "image", "inspect", "--format", "json", image ], {
            encoding: "utf-8",
        });

        let localId = "";
        let localDigests: string[] = [];
        if (resLocal.stdout) {
            const localInspect = JSON.parse(resLocal.stdout!.toString());
            if (Array.isArray(localInspect) && localInspect[0]) {
                localId = localInspect[0].Id;
                localDigests = this.parseRepoDigests(image, localInspect[0].RepoDigests);
            }
        }

        const localDigest = localDigests[0] ?? "";

        if (!(!!localDigest && !!localId)) {
            // Warn only once per image, otherwise this repeats on every poll
            if (!this.warnedImages.has(image)) {
                this.warnedImages.add(image);
                log.warn("updateLocal", "Image '" + image + "': Local id '" + localId + "' digest '" + localDigest + "'");
            }
        } else {
            this.warnedImages.delete(image);
        }

        imageInfo = new ImageInfo(imageInfo.remoteDigest, localDigest, localId, localDigests, imageInfo.remoteConfigDigest);
        this.updateInfo(stack, service, image, imageInfo);

        return imageInfo;
    }

    /**
     * The digests Docker knows the local image by, most relevant one first.
     *
     * An image can be known under more than one repository - the same content
     * pushed to a mirror, or pulled once by its docker.io name and once by a
     * registry alias - and every one of them gets its own entry. Comparing the
     * remote digest against the first entry alone reports an endless update when
     * that entry happens to belong to another repository, so the digest of the
     * repository the stack actually references is put first and the rest are
     * kept as alternatives.
     * @param image Image reference the digests were looked up for
     * @param repoDigests The RepoDigests field of "docker image inspect"
     */
    private parseRepoDigests(image: string, repoDigests: unknown): string[] {
        if (!Array.isArray(repoDigests)) {
            return [];
        }

        const wantedRepository = this.repositoryOf(image);
        const matching: string[] = [];
        const others: string[] = [];

        for (const entry of repoDigests) {
            if (typeof(entry) !== "string") {
                continue;
            }

            const indexOfAt = entry.indexOf("@");
            if (indexOfAt <= 0) {
                continue;
            }

            const digest = entry.substring(indexOfAt + 1);
            if (this.repositoryOf(entry) === wantedRepository) {
                matching.push(digest);
            } else {
                others.push(digest);
            }
        }

        return [ ...matching, ...others ];
    }

    /**
     * The repository part of an image reference, without registry defaults, tag
     * or digest, so that "caddy:2", "docker.io/library/caddy" and
     * "caddy@sha256:..." all compare equal.
     * @param ref Image reference
     */
    private repositoryOf(ref: string): string {
        let repository = ref;

        const indexOfAt = repository.indexOf("@");
        if (indexOfAt > 0) {
            repository = repository.substring(0, indexOfAt);
        }

        // A colon is only a tag separator when it comes after the last slash,
        // otherwise it is the port of a registry host
        const indexOfColon = repository.lastIndexOf(":");
        if (indexOfColon > repository.lastIndexOf("/")) {
            repository = repository.substring(0, indexOfColon);
        }

        for (const prefix of [ "docker.io/", "index.docker.io/", "registry-1.docker.io/" ]) {
            if (repository.startsWith(prefix)) {
                repository = repository.substring(prefix.length);
                break;
            }
        }

        // "library/" is Docker Hub's namespace for official images, and only
        // means that when no registry host is in front of it
        const firstSegment = repository.split("/")[0];
        const hasRegistryHost = repository.includes("/")
            && (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost");
        if (!hasRegistryHost && repository.startsWith("library/")) {
            repository = repository.substring("library/".length);
        }

        return repository;
    }

    getImageInfo(stack: string, service: string, image: string) : ImageInfo {
        return this.imageInfos.get(stack)?.get(this.imageKey(service, image)) ?? new ImageInfo("", "", "");
    }

    private updateInfo(stack: string, service: string, image: string, imageInfo: ImageInfo) {
        if (!this.imageInfos.has(stack)) {
            this.imageInfos.set(stack, new Map());
        }

        this.imageInfos.get(stack)!.set(this.imageKey(service, image), imageInfo);
    }

    private imageKey(service: string, image: string): string {
        return `${service}::${image}`;
    }
}

export class ImageInfo {
    /**
     * Every digest the local image is known by, `localDigest` first.
     */
    public readonly localDigests: readonly string[];

    constructor(
        public readonly remoteDigest: string,
        public readonly localDigest: string,
        public readonly localId: string,
        localDigests?: readonly string[],
        public readonly remoteConfigDigest: string = ""
    ) {
        this.localDigests = localDigests ?? (localDigest ? [ localDigest ] : []);
    }

    isImageUpdateAvailable() {
        if (!this.localDigest || !this.remoteDigest) {
            return false;
        }

        // The local image may be known under several repositories, each with its
        // own digest - any of them matching means it is the image we have
        if (this.localDigests.includes(this.remoteDigest)) {
            return false;
        }

        // Same image config means same layers and same metadata: the manifests
        // differ, the image does not
        if (!!this.remoteConfigDigest && this.remoteConfigDigest === this.localId) {
            return false;
        }

        return true;
    }
}
