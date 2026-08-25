import { describe, it, expect, vi } from "vitest";
import { Terminal } from "../backend/terminal";
import { DockgeSocket } from "../backend/util-server";

function mockSocket() {
    return {
        id: "socket-1",
        emitAgent: vi.fn(),
    } as unknown as DockgeSocket;
}

describe("Terminal.writeStatus", () => {
    it("tells the client that started the operation which step is running", () => {
        const socket = mockSocket();

        Terminal.writeStatus(socket, "compose-terminal", "statusPruningImages", "Pruning unused images...");

        expect(socket.emitAgent).toHaveBeenCalledWith(
            "terminalStatus",
            "compose-terminal",
            "statusPruningImages",
            "Pruning unused images..."
        );
    });

    it("reports nothing for an operation nobody is watching, such as an auto update", () => {
        expect(
            () => Terminal.writeStatus(undefined, "compose-terminal", "statusUpdateFinished", "Update finished.")
        ).not.toThrow();
    });
});
