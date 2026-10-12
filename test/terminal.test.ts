import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { InteractiveTerminal, MainTerminal, Terminal } from "../backend/terminal";
import { DockgeSocket } from "../backend/util-server";

/**
 * A stand-in for a process in a pty: what it is sent is recorded, and the
 * test plays its output and its exit
 */
interface FakePty {
    write : ReturnType<typeof vi.fn>;
    kill : ReturnType<typeof vi.fn>;
    resize : ReturnType<typeof vi.fn>;
    output(data : string) : void;
    exit(exitCode : number) : void;
}

const spawned : FakePty[] = [];

vi.mock("@homebridge/node-pty-prebuilt-multiarch", () => ({
    spawn: vi.fn(() => {
        let onData = (_data : string) => {};
        let onExit = (_res : { exitCode : number }) => {};
        const fake = {
            write: vi.fn(),
            kill: vi.fn(),
            resize: vi.fn(),
            onData: (cb : typeof onData) => {
                onData = cb;
            },
            onExit: (cb : typeof onExit) => {
                onExit = cb;
            },
            output: (data : string) => onData(data),
            exit: (exitCode : number) => onExit({ exitCode }),
        };
        spawned.push(fake);
        return fake;
    }),
}));

/**
 * Wait for everything written to a terminal's screen copy to be taken in
 * @param terminal The terminal
 */
function screenSettled(terminal : InteractiveTerminal) {
    return new Promise<void>(resolve => terminal["screen"].write("", resolve));
}

function mockSocket(id = "socket-1", connected = true) {
    return {
        id,
        connected,
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

// start() sets up timers of its own, which fake timers keep from outliving the
// test. Every process a test starts is made to exit, which clears them, and
// the spawn mock forgets its calls so an assertion only sees this test's.
function cleanUpTerminals() {
    for (const fake of spawned.splice(0)) {
        fake.exit(0);
    }
    Terminal["terminalMap"].clear();
    vi.mocked(pty.spawn).mockClear();
    vi.useRealTimers();
}

const consoleServer = {
    config: { enableConsole: true },
    stacksDir: "/opt/stacks",
} as never;

describe("TERM", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(cleanUpTerminals);

    // node-pty sets TERM from the name it is given, which used to be the
    // terminal's own, "console". No terminfo answers to that, so nano and
    // clear refused to start in the console.
    it("tells the console it is talking to an xterm", () => {
        new MainTerminal(consoleServer, "console").start();

        expect(pty.spawn).toHaveBeenCalledTimes(1);
        expect(pty.spawn).toHaveBeenCalledWith(
            expect.any(String),
            [],
            expect.objectContaining({ name: "xterm-256color" })
        );
    });

    it("tells every other process the same, rather than the terminal's name", () => {
        new Terminal({} as never, "compose--stack", "docker", [ "compose", "up" ], "").start();

        expect(pty.spawn).toHaveBeenCalledWith(
            "docker",
            [ "compose", "up" ],
            expect.objectContaining({ name: "xterm-256color" })
        );
    });
});

describe("InteractiveTerminal screen copy", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: [ "setInterval", "clearInterval" ] });
    });
    afterEach(cleanUpTerminals);

    function startShell(name = "container-terminal-x") {
        const terminal = new InteractiveTerminal({} as never, name, "bash", [], "");
        terminal.rows = 5;
        terminal.cols = 20;
        terminal.start();
        return {
            terminal,
            pty: spawned[spawned.length - 1],
        };
    }

    // The echo of each key used to be a chunk of its own, and only a hundred
    // chunks were kept, so typing pushed out the output of the commands run
    it("keeps the output of a command however many keys are pressed after it", async () => {
        const { terminal, pty: shell } = startShell();

        shell.output("$ ls\r\nimportant-output\r\n$ ");
        for (const key of "echo typing a good deal more than a hundred keys after the command whose output matters".repeat(2)) {
            shell.output(key);
        }
        await screenSettled(terminal);

        expect(terminal.getBuffer()).toContain("important-output");
    });

    // nano draws once on the alternate screen and then only sends changes, so a
    // replay of the last few chunks came back as fragments on the wrong screen
    it("gives a client joining mid-program the program's screen, on the alternate screen", async () => {
        const { terminal, pty: shell } = startShell();

        shell.output("$ nano f\r\n\x1b[?1049h\x1b[H\x1b[2J  GNU nano\x1b[5;1H^X Exit");
        for (let i = 0; i < 150; i++) {
            shell.output("\x1b[2;1Hx");
        }
        await screenSettled(terminal);

        const buffer = terminal.getBuffer();
        expect(buffer).toContain("\x1b[?1049h");
        expect(buffer).toContain("GNU nano");
        expect(buffer).toContain("^X Exit");
    });

    // Replayed, a query would be answered by the client into the shell
    it("sends no queries to a client joining later", async () => {
        const { terminal, pty: shell } = startShell();

        shell.output("before\x1b[c\x1b[6nafter");
        await screenSettled(terminal);

        const buffer = terminal.getBuffer();
        expect(buffer).toContain("before");
        expect(buffer).toContain("after");
        expect(buffer).not.toContain("\x1b[c");
        expect(buffer).not.toContain("\x1b[6n");
    });

    // Parsing is asynchronous. Output that went out before a client joined,
    // and was not on the screen yet, would otherwise reach it by neither route.
    it("includes output the screen has not taken in yet", () => {
        const { terminal, pty: shell } = startShell();

        shell.output("just written");

        expect(terminal.getBuffer()).toContain("just written");
    });

    it("keeps the screen copy the size the shell is told", () => {
        const { terminal, pty: shell } = startShell();

        terminal.rows = 30;
        terminal.cols = 90;

        expect(shell.resize).toHaveBeenLastCalledWith(90, 30);
        expect(terminal["screen"].rows).toBe(30);
        expect(terminal["screen"].cols).toBe(90);
    });
});

describe("keep-alive", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(cleanUpTerminals);

    it("closes an operation's terminal at the first check nobody is watching", () => {
        const terminal = new Terminal({} as never, "container-log-x", "docker", [], "");
        terminal.enableKeepAlive = true;
        terminal.start();

        vi.advanceTimersByTime(60 * 1000);

        expect(spawned[0].kill).toHaveBeenCalled();
    });

    // Closing a minute after the last client left killed whatever was running
    // in the shell, such as an editor, on a visit to another page
    it("leaves a shell running for ten minutes with nobody watching", () => {
        const terminal = new InteractiveTerminal({} as never, "container-terminal-x", "bash", [], "");
        terminal.enableKeepAlive = true;
        terminal.start();

        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(spawned[0].kill).not.toHaveBeenCalled();

        vi.advanceTimersByTime(60 * 1000);
        expect(spawned[0].kill).toHaveBeenCalled();
    });

    it("starts counting again when a client comes back", () => {
        const socket = mockSocket();
        const terminal = new InteractiveTerminal({} as never, "container-terminal-x", "bash", [], "");
        terminal.enableKeepAlive = true;
        terminal.start();

        vi.advanceTimersByTime(9 * 60 * 1000);
        terminal.join(socket);
        terminal.leave(socket);
        vi.advanceTimersByTime(9 * 60 * 1000);

        expect(spawned[0].kill).not.toHaveBeenCalled();
    });
});

describe("Terminal.leaveAll on logout", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(cleanUpTerminals);

    it("closes a shell the user leaves with nobody watching", () => {
        const socket = mockSocket();
        const shell = new MainTerminal(consoleServer, "console-x");
        shell.join(socket);
        shell.start();

        Terminal.leaveAll(socket);

        expect(spawned[0].kill).toHaveBeenCalled();
    });

    // A connection that dropped stays listed until the next sweep
    it("does not count a client whose connection dropped as watching", () => {
        const socket = mockSocket("logging-out");
        const shell = new InteractiveTerminal({} as never, "container-terminal-x", "bash", [], "");
        shell.join(socket);
        shell.join(mockSocket("before-a-reconnect", false));
        shell.start();

        Terminal.leaveAll(socket);

        expect(spawned[0].kill).toHaveBeenCalled();
    });

    it("leaves a shell someone else is still watching", () => {
        const socket = mockSocket("logging-out");
        const shell = new InteractiveTerminal({} as never, "container-terminal-x", "bash", [], "");
        shell.join(socket);
        shell.join(mockSocket("still-here"));
        shell.start();

        Terminal.leaveAll(socket);

        expect(spawned[0].kill).not.toHaveBeenCalled();
    });

    it("leaves an operation running", () => {
        const socket = mockSocket();
        const operation = new Terminal({} as never, "compose--stack", "docker", [], "");
        operation.join(socket);
        operation.start();

        Terminal.leaveAll(socket);

        expect(spawned[0].kill).not.toHaveBeenCalled();
    });
});
