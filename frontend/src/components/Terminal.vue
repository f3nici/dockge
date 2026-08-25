<template>
    <div class="shadow-box">
        <div v-pre ref="terminal" class="main-terminal"></div>
    </div>
</template>

<script>
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_COLS, TERMINAL_ROWS } from "../../../common/util-common";

export default {
    /**
     * @type {Terminal}
     */
    terminal: null,
    components: {

    },
    props: {
        name: {
            type: String,
            require: true,
        },

        endpoint: {
            type: String,
            require: true,
        },

        // Require if mode is interactive
        stackName: {
            type: String,
        },

        // Require if mode is interactive
        serviceName: {
            type: String,
        },

        // Require if mode is interactive
        shell: {
            type: String,
            default: "bash",
        },

        rows: {
            type: Number,
            default: TERMINAL_ROWS,
        },

        cols: {
            type: Number,
            default: TERMINAL_COLS,
        },

        // Mode
        // displayOnly: Only display terminal output
        // mainTerminal: Allow input limited commands and output
        // interactive: Free input and output
        mode: {
            type: String,
            default: "displayOnly",
        }
    },
    emits: [ "has-data" ],
    data() {
        return {
            first: true,
            terminalInputBuffer: "",
            cursorPosition: 0,
        };
    },
    computed: {
        /**
         * Whether the browser is running on macOS, which pastes with Cmd rather
         * than Ctrl. userAgentData is the non-deprecated source but is still
         * Chromium-only, so navigator.platform stays as the fallback.
         *
         * @returns {boolean} true on macOS
         */
        isMac() {
            const platform = navigator.userAgentData?.platform || navigator.platform || "";
            return platform.toLowerCase().includes("mac");
        },
    },
    created() {

    },
    mounted() {
        console.debug("Terminal " + this.name + " mounted");

        let cursorBlink = true;

        if (this.mode === "displayOnly") {
            cursorBlink = false;
        }

        this.terminal = new Terminal({
            fontSize: 14,
            fontFamily: "'JetBrains Mono', monospace",
            cursorBlink,
            cols: this.cols,
            rows: this.rows,
        });

        if (this.mode === "mainTerminal") {
            this.mainTerminalConfig();
        } else if (this.mode === "interactive") {
            this.interactiveTerminalConfig();
        }

        // Ctrl+C copies the selection instead of sending SIGINT, like most
        // terminal emulators. Without a selection it is passed through as usual.
        this.terminal.attachCustomKeyEventHandler(this.handleCustomKeyEvent);

        //this.terminal.loadAddon(new WebLinksAddon());

        // Bind to a div
        this.terminal.open(this.$refs.terminal);

        if (this.mode !== "displayOnly") {
            this.terminal.focus();
        }

        // Add right-click context menu handler for paste
        this.$refs.terminal.addEventListener("contextmenu", this.handleContextMenu);

        // Handle the browser's own paste. Registered on the container during
        // the capture phase so it runs before xterm's handler, which is bound
        // to the helper textarea the event actually targets.
        //
        // Kept on a plain property rather than in data(): it is a DOM node with
        // no business being reactive, and $refs is already cleared by the time
        // unmounted() needs it back.
        this.pasteTarget = this.$refs.terminal;
        this.pasteTarget.addEventListener("paste", this.handleNativePaste, true);

        // Add selection handler for copy to clipboard
        this.terminal.onSelectionChange(() => {
            this.handleSelection();
        });

        // Notify parent component when data is received
        this.terminal.onCursorMove(() => {
            console.debug("onData triggered");
            if (this.first) {
                this.$emit("has-data");
                this.first = false;
            }
        });

        this.bind();

        // Create a new Terminal
        if (this.mode === "mainTerminal") {
            this.$root.emitAgent(this.endpoint, "mainTerminal", this.name, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });  // <- ADD THIS LINE
        } else if (this.mode === "interactive") {
            console.debug("Create Interactive terminal:", this.name);
            this.$root.emitAgent(this.endpoint, "interactiveTerminal", this.stackName, this.serviceName, this.shell, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        }
        // Fit the terminal width to the div container size after terminal is created.
        this.updateTerminalSize();
    },

    unmounted() {
        console.debug("Terminal " + this.name + " unmounted");

        window.removeEventListener("resize", this.onResizeEvent); // Remove the resize event listener from the window object.
        this.pasteTarget?.removeEventListener("paste", this.handleNativePaste, true);
        this.$root.unbindTerminal(this.endpoint, this.name);
        this.terminal.dispose();
    },

    methods: {
        bind(endpoint, name) {
            // Workaround: normally this.name should be set, but it is not sometimes, so we use the parameter, but eventually this.name and name must be the same name
            if (name) {
                //this.$root.unbindTerminal(endpoint, name);
                this.$root.bindTerminal(endpoint, name, this.terminal);
                console.debug("Terminal bound via parameter: " + name);
            } else if (this.name) {
                //this.$root.unbindTerminal(this.endpoint, this.name);
                this.$root.bindTerminal(this.endpoint, this.name, this.terminal);
                console.debug("Terminal bound: " + this.name);
            } else {
                console.debug("Terminal name not set");
            }
        },

        clearTerminal() {
            this.terminal.clear();
            this.terminalInputBuffer = "";
            this.cursorPosition = 0;
        },

        removeInput() {
            const backspaceCount = this.terminalInputBuffer.length;
            const backspaces = "\b \b".repeat(backspaceCount);
            this.cursorPosition = 0;
            this.terminal.write(backspaces);
            this.terminalInputBuffer = "";
        },

        clearCurrentLine() {
            // Move cursor to the beginning of the input and clear it
            const backspaces = "\b".repeat(this.cursorPosition);
            const spaces = " ".repeat(this.terminalInputBuffer.length);
            const moreBackspaces = "\b".repeat(this.terminalInputBuffer.length);
            this.terminal.write(backspaces + spaces + moreBackspaces);
        },

        mainTerminalConfig() {
            // Use onData (not onKey): onKey only fires for events that
            // originate from a real keydown, so input coming from mobile
            // virtual keyboards/IME composition (which xterm.js delivers
            // straight to onData) would otherwise be silently dropped.
            this.terminal.onData(data => {
                const code = data.charCodeAt(0);
                console.debug("Encode: " + JSON.stringify(data));

                if (data === "\r") {
                    // Return if no input
                    if (this.terminalInputBuffer.length === 0) {
                        return;
                    }

                    const buffer = this.terminalInputBuffer;

                    // Remove the input from the terminal
                    this.removeInput();

                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, buffer + data, (err) => {
                        this.$root.toastError(err.msg);
                    });

                } else if (code === 127) { // Backspace
                    if (this.cursorPosition > 0) {
                        // Remove character to the left of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition - 1);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                        this.terminalInputBuffer = beforeCursor + afterCursor;
                        this.cursorPosition--;

                        // Redraw the line
                        this.terminal.write("\b" + afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (data === "\u001B\u005B\u0033\u007E") { // Delete key
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        // Remove character to the right of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition + 1);
                        this.terminalInputBuffer = beforeCursor + afterCursor;

                        // Redraw the line from cursor position
                        this.terminal.write(afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (data === "\u001B\u005B\u0041" || data === "\u001B\u005B\u0042") {      // UP OR DOWN
                    // Do nothing

                } else if (data === "\u001B\u005B\u0043") {      // RIGHT
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        this.terminal.write(this.terminalInputBuffer[this.cursorPosition]);
                        this.cursorPosition++;
                    }
                } else if (data === "\u001B\u005B\u0044") {      // LEFT
                    if (this.cursorPosition > 0) {
                        this.terminal.write("\b");
                        this.cursorPosition--;
                    }
                } else if (data === "\u0003") {      // Ctrl + C
                    console.debug("Ctrl + C");
                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, data);
                    this.removeInput();
                } else {
                    // data may be more than one character (e.g. a mobile
                    // IME/autocomplete committing a whole word at once)
                    const textBeforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                    const textAfterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                    this.terminalInputBuffer = textBeforeCursor + data + textAfterCursor;
                    this.terminal.write(data + textAfterCursor + "\b".repeat(textAfterCursor.length));
                    this.cursorPosition += data.length;
                }
            });
        },

        interactiveTerminalConfig() {
            // Use onData (not onKey): mobile virtual keyboards/IME
            // composition deliver typed text via onData without ever
            // firing a keydown, so onKey alone misses that input.
            this.terminal.onData(data => {
                this.$root.emitAgent(this.endpoint, "terminalInput", this.name, data, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            });
        },

        /**
         * Update the terminal size to fit the container size.
         *
         * If the terminalFitAddOn is not created, creates it, loads it and then fits the terminal to the appropriate size.
         * It then addes an event listener to the window object to listen for resize events and calls the fit method of the terminalFitAddOn.
         */
        updateTerminalSize() {
            if (!Object.hasOwn(this, "terminalFitAddOn")) {
                this.terminalFitAddOn = new FitAddon();
                this.terminal.loadAddon(this.terminalFitAddOn);
                window.addEventListener("resize", this.onResizeEvent);
            }
            this.terminalFitAddOn.fit();
        },
        /**
         * Handles the resize event of the terminal component.
         */
        onResizeEvent() {
            this.terminalFitAddOn.fit();
            let rows = this.terminal.rows;
            let cols = this.terminal.cols;
            this.$root.emitAgent(this.endpoint, "terminalResize", this.name, rows, cols);
        },

        /**
         * Handle clipboard paste operation
         */
        async handlePaste() {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    this.pasteText(text);
                }
            } catch (error) {
                console.error("Failed to read from clipboard:", error);
            }
        },

        /**
         * Handle a paste performed by the browser itself, from Ctrl+V, Cmd+V or
         * the native context menu.
         *
         * This is the only paste path that works over plain HTTP, which is how
         * Dockge is usually reached. navigator.clipboard.readText() is gated on
         * a secure context, but the clipboardData carried by a paste event is
         * not: the read was performed by the browser in response to a real user
         * gesture, so there is nothing for it to withhold.
         *
         * Only mainTerminal is handled here. Everywhere else xterm's own paste
         * handler is left to do the job, because it reads the same clipboardData
         * and then normalises newlines and applies bracketed paste before
         * handing the text to onData - all of which the interactive terminal
         * wants and mainTerminal, with its hand-rolled line buffer, cannot use.
         *
         * @param {ClipboardEvent} event
         */
        handleNativePaste(event) {
            if (this.mode !== "mainTerminal") {
                return;
            }

            // Claim the paste before xterm's own handler sees it, so the text is
            // not delivered twice and mainTerminal keeps ownership of its input
            // buffer. Also stops the text landing in the helper textarea, which
            // preventDefault alone would allow.
            event.preventDefault();
            event.stopPropagation();

            const text = event.clipboardData?.getData("text/plain");

            if (text) {
                this.pasteText(text);
            }
        },

        /**
         * Paste text into the terminal based on current mode
         */
        pasteText(text) {
            if (this.mode === "mainTerminal") {
                // For main terminal, insert text at current cursor position
                const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);

                // Update the buffer with inserted text
                this.terminalInputBuffer = beforeCursor + text + afterCursor;

                // Clear the current line and rewrite it
                this.clearCurrentLine();
                this.terminal.write(this.terminalInputBuffer);

                // Move cursor to the correct position (after the pasted text)
                this.cursorPosition += text.length;
                const backspaces = "\b".repeat(afterCursor.length);
                this.terminal.write(backspaces);

            } else if (this.mode === "interactive") {
                // Hand it to xterm rather than emitting it raw, so it gets the
                // same newline normalisation and bracketed-paste framing as a
                // paste the browser performed itself. Without the framing a
                // multi-line paste is run line by line as it arrives instead of
                // being held for the user to confirm. xterm passes the result
                // to onData, which is what sends it to the server.
                this.terminal.paste(text);
            }
        },

        /**
         * Handle right-click context menu for paste operation
         */
        handleContextMenu(event) {
            // Only handle paste for modes that support input
            if (this.mode !== "mainTerminal" && this.mode !== "interactive") {
                return;
            }

            // Without navigator.clipboard there is nothing to replace the menu
            // with, so suppressing it would only take away the one working way
            // to paste by mouse. Leave it to the browser, whose own Paste item
            // reaches handleNativePaste.
            if (!navigator.clipboard?.readText) {
                return;
            }

            // Prevent default context menu
            event.preventDefault();
            this.handlePaste();
        },

        /**
         * Intercept Ctrl+C when text is selected so it copies instead of
         * interrupting the running command, and get out of the way of the
         * paste shortcuts entirely.
         *
         * Returning false tells xterm.js to swallow the key, so it never
         * reaches onData and no ^C is sent to the process. xterm bails out on
         * that verdict before it calls preventDefault(), so the browser still
         * performs the key's own default action - which is what makes the
         * paste case work: the browser pastes into xterm's focused helper
         * textarea and handleNativePaste picks the text up from the resulting
         * event. Left to xterm, Ctrl+V would instead be encoded as ^V and the
         * default suppressed, so no paste would ever happen.
         *
         * Cmd+C is deliberately not handled here, so on macOS it stays the
         * browser's own copy, which clearing the selection would break.
         *
         * @param {KeyboardEvent} event
         * @returns {boolean} false to swallow the key, true to let xterm handle it
         */
        handleCustomKeyEvent(event) {
            // Only the modifier the platform actually pastes with: this works
            // by letting the browser act on the key, so claiming one it does
            // not treat as paste would swallow it for nothing. On macOS Ctrl+V
            // is page-down, not paste, and Cmd+V is the real shortcut; the
            // other way round everywhere else. Shift is allowed through so
            // Ctrl+Shift+V is covered too, altKey is not, so AltGr+V still
            // types its character on Windows.
            //
            // The cost is that Ctrl+V can no longer send a literal ^V for
            // readline's quoted-insert, but it never could: it was already
            // bound to paste.
            const isPasteShortcut = event.type === "keydown" &&
                !event.altKey &&
                (this.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
                event.key.toLowerCase() === "v";

            if (isPasteShortcut) {
                return false;
            }

            const isCopyShortcut = event.type === "keydown" &&
                event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                event.key.toLowerCase() === "c";

            if (isCopyShortcut && this.terminal.hasSelection()) {
                // Runs inside a real key event, so the execCommand fallback is
                // allowed to kick in on insecure origins. Copy before clearing:
                // clearSelection() also drops the DOM selection the browser's
                // own Ctrl+C would have used, so the copy has to be ours.
                //
                // The clipboard write is asynchronous, so the selection can only
                // be cleared once it has actually resolved. Clearing on the call
                // returning - which is all it used to wait for - threw the
                // selection away even when the write went on to fail, leaving
                // the key press with neither a copy nor a SIGINT to show for it.
                this.copyToClipboard(this.terminal.getSelection(), true).then((copied) => {
                    if (copied) {
                        // The text really is on the clipboard, so the selection
                        // has served its purpose and the next Ctrl+C can send
                        // SIGINT again instead of being swallowed by a stale
                        // selection. If it failed the selection is kept, so the
                        // copy can simply be tried again.
                        this.terminal.clearSelection();
                    }
                });

                // Returned synchronously: xterm needs the verdict now, and the
                // key is swallowed either way so a failed copy never turns into
                // an unintended interrupt.
                return false;
            }

            return true;
        },

        /**
         * Handle text selection in terminal - copy to clipboard
         */
        handleSelection() {
            const selectedText = this.terminal.getSelection();
            if (selectedText && selectedText.length > 0) {
                this.copyToClipboard(selectedText);
            }
        },

        /**
         * Copy text to clipboard
         *
         * navigator.clipboard only exists in a secure context. Dockge is
         * usually reached over plain HTTP on a LAN, where the whole clipboard
         * object is undefined, so this silently did nothing for most users.
         *
         * @param {string} text
         * @param {boolean} allowFallback Set by callers that run inside a real
         * user gesture (Ctrl+C). document.execCommand("copy") still works on
         * insecure origins, but only while the gesture is being handled, and
         * it briefly moves focus, so the copy-on-select path stays out of it.
         * @returns {Promise<boolean>} whether the text reached the clipboard.
         * Resolves only once the write has actually completed, so callers can
         * tell a real copy from one that was merely started.
         */
        async copyToClipboard(text, allowFallback = false) {
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(text);
                    console.debug("Text copied to clipboard");
                    return true;
                } catch (error) {
                    // Denied permission, an unfocused document, a transient
                    // failure. The gesture is over by the time this resolves, so
                    // execCommand is no longer an option either.
                    console.error("Failed to copy to clipboard:", error);
                    return false;
                }
            }

            if (!allowFallback) {
                console.error("Clipboard API unavailable, text not copied");
                return false;
            }

            // Reached without having awaited anything, so this still runs inside
            // the key event and execCommand is allowed to work.
            return this.copyToClipboardFallback(text);
        },

        /**
         * Copy text to clipboard on origins where navigator.clipboard is not
         * available, by selecting the text in a throwaway textarea.
         *
         * @param {string} text
         * @returns {boolean} whether the copy command succeeded
         */
        copyToClipboardFallback(text) {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.setAttribute("readonly", "");
            // Keep it off-screen so the page does not jump when it is focused.
            textarea.style.position = "fixed";
            textarea.style.top = "-9999px";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);

            const previouslyFocused = document.activeElement;
            let copied = false;

            try {
                textarea.select();
                copied = document.execCommand("copy");
            } catch (error) {
                console.error("Failed to copy to clipboard:", error);
            } finally {
                textarea.remove();

                // Focus has to go back to the terminal, otherwise the next
                // keystroke is typed into nothing.
                if (previouslyFocused instanceof HTMLElement) {
                    previouslyFocused.focus();
                }
            }

            return copied;
        },
    }
};
</script>

<style scoped lang="scss">
.main-terminal {
    height: 100%;
}
</style>

<style lang="scss">
.terminal {
    background-color: black !important;
    height: 100%;
}
</style>
