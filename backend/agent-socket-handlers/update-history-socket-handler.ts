import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { MAX_HISTORY_ENTRIES, normalizeHistoryFilter, UpdateHistory } from "../update-history";

/**
 * This instance's own update history. Another Dockge asks for it to put the
 * history of all its agents together.
 */
export class UpdateHistoryAgentSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {

        agentSocket.on("listUpdateHistory", async (filter : unknown, callback) => {
            try {
                checkLogin(socket);

                const page = await UpdateHistory.list(normalizeHistoryFilter(filter, MAX_HISTORY_ENTRIES));

                callbackResult({
                    ok: true,
                    ...page,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getUpdateHistoryEntry", async (id : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(id) !== "number" || !Number.isInteger(id)) {
                    throw new ValidationError("ID must be an integer");
                }

                const entry = await UpdateHistory.get(id);

                if (!entry) {
                    throw new ValidationError("Update history entry not found");
                }

                callbackResult({
                    ok: true,
                    entry,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
