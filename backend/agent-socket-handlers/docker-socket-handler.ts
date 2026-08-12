import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { log } from "../log";

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                await stack.deploy(socket);
                // Force a full rescan (useCache=false) because a new stack on disk
                // won't be in the cached managedStackList yet
                server.sendStackList(false);
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                // Force a full rescan (useCache=false) because a new stack on disk
                // won't be in the cached managedStackList yet
                server.sendStackList(false);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
                } catch (e) {
                    // Force rescan after failed delete to reflect actual state
                    server.sendStackList(false);
                    throw e;
                }

                // Force a full rescan (useCache=false) because a stack was removed
                server.sendStackList(false);
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.getData(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                server.sendStackList(true);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateStackTags
        agentSocket.on("updateStackTags", async (stackName : unknown, tags : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (!Array.isArray(tags)) {
                    throw new ValidationError("Tags must be an array");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.updateTags(tags);

                callbackResult({
                    ok: true,
                    msg: "Tags updated",
                    msgi18n: true,
                }, callback);

                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // setStackAutoUpdate
        agentSocket.on("setStackAutoUpdate", async (stackName : unknown, policy : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                // null means "no preference": remove the key and follow the global default
                if (typeof(policy) !== "boolean" && policy !== null) {
                    throw new ValidationError("Auto update must be true, false or null");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.setAutoUpdate(policy);

                let msg;
                if (policy === null) {
                    msg = "Auto update follows the global default";
                } else {
                    msg = policy ? "Auto update enabled" : "Auto update disabled";
                }

                callbackResult({
                    ok: true,
                    msg,
                }, callback);

                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stop(socket);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.restart(socket);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // checkStackImageUpdates - force an on-demand remote image update check
        agentSocket.on("checkStackImageUpdates", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                // Refresh remote digests, then recompute the update-available flags
                await stack.updateImageInfos();
                await stack.updateData();

                callbackResult({
                    ok: true,
                    msg: "checkedImageUpdates",
                    msgi18n: true,
                    stack: await stack.getData(socket.endpoint),
                }, callback);

                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // checkAllStacksImageUpdates - force an on-demand remote image update check for every managed stack
        agentSocket.on("checkAllStacksImageUpdates", async (callback) => {
            try {
                checkLogin(socket);

                const stackList = await Stack.getStackList(server, true);
                for (const stack of stackList.values()) {
                    if (!stack.isManagedByDockge) {
                        continue;
                    }
                    try {
                        await stack.updateImageInfos();
                        await stack.updateData();
                    } catch (e) {
                        log.error("checkAllStacksImageUpdates", `Stack "${stack.name}": ${e}`);
                    }
                }

                callbackResult({
                    ok: true,
                    msg: "checkedImageUpdates",
                    msgi18n: true,
                }, callback);

                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName: unknown, pruneAfterUpdate: unknown, pruneAllAfterUpdate: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(pruneAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAfterUpdate must be a boolean");
                }

                if (typeof(pruneAllAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAllAfterUpdate must be a boolean");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket, pruneAfterUpdate, pruneAllAfterUpdate);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.down(socket);
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stop service
        agentSocket.on("stopService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stopService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // start service
        agentSocket.on("startService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.startService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restart service
        agentSocket.on("restartService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.restartService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // recreate service
        agentSocket.on("recreateService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.recreateService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Recreated",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restart service
        agentSocket.on("updateService", async (stackName : unknown, serviceName: unknown, pruneAfterUpdate: unknown, pruneAllAfterUpdate: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                if (typeof(pruneAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAfterUpdate must be a boolean");
                }

                if (typeof(pruneAllAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAllAfterUpdate must be a boolean");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.updateService(socket, serviceName, pruneAfterUpdate, pruneAllAfterUpdate);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList(true);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Interactive Terminal for containers
        agentSocket.on("joinContainerTerminal", async (stackName : unknown, serviceName : unknown, shell : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string.");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string.");
                }

                if (typeof(shell) !== "string") {
                    throw new ValidationError("Shell must be a string.");
                }

                const stack = await Stack.getStack(server, stackName);
                stack.joinContainerTerminal(socket, serviceName, shell);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Container log
        agentSocket.on("joinContainerLog", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.joinContainerLog(socket, serviceName);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Container inspect
        agentSocket.on("containerInspect", async (containerName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(containerName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const inspectData = await server.getContainerInspectData(containerName);

                callbackResult({
                    ok: true,
                    inspectData
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("updateStackData", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.updateData();
                callbackResult({
                    ok: true,
                    stack: await stack.getData(socket.endpoint)
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Service stats
        agentSocket.on("updateServiceStats", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                callbackResult({
                    ok: true,
                    serviceStats: Object.fromEntries(await stack.getServiceStats())
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown) : Promise<Stack> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }

        const stack = new Stack(server, name, composeYAML, composeENV);
        await stack.save(isAdd);

        // Invalidate the cache for this stack so subsequent reads get fresh data from disk
        Stack.invalidateCache(name);

        return stack;
    }

}

