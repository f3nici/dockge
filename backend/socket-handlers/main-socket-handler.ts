// @ts-ignore
import composerize from "composerize";
import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { R } from "redbean-node";
import { loginRateLimiter } from "../rate-limiter";
import { generatePasswordHash, shake256, SHAKE256_LENGTH, verifyPassword } from "../password-hash";
import { User } from "../models/user";
import {
    callbackError,
    callbackResult,
    checkLogin,
    DockgeSocket,
    doubleCheckPassword,
    JWTDecoded,
    ValidationError
} from "../util-server";
import { passwordStrength } from "check-password-strength";
import dayjs from "dayjs";
import jwt from "jsonwebtoken";
import { Settings } from "../settings";
import { Stack } from "../stack";
import { AutoUpdateManager } from "../auto-update";
import { RegistryCredentialManager } from "../registry-credentials";
import { AUTO_UPDATE_DEFAULT, LooseObject } from "../../common/util-common";
import { Terminal } from "../terminal";

/**
 * The settings a client is allowed to write under the "general" type.
 *
 * `setting.key` is unique across every type, so a key written as "general"
 * cannot later be stored by the feature that actually owns it. Without this
 * list, a client could write any key at all and permanently block, say, the
 * registry logins or the notification settings from ever saving.
 */
const GENERAL_SETTING_KEYS = new Set([
    "disableAuth",
    "primaryHostname",
    "trustProxy",
    "serverTimezone",
    "autoUpdateEnabled",
    "autoUpdateCron",
    "autoUpdatePrune",
    "autoUpdateDefault",
    "defaultComposeTemplate",
]);

export class MainSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        // ***************************
        // Public Socket API
        // ***************************

        // Setup
        socket.on("setup", async (username, password, callback) => {
            try {
                // Checked before the strength gate rather than left to bcrypt:
                // passwordStrength() answers "undefined" for a non-string, which
                // is not "Too weak", so the gate was simply skipped and the
                // request died further down on an internal bcrypt error.
                if (typeof(username) !== "string" || !username.trim()) {
                    throw new Error("Username is required");
                }

                if (typeof(password) !== "string") {
                    throw new Error("Password must be a string");
                }

                if (passwordStrength(password).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                if ((await R.knex("user").count("id as count").first()).count !== 0) {
                    throw new Error("Dockge has been initialized. If you want to run setup again, please delete the database.");
                }

                const user = R.dispense("user");
                user.username = username.trim();
                user.password = await generatePasswordHash(password);
                await R.store(user);

                server.needSetup = false;

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Login by token
        socket.on("loginByToken", async (token, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by token. IP=${clientIP}`);

            try {
                const decoded = jwt.verify(token, server.jwtSecret) as JWTDecoded;

                log.info("auth", "Username from JWT: " + decoded.username);

                const user = await R.findOne("user", " username = ? AND active = 1 ", [
                    decoded.username,
                ]) as User;

                if (user) {
                    // Check if the password changed
                    if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                        throw new Error("The token is invalid due to password change or old token");
                    }

                    log.debug("auth", "afterLogin");
                    await server.afterLogin(socket, user);
                    log.debug("auth", "afterLogin ok");

                    log.info("auth", `Successfully logged in user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                    });
                } else {

                    log.info("auth", `Inactive or deleted user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                if (!(error instanceof Error)) {
                    console.error("Unknown error:", error);
                    return;
                }
                log.error("auth", `Invalid token. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message + ` IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }

        });

        // Login
        socket.on("login", async (data, callback) => {
            // Checking
            if (typeof callback !== "function") {
                return;
            }

            try {
                const clientIP = await server.getClientIP(socket);

                log.info("auth", `Login by username + password. IP=${clientIP}`);

                if (!data) {
                    return;
                }

                // Login Rate Limit, budgeted per client so one caller cannot
                // spend everybody else's allowance
                if (!await loginRateLimiter.pass(callback, 1, clientIP)) {
                    log.info("auth", `Too many failed requests for user ${data.username}. IP=${clientIP}`);
                    return;
                }

                const user = await this.login(data.username, data.password);

                if (!user) {
                    log.warn("auth", `Incorrect username or password for user ${data.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authIncorrectCreds",
                        msgi18n: true,
                    });
                    return;
                }

                await server.afterLogin(socket, user);

                log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                callback({
                    ok: true,
                    token: User.createJWT(user, server.jwtSecret),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Change Password
        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket);

                if (!password || typeof(password) !== "object") {
                    throw new Error("Invalid new password");
                }

                if (! password.newPassword) {
                    throw new Error("Invalid new password");
                }

                // See the setup handler: a non-string slips past the strength
                // check, so its type is settled first
                if (typeof(password.newPassword) !== "string") {
                    throw new Error("Password must be a string");
                }

                if (passwordStrength(password.newPassword).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                let user = await doubleCheckPassword(socket, password.currentPassword);
                await user.resetPassword(password.newPassword);

                server.disconnectAllSocketClients(user.id, socket.id);

                callback({
                    ok: true,
                    msg: "Password has been updated successfully.",
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const data = await Settings.getSettings("general");

                // Never saved before: show the same default the scheduler applies
                if (!data.autoUpdateDefault) {
                    data.autoUpdateDefault = AUTO_UPDATE_DEFAULT;
                }

                callback({
                    ok: true,
                    data: data,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("setSettings", async (requestData, currentPassword, callback) => {
            try {
                checkLogin(socket);

                if (!requestData || typeof(requestData) !== "object" || Array.isArray(requestData)) {
                    throw new ValidationError("Settings must be an object");
                }

                // Only the keys this page owns are written. Anything else would
                // claim that key name for the "general" type and stop its real
                // owner from ever saving it.
                //
                // Dropped rather than rejected: the settings page sends back
                // whatever getSettings() gave it, which on an upgraded install
                // includes keys nothing reads any more. Refusing the whole save
                // over one of those would break the page outright.
                const data = {} as LooseObject;
                for (const [ key, value ] of Object.entries(requestData as LooseObject)) {
                    if (GENERAL_SETTING_KEYS.has(key)) {
                        data[key] = value;
                    } else {
                        log.debug("settings", `Ignoring unknown general setting "${key}"`);
                    }
                }

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await Settings.get("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket, currentPassword);
                }

                // Validated whenever a pattern is present, not only when auto
                // update is being switched on in the same save. An invalid
                // pattern stored while disabled was never re-checked on the save
                // that enabled it, and schedule() swallows the parse error: the
                // page then reported auto update as on with no job behind it.
                if (data.autoUpdateCron) {
                    if (typeof data.autoUpdateCron !== "string") {
                        throw new ValidationError("Auto update cron must be a string");
                    }
                    try {
                        AutoUpdateManager.validateCron(data.autoUpdateCron);
                    } catch (e) {
                        throw new ValidationError("Invalid auto update cron expression");
                    }
                }

                if (data.autoUpdateDefault !== undefined && data.autoUpdateDefault !== "none" && data.autoUpdateDefault !== "update") {
                    throw new ValidationError("Auto update default must be \"none\" or \"update\"");
                }

                await Settings.setSettings("general", data);

                // Reschedule (or cancel) the auto-update job to reflect the new settings
                await server.autoUpdateManager.schedule();

                callback({
                    ok: true,
                    msg: "Saved"
                });

                server.sendInfo(socket);

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Trigger an auto update run immediately ("Update now")
        socket.on("triggerAutoUpdate", async (callback) => {
            try {
                checkLogin(socket);

                const updated = await server.autoUpdateManager.runNow();

                callback({
                    ok: true,
                    msg: `Auto update finished. Updated ${updated.length} stack(s).`,
                    updated,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Auto update schedule status: the server's timezone (cron expressions are
        // evaluated in it) and the next scheduled run.
        socket.on("getAutoUpdateStatus", async (callback) => {
            try {
                checkLogin(socket);

                const nextRun = server.autoUpdateManager.nextRun();

                callback({
                    ok: true,
                    timezone: await server.getTimezone(),
                    timezoneOffset: server.getTimezoneOffset(),
                    serverTime: dayjs().format("YYYY-MM-DD HH:mm:ss"),
                    nextRun: nextRun ? dayjs(nextRun).format("YYYY-MM-DD HH:mm:ss") : null,
                    enabled: !!(await Settings.get("autoUpdateEnabled")),
                    // What stacks without x-dockge.auto-update currently do
                    defaultBehaviour: await AutoUpdateManager.getDefaultBehaviour(),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Get notification settings
        socket.on("getNotificationSettings", async (callback) => {
            try {
                checkLogin(socket);

                // Without the token and password: the browser has no use for
                // them, and it does not have to send them back either
                callback({
                    ok: true,
                    data: Stack.notificationManager.getSettingsForClient(),
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Save notification settings
        socket.on("saveNotificationSettings", async (data, callback) => {
            try {
                checkLogin(socket);
                await Stack.notificationManager.saveSettings(data);

                callback({
                    ok: true,
                    msg: "Notification settings saved successfully"
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Test notification. The settings to test with come from the form, so
        // that editing a field and pressing Test exercises what is on screen
        // rather than what was last saved.
        socket.on("testNotification", async (settings : unknown, callback) => {
            // A browser still running the old page sends the callback alone
            if (typeof settings === "function" && callback === undefined) {
                callback = settings as typeof callback;
                settings = undefined;
            }

            try {
                checkLogin(socket);
                const success = await Stack.notificationManager.testNotification(settings);

                if (success) {
                    callback({
                        ok: true,
                        msg: "Test notification sent successfully! Check your NTFY app."
                    });
                } else {
                    callback({
                        ok: false,
                        msg: "Failed to send test notification. Please check your settings."
                    });
                }

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Registry logins - the stored ones, without their secrets
        socket.on("getRegistryCredentials", async (callback) => {
            try {
                checkLogin(socket);

                callback({
                    ok: true,
                    data: RegistryCredentialManager.INSTANCE.list(),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Save registry logins
        socket.on("saveRegistryCredentials", async (data, callback) => {
            try {
                checkLogin(socket);
                await RegistryCredentialManager.INSTANCE.save(data);

                callback({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Check one registry login, and report the pull limit it comes with
        socket.on("testRegistryCredential", async (registry, username, password, callback) => {
            try {
                checkLogin(socket);
                const result = await RegistryCredentialManager.INSTANCE.test(registry, username, password);

                callback({
                    ok: result.ok,
                    msg: result.msg,
                    rateLimit: result.rateLimit,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Docker Hub's pull limit as it currently applies to this Dockge
        socket.on("getDockerHubRateLimit", async (callback) => {
            try {
                checkLogin(socket);

                callback({
                    ok: true,
                    rateLimit: await RegistryCredentialManager.INSTANCE.getDockerHubRateLimit(),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Log out
        //
        // The browser emits this and then drops its token, but the socket it
        // emitted on stays open. Without clearing the session here it kept its
        // userID, so every handler's checkLogin() went on passing and the
        // connection stayed authorised long after the user had logged out.
        socket.on("logout", async (callback) => {
            try {
                if (socket.userID) {
                    socket.leave(socket.userID.toString());
                }

                // 0 rather than undefined: checkLogin() treats it as logged out,
                // and DockgeSocket types userID as a number.
                socket.userID = 0;

                // The connection stays open across a logout, so anything still
                // pointed at it keeps delivering. Terminals are the ones that
                // push on their own: without this they went on streaming
                // container and stack output to a socket that no longer has a
                // session behind it.
                Terminal.leaveAll(socket);

                // These exist on behalf of a logged-in user, so they go too.
                // Logging back in on this socket connects them again.
                socket.instanceManager.disconnectAll();

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Disconnect all other socket clients of the user
        socket.on("disconnectOtherSocketClients", async () => {
            try {
                checkLogin(socket);
                server.disconnectAllSocketClients(socket.userID, socket.id);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("disconnectOtherSocketClients", e.message);
                }
            }
        });

        // composerize
        socket.on("composerize", async (dockerRunCommand : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(dockerRunCommand) !== "string") {
                    throw new ValidationError("dockerRunCommand must be a string");
                }

                // Option: 'latest' | 'v2x' | 'v3x'
                let composeTemplate = composerize(dockerRunCommand, "", "latest");

                // Remove the first line "name: <your project name>"
                composeTemplate = composeTemplate.split("\n").slice(1).join("\n");

                callback({
                    ok: true,
                    composeTemplate,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async login(username : string, password : string) : Promise<User | null> {
        if (typeof username !== "string" || typeof password !== "string") {
            return null;
        }

        const user = await R.findOne("user", " username = ? AND active = 1 ", [
            username,
        ]) as User;

        if (user && await verifyPassword(password, user.password)) {
            return user;
        }

        return null;
    }
}
