import { log } from "./log";
import childProcessAsync from "promisify-child-process";

export class ImageRepository {

    static INSTANCE = new ImageRepository();

    private imageInfos: Map<string, Map<string, ImageInfo>> = new Map();

    private warnedImages: Set<string> = new Set();

    private skopeoMissingWarned = false;

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
            let resRemote;
            try {
                resRemote = await childProcessAsync.spawn("skopeo", [ "inspect", "--no-tags", "--format", "{{ .Digest }}", "docker://" + image ], {
                    encoding: "utf-8",
                });
            } catch (e) {
                // skopeo is optional: without it, remote update checks are skipped
                if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                    if (!this.skopeoMissingWarned) {
                        this.skopeoMissingWarned = true;
                        log.warn("update", "skopeo binary not found, remote image update checks are disabled");
                    }
                    return imageInfo;
                }
                throw e;
            }

            let remoteDigest = "";
            if (resRemote.stdout) {
                remoteDigest = resRemote.stdout?.toString().trim();
            }

            imageInfo = new ImageInfo(remoteDigest, imageInfo.localDigest, imageInfo.localId);
            this.updateInfo(stack, service, image, imageInfo);
        }

        return imageInfo;
    }

    async updateLocal(stack: string, service: string, image: string): Promise<ImageInfo> {
        let imageInfo = this.getImageInfo(stack, service, image);

        // "docker image inspect" instead of "docker inspect": a container with
        // the same name as the image would otherwise shadow the image lookup
        const resLocal = await childProcessAsync.spawn("docker", [ "image", "inspect", "--format", "json", image ], {
            encoding: "utf-8",
        });

        let localId = "";
        let localDigest = "";
        if (resLocal.stdout) {
            const localInspect = JSON.parse(resLocal.stdout!.toString());
            if (Array.isArray(localInspect) && localInspect[0]) {
                localId = localInspect[0].Id;

                const localRepoDigest = localInspect[0].RepoDigests;
                if (Array.isArray(localRepoDigest)) {
                    localDigest = localRepoDigest[0];
                }
                if (!!localDigest) {
                    const indexOfAt = localDigest.indexOf("@");
                    if (indexOfAt > 0) {
                        localDigest = localDigest.substring(indexOfAt + 1);
                    }
                }
            }
        }

        if (!(!!localDigest && !!localId)) {
            // Warn only once per image, otherwise this repeats on every poll
            if (!this.warnedImages.has(image)) {
                this.warnedImages.add(image);
                log.warn("updateLocal", "Image '" + image + "': Local id '" + localId + "' digest '" + localDigest + "'");
            }
        } else {
            this.warnedImages.delete(image);
        }

        imageInfo = new ImageInfo(imageInfo.remoteDigest, localDigest, localId);
        this.updateInfo(stack, service, image, imageInfo);

        return imageInfo;
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
    constructor(
        public readonly remoteDigest: string,
        public readonly localDigest: string,
        public readonly localId: string
    ) {}

    isImageUpdateAvailable() {
        return !!this.localDigest && !!this.remoteDigest && this.localDigest !== this.remoteDigest;
    }
}
