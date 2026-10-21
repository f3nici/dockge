import fs, { promises as fsAsync } from "node:fs";
import path from "node:path";
import childProcessAsync from "promisify-child-process";
import { log } from "./log";
import { sleep } from "../common/util-common";

/**
 * The container Dockge itself is running in, as docker compose created it.
 */
export interface SelfContainer {
    /** Full container ID */
    id : string;

    /** ID of the image the container runs */
    image : string;

    /**
     * The image as the compose file names it. Once a pull has moved its tag on,
     * this is the new image rather than the one running.
     */
    imageRef : string;

    /** Compose project the container belongs to, i.e. the stack name */
    project : string;

    /** Compose service the container belongs to */
    service : string;

    /** Networks the container is attached to */
    networks : string[];
}

/**
 * What the helper container is asked to run, once Dockge is out of the way.
 */
export interface HandOffRequest {
    /** The stack directory, the same path inside the helper as in Dockge */
    stackPath : string;

    /** Arguments to `docker`, e.g. `[ "compose", "up", "-d" ]` */
    args : string[];

    /** Prune images afterwards, and whether to prune all unused ones */
    prune? : boolean;
    pruneAll? : boolean;

    /** The update history entry to complete once Dockge is back, if any */
    historyId? : number;
}

/**
 * Written to the data directory just before the helper starts, and read back
 * once Dockge is running again, so whoever looks at the history can see whether
 * the last step went through.
 */
interface PendingHandOff {
    helper : string;
    args : string[];
    startedAt : string;
    historyId? : number;
}

const PENDING_FILE = "self-update.json";
const LOG_FILE = "self-update.log";

/**
 * How long the helper waits before it acts. Long enough for Dockge to answer
 * whoever asked, and to write the history entry, before compose stops it.
 */
const HAND_OFF_DELAY_SECONDS = 3;

/**
 * How long Dockge, once back, waits for the helper to finish before it gives
 * up on its result. Compose starts Dockge's new container before it is done
 * with the rest of the stack, and the prune comes after that, so the helper is
 * often still at work when Dockge starts.
 */
const HELPER_WAIT_MS = 30 * 60 * 1000;

/** How often the helper is looked in on while Dockge waits for it */
const HELPER_POLL_MS = 2 * 1000;

/** The line the helper ends its log with */
const EXIT_LINE = /^exit:(\d+)\s*$/m;

/**
 * Find the container ID in /proc/self/mountinfo.
 *
 * Docker bind mounts /etc/hostname, /etc/hosts and /etc/resolv.conf from the
 * container's own directory, so the ID turns up there whatever the hostname
 * was set to, and on cgroup v2, where /proc/self/cgroup no longer has it.
 * @param mountInfo Contents of /proc/self/mountinfo
 * @returns The 64 character container ID, if there is one
 */
export function containerIdFromMountInfo(mountInfo : string) : string | undefined {
    const match = mountInfo.match(/\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\s/);
    return match?.[1];
}

/**
 * Quote a value for a POSIX shell.
 * @param value The value
 * @returns The value in single quotes, safe to paste into a command line
 */
export function shellQuote(value : string) : string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The script the helper container runs.
 *
 * Its output goes to a log in the data directory rather than to the helper's
 * own log, because the helper removes itself when it is done.
 * @param request What to run
 * @param logPath Where to write the output, as the helper sees it
 * @returns The script
 */
export function buildHandOffScript(request : HandOffRequest, logPath : string) : string {
    const lines = [
        `sleep ${HAND_OFF_DELAY_SECONDS}`,
        `cd ${shellQuote(request.stackPath)} || exit 1`,
        `docker ${request.args.map(shellQuote).join(" ")} > ${shellQuote(logPath)} 2>&1`,
        "code=$?",
    ];

    if (request.prune) {
        lines.push(`docker image prune -f${request.pruneAll ? " -a" : ""} >> ${shellQuote(logPath)} 2>&1`);
    }

    lines.push(`echo "exit:$code" >> ${shellQuote(logPath)}`);
    lines.push("exit $code");

    return lines.join("\n");
}

/**
 * The environment the helper runs compose with, as an env file.
 *
 * Compose takes variables from its own environment as well as from .env, so
 * the helper gets Dockge's: without them a compose file that interpolates,
 * say, ${TZ} would come out differently from the helper than it does from
 * Dockge, and the container would be recreated with something else.
 * @param env Dockge's environment
 * @returns The contents of the env file
 */
export function buildEnvFile(env : NodeJS.ProcessEnv) : string {
    const lines : string[] = [];

    for (const [ key, value ] of Object.entries(env)) {
        // HOSTNAME is the container's own. A value spanning lines cannot be
        // written to an env file at all.
        if (value === undefined || key === "HOSTNAME" || value.includes("\n") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }
        lines.push(`${key}=${value}`);
    }

    return lines.join("\n") + "\n";
}

/**
 * Lets Dockge act on the stack it is running in.
 *
 * Running `docker compose up` from inside Dockge on its own stack stops Dockge
 * partway through: compose stops the old container, and with it the compose
 * process that was going to start the new one, which then never comes. So
 * whatever would restart Dockge is handed to a helper container instead. It
 * runs Dockge's own image with Dockge's volumes, so every path inside it is
 * what it is inside Dockge and compose does exactly what it would have done
 * there, and it outlives Dockge while it does it.
 *
 * Stopping the stack is refused outright: there would be nothing left to start
 * it again.
 */
export class SelfStack {

    protected static detected? : Promise<SelfContainer | null>;

    /**
     * The helper started last: by this process, or, read back from the data
     * directory, by the one before the restart.
     */
    protected static lastHelper? : string;

    /**
     * Picking up the result of the hand-off from before the restart, while
     * that goes on. It reads and then removes the files a new hand-off writes.
     */
    protected static finishing? : Promise<void>;

    /**
     * The container Dockge runs in, or null when it is not in one that docker
     * compose created. Looked up once: it cannot change while Dockge runs.
     */
    static getSelfContainer() : Promise<SelfContainer | null> {
        SelfStack.detected ??= SelfStack.detect();
        return SelfStack.detected;
    }

    /**
     * Forget what was detected, for tests.
     */
    static reset() {
        SelfStack.detected = undefined;
        SelfStack.lastHelper = undefined;
        SelfStack.finishing = undefined;
    }

    /**
     * Whether a container is running.
     * @param name The container
     */
    static async isContainerRunning(name : string) : Promise<boolean> {
        try {
            const res = await childProcessAsync.spawn("docker", [ "inspect", "--type", "container", "--format", "{{.State.Running}}", name ], {
                encoding: "utf-8",
            });
            return res.stdout?.toString().trim() === "true";
        } catch (e) {
            // Gone: the helper removes itself when it is done
            return false;
        }
    }

    protected static async detect() : Promise<SelfContainer | null> {
        const candidates : string[] = [];

        // Set when docker could not be asked at all, rather than saying the
        // container is not there: the answer is not known then, and keeping
        // "not in a container" for good would have Dockge run compose on its
        // own stack itself, which stops it halfway
        let inconclusive = false;

        try {
            const id = containerIdFromMountInfo(await fsAsync.readFile("/proc/self/mountinfo", "utf-8"));
            if (id) {
                candidates.push(id);
            }
        } catch (e) {
            // Not Linux, or no /proc: not in a container either
        }

        // Docker's default hostname is the short container ID
        if (process.env.HOSTNAME && /^[0-9a-f]{12,64}$/.test(process.env.HOSTNAME)) {
            candidates.push(process.env.HOSTNAME);
        }

        for (const candidate of candidates) {
            try {
                const res = await childProcessAsync.spawn("docker", [ "inspect", "--type", "container", "--format", "{{json .}}", candidate ], {
                    encoding: "utf-8",
                });
                const data = JSON.parse(res.stdout?.toString() ?? "");

                if (typeof data?.Id !== "string" || !data.Id.startsWith(candidate)) {
                    continue;
                }

                const labels = data.Config?.Labels ?? {};
                const project = labels["com.docker.compose.project"];
                const service = labels["com.docker.compose.service"];

                if (typeof project !== "string" || typeof service !== "string") {
                    log.info("self-stack", "Dockge is not running from a compose stack, so it has no stack of its own to look after");
                    return null;
                }

                const self = {
                    id: data.Id,
                    image: data.Image,
                    imageRef: data.Config?.Image ?? data.Image,
                    project,
                    service,
                    networks: Object.keys(data.NetworkSettings?.Networks ?? {}),
                };

                log.info("self-stack", `Dockge runs as service "${service}" of stack "${project}"`);
                return self;
            } catch (e) {
                const stderr = (e as { stderr? : string }).stderr?.toString() ?? "";
                if (!/no such (container|object)/i.test(stderr)) {
                    inconclusive = true;
                }
                log.debug("self-stack", `Container ${candidate} could not be inspected: ${e}`);
            }
        }

        if (inconclusive) {
            // Asked again next time
            SelfStack.detected = undefined;
            log.warn("self-stack", "Could not ask docker which container Dockge runs in; trying again on the next operation");
            return null;
        }

        log.debug("self-stack", "Dockge does not appear to be running in a container");
        return null;
    }

    /**
     * Whether a stack is the one Dockge is running in.
     * @param stackName The stack
     */
    static async isSelfStack(stackName : string) : Promise<boolean> {
        const self = await SelfStack.getSelfContainer();
        return !!self && self.project === stackName;
    }

    /**
     * Whether a service is Dockge itself.
     * @param stackName The stack
     * @param serviceName The service
     */
    static async isSelfService(stackName : string, serviceName : string) : Promise<boolean> {
        const self = await SelfStack.getSelfContainer();
        return !!self && self.project === stackName && self.service === serviceName;
    }

    /**
     * Start the helper container that finishes an operation on Dockge's own
     * stack, then return straight away. Dockge is stopped a few seconds later.
     * @param dataDir Dockge's data directory
     * @param request What the helper should run
     * @returns The name of the helper container
     */
    static async handOff(dataDir : string, request : HandOffRequest) : Promise<string> {
        const self = await SelfStack.getSelfContainer();

        if (!self) {
            throw new Error("Dockge could not find its own container, so it cannot hand this over");
        }

        // One at a time: a second helper would run compose alongside the first,
        // and write over the file the first one's result is picked up from
        if (SelfStack.lastHelper && await SelfStack.isContainerRunning(SelfStack.lastHelper)) {
            throw new SelfStackError("A helper container is still finishing an earlier operation on Dockge's own stack, and Dockge restarts when it is done. Try again once Dockge is back.");
        }
        await SelfStack.finishing;

        const helper = `dockge-self-update-${Date.now()}`;
        const dataDirFull = path.resolve(dataDir);
        const logPath = path.join(dataDirFull, LOG_FILE);
        const envPath = path.join(dataDirFull, `.${helper}.env`);

        const pending : PendingHandOff = {
            helper,
            args: request.args,
            startedAt: new Date().toISOString(),
            historyId: request.historyId,
        };

        await fsAsync.rm(logPath, { force: true });
        await fsAsync.writeFile(path.join(dataDirFull, PENDING_FILE), JSON.stringify(pending));
        await fsAsync.writeFile(envPath, buildEnvFile(process.env), { mode: 0o600 });

        const args = [
            "run", "-d", "--rm",
            "--name", helper,
            "--label", "dockge.self-update=true",
            // Every mount Dockge has, at the same paths: the docker socket, the
            // stacks directory and the data directory among them
            "--volumes-from", self.id,
            "--env-file", envPath,
            "--entrypoint", "/bin/sh",
        ];

        // Compose reaches docker through the socket, which needs no network. A
        // DOCKER_HOST over the network, such as a socket proxy, is reached the
        // way Dockge reaches it.
        const dockerHost = process.env.DOCKER_HOST;
        if (dockerHost && !dockerHost.startsWith("unix://") && self.networks.length > 0) {
            args.push("--network", self.networks[0]);
        } else {
            args.push("--network", "none");
        }

        // Nothing is ever pulled for the helper: both images are here already
        args.push("--pull", "never");

        const script = buildHandOffScript(request, logPath);

        try {
            try {
                // The image Dockge is running right now, so the helper is known
                // to have what it needs
                await childProcessAsync.spawn("docker", [ ...args, self.image, "-c", script ], {
                    encoding: "utf-8",
                });
            } catch (e) {
                // With the containerd image store, an image whose tag a pull has
                // moved on cannot be started by its ID any more, even while a
                // container still runs it. The image the tag points to now is
                // the one Dockge is about to be recreated on, so it has what
                // the helper needs just as well.
                const stderr = (e as { stderr? : string }).stderr?.toString() ?? "";
                if (!/no such image/i.test(stderr) || self.imageRef === self.image) {
                    throw e;
                }
                log.info("self-stack", `Image ${self.image} cannot be started by its ID, starting the helper from ${self.imageRef} instead`);
                await childProcessAsync.spawn("docker", [ ...args, self.imageRef, "-c", script ], {
                    encoding: "utf-8",
                });
            }
        } catch (e) {
            await fsAsync.rm(path.join(dataDirFull, PENDING_FILE), { force: true });
            const stderr = (e as { stderr? : string }).stderr?.toString().trim();
            throw new Error("Could not start the helper container: " + (stderr || e));
        } finally {
            await fsAsync.rm(envPath, { force: true });
        }

        SelfStack.lastHelper = helper;
        log.info("self-stack", `Handed "docker ${request.args.join(" ")}" for stack "${self.project}" to helper container ${helper}; Dockge restarts in a few seconds`);
        return helper;
    }

    /**
     * On startup, pick up the result of a hand-off from before the restart.
     *
     * The helper can still be at work when Dockge is back, so this waits for
     * it to finish, and is meant to run alongside the rest of the startup
     * rather than hold it up.
     * @param dataDir Dockge's data directory
     * @param complete Called with the helper's outcome when the hand-off
     * belonged to an update, to complete its history entry
     * @param helperRunning Whether the helper container is still running
     */
    static finishPendingHandOff(dataDir : string, complete : (historyId : number, success : boolean, output : string, completedAt : string) => Promise<void>, helperRunning : (name : string) => Promise<boolean> = SelfStack.isContainerRunning) : Promise<void> {
        const finishing = SelfStack.readPendingHandOff(dataDir, complete, helperRunning);
        SelfStack.finishing = finishing;
        return finishing;
    }

    /**
     * See finishPendingHandOff(). Never throws.
     * @param dataDir Dockge's data directory
     * @param complete Completes the history entry
     * @param helperRunning Whether the helper container is still running
     */
    protected static async readPendingHandOff(dataDir : string, complete : (historyId : number, success : boolean, output : string, completedAt : string) => Promise<void>, helperRunning : (name : string) => Promise<boolean>) {
        const pendingPath = path.join(dataDir, PENDING_FILE);
        const logPath = path.join(dataDir, LOG_FILE);

        if (!fs.existsSync(pendingPath)) {
            return;
        }

        const readLog = async () => {
            try {
                return {
                    output: await fsAsync.readFile(logPath, "utf-8"),
                    completedAt: (await fsAsync.stat(logPath)).mtime.toISOString(),
                };
            } catch (e) {
                // The data directory is not a volume, or the helper never ran
                return {
                    output: "",
                    completedAt: new Date().toISOString(),
                };
            }
        };

        try {
            const pending = JSON.parse(await fsAsync.readFile(pendingPath, "utf-8")) as PendingHandOff;
            SelfStack.lastHelper = pending.helper;

            // Compose starts Dockge's new container before it is done with the
            // rest of the stack, and the prune comes after that: the result is
            // only there once the helper is done
            const deadline = Date.now() + HELPER_WAIT_MS;
            let { output, completedAt } = await readLog();
            while (!EXIT_LINE.test(output) && Date.now() < deadline && await helperRunning(pending.helper)) {
                await sleep(HELPER_POLL_MS);
                ({ output, completedAt } = await readLog());
            }
            if (!EXIT_LINE.test(output)) {
                // It may have written its last line just before it was found gone
                ({ output, completedAt } = await readLog());
            }

            const exitMatch = output.match(EXIT_LINE);
            const success = exitMatch ? exitMatch[1] === "0" : false;
            output = output.replace(EXIT_LINE, "").trimEnd();

            if (exitMatch) {
                log.info("self-stack", `Helper ${pending.helper} finished "docker ${pending.args.join(" ")}" with exit code ${exitMatch[1]}`);
            } else {
                log.warn("self-stack", `Helper ${pending.helper} left no result behind; check that "docker ${pending.args.join(" ")}" went through`);
            }

            if (pending.historyId !== undefined) {
                await complete(pending.historyId, success, output, completedAt);
            }
        } catch (e) {
            log.error("self-stack", "Could not read the result of the last self update: " + e);
        } finally {
            await fsAsync.rm(pendingPath, { force: true }).catch(() => {});
            await fsAsync.rm(logPath, { force: true }).catch(() => {});
        }
    }
}

/**
 * Refused because it would stop Dockge with nothing left to start it again.
 */
export class SelfStackError extends Error {
}

/**
 * Shown, and kept in the update history, when Dockge hands an operation on its
 * own stack to the helper container.
 */
export const SELF_HAND_OFF_NOTE = "Dockge runs in this stack, so a helper container finishes this while Dockge restarts. The page reconnects once Dockge is back.";
