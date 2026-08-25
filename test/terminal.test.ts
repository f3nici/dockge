import { describe, it, expect, vi } from "vitest";
import { Terminal } from "../backend/terminal";
import { DockgeServer } from "../backend/dockge-server";
import { DockgeSocket } from "../backend/util-server";

function mockSocket() {
    return {
        id: "socket-" + Math.random(),
        emitAgent: vi.fn(),
    } as unknown as DockgeSocket;
}

describe("Terminal.writeStatus", () => {
    it("tells the client that started the operation when no terminal is running", () => {
        const socket = mockSocket();

        Terminal.writeStatus(socket, "compose-not-running", "Images pulled, redeploying the stack...");

        expect(socket.emitAgent).toHaveBeenCalledWith(
            "terminalWrite",
            "compose-not-running",
            "\r\nImages pulled, redeploying the stack...\r\n"
        );
    });

    it("does nothing when there is neither a terminal nor a client", () => {
        expect(() => Terminal.writeStatus(undefined, "compose-no-client", "Update finished.")).not.toThrow();
    });

    it("writes to the clients of a running terminal, and into its buffer", () => {
        const terminalName = "compose-running";
        const terminal = new Terminal({} as DockgeServer, terminalName, "docker", [ "compose", "up" ], "/tmp");
        const joined = mockSocket();
        const starter = mockSocket();
        terminal.join(joined);

        Terminal.writeStatus(starter, terminalName, "Pruning unused images...");

        expect(joined.emitAgent).toHaveBeenCalledWith(
            "terminalWrite",
            terminalName,
            "\r\nPruning unused images...\r\n"
        );
        // The terminal's own client list is what gets told, so the message is
        // not sent twice to whoever started the operation and is also watching
        expect(starter.emitAgent).not.toHaveBeenCalled();
        expect(terminal.getBuffer()).toContain("Pruning unused images...");
    });
});
