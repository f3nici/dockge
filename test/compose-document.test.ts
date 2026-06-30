import { describe, it, expect } from "vitest";
import { ComposeDocument } from "../common/compose-document";
import { LABEL_STATUS_IGNORE } from "../common/compose-labels";

const sampleYAML = `services:
  web:
    image: nginx:1.25
    container_name: my-web
    restart: unless-stopped
    ports:
      - "8080:80"
    networks:
      - frontend
    labels:
      - dockge.status.ignore=true
  db:
    image: postgres
networks:
  frontend:
    external: true
`;

describe("ComposeDocument parsing", () => {
    it("creates an empty document when given no input", () => {
        const doc = new ComposeDocument();
        expect(doc.services.names).toEqual([]);
        expect(doc.toYAML().trim()).toBe("{}");
    });

    it("lists the parsed services", () => {
        const doc = new ComposeDocument(sampleYAML);
        expect(doc.services.names.sort()).toEqual([ "db", "web" ]);
    });

    it("ensures a services map exists even when omitted", () => {
        const doc = new ComposeDocument("networks:\n  default: {}\n");
        expect(doc.services.names).toEqual([]);
    });

    it("throws when services is not an object", () => {
        expect(() => new ComposeDocument("services:\n  - a\n  - b\n")).toThrow();
    });

    it("throws on invalid YAML", () => {
        expect(() => new ComposeDocument("services:\n  web:\n   - : :\n")).toThrow();
    });
});

describe("ComposeService", () => {
    it("reads image name and tag", () => {
        const doc = new ComposeDocument(sampleYAML);
        const web = doc.services.getService("web");
        expect(web.image).toBe("nginx:1.25");
        expect(web.imageName).toBe("nginx");
        expect(web.imageTag).toBe("1.25");
    });

    it("defaults the tag to latest when omitted", () => {
        const doc = new ComposeDocument(sampleYAML);
        const db = doc.services.getService("db");
        expect(db.imageName).toBe("postgres");
        expect(db.imageTag).toBe("latest");
    });

    it("reads container name and restart policy", () => {
        const doc = new ComposeDocument(sampleYAML);
        const web = doc.services.getService("web");
        expect(web.containerName).toBe("my-web");
        expect(web.restart).toBe("unless-stopped");
    });

    it("exposes ports as a compose array", () => {
        const doc = new ComposeDocument(sampleYAML);
        const web = doc.services.getService("web");
        expect(web.ports.values).toEqual([ "8080:80" ]);
    });

    it("allows setting the image and writes it back to YAML", () => {
        const doc = new ComposeDocument(sampleYAML);
        const web = doc.services.getService("web");
        web.image = "nginx:1.27";
        expect(doc.toYAML()).toContain("nginx:1.27");
    });
});

describe("ComposeNetwork", () => {
    it("reads an external network flag", () => {
        const doc = new ComposeDocument(sampleYAML);
        const frontend = doc.networks.getNetwork("frontend");
        expect(frontend.external).toBe(true);
    });

    it("can toggle the external flag off", () => {
        const doc = new ComposeDocument(sampleYAML);
        const frontend = doc.networks.getNetwork("frontend");
        frontend.external = false;
        expect(doc.networks.getNetwork("frontend").external).toBe(false);
    });
});

describe("ComposeLabels", () => {
    it("reads labels defined as an array", () => {
        const doc = new ComposeDocument(sampleYAML);
        const labels = doc.services.getService("web").labels;
        expect(labels.isArray).toBe(true);
        expect(labels.isTrue(LABEL_STATUS_IGNORE)).toBe(true);
        expect(labels.get(LABEL_STATUS_IGNORE)).toBe("true");
    });

    it("reads labels defined as a map", () => {
        const yaml = `services:
  web:
    image: nginx
    labels:
      dockge.status.ignore: "false"
`;
        const doc = new ComposeDocument(yaml);
        const labels = doc.services.getService("web").labels;
        expect(labels.isArray).toBe(false);
        expect(labels.isFalse(LABEL_STATUS_IGNORE)).toBe(true);
        expect(labels.isSet(LABEL_STATUS_IGNORE)).toBe(true);
    });

    it("can set and delete a label", () => {
        const doc = new ComposeDocument(sampleYAML);
        const labels = doc.services.getService("web").labels;
        labels.set("custom.label", "hello");
        expect(labels.get("custom.label")).toBe("hello");
        labels.delete("custom.label");
        expect(labels.isSet("custom.label")).toBe(false);
    });
});

describe("environment variable substitution", () => {
    it("substitutes variables from the env file in envsubst data", () => {
        const yaml = `services:
  web:
    image: nginx:\${TAG}
`;
        const env = "TAG=1.27";
        const doc = new ComposeDocument(yaml, env);
        // Raw data keeps the template, envsubst data is resolved
        expect(doc.services.getService("web").get("image")).toBe("nginx:${TAG}");
        expect(doc.services.getService("web").image).toBe("nginx:1.27");
    });
});

describe("toYAML", () => {
    it("preserves comments through a round trip", () => {
        const yaml = `# top level comment
services:
  web:
    image: nginx
`;
        const doc = new ComposeDocument(yaml);
        expect(doc.toYAML()).toContain("# top level comment");
    });
});
