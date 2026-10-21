import { R } from "redbean-node";
import semver from "semver";
// CommonJS bundle, see terminal.ts
import xtermHeadless from "@xterm/headless";
import { log } from "./log";
import { ALL_ENDPOINTS, isDev, PROGRESS_TERMINAL_ROWS, TERMINAL_COLS } from "../common/util-common";
import { Agent } from "./models/agent";
import type { AgentManager } from "./agent-manager";
import { UpdateHistoryEntry, UpdateHistoryFilter, UpdateHistoryPage, UpdateTrigger, UPDATE_TRIGGERS } from "../common/types";

const { Terminal: HeadlessTerminal } = xtermHeadless;

/**
 * How many entries each instance keeps. Older ones are dropped as new ones are
 * written.
 */
export const MAX_HISTORY_ENTRIES = 500;

/**
 * How much of an update's output is kept, in characters. The end is what is
 * kept: it is where an update that failed says why.
 */
export const MAX_HISTORY_OUTPUT = 64 * 1024;

/** Longest page a caller can ask for */
export const MAX_HISTORY_PAGE = 100;

/** The first Dockge version that keeps an update history */
export const MIN_AGENT_VERSION_HISTORY = "2.3.0";

/** How long an agent gets to send its history */
const AGENT_HISTORY_TIMEOUT = 10 * 1000;

const TRIMMED_NOTICE = "[... earlier output trimmed ...]\n";

/**
 * Keeps the output of an update as it would read on screen.
 *
 * Writing down what the terminal was sent would not do: a pull redraws its
 * progress bars many times a second, so the raw output of a big one runs to
 * megabytes of cursor movements. Played into a terminal emulator of its own,
 * the same output comes out as the lines it finally left on the screen.
 */
export class OutputRecorder {
    protected screen : InstanceType<typeof HeadlessTerminal>;

    constructor(cols = TERMINAL_COLS, rows = PROGRESS_TERMINAL_ROWS) {
        this.screen = new HeadlessTerminal({
            cols,
            rows,
            scrollback: 5000,
            allowProposedApi: true,
        });
    }

    /**
     * Output as the terminal was sent it.
     * @param data The output
     */
    write(data : string) {
        this.screen.write(data);
    }

    /**
     * A line of Dockge's own, such as which step is starting.
     * @param text The line
     */
    note(text : string) {
        this.screen.write("\r\n" + text + "\r\n");
    }

    /**
     * Follow the terminal the output is coming from, so it wraps in the same
     * places.
     * @param cols Columns
     * @param rows Rows
     */
    resize(cols : number, rows : number) {
        try {
            this.screen.resize(cols, rows);
        } catch (e) {
            // A size the emulator does not take, such as 0: keep the old one
        }
    }

    /**
     * Everything recorded, as plain text, once the emulator has caught up.
     */
    async getText() : Promise<string> {
        // Writes are parsed asynchronously, and in order
        await new Promise<void>((resolve) => this.screen.write("", resolve));

        const buffer = this.screen.buffer.active;
        const lines : string[] = [];

        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (!line) {
                continue;
            }
            const text = line.translateToString(true);

            // A line the terminal wrapped is the same line of output
            if (line.isWrapped && lines.length > 0) {
                lines[lines.length - 1] += text;
            } else {
                lines.push(text);
            }
        }

        this.screen.dispose();
        return tidyOutput(lines.join("\n"));
    }
}

/**
 * Drop the blank lines a terminal leaves behind: at the end, from rows that
 * were never written to, and runs of them in between.
 * @param text The output
 * @returns The output, tidied
 */
export function tidyOutput(text : string) : string {
    return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Cut output down to what is kept, keeping the end.
 * @param output The output
 * @param max Most characters kept
 * @returns The output, trimmed if it had to be
 */
export function trimOutput(output : string, max = MAX_HISTORY_OUTPUT) : string {
    if (output.length <= max) {
        return output;
    }
    return TRIMMED_NOTICE + output.slice(output.length - max + TRIMMED_NOTICE.length);
}

/**
 * Check a filter from a client, and fill in what it leaves out.
 * @param input The filter as sent
 * @param maxLimit Longest page allowed
 * @returns A filter that is safe to query with
 */
export function normalizeHistoryFilter(input : unknown, maxLimit = MAX_HISTORY_PAGE) : Required<Pick<UpdateHistoryFilter, "limit" | "offset">> & UpdateHistoryFilter {
    const data = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

    const toInt = (value : unknown, fallback : number) => {
        const number = typeof value === "string" ? parseInt(value, 10) : value;
        return typeof number === "number" && Number.isFinite(number) ? Math.trunc(number) : fallback;
    };

    const filter : Required<Pick<UpdateHistoryFilter, "limit" | "offset">> & UpdateHistoryFilter = {
        limit: Math.min(maxLimit, Math.max(1, toInt(data.limit, 25))),
        offset: Math.max(0, toInt(data.offset, 0)),
    };

    if (typeof data.stackName === "string" && data.stackName !== "") {
        filter.stackName = data.stackName;
    }

    if (typeof data.search === "string" && data.search.trim() !== "") {
        filter.search = data.search.trim();
    }

    if (typeof data.triggerType === "string" && (UPDATE_TRIGGERS as string[]).includes(data.triggerType)) {
        filter.triggerType = data.triggerType as UpdateTrigger;
    }

    if (typeof data.success === "boolean") {
        filter.success = data.success;
    } else if (data.success === "true" || data.success === "false") {
        filter.success = data.success === "true";
    }

    return filter;
}

/**
 * Put pages from several instances together into one, newest first.
 *
 * Each page has to start at the first entry and hold at least offset + limit
 * of them, so that whatever ends up on the merged page is in one of them.
 * @param pages One page per instance, with the endpoint it came from
 * @param offset Entries to skip
 * @param limit Entries to return
 * @returns The merged page
 */
export function mergeHistoryPages(pages : { endpoint : string, page : UpdateHistoryPage }[], offset : number, limit : number) : UpdateHistoryPage {
    const entries = pages.flatMap(({ endpoint, page }) => page.entries.map((entry) => ({
        ...entry,
        endpoint,
    })));

    entries.sort((a, b) => {
        if (a.startedAt !== b.startedAt) {
            return a.startedAt < b.startedAt ? 1 : -1;
        }
        if (a.endpoint !== b.endpoint) {
            return a.endpoint < b.endpoint ? -1 : 1;
        }
        return b.id - a.id;
    });

    return {
        entries: entries.slice(offset, offset + limit),
        total: pages.reduce((sum, { page }) => sum + page.total, 0),
    };
}

/**
 * Where a page of history can come from: this instance, or an agent.
 */
export interface HistorySource {
    endpoint : string;
    fetch : (filter : UpdateHistoryFilter) => Promise<UpdateHistoryPage>;
}

/**
 * A page of history from one or more instances, newest first.
 *
 * One that does not answer is listed in `unreachable` instead of failing the
 * whole page: an agent that is offline should not hide everybody else's
 * history.
 * @param sources The instances to ask
 * @param input Which entries, and which page of them
 * @returns The page
 */
export async function collectHistory(sources : HistorySource[], input : UpdateHistoryFilter) : Promise<UpdateHistoryPage> {
    const filter = normalizeHistoryFilter(input);
    const unreachable : string[] = [];

    // A single instance can page by itself. Several have to be asked for
    // everything up to the end of the page, since any of them could hold any
    // part of it; none keeps more than MAX_HISTORY_ENTRIES.
    const perSource : UpdateHistoryFilter = sources.length === 1 ? filter : {
        ...filter,
        offset: 0,
        limit: Math.min(MAX_HISTORY_ENTRIES, filter.offset + filter.limit),
    };

    const pages = await Promise.all(sources.map(async ({ endpoint, fetch }) => {
        try {
            return {
                endpoint,
                page: await fetch(perSource),
            };
        } catch (e) {
            log.warn("update-history", `Could not read the update history of ${endpoint || "this instance"}: ${e instanceof Error ? e.message : e}`);
            unreachable.push(endpoint);
            return undefined;
        }
    }));

    const answered = pages.filter((page) => page !== undefined) as { endpoint : string, page : UpdateHistoryPage }[];
    const merged = sources.length === 1
        ? mergeHistoryPages(answered, 0, filter.limit)
        : mergeHistoryPages(answered, filter.offset, filter.limit);

    return {
        ...merged,
        unreachable,
    };
}

/**
 * The instances to read history from.
 * @param agentManager Connections to the agents, if there are any to ask
 * @param endpoint ALL_ENDPOINTS for this instance and every agent, "" for this
 * instance alone, or one agent's endpoint
 * @returns One source per instance
 */
export async function historySources(agentManager : AgentManager | undefined, endpoint : string) : Promise<HistorySource[]> {
    const local : HistorySource = {
        endpoint: "",
        fetch: (filter) => UpdateHistory.list(filter),
    };

    const agent = (agentEndpoint : string) : HistorySource => ({
        endpoint: agentEndpoint,
        fetch: async (filter) => {
            if (!agentManager) {
                throw new Error("Not connected to agents");
            }

            const version = agentManager.getAgentVersion(agentEndpoint);
            if (version && !isDev && semver.valid(version) && semver.lt(version, MIN_AGENT_VERSION_HISTORY)) {
                throw new Error(`runs Dockge ${version}, which keeps no update history`);
            }

            const res = await agentManager.request(agentEndpoint, "listUpdateHistory", AGENT_HISTORY_TIMEOUT, filter);
            if (!res.ok) {
                throw new Error(res.msg ?? "Failed to read the update history");
            }
            return {
                entries: res.entries ?? [],
                total: res.total ?? 0,
            };
        },
    });

    if (endpoint === "") {
        return [ local ];
    }

    if (endpoint !== ALL_ENDPOINTS) {
        return [ agent(endpoint) ];
    }

    const agentList = await Agent.getAgentList();
    const endpoints = Object.values(agentList)
        .map((a) => a.endpoint)
        .filter((e) => e !== "");

    return [ local, ...endpoints.map(agent) ];
}

interface HistoryRow {
    id : number;
    stack_name : string;
    service_name : string | null;
    trigger_type : string;
    success : number | boolean;
    output? : string | null;
    error_message : string | null;
    started_at : string;
    completed_at : string | null;
    duration_ms : number | null;
}

/**
 * Turn a row into an entry.
 * @param row The row
 * @returns The entry
 */
function toEntry(row : HistoryRow) : UpdateHistoryEntry {
    const entry : UpdateHistoryEntry = {
        id: row.id,
        stackName: row.stack_name,
        serviceName: row.service_name ?? null,
        // Each instance keeps the history of its own stacks. Whoever puts
        // several instances together fills in which one an entry is from.
        endpoint: "",
        triggerType: row.trigger_type,
        success: !!row.success,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
    };

    if (row.output !== undefined) {
        entry.output = row.output;
    }

    return entry;
}

/**
 * The updates this instance has run on its own stacks: by hand, on the auto
 * update schedule, or through the API.
 */
export class UpdateHistory {

    /**
     * Write down an update that has finished.
     * @param entry The update
     * @returns The ID of the new entry
     */
    static async record(entry : Omit<UpdateHistoryEntry, "id" | "endpoint">) : Promise<number> {
        const [ id ] = await R.knex("update_history").insert({
            stack_name: entry.stackName,
            service_name: entry.serviceName,
            endpoint: "",
            trigger_type: entry.triggerType,
            success: entry.success,
            output: typeof entry.output === "string" ? trimOutput(entry.output) : null,
            error_message: entry.errorMessage,
            started_at: entry.startedAt,
            completed_at: entry.completedAt,
            duration_ms: entry.durationMs,
        });

        await R.knex("update_history")
            .whereNotIn("id", R.knex("update_history").select("id").orderBy("id", "desc").limit(MAX_HISTORY_ENTRIES))
            .delete();

        return id;
    }

    /**
     * Complete an entry whose last step was finished by someone else: the
     * helper that restarts Dockge's own stack.
     * @param id The entry
     * @param success Whether that step went through
     * @param output What it printed
     * @param completedAt When it finished
     * @param errorMessage Why it failed, when it did
     */
    static async complete(id : number, success : boolean, output : string, completedAt : string, errorMessage? : string) {
        const row = await R.knex("update_history").where("id", id).first() as HistoryRow | undefined;

        if (!row) {
            return;
        }

        const combined = [ row.output ?? "", output ].filter((part) => part !== "").join("\n");

        await R.knex("update_history").where("id", id).update({
            success,
            output: trimOutput(combined),
            error_message: success ? row.error_message : (errorMessage ?? "The helper container that restarts Dockge did not finish the update, see the output"),
            completed_at: completedAt,
            duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(row.started_at)) || row.duration_ms,
        });
    }

    /**
     * A page of entries, newest first, without their output.
     * @param filter Which entries, and which page of them
     */
    static async list(filter : UpdateHistoryFilter) : Promise<UpdateHistoryPage> {
        // Up to everything that is kept: another instance putting several
        // together asks for whole stretches of it, see collectHistory()
        const { limit, offset, ...where } = normalizeHistoryFilter(filter, MAX_HISTORY_ENTRIES);

        const query = R.knex("update_history");

        if (where.stackName) {
            query.where("stack_name", where.stackName);
        }

        if (where.search) {
            const escaped = where.search.replace(/[\\%_]/g, (c) => "\\" + c);
            query.whereRaw("stack_name LIKE ? ESCAPE '\\'", [ `%${escaped}%` ]);
        }

        if (where.triggerType) {
            query.where("trigger_type", where.triggerType);
        }

        if (where.success !== undefined) {
            query.where("success", where.success);
        }

        const totalRow = await query.clone().count("id as count").first() as { count : number } | undefined;

        const rows = await query
            .select("id", "stack_name", "service_name", "trigger_type", "success", "error_message", "started_at", "completed_at", "duration_ms")
            .orderBy("started_at", "desc")
            .orderBy("id", "desc")
            .limit(limit)
            .offset(offset) as HistoryRow[];

        return {
            entries: rows.map(toEntry),
            total: Number(totalRow?.count ?? 0),
        };
    }

    /**
     * One entry, with its output.
     * @param id The entry
     */
    static async get(id : number) : Promise<UpdateHistoryEntry | undefined> {
        const row = await R.knex("update_history").where("id", id).first() as HistoryRow | undefined;
        return row ? toEntry(row) : undefined;
    }
}

/**
 * One update while it runs: collects its output, and writes it down when it
 * is over.
 */
export class UpdateRun {
    readonly recorder = new OutputRecorder();
    protected startedAt = new Date();
    protected finished = false;

    constructor(
        protected stackName : string,
        protected serviceName : string | null,
        protected trigger : UpdateTrigger,
    ) {
    }

    /**
     * Write the update down. Only the first call counts.
     *
     * A history that cannot be written must not turn a good update into a
     * failed one, so this never throws.
     * @param error What went wrong, if it did
     * @param note A last line to add to the output
     * @returns The ID of the entry, if it was written
     */
    async finish(error? : unknown, note? : string) : Promise<number | undefined> {
        if (this.finished) {
            return undefined;
        }
        this.finished = true;

        const errorMessage = error === undefined ? null : (error instanceof Error ? error.message : String(error));

        if (errorMessage) {
            this.recorder.note(errorMessage);
        }
        if (note) {
            this.recorder.note(note);
        }

        const completedAt = new Date();

        try {
            return await UpdateHistory.record({
                stackName: this.stackName,
                serviceName: this.serviceName,
                triggerType: this.trigger,
                success: errorMessage === null,
                output: await this.recorder.getText(),
                errorMessage,
                startedAt: this.startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - this.startedAt.getTime(),
            });
        } catch (e) {
            log.error("update-history", `Could not record the update of "${this.stackName}": ${e}`);
            return undefined;
        }
    }
}
