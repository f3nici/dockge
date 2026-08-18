/**
 * A very small markdown subset parser, just enough to render GitHub release
 * notes in the "new version available" dialog.
 *
 * This deliberately is not a general markdown implementation. It covers what
 * release notes actually use - headings, bullet lists, bold, inline code and
 * links - and lets anything else through as plain text.
 *
 * The output is a block/span tree rather than an HTML string, so the dialog can
 * render it with ordinary Vue templates. Nothing ever reaches `v-html`, which
 * keeps a release body from injecting markup into the page.
 */

export type InlineSpan =
    | { type: "text", text: string }
    | { type: "strong", text: string }
    | { type: "code", text: string }
    | { type: "link", text: string, href: string };

export type NotesBlock =
    | { type: "heading", level: number, spans: InlineSpan[] }
    | { type: "paragraph", spans: InlineSpan[] }
    | { type: "list", items: InlineSpan[][] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Matches, in priority order: inline code, a markdown link, bold text, and a
 * bare URL. Only http(s) links are recognised, so a `javascript:` URL can never
 * become an href.
 */
const INLINE_RE = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|(https?:\/\/[^\s<>()[\]]+)/g;

/**
 * Split one line of markdown into inline spans.
 * @param line The line to parse
 * @returns The spans making up the line, in order
 */
export function parseInline(line : string) : InlineSpan[] {
    const spans : InlineSpan[] = [];
    let lastIndex = 0;

    // A fresh regex state per call: INLINE_RE is global and therefore stateful.
    INLINE_RE.lastIndex = 0;

    let match = INLINE_RE.exec(line);
    while (match !== null) {
        if (match.index > lastIndex) {
            spans.push({
                type: "text",
                text: line.slice(lastIndex, match.index),
            });
        }

        const [ , code, linkText, linkHref, strong, bareUrl ] = match;

        if (code !== undefined) {
            spans.push({
                type: "code",
                text: code,
            });
        } else if (linkText !== undefined && linkHref !== undefined) {
            spans.push({
                type: "link",
                text: linkText,
                href: linkHref,
            });
        } else if (strong !== undefined) {
            spans.push({
                type: "strong",
                text: strong,
            });
        } else if (bareUrl !== undefined) {
            spans.push({
                type: "link",
                text: bareUrl,
                href: bareUrl,
            });
        }

        lastIndex = match.index + match[0].length;
        match = INLINE_RE.exec(line);
    }

    if (lastIndex < line.length) {
        spans.push({
            type: "text",
            text: line.slice(lastIndex),
        });
    }

    return spans;
}

/**
 * Parse release notes into renderable blocks.
 *
 * Consecutive bullets are gathered into a single list. Every other non-blank
 * line becomes its own paragraph, which matches how GitHub renders release
 * notes: a single newline there is a line break, not a paragraph continuation.
 * @param markdown The raw release body
 * @returns The blocks to render, in order
 */
export function parseReleaseNotes(markdown : string) : NotesBlock[] {
    if (!markdown) {
        return [];
    }

    const blocks : NotesBlock[] = [];
    // Anything HTML stays as literal text, but hidden comments are noise.
    const lines = markdown.replace(HTML_COMMENT_RE, "").split(/\r?\n/);

    // The list currently being accumulated, if the previous line was a bullet.
    let openList : InlineSpan[][] | undefined;

    const closeList = () => {
        if (openList) {
            blocks.push({
                type: "list",
                items: openList,
            });
            openList = undefined;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        if (!line.trim()) {
            closeList();
            continue;
        }

        const listMatch = line.match(LIST_ITEM_RE);
        if (listMatch) {
            openList = openList ?? [];
            openList.push(parseInline(listMatch[1]));
            continue;
        }

        closeList();

        const headingMatch = line.match(HEADING_RE);
        if (headingMatch) {
            blocks.push({
                type: "heading",
                level: headingMatch[1].length,
                spans: parseInline(headingMatch[2]),
            });
            continue;
        }

        blocks.push({
            type: "paragraph",
            spans: parseInline(line),
        });
    }

    closeList();

    return blocks;
}
