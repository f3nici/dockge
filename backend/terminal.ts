import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { sync as commandExistsSync } from "command-exists";
import { log } from "./log";

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callback? : (exitCode : number) => void;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.name, this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        log.debug("Terminal", "Terminal " + this.name + " starting");

        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            // Print command
            this.writeToClients(this.file + " " + (Array.isArray(this.args) ? this.args.join(" ") : this.args) + "\n\r");

            this._ptyProcess = pty.spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: this.cols,
                rows: this.rows,
            });

            // On Data
            this._ptyProcess.onData((data) => {
                this.writeToClients(data);
            });

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);

                // Try to extract exit code from error, default to 1 if not found
                // ENOENT errors don't have a numeric exit code in the message
                let exitCode = 1;
                const errorCode = (error as NodeJS.ErrnoException).code;
                if (errorCode === "ENOENT") {
                    // Command not found - write helpful error to terminal
                    this.writeToClients(`\r\nError: Command '${this.file}' not found. Please ensure it is installed and in the PATH.\r\n`);
                    exitCode = 127; // Standard exit code for command not found
                } else {
                    // Try to parse exit code from error message
                    const parsedCode = Number(error.message.split(" ").pop());
                    if (!isNaN(parsedCode)) {
                        exitCode = parsedCode;
                    }
                }

                this.exit({
                    exitCode,
                });
            }
        }
    }

    /**
     * Send output to every client watching this terminal, and keep it in the
     * buffer so a client joining later still sees it.
     * @param data
     */
    protected writeToClients(data : string) {
        this.buffer.pushItem(data);

        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalWrite", this.name, data);
        }
    }

    /**
     * Tell the client that started an operation which step is running now.
     *
     * An operation such as an update runs several commands in a row under one
     * terminal name, and between them nothing is writing to the terminal at
     * all: the pull ends, and recreating the containers can take a while
     * before it produces its first line, which reads as the operation having
     * silently stopped. Announcing each step keeps the terminal talking across
     * those gaps.
     *
     * This is a message of its own rather than terminal output, because
     * between two commands there is no terminal to write into: the one that
     * has just finished is gone, and the next one does not exist yet. It is
     * therefore not part of any terminal buffer either, so a client that joins
     * later does not see it - the same as the output of the commands that have
     * already finished.
     * @param socket Client that started the operation. Operations nobody is
     * watching, such as a scheduled auto update, have none and report nothing.
     * @param terminalName Terminal the operation is running in
     * @param translationKey Message to show, translated by the client
     * @param fallbackText Message to show when the client does not know the
     * translation key, which happens when it is older than the agent
     */
    public static writeStatus(socket : DockgeSocket | undefined, terminalName : string, translationKey : string, fallbackText : string) {
        socket?.emitAgent("terminalStatus", terminalName, translationKey, fallbackText);
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        Terminal.terminalMap.delete(this.name);
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        this._ptyProcess = undefined;

        if (this.callback) {
            this.callback(res.exitCode);
        }
    };

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    public join(socket : DockgeSocket) {
        log.debug("Terminal", "Terminal " + this.name + " socket " + socket.id + " joining");

        this.socketList[socket.id] = socket;
    }

    public leave(socket : DockgeSocket) {
        log.debug("Terminal", "Terminal " + this.name + " socket " + socket.id + " leaving");

        delete this.socketList[socket.id];
    }

    /**
     * Detach a socket from every terminal it is watching.
     *
     * Logging out does not close the connection - the browser keeps the same
     * socket and simply drops its token - so nothing here would otherwise stop
     * the terminals it had joined. They went on writing container and stack
     * output to a connection that is no longer authorised, and the sweep that
     * removes stale clients only looks at disconnected ones, which this is not.
     * @param socket The socket to remove from every terminal
     */
    public static leaveAll(socket : DockgeSocket) {
        for (const terminal of Terminal.terminalMap.values()) {
            if (socket.id in terminal.socketList) {
                terminal.leave(socket);
            }
        }
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    /**
     * Clear the terminal buffer
     */
    clearBuffer() {
        this.buffer.length = 0;
    }

    close() {
        clearInterval(this.keepAliveInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
        this.ptyProcess?.kill(undefined);
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<number> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.terminalMap.has(terminalName)) {
                reject(new Error("Another operation is already running, please try again later."));
                return;
            }

            let terminal = new Terminal(server, terminalName, file, args, cwd);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                resolve(exitCode);
            });
            terminal.start();
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    constructor(server : DockgeServer, name : string) {
        let shell;

        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir);
    }

    public write(input : string) {
        super.write(input);
    }
}
