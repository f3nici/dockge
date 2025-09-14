import { BeanModel } from "redbean-node/dist/bean-model";
import { R } from "redbean-node";
import { AgentData } from "../../common/types";

export class Agent extends BeanModel {

    static async getAgentList() : Promise<Record<string, Agent>> {
        let list = await R.findAll("agent") as Agent[];
        let result : Record<string, Agent> = {};
        for (let agent of list) {
            result[agent.url] = agent;
        }
        return result;
    }

    get endpoint() : string {
        if (!!this.url) {
            let obj = new URL(this.url);
            return obj.host;
        } else {
            return "";
        }
    }

    toJSON() : AgentData {
        return {
            url: this.url,
            username: this.username,
            password: "", // password is not published
            endpoint: this.endpoint,
            name: this.name,
        };
    }

}

export default Agent;
