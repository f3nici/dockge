import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { collectHistory, historySources } from "../update-history";
import { UpdateHistoryFilter } from "../../common/types";

/**
 * The update history of this instance and its agents, put together for the
 * update history page.
 */
export class UpdateHistorySocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        // endpoint: ALL_ENDPOINTS, "" for this instance, or an agent
        socket.on("getUpdateHistory", async (endpoint : unknown, filter : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(endpoint) !== "string") {
                    throw new ValidationError("Endpoint must be a string");
                }

                const sources = await historySources(socket.instanceManager, endpoint);
                const page = await collectHistory(sources, (filter ?? {}) as UpdateHistoryFilter);

                callbackResult({
                    ok: true,
                    ...page,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
