import { DockgeServer } from "./dockge-server";
import { DockerArtefactData } from "../common/types";
import { getAgentMaintenanceTerminalName } from "../common/util-common";
import { DockgeSocket } from "./util-server";
import { Terminal } from "./terminal";
import { log } from "./log";
import childProcessAsync from "promisify-child-process";

export class AgentMaintenance {

    constructor(protected server: DockgeServer) {
    }

    async getContainerData(): Promise<DockerArtefactData> {
        const containerData: DockerArtefactData = {
            header: [ "Names", "Image", "Created", "Status" ],
            data: []
        };

        try {
            const res = await childProcessAsync.spawn("docker", [ "ps", "--all", "--format", "json" ], {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return containerData;
            }

            const lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                if (line != "") {
                    const containerInfo = JSON.parse(line);

                    containerData.data.push({
                        values: [ containerInfo.Names, containerInfo.Image, containerInfo.CreatedAt, containerInfo.Status ],
                        dangling: containerInfo.Status.startsWith("Exited"),
                        danglingLabel: "stopped"
                    });
                }
            }
        } catch (e) {
            log.error("getContainerData", e);
        }

        return containerData;
    }

    async getImageData(): Promise<DockerArtefactData> {
        const containerData: DockerArtefactData = {
            header: [ "Name", "Created", "Size" ],
            data: []
        };

        try {
            const res = await childProcessAsync.spawn("docker", [ "image", "ls", "--format", "json" ], {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return containerData;
            }

            const lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                if (line != "") {
                    const imageInfo = JSON.parse(line);

                    containerData.data.push({
                        values: [ imageInfo.Repository + (imageInfo.Tag === "<none>" ? "" : `:${imageInfo.Tag}`), imageInfo.CreatedSince, imageInfo.Size ],
                        dangling: imageInfo.Containers === "0",
                        danglingLabel: imageInfo.Tag === "<none>" ? "dangling" : "unused"
                    });
                }
            }
        } catch (e) {
            log.error("getImageData", e);
        }

        return containerData;
    }

    async getNetworkData(): Promise<DockerArtefactData> {
        const containerData: DockerArtefactData = {
            header: [ "Name", "Created", "Driver", "Scope" ],
            data: []
        };

        const defaultNetworks = new Set(["bridge", "host", "none"]);

        try {
            const res = await childProcessAsync.spawn("docker", [ "network", "ls", "--format", "json" ], {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return containerData;
            }

            const lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                if (line != "") {
                    const networkInfo = JSON.parse(line);

                    let inspectData = {
                        Containers: {
                            nodata: true
                        }
                    };

                    if (!defaultNetworks.has(networkInfo.Name)) {
                        const inspectRes = await childProcessAsync.spawn("docker", [ "network", "inspect", "--format", "json", networkInfo.ID ], {
                            encoding: "utf-8",
                        });

                        if (inspectRes.stdout) {
                            inspectData = JSON.parse(inspectRes.stdout.toString())[0];
                        }
                    }

                    containerData.data.push({
                        values: [ networkInfo.Name, networkInfo.CreatedAt, networkInfo.Driver, networkInfo.Scope ],
                        dangling: Object.keys(inspectData.Containers).length === 0,
                        danglingLabel: "dangling"
                    });
                }
            }
        } catch (e) {
            log.error("getNetworkData", e);
        }

        return containerData;
    }

    async getVolumeData(): Promise<DockerArtefactData> {
        const containerData: DockerArtefactData = {
            header: [ "Name", "Created", "Driver", "Scope", "Size" ],
            data: []
        };

        try {
            const danglingRes = await childProcessAsync.spawn("docker", [ "volume", "ls", "--format", "json", "-f", "dangling=true" ], {
                encoding: "utf-8",
            });

            const danglingVolumes = new Set();
            if (danglingRes.stdout) {
                const lines = danglingRes.stdout?.toString().split("\n");
                for (let line of lines) {
                    if (line != "") {
                        const danglingVolume = JSON.parse(line);
                        danglingVolumes.add(danglingVolume.Name);
                    }
                }
            }

            const res = await childProcessAsync.spawn("docker", [ "volume", "ls", "--format", "json" ], {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return containerData;
            }

            const lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                if (line != "") {
                    const volumeInfo = JSON.parse(line);

                    const inspectRes = await childProcessAsync.spawn("docker", [ "volume", "inspect", "--format", "json", volumeInfo.Name ], {
                        encoding: "utf-8",
                    });

                    let inspectData = {
                        CreatedAt: ""
                    };
                    if (inspectRes.stdout) {
                        inspectData = JSON.parse(inspectRes.stdout.toString())[0];
                    }

                    containerData.data.push({
                        values: [ volumeInfo.Name, inspectData.CreatedAt, volumeInfo.Driver, volumeInfo.Scope, volumeInfo.Size ],
                        dangling: danglingVolumes.has(volumeInfo.Name),
                        danglingLabel: "dangling"
                    });
                }
            }
        } catch (e) {
            log.error("getVolumeData", e);
        }

        return containerData;
    }

    async prune(socket: DockgeSocket, artefact: string, all: boolean) {
        const terminalName = getAgentMaintenanceTerminalName(socket.endpoint);

        const dockerParams = [ artefact, "prune", "-f" ];
        if (all) {
            dockerParams.push("-a");
        }

        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", dockerParams, "");

        if (exitCode !== 0) {
            throw new Error("Failed to prune, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async systemPrune(socket: DockgeSocket, all: boolean, volumes: boolean) {
        const terminalName = getAgentMaintenanceTerminalName(socket.endpoint);

        const dockerParams = [ "system", "prune", "-f" ];
        if (all) {
            dockerParams.push("-a");
        }
        if (volumes) {
            dockerParams.push("--volumes");
        }

        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", dockerParams, "");

        if (exitCode !== 0) {
            throw new Error("Failed to prune, please check the terminal output for more information.");
        }

        return exitCode;
    }
}
