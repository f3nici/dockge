import { describe, it, expect } from "vitest";
import { ComposeDocument, setAutoUpdateInYAML } from "../common/compose-document";
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

describe("ComposeDockge x-dockge", () => {
    it("leaves autoUpdate undefined when x-dockge is absent (inherit)", () => {
        const doc = new ComposeDocument(sampleYAML);
        expect(doc.xDockge.autoUpdate).toBe(undefined);
    });

    it("reads auto-update: true", () => {
        const yaml = `x-dockge:
  auto-update: true
services:
  web:
    image: nginx
`;
        const doc = new ComposeDocument(yaml);
        expect(doc.xDockge.autoUpdate).toBe(true);
    });

    it("reads auto-update given as the string \"true\"", () => {
        const yaml = `x-dockge:
  auto-update: "true"
services:
  web:
    image: nginx
`;
        const doc = new ComposeDocument(yaml);
        expect(doc.xDockge.autoUpdate).toBe(true);
    });

    it("reads an explicit auto-update: false as an opt-out", () => {
        const yaml = `x-dockge:
  auto-update: false
services:
  web:
    image: nginx
`;
        const doc = new ComposeDocument(yaml);
        expect(doc.xDockge.autoUpdate).toBe(false);
    });

});

describe("setAutoUpdateInYAML", () => {
    const commentedYAML = `# My stack
x-dockge:
  urls:
    - https://example.com

services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
`;

    it("writes true and false, and reads back what it wrote", () => {
        const enabled = setAutoUpdateInYAML(commentedYAML, true);
        expect(enabled).toContain("auto-update: true");
        expect(new ComposeDocument(enabled).xDockge.autoUpdate).toBe(true);

        const disabled = setAutoUpdateInYAML(enabled, false);
        expect(disabled).toContain("auto-update: false");
        expect(new ComposeDocument(disabled).xDockge.autoUpdate).toBe(false);
    });

    it("adds an x-dockge block when the file has none", () => {
        const yaml = `# My stack
services:
  web:
    image: nginx
`;
        const out = setAutoUpdateInYAML(yaml, true);
        expect(new ComposeDocument(out).xDockge.autoUpdate).toBe(true);
        // The block is appended, so a leading file comment stays at the top
        expect(out.startsWith("# My stack")).toBe(true);
    });

    it("removes the key again on undefined, leaving other x-dockge keys alone", () => {
        const out = setAutoUpdateInYAML(setAutoUpdateInYAML(commentedYAML, true), undefined);

        expect(out).not.toContain("auto-update");
        expect(out).toContain("https://example.com");
        expect(new ComposeDocument(out).xDockge.autoUpdate).toBe(undefined);
    });

    it("removes an x-dockge block that it created itself", () => {
        const yaml = `services:
  web:
    image: nginx
`;
        const out = setAutoUpdateInYAML(setAutoUpdateInYAML(yaml, true), undefined);
        expect(out).not.toContain("x-dockge");
        expect(out).toBe(yaml);
    });

    it("leaves comments, blank lines and quoting untouched", () => {
        const out = setAutoUpdateInYAML(commentedYAML, true);

        expect(out).toContain("# My stack");
        expect(out).toContain("\"8080:80\"");
        expect(out).toContain("\n\nservices:");
        // Round tripping back to "inherit" restores the original file
        expect(setAutoUpdateInYAML(out, undefined)).toBe(commentedYAML);
    });

    it("throws on an unparseable compose file", () => {
        expect(() => setAutoUpdateInYAML("services:\n  web:\n   - :\n  bad\n", true)).toThrow();
    });

    const plainYAML = `services:
  web:
    image: nginx
`;

    it("switching to inherit is a no-op when the file has no x-dockge block", () => {
        expect(setAutoUpdateInYAML(plainYAML, undefined)).toBe(plainYAML);
    });

    it("switching to inherit twice in a row leaves the file alone", () => {
        const inherited = setAutoUpdateInYAML(setAutoUpdateInYAML(plainYAML, true), undefined);
        expect(setAutoUpdateInYAML(inherited, undefined)).toBe(plainYAML);
    });

    it("switching to inherit keeps an x-dockge block that has no auto-update key", () => {
        const yaml = `x-dockge:
  urls:
    - https://example.com
${plainYAML}`;
        expect(setAutoUpdateInYAML(yaml, undefined)).toBe(yaml);
    });

    it("handles an x-dockge block with nothing under it", () => {
        const yaml = `x-dockge:
${plainYAML}`;
        // Nothing to remove
        expect(setAutoUpdateInYAML(yaml, undefined)).toBe(yaml);

        // ...and the empty block becomes a real mapping when a preference is set
        const out = setAutoUpdateInYAML(yaml, true);
        expect(new ComposeDocument(out).xDockge.autoUpdate).toBe(true);
    });

    it("refuses to write into an x-dockge that is not a mapping", () => {
        expect(() => setAutoUpdateInYAML(`x-dockge: nonsense\n${plainYAML}`, true)).toThrow();
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

    it("preserves collection anchors and aliases", () => {
        const yaml = `services:
  first:
    image: my-image:latest
    environment: &env
      - CONFIG_KEY
      - EXAMPLE_KEY
  second:
    image: another-image:latest
    environment: *env
`;
        const out = new ComposeDocument(yaml).toYAML();
        expect(out).toContain("&env");
        expect(out).toContain("*env");
        // The aliased value must not be expanded into a duplicate list
        expect(out.match(/CONFIG_KEY/g)?.length).toBe(1);
    });

    it("preserves scalar anchors and aliases", () => {
        const yaml = `services:
  first:
    image: &img my-image:latest
  second:
    image: *img
`;
        const out = new ComposeDocument(yaml).toYAML();
        expect(out).toContain("&img my-image:latest");
        expect(out).toContain("*img");
    });

    it("keeps the original anchor name instead of renaming it", () => {
        const yaml = `services:
  first:
    image: nginx
    environment: &shared
      - A=1
  second:
    image: redis
    environment: *shared
`;
        const out = new ComposeDocument(yaml).toYAML();
        expect(out).toContain("&shared");
        expect(out).not.toContain("&a1");
    });

    it("preserves merge keys", () => {
        const yaml = `x-common: &common
  restart: unless-stopped
services:
  first:
    image: nginx
    <<: *common
`;
        const out = new ComposeDocument(yaml).toYAML();
        expect(out).toContain("&common");
        expect(out).toContain("<<: *common");
    });
});
