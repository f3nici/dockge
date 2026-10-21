import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, doubleCheckPassword } from "../util-server";
import { ApiKeys } from "../api-keys";
import { Settings } from "../settings";
import { log } from "../log";

/**
 * Settings → API: the keys the REST API accepts.
 */
export class ApiKeySocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        socket.on("getApiKeys", async (callback) => {
            try {
                checkLogin(socket);

                callbackResult({
                    ok: true,
                    keys: await ApiKeys.list(),
                    // Set in the environment, so it can be mentioned but not managed
                    envKey: !!process.env.DOCKGE_API_KEY,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("createApiKey", async (name : unknown, readOnly : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);

                // A key with full access can do anything a logged in user can,
                // from anywhere, so creating one takes the password, the same as
                // turning authentication off does
                if (!await Settings.get("disableAuth")) {
                    await doubleCheckPassword(socket, currentPassword);
                }

                const { key, info } = await ApiKeys.create(name, readOnly);
                log.info("api", `API key "${info.name}" created${info.readOnly ? " (read-only)" : ""}`);

                callbackResult({
                    ok: true,
                    key,
                    info,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("deleteApiKey", async (id : unknown, callback) => {
            try {
                checkLogin(socket);

                await ApiKeys.revoke(id);
                log.info("api", `API key ${id} deleted`);

                callbackResult({
                    ok: true,
                    msg: "apiKeyDeleted",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
