import { describe, it, expect } from "vitest";
import { DockerArtefactAction, DockerArtefactInfos, getDockerArtefactInfo } from "../common/types";

describe("getDockerArtefactInfo", () => {
    it("resolves the four artefact kinds by their wire name", () => {
        for (const info of Object.values(DockerArtefactInfos)) {
            expect(getDockerArtefactInfo(info.name)).toBe(info);
        }
    });

    it("does not resolve the capitalised map keys", () => {
        // The keys are Container/Image/..., the wire uses container/image/...
        // Indexing the map by the incoming name always missed.
        expect(getDockerArtefactInfo("Container")).toBeUndefined();
    });

    it("refuses docker subcommands that are not artefact kinds", () => {
        // These end up as "docker <artefact> rm/prune", so anything outside the
        // known set has to be turned away.
        for (const name of [ "builder", "context", "config", "secret", "plugin", "system" ]) {
            expect(getDockerArtefactInfo(name)).toBeUndefined();
        }
    });

    it("refuses values that are not strings", () => {
        expect(getDockerArtefactInfo(undefined)).toBeUndefined();
        expect(getDockerArtefactInfo(null)).toBeUndefined();
        expect(getDockerArtefactInfo(42)).toBeUndefined();
        expect(getDockerArtefactInfo({ name: "image" })).toBeUndefined();
    });

    it("reports which actions each kind allows", () => {
        expect(getDockerArtefactInfo("image")?.actions).toContain(DockerArtefactAction.Pull);
        // Pulling a container or a network is not a thing
        expect(getDockerArtefactInfo("container")?.actions).not.toContain(DockerArtefactAction.Pull);
        expect(getDockerArtefactInfo("network")?.actions).not.toContain(DockerArtefactAction.Pull);
    });
});
