import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { log } from "../log";
import { InteractiveTerminal, MainTerminal, Terminal } from "../terminal";
import { AgentSocketHandler } from "../agent-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import { isConsoleTerminalName } from "../../common/util-common";

export class TerminalSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {

        agentSocket.on("terminalInput", async (terminalName : unknown, cmd : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(terminalName) !== "string") {
                    throw new Error("Terminal name must be a string.");
                }

                if (typeof(cmd) !== "string") {
                    throw new Error("Command must be a string.");
                }

                let terminal = Terminal.getTerminal(terminalName);
                if (terminal instanceof InteractiveTerminal) {
                    //log.debug("terminalInput", "Terminal found, writing to terminal.");
                    terminal.write(cmd);
                } else if (!terminal) {
                    // The shell has gone, most likely exited while this client
                    // was not attached to hear about it. Keys are sent without
                    // waiting for an answer, so say so rather than swallow
                    // them: the client offers to start a new one.
                    socket.emitAgent("terminalExit", terminalName, -1);
                } else {
                    throw new Error("Terminal not found or it is not a Interactive Terminal.");
                }
            } catch (e) {
                // Clients no longer ask for an answer to every key pressed,
                // since nothing comes back when it worked
                if (typeof(callback) === "function") {
                    callbackError(e, callback);
                } else {
                    log.debug("terminalInput", e instanceof Error ? e.message : String(e));
                }
            }
        });

        // Main Terminal
        agentSocket.on("mainTerminal", async (terminalName : unknown, callback) => {
            try {
                checkLogin(socket);

                // Throw an error if console is not enabled
                if (!server.config.enableConsole) {
                    throw new ValidationError("Console is not enabled.");
                }

                // Each browser tab asks for a console of its own. Shared, two
                // tabs typing at once had their keys interleaved into one
                // command line, and each resized the screen under the other.
                // A client from before that gets the one shared console it
                // always had.
                if (!isConsoleTerminalName(terminalName)) {
                    terminalName = "console";
                }

                if (typeof(terminalName) !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }

                log.debug("mainTerminal", "Terminal name: " + terminalName);

                let terminal = Terminal.getTerminal(terminalName);

                if (!terminal) {
                    terminal = new MainTerminal(server, terminalName);
                    terminal.rows = 50;

                    // As every other long-lived terminal does. Without it the
                    // console shell outlived its last client: logging out
                    // detached the socket but left a root shell running, and
                    // the next person to open the console was handed it along
                    // with the previous user's scrollback.
                    terminal.enableKeepAlive = true;

                    log.debug("mainTerminal", "Terminal created");
                }

                terminal.join(socket);
                terminal.start();

                callbackResult({
                    ok: true,
                    terminalName,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Check if MainTerminal is enabled
        agentSocket.on("checkMainTerminal", async (callback) => {
            try {
                checkLogin(socket);
                callbackResult({
                    ok: server.config.enableConsole,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Clear terminal buffer
        agentSocket.on("clearTerminal", async (terminalName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(terminalName) !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }

                const terminal = Terminal.getTerminal(terminalName);
                if (terminal) {
                    terminal.clearBuffer();
                }

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Join Output Terminal
        agentSocket.on("terminalJoin", async (terminalName : unknown, callback) => {
            if (typeof(callback) !== "function") {
                log.debug("console", "Callback is not a function.");
                return;
            }

            try {
                checkLogin(socket);
                if (typeof(terminalName) !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }

                const terminal = Terminal.getTerminal(terminalName);

                // A shell's screen is sent as it stands, and from this point
                // on, so the client is attached in the same step. Joined
                // later, output in between would be on neither.
                if (terminal instanceof InteractiveTerminal) {
                    terminal.join(socket);
                }

                let buffer : string = terminal?.getBuffer() ?? "";

                if (!buffer) {
                    log.debug("console", "No buffer found.");
                }

                callback({
                    ok: true,
                    buffer,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Join Output Terminal
        agentSocket.on("terminalLeave", async (terminalName : unknown, callback) => {
            if (typeof(callback) !== "function") {
                log.debug("console", "Callback is not a function.");
                return;
            }

            try {
                checkLogin(socket);
                if (typeof(terminalName) !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }

                const terminal = Terminal.getTerminal(terminalName);
                if (terminal) {
                    terminal.leave(socket);
                }

                callback({
                    ok: true
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Resize Terminal
        agentSocket.on("terminalResize", async (terminalName: unknown, rows: unknown, cols: unknown) => {
            try {
                checkLogin(socket);
                if (typeof terminalName !== "string") {
                    throw new Error("Terminal name must be a string.");
                }

                if (!Number.isInteger(rows) || (rows as number) < 1 || (rows as number) > 1000) {
                    throw new Error("Rows must be a whole number from 1 to 1000.");
                }
                if (!Number.isInteger(cols) || (cols as number) < 1 || (cols as number) > 1000) {
                    throw new Error("Cols must be a whole number from 1 to 1000.");
                }

                let terminal = Terminal.getTerminal(terminalName);

                // log.info("terminal", terminal);
                if (terminal instanceof Terminal) {
                    //log.debug("terminalInput", "Terminal found, writing to terminal.");
                    terminal.rows = rows as number;
                    terminal.cols = cols as number;
                } else {
                    throw new Error(`${terminalName} Terminal not found.`);
                }
            } catch (e) {
                log.warn("terminalResize",
                        // Added to prevent the lint error when adding the type
                        // and ts type checker saying type is unknown.
                        // @ts-ignore
                        `Error on ${terminalName}: ${e.message}`
                );
            }
        });
    }
}
