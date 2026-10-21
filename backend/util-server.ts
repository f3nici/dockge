import { Socket } from "socket.io";
import type { IncomingHttpHeaders } from "node:http";
import { Terminal } from "./terminal";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import { R } from "redbean-node";
import { verifyPassword } from "./password-hash";
import fs from "fs";
import { AgentManager } from "./agent-manager";

export interface JWTDecoded {
    username : string;
    h? : string;
}

export interface DockgeSocket extends Socket {
    userID: number;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    emitAgent : (eventName : string, ...args : unknown[]) => void;

    /**
     * "api" for the connection another Dockge's REST API makes to this one,
     * from its `dockge-origin` header. Unset for everything else.
     */
    origin? : "api";
}

/**
 * The address a client connected from.
 * @param remoteAddress The address of the connection itself
 * @param headers The request headers
 * @param trustProxy Whether to believe X-Forwarded-For and X-Real-IP, as the
 * trustProxy setting says
 * @returns The address
 */
export function clientIPFrom(remoteAddress : string | undefined, headers : IncomingHttpHeaders, trustProxy : boolean) : string {
    if (trustProxy) {
        const forwardedFor = headers["x-forwarded-for"];

        if (typeof forwardedFor === "string") {
            return forwardedFor.split(",")[0].trim();
        } else if (typeof headers["x-real-ip"] === "string") {
            return headers["x-real-ip"];
        }
    }
    return (remoteAddress ?? "").replace(/^::ffff:/, "");
}

/**
 * What an update a client asked for counts as in the update history.
 * @param socket The client
 */
export function socketTrigger(socket : DockgeSocket) : "api" | "manual" {
    return socket.origin === "api" ? "api" : "manual";
}

// For command line arguments, so they are nullable
export interface Arguments {
    sslKey? : string;
    sslCert? : string;
    sslKeyPassphrase? : string;
    port? : number;
    hostname? : string;
    dataDir? : string;
    stacksDir? : string;
    enableConsole? : boolean;
    basePath? : string;
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;

    /** Empty when Dockge is served from the root of its domain */
    basePath : string;
}

export function checkLogin(socket : DockgeSocket) {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
}

export class ValidationError extends Error {
    constructor(message : string) {
        super(message);
    }
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    // Check ValidationError first since it extends Error
    if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: error.message,
            msgi18n: true,
        });
    } else if (error instanceof Error) {
        // No msgi18n: a plain Error carries an English sentence, not a
        // translation key. Tagging it as one sends it through $t(), which warns
        // about a missing key and only displays at all because vue-i18n falls
        // back to passing the key through.
        callback({
            ok: false,
            msg: error.message,
        });
    } else {
        // Not an Error, but the caller is still waiting on an answer. Staying
        // silent here leaves the browser on a spinner forever, so whatever was
        // thrown is passed on as best it can be.
        log.error("console", "Unknown error: " + error);
        callback({
            ok: false,
            msg: String(error),
        });
    }
}

export function callbackResult(result : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

export async function doubleCheckPassword(socket : DockgeSocket, currentPassword : unknown) {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await R.findOne("user", " id = ? AND active = 1 ", [
        socket.userID,
    ]);

    if (!user || !await verifyPassword(currentPassword, user.password)) {
        throw new Error("Incorrect current password");
    }

    return user;
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}
