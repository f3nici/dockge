import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerTerminalName,
    getContainerLogName,
    RUNNING, RUNNING_AND_EXITED, UNHEALTHY,
    TERMINAL_ROWS, UNKNOWN,
    sleep
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { ImageRepository } from "./image-repository";
import { AutoUpdatePolicy, SimpleStackData, StackData, ServiceData, StatsData, NotificationEvent } from "../common/types";
import { ComposeDocument, setAutoUpdateInYAML } from "../common/compose-document";
import { LABEL_STATUS_IGNORE, LABEL_IMAGEUPDATES_CHECK, LABEL_IMAGEUPDATES_IGNORE } from "../common/compose-labels";
import { NotificationManager } from "./notification-manager";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected _composeDocument: ComposeDocument | undefined = undefined;
    protected _unhealthy: boolean = false;
    protected _imageUpdatesAvailable: boolean = false;
    protected _imageCheckConclusive: boolean = false;
    protected _imageChecksOptedOut: boolean = false;
    protected _recreateNecessary: boolean = false;
    protected _services: Map<string, ServiceData> = new Map();
    protected server: DockgeServer;
    protected _firstUpdate: boolean = true;
    protected _tags: string[] = [];
    protected _tagsLoaded: boolean = false;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    protected static imageRepository : ImageRepository = new ImageRepository();

    /**
     * Invalidate a stack from the cache.
     * This forces the stack to be re-read from disk on next access.
     * @param stackName The name of the stack to invalidate
     */
    static invalidateCache(stackName: string) : void {
        this.managedStackList.delete(stackName);
    }

    static notificationManager: NotificationManager = new NotificationManager();

    constructor(server: DockgeServer, name: string, composeYAML?: string, composeENV?: string) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        // Check if compose file name is different from compose.yaml
        for (const filename of acceptedComposeFileNames) {
            if (fs.existsSync(path.join(this.path, filename))) {
                this._composeFileName = filename;
                break;
            }
        }
    }

    async getData(endpoint : string) : Promise<StackData> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        const simpleData = this.getSimpleData(endpoint);
        return {
            ...simpleData,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
            services: Object.fromEntries(this._services),
        };
    }

    getSimpleData(endpoint : string) : SimpleStackData {
        return {
            name: this.name,
            status: this._status,
            started: this.isStarted,
            recreateNecessary: this._recreateNecessary,
            imageUpdatesAvailable: this._imageUpdatesAvailable,
            tags: this.tags,
            autoUpdate: this.autoUpdate,
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint
        };
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    get isStarted(): boolean {
        return this._status == RUNNING || this._status == RUNNING_AND_EXITED || this._status == UNHEALTHY;
    }

    /**
     * Whether any of this stack's services runs an image the registry has a
     * newer one for, as of the last check.
     */
    get imageUpdatesAvailable(): boolean {
        return this._imageUpdatesAvailable;
    }

    /**
     * Whether a service runs an image other than the one its compose file names,
     * which "docker compose up" would put right.
     */
    get recreateNecessary(): boolean {
        return this._recreateNecessary;
    }

    /**
     * Whether the last check managed to compare every image it was asked to
     * against its registry.
     *
     * False says the answer is "we do not know", not "there is nothing new": a
     * registry that could not be reached leaves nothing flagged for reasons
     * that have nothing to do with the images being current.
     *
     * A service whose checks are switched off is not a failure and does not
     * count here - see imageChecksOptedOut.
     */
    get imageCheckConclusive(): boolean {
        return this._imageCheckConclusive;
    }

    /**
     * Whether at least one service asked not to be checked, via
     * dockge.imageupdates.check=false.
     *
     * Those services are left out of the stack's verdict entirely: the label is
     * an instruction, not a failed lookup, so honouring it means neither
     * flagging an update nor pulling "just in case".
     */
    get imageChecksOptedOut(): boolean {
        return this._imageChecksOptedOut;
    }

    /**
     * Whether the compose file names a service that has no container at all,
     * which only bringing the stack up can put right.
     *
     * A service that is meant to have no container does not count: one kept
     * behind a compose profile, or one scaled to zero. Bringing the stack up
     * would not create those either, so treating them as missing would pull the
     * stack on every single run.
     */
    get servicesMissing(): boolean {
        try {
            const services = this.composeDocument.services;

            return services.names.some((name) => {
                if (this._services.has(name)) {
                    return false;
                }

                const service = services.getService(name);

                if (service.has("profiles")) {
                    return false;
                }

                const replicas = service.get("scale") ?? service.get("deploy")?.replicas;
                return replicas !== 0;
            });
        } catch (e) {
            // Unparseable compose file: there is nothing to compare against
            return false;
        }
    }

    /**
     * Forget the remembered remote digests, so the next check asks the
     * registries rather than answering from what it read a moment ago.
     */
    static forgetRemoteImageDigests() {
        Stack.imageRepository.forgetRemoteDigests();
    }

    /**
     * This stack's auto update preference, read from `x-dockge.auto-update` in
     * its compose file. `null` means the stack does not state one, so the global
     * default in Settings applies.
     */
    get autoUpdate(): AutoUpdatePolicy {
        try {
            const value = this.composeDocument.xDockge.autoUpdate;
            return value === undefined ? null : value;
        } catch (e) {
            // Unparseable compose file: treat it as "no preference"
            return null;
        }
    }

    /**
     * Write the auto update preference into the compose file, or remove it
     * (`null`) so the stack follows the global default again.
     * @param policy true, false, or null to inherit
     */
    async setAutoUpdate(policy: AutoUpdatePolicy) : Promise<void> {
        if (!this.isManagedByDockge) {
            throw new ValidationError("Stack is not managed by Dockge");
        }

        const composeFilePath = path.join(this.path, this._composeFileName);

        // Re-read from disk instead of using the cached copy, so an edit made
        // elsewhere since this Stack object was created is not silently reverted.
        const composeYAML = await fsAsync.readFile(composeFilePath, "utf-8");

        this._composeYAML = setAutoUpdateInYAML(composeYAML, policy === null ? undefined : policy);
        this._composeDocument = undefined;
        await fsAsync.writeFile(composeFilePath, this._composeYAML);

        // Other cached copies of this stack still hold the previous compose file
        Stack.invalidateCache(this.name);
    }

    async validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }

        // save yaml and env as temporary files
        const tempYamlName = this._composeFileName + ".tmp";
        const tempEnvName = ".env.temp";

        const tempYamlPath = path.join(this.path, tempYamlName);
        const tempEnvPath = path.join(this.path, tempEnvName);
        const realEnvPath = path.join(this.path, ".env");

        await this.saveFiles(tempYamlPath, tempEnvPath);

        // Also ensure the real .env file exists for validation
        // This is needed because compose.yaml may contain env_file: .env references
        const realEnvExistedBefore = await fileExists(realEnvPath);
        if (!realEnvExistedBefore) {
            await fsAsync.writeFile(realEnvPath, this.composeENV);
        }

        const hasEnvFile = this.composeENV.trim() !== "";

        try {
            // check the files with docker compose

            const args = [ "compose", "-f", tempYamlName ];
            if (hasEnvFile) {
                args.push("--env-file", tempEnvName);
            }
            args.push("config", "--dry-run");

            await childProcessAsync.spawn("docker", args, {
                cwd: this.path,
                encoding: "utf-8",
            });
        } catch (e) {
            log.warn("validate", e);

            // Extract error information from the spawn error
            const spawnError = e as { stderr?: string; stdout?: string; code?: number; message?: string };
            let valMsg = spawnError.stderr?.trim() || spawnError.stdout?.trim();

            if (valMsg) {
                // remove prefix
                valMsg = valMsg.replace(/^validating .*?: /, "");
            } else {
                // If no stderr/stdout, provide a meaningful default message
                // This handles cases where the process fails without output (e.g., ENOENT)
                if (spawnError.code !== undefined && spawnError.code !== null) {
                    valMsg = `Docker compose validation failed with exit code ${spawnError.code}`;
                } else if (spawnError.message) {
                    valMsg = spawnError.message;
                } else {
                    valMsg = "Docker compose validation failed. Please check that docker is installed and accessible.";
                }
            }

            throw new ValidationError(valMsg);
        } finally {
            // delete the temporary files
            await fsAsync.unlink(tempYamlPath);
            if (hasEnvFile) {
                await fsAsync.unlink(tempEnvPath);
            }
            // Note: We don't delete the real .env file we created because:
            // - On success, saveFiles() will overwrite it with the final version
            // - On failure for new stacks, save() deletes the entire directory
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get composeDocument(): ComposeDocument {
        if (!this._composeDocument) {
            this._composeDocument = new ComposeDocument(this.composeYAML, this.composeENV);
        }

        return this._composeDocument!;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get metadataPath() : string {
        return path.join(this.path, "dockge.json");
    }

    get tags() : string[] {
        if (!this._tagsLoaded) {
            this.loadMetadata();
        }
        return this._tags;
    }

    /**
     * Load metadata from dockge.json file
     */
    protected loadMetadata() : void {
        try {
            if (fs.existsSync(this.metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(this.metadataPath, "utf-8"));
                this._tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } else {
                this._tags = [];
            }
        } catch (e) {
            log.error("loadMetadata", `Failed to load metadata for stack ${this.name}: ${e}`);
            this._tags = [];
        }
        this._tagsLoaded = true;
    }

    /**
     * Save metadata to dockge.json file
     */
    protected async saveMetadata() : Promise<void> {
        try {
            // Only save if the stack directory exists
            if (!this.isManagedByDockge) {
                return;
            }

            const metadata = {
                tags: this._tags
            };
            await fsAsync.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
        } catch (e) {
            log.error("saveMetadata", `Failed to save metadata for stack ${this.name}: ${e}`);
            throw e;
        }
    }

    /**
     * Update tags for this stack
     */
    async updateTags(tags: string[]) : Promise<void> {
        // Validate tags
        if (!Array.isArray(tags)) {
            throw new ValidationError("Tags must be an array");
        }

        // Load existing metadata first so we don't clobber other fields
        if (!this._tagsLoaded) {
            this.loadMetadata();
        }

        // Filter out empty tags and trim whitespace
        this._tags = tags
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);

        this._tagsLoaded = true;
        await this.saveMetadata();
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
 * Save the stack to the disk
 * @param isAdd
 */
    async save(isAdd : boolean) {
        // Reject any name that would escape the stacks directory before creating
        // anything on disk (validate() also enforces the name charset).
        Stack.resolveStackDir(this.server, this.name);

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create temporary directory for validation
            await fsAsync.mkdir(dir);

            try {
            // Validate the compose file
                await this.validate();

                // Everything is good, writing the main files
                await this.saveFiles(path.join(dir, this._composeFileName), path.join(dir, ".env"));
            } catch (error) {
            // If validation fails, clean up the directory we just created
                await fsAsync.rm(dir, { recursive: true,
                    force: true });
                throw error;
            }
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }

            // For updates, validate before writing
            await this.validate();

            // Everything is good, writing the main files
            await this.saveFiles(path.join(dir, this._composeFileName), path.join(dir, ".env"));
        }
    }

    private async saveFiles(yamlPath: string, envPath: string) {
        // Write or overwrite the compose.yaml
        await fsAsync.writeFile(yamlPath, this.composeYAML);

        // Always write the .env file, even if empty
        // This ensures that any env_file references in compose.yaml will work
        await fsAsync.writeFile(envPath, this.composeENV);
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "down", "--remove-orphans" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async getServiceStats(): Promise<Map<string, StatsData>> {
        const serviceStats = new Map<string, StatsData>();
        try {
            const statsRes = await childProcessAsync.spawn("docker", [ "compose", "stats", "--no-stream", "--format", "json" ], {
                cwd: this.path,
                encoding: "utf-8",
            });

            if (statsRes.stdout) {
                const statsLines = statsRes.stdout?.toString().split("\n");

                for (let statsLine of statsLines) {
                    if (statsLine != "") {
                        const stats = JSON.parse(statsLine);
                        serviceStats.set(
                            stats.Name,
                            {
                                cpuPerc: stats.CPUPerc,
                                memUsage: stats.MemUsage,
                                memPerc: stats.MemPerc,
                                netIO: stats.NetIO,
                                blockIO: stats.BlockIO
                            }
                        );
                    }
                }
            }
        } catch (e) {
            log.error("getServiceStats", e);
        }

        return serviceStats;
    }

    async updateData() {
        const services = new Map<string, ServiceData>();
        const composeDocument = this.composeDocument;

        // Store previous state for change detection
        const oldStatus = this._status;
        const oldUnhealthy = this._unhealthy;
        const oldServices = new Map(this._services);

        try {
            const res = await childProcessAsync.spawn("docker", [ "compose", "ps", "--all", "--format", "json" ], {
                cwd: this.path,
                encoding: "utf-8",
            });

            // No output means the stack has no containers at all, which is a
            // result like any other: returning here instead would leave the
            // status, services and check flags describing containers that are
            // no longer there.
            const lines = res.stdout ? res.stdout.toString().split("\n") : [];

            let runningCount = 0;
            let ignoredRunningCount = 0;
            let exitedCount = 0;
            let ignoredExitedCount = 0;
            let createdCount = 0;
            this._unhealthy = false;
            this._recreateNecessary = false;
            this._imageUpdatesAvailable = false;

            // Set to false by any service whose images could not be compared
            // against the registry, so that "nothing is flagged" is not mistaken
            // for "everything is up to date"
            let imageCheckConclusive = true;

            // Set by any service that asked not to be checked at all. Kept
            // apart from the above: one is a lookup that failed, the other is
            // an instruction we are following.
            let imageChecksOptedOut = false;

            for (let line of lines) {
                if (line != "") {
                    const serviceInfo = JSON.parse(line);

                    const composeService = composeDocument.services.getService(serviceInfo.Service);
                    const composeServiceLabels = composeService.labels;

                    const recreateNecessary = serviceInfo.Image !== composeService.image;
                    if (recreateNecessary) {
                        this._recreateNecessary = true;
                    }

                    let imageInfo = Stack.imageRepository.getImageInfo(this.name, serviceInfo.Service, serviceInfo.Image);

                    let serviceImageUpdateAvailable = false;
                    if (!recreateNecessary && !composeServiceLabels.isFalse(LABEL_IMAGEUPDATES_CHECK)) {
                        const localImageId = serviceInfo.Labels?.match(/com\.docker\.compose\.image=([^,]+)/)?.[1] ?? "";

                        if (localImageId !== imageInfo.localId) {
                            try {
                                imageInfo = await Stack.imageRepository.updateLocal(this.name, serviceInfo.Service, serviceInfo.Image);
                            } catch (e) {
                                log.error("updateStackData", "Stack: '" + this.name + "' service: '" + serviceInfo.Service + "': " + e);
                            }
                        }

                        if (
                            imageInfo.isImageUpdateAvailable()
                            && imageInfo.remoteDigest !== composeServiceLabels.get(LABEL_IMAGEUPDATES_IGNORE)
                        ) {
                            serviceImageUpdateAvailable = true;
                            this._imageUpdatesAvailable = true;
                        }

                        // No remote digest means the registry was never reached:
                        // skopeo is missing, it is rate limiting us, the login
                        // was refused. A pinned image is the one case where
                        // there is nothing to reach for.
                        if (!imageInfo.remoteDigest && !ImageRepository.isDigestPinned(serviceInfo.Image)) {
                            imageCheckConclusive = false;
                        }
                    } else if (!recreateNecessary) {
                        // Checks turned off for this service. Nothing is known
                        // about whether it is behind, and nothing is meant to
                        // be: leave it out of the stack's verdict rather than
                        // letting it make the whole stack inconclusive, which
                        // would pull every service on every run.
                        imageChecksOptedOut = true;
                    }

                    services.set(
                        serviceInfo.Service,
                        {
                            name: serviceInfo.Service,
                            containerName: serviceInfo.Name,
                            image: serviceInfo.Image,
                            state: serviceInfo.State,
                            status: serviceInfo.Status,
                            health: serviceInfo.Health,
                            recreateNecessary: recreateNecessary,
                            imageUpdateAvailable: serviceImageUpdateAvailable,
                            remoteImageDigest: imageInfo.remoteDigest
                        }
                    );

                    const ignoreState = composeServiceLabels.isTrue(LABEL_STATUS_IGNORE);
                    if (serviceInfo.State === "running") {
                        if (!ignoreState) {
                            runningCount++;
                        } else {
                            ignoredRunningCount++;
                        }
                    } else if (serviceInfo.State == "exited") {
                        if (!ignoreState) {
                            exitedCount++;
                        } else {
                            ignoredExitedCount++;
                        }
                    } else if (serviceInfo.State === "created") {
                        createdCount++;
                    } else {
                        log.warn("updateStackData", "Unexpected service state '" + serviceInfo.State + "'");
                    }

                    if (serviceInfo.Health === "unhealthy") {
                        this._unhealthy = true;
                    }
                }
            }

            if (runningCount > 0 && exitedCount > 0) {
                this._status = RUNNING_AND_EXITED;
            } else if (runningCount > 0) {
                this._status = RUNNING;
            } else if (exitedCount > 0) {
                this._status = EXITED;
            } else if (ignoredRunningCount > 0) {
                this._status = RUNNING;
            } else if (ignoredExitedCount > 0) {
                this._status = EXITED;
            } else if (createdCount > 0) {
                this._status = CREATED_STACK;
            } else {
                this._status = UNKNOWN;
            }

            if (this._unhealthy) {
                this._status = UNHEALTHY;
            }

            this._services = services;
            this._imageCheckConclusive = imageCheckConclusive;
            this._imageChecksOptedOut = imageChecksOptedOut;

            // Detect and notify status changes (skip on first update to avoid spam)
            if (!this._firstUpdate) {
                await this.detectAndNotifyChanges(oldStatus, oldUnhealthy, oldServices);
            }

            this._firstUpdate = false;
        } catch (e) {
            log.error("updateStackData", e);
        }
    }

    /**
     * Detect status changes and send notifications
     */
    private async detectAndNotifyChanges(
        oldStatus: number,
        oldUnhealthy: boolean,
        oldServices: Map<string, ServiceData>
    ): Promise<void> {
        try {
            // Stack-level status changes
            if (oldStatus !== this._status) {
                if (oldStatus === RUNNING && this._status === EXITED) {
                    await Stack.notificationManager.notifyStackChange(
                        this.name,
                        NotificationEvent.StackExited,
                        "Stack has stopped running"
                    );
                } else if ((oldStatus === EXITED || oldStatus === UNKNOWN || oldStatus === CREATED_STACK) && this._status === RUNNING) {
                    await Stack.notificationManager.notifyStackChange(
                        this.name,
                        NotificationEvent.StackRunning,
                        "Stack is now running"
                    );
                }
            }

            // Check for health status changes
            if (!oldUnhealthy && this._unhealthy) {
                await Stack.notificationManager.notifyStackChange(
                    this.name,
                    NotificationEvent.ServiceUnhealthy,
                    "One or more services are unhealthy"
                );
            } else if (oldUnhealthy && !this._unhealthy) {
                await Stack.notificationManager.notifyStackChange(
                    this.name,
                    NotificationEvent.ServiceHealthy,
                    "All services are healthy"
                );
            }

            // Service-level changes
            for (const [ serviceName, newServiceData ] of this._services.entries()) {
                const oldServiceData = oldServices.get(serviceName);

                if (!oldServiceData) {
                    // New service detected
                    if (newServiceData.state === "running") {
                        await Stack.notificationManager.notifyServiceChange(
                            this.name,
                            serviceName,
                            NotificationEvent.ServiceUp,
                            "Service started"
                        );
                    }
                    continue;
                }

                // Check for state changes
                if (oldServiceData.state !== newServiceData.state) {
                    if (oldServiceData.state === "running" && newServiceData.state === "exited") {
                        await Stack.notificationManager.notifyServiceChange(
                            this.name,
                            serviceName,
                            NotificationEvent.ServiceDown,
                            `Service exited with status: ${newServiceData.status}`
                        );
                    } else if (oldServiceData.state === "exited" && newServiceData.state === "running") {
                        await Stack.notificationManager.notifyServiceChange(
                            this.name,
                            serviceName,
                            NotificationEvent.ServiceUp,
                            "Service is now running"
                        );
                    }
                }

                // Check for health changes
                if (oldServiceData.health !== newServiceData.health) {
                    if (newServiceData.health === "unhealthy") {
                        await Stack.notificationManager.notifyServiceChange(
                            this.name,
                            serviceName,
                            NotificationEvent.ServiceUnhealthy,
                            `Service health check failed: ${newServiceData.status}`
                        );
                    } else if (oldServiceData.health === "unhealthy" && newServiceData.health !== "unhealthy") {
                        await Stack.notificationManager.notifyServiceChange(
                            this.name,
                            serviceName,
                            NotificationEvent.ServiceHealthy,
                            "Service is now healthy"
                        );
                    }
                }
            }

            // Check for removed services
            for (const [ serviceName, oldServiceData ] of oldServices.entries()) {
                if (!this._services.has(serviceName) && oldServiceData.state === "running") {
                    await Stack.notificationManager.notifyServiceChange(
                        this.name,
                        serviceName,
                        NotificationEvent.ServiceDown,
                        "Service removed or stopped"
                    );
                }
            }
        } catch (e) {
            log.error("detectAndNotifyChanges", `Error sending notifications for stack ${this.name}: ${e}`);
        }
    }

    async updateImageInfos() {
        Stack.imageRepository.resetStack(this.name);
        for (const serviceData of this._services.values()) {
            try {
                await Stack.imageRepository.update(this.name, serviceData.name, serviceData.image);
            } catch (e) {
                log.error("updateImageInfos", "Stack '" + this.name + "' - Image '" + serviceData.image + "': " + e);
            }
        }
    }

    /**
     * Re-read the running services and their images, then recompute the
     * "update available" flags from scratch.
     *
     * Called right after a stack has been updated - the remote digests are only
     * refreshed every few hours, so without this a stack that was just updated
     * keeps its update indicator until the next scheduled check, which reads as
     * "the update did not happen" - and before an auto update run decides
     * whether the stack needs pulling at all.
     */
    async refreshImageUpdateStatus() {
        try {
            // The service list is where the images to look up come from, and it
            // is read lazily: on a freshly started instance nothing has filled
            // it in yet, and a check run against an empty one quietly looks up
            // nothing at all. So read it, look the images up, then read it once
            // more to recompute the flags from what came back.
            await this.updateData();
            await this.updateImageInfos();
            await this.updateData();
        } catch (e) {
            log.error("refreshImageUpdateStatus", "Stack '" + this.name + "': " + e);
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            // A copy, not the cache itself. Stacks docker knows about but Dockge
            // does not are added to this list further down, and writing those
            // into the cache left them there for good: they kept being sent to
            // every browser, with the status they last had, long after the
            // compose project behind them was gone.
            stackList = new Map(this.managedStackList);
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename, false);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from docker compose ls
        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._configFilePath = composeStack.ConfigFiles;

            if (composeStack.Status.startsWith("running")) {
                // Only running containers, nothing more to check
                stack._status = stack._unhealthy ? UNHEALTHY : RUNNING;
            } else {
                // We have to check the stack data, to get the correct status
                await stack.updateData();
            }
        }

        return stackList;
    }

    /**
     * Ensure a stack name resolves to a directory strictly inside stacksDir.
     * Prevents path traversal (e.g. "../../etc") from lifecycle operations that
     * build filesystem paths from the socket-supplied name.
     * @param server
     * @param stackName
     * @returns The resolved, validated absolute stack directory
     */
    static resolveStackDir(server: DockgeServer, stackName: string) : string {
        const stacksDirResolved = path.resolve(server.stacksDir);
        const dirResolved = path.resolve(path.join(server.stacksDir, stackName));

        // Must be a strict subdirectory of stacksDir
        if (dirResolved !== stacksDirResolved && !dirResolved.startsWith(stacksDirResolved + path.sep)) {
            throw new ValidationError("Invalid stack name");
        }

        // Disallow the stacksDir itself (empty / dot names)
        if (dirResolved === stacksDirResolved) {
            throw new ValidationError("Invalid stack name");
        }

        return dirResolved;
    }

    static async getStack(server: DockgeServer, stackName: string, useCache = true) : Promise<Stack> {
        // Reject any name that would escape the stacks directory before touching the filesystem
        Stack.resolveStackDir(server, stackName);

        let dir = path.join(server.stacksDir, stackName);

        if (useCache) {
            const cachedStack = this.managedStackList.get(stackName);
            if (cachedStack) {
                return cachedStack;
            }
        }

        if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
            // Maybe it is a stack managed by docker compose directly
            let stackList = await this.getStackList(server, true);
            let stack = stackList.get(stackName);

            if (stack) {
                return stack;
            } else {
                // Really not found
                throw new ValidationError("Stack not found");
            }
        }

        let stack : Stack;

        stack = new Stack(server, stackName);
        stack._configFilePath = path.resolve(dir);

        await stack.updateData();

        return stack;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, service: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to stop service, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async startService(socket: DockgeSocket, service: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "start", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to start service, please check the terminal output for more information.");
        }

        // Update image infos
        await this.updateImageInfos();

        return exitCode;
    }

    async restartService(socket: DockgeSocket, service: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart service, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async recreateService(socket: DockgeSocket, service: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--force-recreate", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to recreate service, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "down" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket | undefined, pruneAfterUpdate: boolean, pruneAllAfterUpdate: boolean) {
        // socket is optional so scheduled auto-updates can run without a client attached.
        // A missing socket means the local (master) endpoint, whose name is the empty string.
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "pull" ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is running, restart it
        await this.updateData();
        if (this.isStarted) {
            Terminal.writeStatus(socket, terminalName, "Images pulled, redeploying the stack...");

            await sleep(500); // sleep to wait for terminal output finished

            exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans" ], this.path);
            if (exitCode !== 0) {
                throw new Error("Failed to restart, please check the terminal output for more information.");
            }
        } else {
            Terminal.writeStatus(socket, terminalName, "Images pulled. The stack is not running, so nothing was redeployed.");
        }

        if (pruneAfterUpdate) {
            Terminal.writeStatus(socket, terminalName, "Pruning unused images...");

            await sleep(500); // sleep to wait for terminal output finished

            const dockerParams = [ "image", "prune", "-f" ];
            if (pruneAllAfterUpdate) {
                dockerParams.push("-a");
            }

            exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", dockerParams, "");
            if (exitCode !== 0) {
                throw new Error("Failed to prune images, please check the terminal output for more information.");
            }
        }

        // The stack now runs whatever the registry had, so clear the update
        // indicator instead of leaving it up until the next scheduled check
        Terminal.writeStatus(socket, terminalName, "Checking image update status...");
        await this.refreshImageUpdateStatus();
        Terminal.writeStatus(socket, terminalName, "Update finished.");

        return exitCode;
    }

    async updateService(socket: DockgeSocket, service: string, pruneAfterUpdate: boolean, pruneAllAfterUpdate: boolean) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "pull", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        Terminal.writeStatus(socket, terminalName, "Image pulled, redeploying the service...");

        await sleep(500); // sleep to wait for terminal output finished

        exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", "--remove-orphans", service ], this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }

        if (pruneAfterUpdate) {
            Terminal.writeStatus(socket, terminalName, "Pruning unused images...");

            await sleep(500); // sleep to wait for terminal output finished

            const dockerParams = [ "image", "prune", "-f" ];
            if (pruneAllAfterUpdate) {
                dockerParams.push("-a");
            }

            exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", dockerParams, "");
            if (exitCode !== 0) {
                throw new Error("Failed to prune images, please check the terminal output for more information.");
            }
        }

        // See update(): the service is on the current image now
        Terminal.writeStatus(socket, terminalName, "Checking image update status...");
        await this.refreshImageUpdateStatus();
        Terminal.writeStatus(socket, terminalName, "Update finished.");

        return exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", [ "compose", "logs", "-f", "--tail", "100" ], this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerTerminalName(socket.endpoint, this.name, serviceName, shell, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", [ "compose", "exec", serviceName, shell ], this.path);
            terminal.enableKeepAlive = true;
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async joinContainerLog(socket: DockgeSocket, serviceName: string, index: number = 0) {
        const terminalName = getContainerLogName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new Terminal(this.server, terminalName, "docker", [ "compose", "logs", "-f", "--tail", "100", serviceName ], this.path);
            terminal.enableKeepAlive = true;
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerLog", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }
}
