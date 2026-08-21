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
import { DockerArtefactAction, DockerArtefactData, getDockerArtefactInfo } from "../../common/types";

export class AgentMaintenanceSocketHandler extends AgentSocketHandler {

    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket) {

        const agentMaintenance = new AgentMaintenance(server);

        agentSocket.on("getDockerArtefactData", async (artefact: unknown, callback) => {
            try {
                checkLogin(socket);

                const info = getDockerArtefactInfo(artefact);

                if (!info) {
                    throw new ValidationError(`Unknown artefact '${artefact}'`);
                }

                let artefactData: DockerArtefactData = {
                    info,
                    data: []
                };

                if (info.name === "container") {
                    artefactData = await agentMaintenance.getContainerData();
                } else if (info.name === "image") {
                    artefactData = await agentMaintenance.getImageData();
                } else if (info.name === "network") {
                    artefactData = await agentMaintenance.getNetworkData();
                } else if (info.name === "volume") {
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

        agentSocket.on("executeDockerArtefactAction", async (artefact: unknown, action: unknown, ids: unknown, callback) => {
            try {
                checkLogin(socket);

                // The artefact becomes a docker subcommand, so it is matched
                // against the known kinds rather than passed through: without
                // this, any string reached "docker <artefact> rm/prune".
                const info = getDockerArtefactInfo(artefact);

                if (!info) {
                    throw new ValidationError(`Unknown artefact '${artefact}'`);
                }
                if (typeof(action) !== "string") {
                    throw new ValidationError("action must be a string");
                }
                if (!Array.isArray(ids) || ids.some(item => typeof item !== "string")) {
                    throw new ValidationError("ids must be a string[]");
                }
                if (!info.actions.includes(action as DockerArtefactAction)) {
                    throw new ValidationError(`Action '${action}' is not supported for ${info.name}`);
                }

                if (action === DockerArtefactAction.Prune || action === DockerArtefactAction.PruneAll) {
                    await agentMaintenance.prune(socket, info.name, action === DockerArtefactAction.PruneAll);
                } else if (action === DockerArtefactAction.Remove) {
                    await agentMaintenance.remove(socket, info.name, ids);
                } else if (info.name === "image" && action === DockerArtefactAction.Pull) {
                    await agentMaintenance.pullImages(socket, ids);
                } else {
                    log.error("executeDockerArtefactAction", `Unsupport combination: artefact '${info.name}' & action '${action}'`);
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
