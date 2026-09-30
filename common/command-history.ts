/**
 * How many commands are remembered per console. Plenty to scroll back through
 * with the arrow keys, without growing for as long as the tab stays open.
 */
export const MAX_HISTORY_ENTRIES = 100;

/**
 * The commands run in a console, for stepping back through with Up and Down.
 *
 * The main console edits its line locally and only sends it once Enter is
 * pressed, so the shell's own history never sees the arrow keys: this is what
 * stands in for it.
 *
 * Like a shell, whatever was being typed before Up was first pressed is kept,
 * and Down past the newest command brings it back.
 */
export class CommandHistory {
    private entries : string[] = [];

    /**
     * Where Up and Down have got to. entries.length means "not in the history",
     * i.e. on the line being typed.
     */
    private position = 0;

    /** The line being typed when the history was first stepped into */
    private draft = "";

    /**
     * Remember a command that was just run, and go back to a fresh line.
     *
     * Blank commands and a repeat of the one before are not stored, the same
     * as bash with ignoredups: neither is worth an extra press of Up.
     * @param command The command as it was sent
     */
    add(command : string) : void {
        if (command.trim() !== "" && this.entries[this.entries.length - 1] !== command) {
            this.entries.push(command);

            if (this.entries.length > MAX_HISTORY_ENTRIES) {
                this.entries.splice(0, this.entries.length - MAX_HISTORY_ENTRIES);
            }
        }

        this.reset();
    }

    /**
     * Step back to the command before the current one.
     * @param current What is on the line right now, kept if it is a new line
     * @returns The command to show, or undefined when there is nothing older
     */
    previous(current : string) : string | undefined {
        if (this.position === 0) {
            return undefined;
        }

        if (this.position === this.entries.length) {
            this.draft = current;
        }

        this.position--;
        return this.entries[this.position];
    }

    /**
     * Step forward to the command after the current one.
     * @returns The command to show - the line that was being typed once past
     * the newest one - or undefined when not in the history at all
     */
    next() : string | undefined {
        if (this.position >= this.entries.length) {
            return undefined;
        }

        this.position++;

        if (this.position === this.entries.length) {
            return this.draft;
        }

        return this.entries[this.position];
    }

    /**
     * Leave the history and go back to a new line, e.g. once it was cleared
     * with Ctrl+C.
     */
    reset() : void {
        this.position = this.entries.length;
        this.draft = "";
    }
}
