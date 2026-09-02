/**
 * How many past lines stay searchable. Enough to cover the scrollback a log view
 * is worth reading, without holding a whole day of output in memory.
 */
export const MAX_BUFFERED_LINES = 5000;

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/**
 * Drop the escape sequences colouring a line, so a filter matches the text as it
 * is read rather than the bytes behind it.
 * @param line One line of output
 * @returns The same line without escape sequences
 */
export function stripAnsi(line : string) : string {
    return line.replace(ANSI_PATTERN, "");
}

/**
 * Narrows terminal output down to the lines matching what the user typed.
 *
 * Output arrives in chunks that do not line up with lines, so completed lines
 * are kept here: a filter typed after the fact still has something to search,
 * and clearing it puts the whole log back.
 *
 * With no filter set this hands every chunk straight back, escape sequences and
 * all, so an unfiltered terminal behaves exactly as it did before.
 */
export class LogFilter {

    private lines : string[] = [];

    /** The tail of the output that has not reached a newline yet */
    private partial = "";

    private text = "";

    private matches = 0;

    constructor(private readonly maxLines : number = MAX_BUFFERED_LINES) {
    }

    get filter() : string {
        return this.text;
    }

    /** How many lines the current filter is showing */
    get matchingLineCount() : number {
        return this.matches;
    }

    /**
     * Take one chunk of output and say what should be written now.
     * @param data Raw output, which may hold any number of lines and may stop in
     * the middle of one
     * @returns The text to write to the terminal
     */
    write(data : string) : string {
        const completed = this.consume(data);

        for (const line of completed) {
            this.lines.push(line);
        }

        if (this.lines.length > this.maxLines) {
            this.lines.splice(0, this.lines.length - this.maxLines);
        }

        if (!this.text) {
            return data;
        }

        // While filtering, only whole lines are shown: a line still being
        // written waits for its newline rather than appearing and then turning
        // out not to match
        const shown = completed.filter(line => this.matchesLine(line));
        this.matches += shown.length;

        return shown.map(line => line + "\r\n").join("");
    }

    /**
     * Change the filter.
     * @param text What to filter by, or "" for everything
     * @returns The whole output to redraw the terminal with
     */
    setFilter(text : string) : string {
        this.text = text;
        return this.redraw();
    }

    /**
     * The output as the current filter has it: every buffered line when the
     * filter is empty, only the matching ones otherwise.
     * @returns The whole output to redraw the terminal with
     */
    redraw() : string {
        const shown = this.text ? this.lines.filter(line => this.matchesLine(line)) : this.lines;
        this.matches = shown.length;

        let out = shown.length > 0 ? shown.join("\r\n") + "\r\n" : "";

        // A half-written line is only meaningful when everything is shown
        if (!this.text && this.partial) {
            out += this.partial;
        }

        return out;
    }

    /** Forget everything received so far */
    clear() {
        this.lines = [];
        this.partial = "";
        this.matches = 0;
    }

    /**
     * Split a chunk into whole lines, holding on to a trailing partial line
     * until the rest of it arrives.
     * @param data Raw output
     * @returns The lines completed by this chunk
     */
    private consume(data : string) : string[] {
        const parts = (this.partial + data).split("\n");
        this.partial = parts.pop() ?? "";
        return parts.map(line => line.replace(/\r$/, ""));
    }

    /**
     * Whether a line should be shown under the current filter. The comparison
     * ignores case and any colours around the text.
     * @param line One line of output
     * @returns true when the line matches
     */
    private matchesLine(line : string) : boolean {
        return stripAnsi(line).toLowerCase().includes(this.text.toLowerCase());
    }
}
