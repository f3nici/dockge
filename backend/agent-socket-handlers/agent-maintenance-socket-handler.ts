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
import { DockerArtefactAction, DockerArtefactData, DockerArtefactInfos } from "../../common/types";

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
                    info: DockerArtefactInfos[artefact],
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
                } else {
                    log.error("getDockerArtefactData", `Unknown artefact '${artefact}'`);
                }

                callbackResult({
                    ok: true,
                    data: artefactData,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("executeDockerArtefactAction", async (artefact: unknown, action: unknown, ids: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(artefact) !== "string") {
                    throw new ValidationError("artefact must be a string");
                }
                if (typeof(action) !== "string") {
                    throw new ValidationError("action must be a string");
                }
                if (!Array.isArray(ids) || ids.some(item => typeof item !== "string")) {
                    throw new ValidationError("ids must be a string[]");
                }

                if (action === DockerArtefactAction.Prune || action === DockerArtefactAction.PruneAll) {
                    await agentMaintenance.prune(socket, artefact, action === DockerArtefactAction.PruneAll);
                } else if (action === DockerArtefactAction.Remove) {
                    await agentMaintenance.remove(socket, artefact, ids);
                } else if (artefact === "image" && action === DockerArtefactAction.Pull) {
                    await agentMaintenance.pullImages(socket, ids);
                } else {
                    log.error("executeDockerArtefactAction", `Unsupport combination: artefact '${artefact}' & action '${action}'`);
                }

                callbackResult({
                    ok: true,
                    msg: "Action executed successfully",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("dockerSystemPrune", async (all: unknown, volumes: unknown, callback) => {
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
