import { describe, it, expect, vi, afterEach } from "vitest";
import { Terminal } from "../backend/terminal";
import { DockgeSocket } from "../backend/util-server";

function mockSocket(id = "socket-1") {
    return {
        id,
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

describe("Terminal.leaveAll", () => {
    // Terminal's constructor registers it in the static terminalMap and only
    // exit() removes it. These are never started, so they never exit and would
    // otherwise be visible to every test that runs after them.
    afterEach(() => {
        Terminal["terminalMap"].clear();
    });

    // Logging out does not close the connection: the browser keeps the same
    // socket and drops its token. Nothing else detaches it from the terminals it
    // joined, and the sweep for stale clients only looks at disconnected ones,
    // so without this they kept streaming container output to a socket that no
    // longer has a session behind it.
    it("detaches a socket from every terminal it had joined", () => {
        const socket = mockSocket("logging-out");
        const other = mockSocket("still-logged-in");

        const first = new Terminal({} as never, "combined--stack-a", "docker", [], "");
        const second = new Terminal({} as never, "container-log--stack-b", "docker", [], "");

        first.join(socket);
        first.join(other);
        second.join(socket);

        Terminal.leaveAll(socket);

        // The socket that logged out hears nothing more
        first["writeToClients"]("output from stack a");
        second["writeToClients"]("output from stack b");
        expect(socket.emitAgent).not.toHaveBeenCalled();

        // Everybody else carries on
        expect(other.emitAgent).toHaveBeenCalledWith("terminalWrite", "combined--stack-a", "output from stack a");
    });

    it("does nothing for a socket that is watching no terminals", () => {
        const socket = mockSocket("never-joined");

        expect(() => Terminal.leaveAll(socket)).not.toThrow();
    });
});
