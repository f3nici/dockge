import { AgentSocketHandler } from "../agent-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import {
    callbackResult,
    callbackError,
    checkLogin,
    DockgeSocket,
    ValidationError
} from "../util-server";
import { AgentMaintenance } from "../agent-maintenance";
import { DockerArtefactData } from "../../common/types";

export class AgentMaintenanceSocketHandler extends AgentSocketHandler {

    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket) {

        const agentMaintenance = new AgentMaintenance(server);

        agentSocket.on("getDockerArtefactData", async (artefact: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(artefact) !== "string") {
                    throw new ValidationError("artefact must be a string");
                }

                let artefactData: DockerArtefactData = {
                    header: [],
                    data: []
                };

                if (artefact === "container") {
                    artefactData = await agentMaintenance.getContainerData();
                } else if (artefact === "image") {
                    artefactData = await agentMaintenance.getImageData();
                } else if (artefact === "network") {
                    artefactData = await agentMaintenance.getNetworkData();
                } else if (artefact === "volume") {
                    artefactData = await agentMaintenance.getVolumeData();
                }

                callbackResult({
                    ok: true,
                    data: artefactData,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("prune", async (artefact: unknown, all: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(artefact) !== "string") {
                    throw new ValidationError("artefact must be a string");
                }
                if (typeof(all) !== "boolean") {
                    throw new ValidationError("all must be a boolean");
                }

                await agentMaintenance.prune(socket, artefact, all);

                callbackResult({
                    ok: true,
                    msg: "Successfully pruned",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("systemPrune", async (all: unknown, volumes: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(all) !== "boolean") {
                    throw new ValidationError("all must be a boolean");
                }
                if (typeof(volumes) !== "boolean") {
                    throw new ValidationError("volumes must be a boolean");
                }

                await agentMaintenance.systemPrune(socket, all, volumes);

                callbackResult({
                    ok: true,
                    msg: "Successfully pruned",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
