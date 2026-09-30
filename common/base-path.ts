/**
 * Serving Dockge from somewhere other than the root of a domain.
 *
 * Everything the browser loads has to be found under that prefix: the built
 * assets, the socket.io endpoint, and the routes vue-router puts in the address
 * bar. The frontend is built once and cannot know the prefix, so the assets are
 * emitted as relative URLs and the server writes a <base> tag into index.html
 * saying what to resolve them against.
 */

/**
 * Bring a configured base path to one shape: either empty, meaning Dockge is
 * served from the root, or a single leading slash with no trailing one.
 * @param value Whatever the user configured, if anything
 * @returns The normalised base path
 */
export function normalizeBasePath(value? : string | null) : string {
    const trimmed = (value ?? "").trim();

    if (trimmed === "") {
        return "";
    }

    // Collapse repeated slashes and drop the ones on either end, then put a
    // single leading one back: "//dockge/ui//" becomes "/dockge/ui".
    //
    // Anything outside the characters a path segment is normally written with
    // is dropped as it goes: this ends up inside an HTML attribute and a
    // socket.io path, and neither is a place to be passing through a stray
    // quote or angle bracket.
    const segments = trimmed
        .split("/")
        .map(segment => segment.replace(/[^A-Za-z0-9._~%-]/g, ""))
        .filter(segment => segment !== "");

    if (segments.length === 0) {
        return "";
    }

    return "/" + segments.join("/");
}

/**
 * The base path as an href, which always ends in a slash so that relative URLs
 * resolve inside it rather than beside it.
 * @param basePath A normalised base path
 * @returns The href for a <base> tag
 */
export function basePathHref(basePath : string) : string {
    return basePath === "" ? "/" : basePath + "/";
}

/**
 * Where socket.io is served from under this base path.
 * @param basePath A normalised base path
 * @returns The socket.io path for both the server and the client
 */
export function socketIOPath(basePath : string) : string {
    return basePath + "/socket.io";
}

/**
 * Write the base path into the index.html the server hands out.
 *
 * Always written, even at the root: the assets are built as relative URLs, so
 * without it a route like /stack/foo would look for them under /stack/.
 * @param html The built index.html
 * @param basePath A normalised base path
 * @returns index.html with a base tag at the top of its head
 */
export function injectBaseHref(html : string, basePath : string) : string {
    // normalizeBasePath has already taken out everything that would matter here,
    // but this is what actually goes into the page, so it escapes too
    const href = basePathHref(basePath)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const tag = `<base href="${href}">`;

    // Replaced rather than added to, so restarting with a different base path
    // does not leave the previous one behind
    if (/<base\s[^>]*>/i.test(html)) {
        return html.replace(/<base\s[^>]*>/i, tag);
    }

    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, (head) => head + tag);
    }

    // No head to put it in, which should not happen with a built index.html
    return tag + html;
}

/**
 * The base path a URL points into: the page's own, from document.baseURI, or an
 * agent's, from the address it was added under.
 * @param url An absolute URL
 * @returns The normalised base path
 */
export function basePathFromURL(url : string) : string {
    try {
        return normalizeBasePath(new URL(url).pathname);
    } catch (e) {
        return "";
    }
}
