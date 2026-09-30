import { DockgeSocket } from "./util-server";
import { io, Socket as SocketClient } from "socket.io-client";
import { log } from "./log";
import { Agent } from "./models/agent";
import { isDev, LooseObject, sleep } from "../common/util-common";
import semver from "semver";
import { R } from "redbean-node";
import dayjs, { Dayjs } from "dayjs";
import { AgentData } from "../common/types";
import { basePathFromURL, socketIOPath } from "../common/base-path";

/**
 * Dockge Instance Manager
 * One AgentManager per Socket connection.
 *
 * The socket is the browser connection the agents are being managed on behalf
 * of, and is where agent status and proxied agent events are relayed to. It is
 * optional: background jobs (the auto update scheduler) talk to the agents
 * without any browser being connected, and simply have nowhere to relay to.
 */
export class AgentManager {

    protected socket? : DockgeSocket;
    protected agentSocketList : Record<string, SocketClient> = {};
    protected agentLoggedInList : Record<string, boolean> = {};
    protected agentVersionList : Record<string, string> = {};
    protected agentDisconnectCountList : Record<string, number> = {};
    protected _firstConnectTime : Dayjs = dayjs();

    constructor(socket?: DockgeSocket) {
        this.socket = socket;
    }

    get firstConnectTime() : Dayjs {
        return this._firstConnectTime;
    }

    test(url : string, username : string, password : string) : Promise<void> {
        return new Promise((resolve, reject) => {
            // Every one of these has to return: rejecting does not stop the
            // executor, so without it the checks below still ran and a connection
            // was opened - and leaked - for a URL that had already been refused.
            if (url === "") {
                reject(new Error("Invalid Dockge URL"));
                return;
            }

            let endpoint : string;

            try {
                endpoint = new URL(url).host;
            } catch (e) {
                reject(new Error("Invalid Dockge URL"));
                return;
            }

            if (!endpoint) {
                reject(new Error("Invalid Dockge URL"));
                return;
            }

            if (this.agentSocketList[endpoint]) {
                reject(new Error("The Dockge URL already exists"));
                return;
            }

            let client = io(url, {
                reconnection: false,
                extraHeaders: {
                    endpoint,
                }
            });

            client.on("connect", () => {
                client.emit("login", {
                    username: username,
                    password: password,
                }, (res : LooseObject) => {
                    if (res.ok) {
                        resolve();
                    } else {
                        reject(new Error(res.msg));
                    }
                    client.disconnect();
                });
            });

            client.on("connect_error", (err) => {
                if (err.message === "xhr poll error") {
                    reject(new Error("Unable to connect to the Dockge instance"));
                } else {
                    reject(err);
                }
                client.disconnect();
            });
        });
    }

    /**
     *
     * @param url
     * @param username
     * @param password
     * @param name
     */
    async add(url: string, username: string, password: string, name: string): Promise<Agent> {
        let bean = R.dispense("agent") as Agent;
        bean.url = url;
        bean.username = username;
        bean.password = password;
        bean.name = name;
        await R.store(bean);
        return bean;
    }

    /**
     *
     * @param url
     */
    async remove(url : string) {
        let bean = await R.findOne("agent", " url = ? ", [
            url,
        ]);

        if (bean) {
            await R.trash(bean);
            let endpoint = bean.endpoint;
            this.disconnect(endpoint);
            this.sendAgentList();
            delete this.agentSocketList[endpoint];
        } else {
            throw new Error("Agent not found");
        }
    }

    /**
     *
     * @param url
     * @param updatedName
     */
    async update(url: string, updatedName: string) {
        const agent = await R.findOne("agent", " url = ? ", [
            url,
        ]);
        if (agent) {
            agent.name = updatedName;
            await R.store(agent);
        } else if (url === "") {
            // Master has not yet persisted
            let master = R.dispense("agent") as Agent;
            master.url = "";
            master.username = "";
            master.password = "";
            master.name = updatedName;
            await R.store(master);
        } else {
            throw new Error("Agent not found");
        }
    }

    connect(url : string, username : string, password : string) {
        let obj = new URL(url);
        let endpoint = obj.host;

        this.socket?.emit("agentStatus", {
            endpoint: endpoint,
            status: "connecting",
        });

        if (!endpoint) {
            log.error("agent-manager", "Invalid endpoint: " + endpoint + " URL: " + url);
            return;
        }

        if (this.agentSocketList[endpoint]) {
            log.debug("agent-manager", "Already connected to the socket server: " + endpoint);
            return;
        }

        log.info("agent-manager", "Connecting to the socket server: " + endpoint);
        let client = io(url, {
            // An agent may itself be served under a base path, in which case
            // its socket.io lives under that prefix rather than at the root
            path: socketIOPath(basePathFromURL(url)),
            extraHeaders: {
                endpoint,
            }
        });

        client.on("connect", () => {
            log.info("agent-manager", "Connected to the socket server: " + endpoint);

            client.emit("login", {
                username: username,
                password: password,
            }, (res : LooseObject) => {
                if (res.ok) {
                    log.info("agent-manager", "Logged in to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = true;
                    this.socket?.emit("agentStatus", {
                        endpoint: endpoint,
                        status: "online",
                    });
                } else {
                    log.error("agent-manager", "Failed to login to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = false;
                    this.socket?.emit("agentStatus", {
                        endpoint: endpoint,
                        status: "offline",
                    });
                }
            });
        });

        client.on("connect_error", (err) => {
            log.error("agent-manager", "Error from the socket server: " + endpoint);
            this.socket?.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("disconnect", () => {
            log.info("agent-manager", "Disconnected from the socket server: " + endpoint);
            this.agentLoggedInList[endpoint] = false;
            this.agentDisconnectCountList[endpoint] = (this.agentDisconnectCountList[endpoint] ?? 0) + 1;
            this.socket?.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("agent", (...args : unknown[]) => {
            this.socket?.emit("agent", ...args);
        });

        client.on("info", (res) => {
            log.debug("agent-manager", res);

            if (typeof(res?.version) === "string") {
                this.agentVersionList[endpoint] = res.version;
            }

            // Disconnect if the version is lower than 1.4.0
            if (!isDev && semver.satisfies(res.version, "< 1.4.0")) {
                this.socket?.emit("agentStatus", {
                    endpoint: endpoint,
                    status: "offline",
                    msg: `${endpoint}: Unsupported version: ` + res.version,
                });
                client.disconnect();
            }
        });

        this.agentSocketList[endpoint] = client;
    }

    disconnect(endpoint : string) {
        let client = this.agentSocketList[endpoint];
        client?.disconnect();
    }

    /**
     * Wait until an agent is connected and logged in.
     *
     * `emitToEndpoint()` only gives a connection ten seconds to come up, counted
     * from when the manager started connecting, which suits a browser session
     * that is already up. A background job connects and talks to its agents in
     * one go, and it is in no hurry, so it waits here first and can tell the
     * difference between "not ready yet" and "cannot be reached at all".
     * @param endpoint The agent to wait for
     * @param timeoutMs How long to wait before giving up
     * @returns Whether the agent is ready
     */
    async waitUntilReady(endpoint : string, timeoutMs : number) : Promise<boolean> {
        const client = this.agentSocketList[endpoint];

        if (!client) {
            return false;
        }

        const deadline = dayjs().add(timeoutMs, "millisecond");

        for (;;) {
            if (client.connected && this.agentLoggedInList[endpoint]) {
                return true;
            }

            if (dayjs().isAfter(deadline)) {
                return false;
            }

            await sleep(1000);
        }
    }

    /**
     * The Dockge version an agent reported when it connected, if it has yet.
     * @param endpoint The agent
     */
    getAgentVersion(endpoint : string) : string | undefined {
        return this.agentVersionList[endpoint];
    }

    /**
     * How many times the connection to an agent has dropped.
     *
     * Socket.io hands out no acknowledgement across a reconnect, so a caller
     * waiting for one can compare this against what it saw before it asked to
     * find out that the reply it is waiting for is never going to arrive.
     * @param endpoint The agent
     */
    getDisconnectCount(endpoint : string) : number {
        return this.agentDisconnectCountList[endpoint] ?? 0;
    }

    async connectAll() {
        this._firstConnectTime = dayjs();

        if (this.socket?.endpoint) {
            log.info("agent-manager", "This connection is connected as an agent, skip connectAll()");
            return;
        }

        let list : Record<string, Agent> = await Agent.getAgentList();

        if (Object.keys(list).length !== 0) {
            log.info("agent-manager", "Connecting to all instance socket server(s)...");
        }

        for (let url in list) {
            if (url !== "") {
                let agent = list[url];
                this.connect(agent.url, agent.username, agent.password);
            }
        }
    }

    disconnectAll() {
        for (let endpoint in this.agentSocketList) {
            this.disconnect(endpoint);
        }
    }

    async emitToEndpoint(endpoint: string, eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to endpoint: " + endpoint);
        let client = this.agentSocketList[endpoint];

        if (!client) {
            log.error("agent-manager", "Socket client not found for endpoint: " + endpoint);
            throw new Error("Socket client not found for endpoint: " + endpoint);
        }

        if (!client.connected || !this.agentLoggedInList[endpoint]) {
            // Maybe the request is too quick, the socket is not connected yet, check firstConnectTime
            // If it is within 10 seconds, we should apply retry logic here
            let diff = dayjs().diff(this.firstConnectTime, "second");
            log.debug("agent-manager", endpoint + ": diff: " + diff);
            let ok = false;
            while (diff < 10) {
                if (client.connected && this.agentLoggedInList[endpoint]) {
                    log.debug("agent-manager", `${endpoint}: Connected & Logged in`);
                    ok = true;
                    break;
                }
                log.debug("agent-manager", endpoint + ": not ready yet, retrying in 1 second...");
                await sleep(1000);
                diff = dayjs().diff(this.firstConnectTime, "second");
            }

            if (!ok) {
                log.error("agent-manager", `${endpoint}: Socket client not connected`);
                throw new Error("Socket client not connected for endpoint: " + endpoint);
            }
        }

        client.emit("agent", endpoint, eventName, ...args);
    }

    emitToAllEndpoints(eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to all endpoints");
        for (let endpoint in this.agentSocketList) {
            this.emitToEndpoint(endpoint, eventName, ...args).catch((e) => {
                log.warn("agent-manager", e.message);
            });
        }
    }

    async sendAgentList() {
        let list = await Agent.getAgentList();
        let result : Record<string, AgentData> = {};

        // Master
        result[""] = {
            url: "",
            username: "",
            password: "",
            endpoint: "",
            name: "",
        };

        for (let url in list) {
            let agent = list[url];
            result[agent.endpoint] = agent.toJSON();
        }

        this.socket?.emit("agentList", {
            ok: true,
            agentList: result,
        });
    }
}
