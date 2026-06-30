import { describe, it, expect } from "vitest";
import { LimitQueue } from "../backend/utils/limit-queue";

describe("LimitQueue", () => {
    it("keeps items while under the limit", () => {
        const queue = new LimitQueue<number>(3);
        queue.pushItem(1);
        queue.pushItem(2);
        expect([ ...queue ]).toEqual([ 1, 2 ]);
    });

    it("drops the oldest item when the limit is exceeded", () => {
        const queue = new LimitQueue<number>(3);
        queue.pushItem(1);
        queue.pushItem(2);
        queue.pushItem(3);
        queue.pushItem(4);
        expect([ ...queue ]).toEqual([ 2, 3, 4 ]);
        expect(queue.length).toBe(3);
    });

    it("invokes the onExceed callback with the removed item", () => {
        const queue = new LimitQueue<number>(2);
        const removed: (number | undefined)[] = [];
        queue.__onExceed = (item) => removed.push(item);
        queue.pushItem(1);
        queue.pushItem(2);
        queue.pushItem(3);
        expect(removed).toEqual([ 1 ]);
    });
});
