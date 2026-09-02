import { describe, it, expect } from "vitest";
import {
    basePathFromBaseURI,
    basePathHref,
    injectBaseHref,
    normalizeBasePath,
    socketIOPath,
} from "../common/base-path";

describe("normalizeBasePath", () => {
    it("treats nothing configured as the root", () => {
        expect(normalizeBasePath(undefined)).toBe("");
        expect(normalizeBasePath(null)).toBe("");
        expect(normalizeBasePath("")).toBe("");
        expect(normalizeBasePath("   ")).toBe("");
        expect(normalizeBasePath("/")).toBe("");
    });

    it("adds the leading slash", () => {
        expect(normalizeBasePath("dockge")).toBe("/dockge");
    });

    it("drops a trailing slash", () => {
        expect(normalizeBasePath("/dockge/")).toBe("/dockge");
    });

    it("keeps a nested path", () => {
        expect(normalizeBasePath("/apps/dockge")).toBe("/apps/dockge");
    });

    it("collapses repeated slashes", () => {
        expect(normalizeBasePath("//apps//dockge//")).toBe("/apps/dockge");
    });

    it("ignores surrounding whitespace", () => {
        expect(normalizeBasePath("  /dockge  ")).toBe("/dockge");
    });
});

describe("basePathHref", () => {
    it("is a bare slash at the root", () => {
        expect(basePathHref("")).toBe("/");
    });

    it("always ends in a slash, so relative URLs resolve inside it", () => {
        expect(basePathHref("/dockge")).toBe("/dockge/");
    });
});

describe("socketIOPath", () => {
    it("is the default at the root", () => {
        expect(socketIOPath("")).toBe("/socket.io");
    });

    it("sits under the base path otherwise", () => {
        expect(socketIOPath("/dockge")).toBe("/dockge/socket.io");
    });
});

describe("injectBaseHref", () => {
    const html = "<!doctype html><html><head><title>Dockge</title></head><body></body></html>";

    it("puts the tag at the top of the head", () => {
        expect(injectBaseHref(html, "/dockge")).toContain("<head><base href=\"/dockge/\"><title>");
    });

    it("writes one at the root too", () => {
        // The assets are relative, so a route like /stack/foo would otherwise
        // look for them under /stack/
        expect(injectBaseHref(html, "")).toContain("<base href=\"/\">");
    });

    it("replaces a tag that is already there rather than adding another", () => {
        const once = injectBaseHref(html, "/first");
        const twice = injectBaseHref(once, "/second");

        expect(twice).toContain("<base href=\"/second/\">");
        expect(twice).not.toContain("/first/");
        expect(twice.match(/<base /g)?.length).toBe(1);
    });

    it("copes with attributes on the head tag", () => {
        expect(injectBaseHref("<head lang=\"en\"><title>x</title></head>", "/dockge"))
            .toContain("<head lang=\"en\"><base href=\"/dockge/\">");
    });

    it("still produces the tag when there is no head at all", () => {
        expect(injectBaseHref("<p>hi</p>", "/dockge")).toBe("<base href=\"/dockge/\"><p>hi</p>");
    });
});

describe("basePathFromBaseURI", () => {
    it("reads the path back out of a base URI", () => {
        expect(basePathFromBaseURI("https://example.com/dockge/")).toBe("/dockge");
    });

    it("is empty at the root", () => {
        expect(basePathFromBaseURI("https://example.com/")).toBe("");
    });

    it("survives something that is not a URL", () => {
        expect(basePathFromBaseURI("not a url")).toBe("");
    });

    it("round-trips what the server wrote", () => {
        const basePath = normalizeBasePath("/apps/dockge/");
        expect(basePathFromBaseURI("https://example.com" + basePathHref(basePath))).toBe(basePath);
    });
});
