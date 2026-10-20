import os from "node:os";
import fsAsync from "node:fs/promises";
import { HostStatsData } from "../common/types";
import { log } from "./log";

/**
 * CPU time counters, summed over every core, since the machine booted.
 */
export interface CpuTimes {
    idle : number;
    total : number;
}

/**
 * Read how long the cores have spent idle, and in total, since boot.
 *
 * Inside a container /proc/stat is not namespaced, so this is the host's CPU
 * time rather than Dockge's own - which is what the dashboard is after.
 * @returns The counters, or undefined where the platform does not report them
 */
export function readCpuTimes() : CpuTimes | undefined {
    const cpus = os.cpus();

    if (cpus.length === 0) {
        return undefined;
    }

    let idle = 0;
    let total = 0;

    for (const { times } of cpus) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
    }

    return {
        idle,
        total,
    };
}

/**
 * How busy the CPU was between two readings of its counters.
 * @param previous The earlier reading
 * @param current The later reading
 * @returns A percentage from 0 to 100, or undefined when no time was counted
 * between the two, as when they are taken too close together
 */
export function cpuPercentBetween(previous : CpuTimes, current : CpuTimes) : number | undefined {
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;

    if (total <= 0) {
        return undefined;
    }

    // Clamped, as a core going offline in between can throw the counters off
    return Math.min(100, Math.max(0, (1 - idle / total) * 100));
}

/**
 * Keeps track of the resource usage of the machine Dockge runs on.
 *
 * CPU usage can only be told from two readings of the counters some time
 * apart, so it is measured by {@link sampleCpu} on a fixed schedule, and every
 * figure covers the same stretch of time however often it is asked for.
 * Memory and disk are read fresh each time.
 */
export class HostStatsMonitor {
    protected previousCpuTimes : CpuTimes | undefined = readCpuTimes();
    protected cpuPerc : number | null = null;

    /**
     * @param diskPath A path on the filesystem to report the usage of
     */
    constructor(protected diskPath : string) {
    }

    /**
     * Measure how busy the CPU has been since the previous call.
     */
    sampleCpu() {
        const current = readCpuTimes();

        if (this.previousCpuTimes && current) {
            this.cpuPerc = cpuPercentBetween(this.previousCpuTimes, current) ?? this.cpuPerc;
        }

        this.previousCpuTimes = current;
    }

    async getData() : Promise<HostStatsData> {
        const memTotal = os.totalmem();

        // Node reads MemAvailable, so the page cache the kernel would give back
        // on demand does not count as used, the same as `free` reports it
        const memUsed = memTotal - os.freemem();

        let diskUsed : number | null = null;
        let diskTotal : number | null = null;

        try {
            const stats = await fsAsync.statfs(this.diskPath);
            diskTotal = stats.blocks * stats.bsize;
            diskUsed = (stats.blocks - stats.bfree) * stats.bsize;
        } catch (e) {
            log.debug("host-stats", `Cannot read the disk usage of ${this.diskPath}: ${e}`);
        }

        return {
            cpuPerc: this.cpuPerc,
            cpuCount: os.cpus().length,
            memUsed,
            memTotal,
            diskUsed,
            diskTotal,
            diskPath: this.diskPath,
        };
    }
}
