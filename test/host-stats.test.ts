import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { CpuTimes, cpuPercentBetween, HostStatsMonitor, readCpuTimes } from "../backend/host-stats";

/**
 * A reading of the CPU counters.
 * @param idle Time spent idle
 * @param total Time spent in total
 * @returns The reading
 */
function reading(idle : number, total : number) : CpuTimes {
    return {
        idle,
        total,
    };
}

/**
 * A core as os.cpus() reports it, with the given time spent busy and idle.
 * @param busy Time spent busy, split evenly between user and sys
 * @param idle Time spent idle
 * @returns The core
 */
function core(busy : number, idle : number) : os.CpuInfo {
    return {
        model: "test",
        speed: 1000,
        times: {
            user: busy / 2,
            nice: 0,
            sys: busy / 2,
            idle,
            irq: 0,
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("readCpuTimes", () => {
    it("sums the counters of every core", () => {
        vi.spyOn(os, "cpus").mockReturnValue([ core(100, 900), core(300, 700) ]);
        expect(readCpuTimes()).toEqual(reading(1600, 2000));
    });

    // Some platforms, and containers without /proc, report no cores at all
    it("reports nothing where the platform reports no cores", () => {
        vi.spyOn(os, "cpus").mockReturnValue([]);
        expect(readCpuTimes()).toBeUndefined();
    });
});

describe("cpuPercentBetween", () => {
    it("is the share of the time between the readings that was not idle", () => {
        expect(cpuPercentBetween(reading(1000, 2000), reading(1750, 3000))).toBe(25);
        expect(cpuPercentBetween(reading(0, 0), reading(0, 500))).toBe(100);
        expect(cpuPercentBetween(reading(0, 0), reading(500, 500))).toBe(0);
    });

    it("has nothing to say when no time was counted in between", () => {
        expect(cpuPercentBetween(reading(1000, 2000), reading(1000, 2000))).toBeUndefined();
    });

    it("stays within 0 to 100 when the counters go backwards", () => {
        // As when a core goes offline between the two readings
        expect(cpuPercentBetween(reading(1000, 2000), reading(500, 2500))).toBe(100);
        expect(cpuPercentBetween(reading(1000, 2000), reading(2000, 2500))).toBe(0);
    });
});

describe("HostStatsMonitor", () => {
    it("has no CPU figure until it has been measured", async () => {
        const monitor = new HostStatsMonitor(os.tmpdir());
        expect((await monitor.getData()).cpuPerc).toBeNull();
    });

    it("measures the CPU over the time between samples", async () => {
        const cpus = vi.spyOn(os, "cpus").mockReturnValue([ core(0, 0), core(0, 0) ]);
        const monitor = new HostStatsMonitor(os.tmpdir());

        cpus.mockReturnValue([ core(100, 100), core(300, 500) ]);
        monitor.sampleCpu();
        expect((await monitor.getData()).cpuPerc).toBeCloseTo(40);

        // Each sample covers only the time since the previous one
        cpus.mockReturnValue([ core(150, 200), core(350, 1300) ]);
        monitor.sampleCpu();
        expect((await monitor.getData()).cpuPerc).toBeCloseTo(10);
    });

    it("keeps the last CPU figure when a sample comes too soon to tell", async () => {
        const cpus = vi.spyOn(os, "cpus").mockReturnValue([ core(0, 0) ]);
        const monitor = new HostStatsMonitor(os.tmpdir());

        cpus.mockReturnValue([ core(50, 50) ]);
        monitor.sampleCpu();
        monitor.sampleCpu();
        expect((await monitor.getData()).cpuPerc).toBeCloseTo(50);
    });

    it("reports the memory and the disk holding the path", async () => {
        vi.spyOn(os, "totalmem").mockReturnValue(8000);
        vi.spyOn(os, "freemem").mockReturnValue(3000);

        const data = await new HostStatsMonitor(os.tmpdir()).getData();

        expect(data.memTotal).toBe(8000);
        expect(data.memUsed).toBe(5000);
        expect(data.diskPath).toBe(os.tmpdir());
        expect(data.diskTotal).toBeGreaterThan(0);
        expect(data.diskUsed).toBeGreaterThanOrEqual(0);
        expect(data.diskUsed).toBeLessThanOrEqual(data.diskTotal as number);
    });

    it("leaves the disk out when the path cannot be read", async () => {
        const data = await new HostStatsMonitor("/this/path/does/not/exist").getData();
        expect(data.diskUsed).toBeNull();
        expect(data.diskTotal).toBeNull();
        expect(data.memTotal).toBeGreaterThan(0);
    });
});
