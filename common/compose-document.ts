/* eslint-disable @typescript-eslint/no-explicit-any */
import { Alias, Document, isAlias, isMap, isScalar, isSeq, Node, Pair, parseDocument, Scalar, ScalarTag, Tags } from "yaml";
import dotenv, { DotenvParseOutput } from "dotenv";
import { LooseObject } from "./util-common";
// @ts-ignore
import { replaceVariablesSync } from "@inventage/envsubst";

function convertToBoolean(value: any, fallbackVal: boolean | undefined = undefined): boolean | undefined {
    if (value === true || value === "true") {
        return true;
    }

    if (value === false || value === "false") {
        return false;
    }

    return fallbackVal;
}

export type ComposeData = {
    data: any,
    envsubstData: any
}

export const X_DOCKGE = "x-dockge";

/**
 * The format marker put on integers written with a leading zero.
 *
 * `yaml` implements the YAML 1.2 core schema, in which a plain integer with a
 * leading zero (`0755`, `0644`) is read as decimal and, crucially, written back
 * out from the parsed number: `mode: 0755` becomes `mode: 755`. Docker compose
 * reads the same token as octal, so that rewrite silently changes the value, and
 * every compose file we write back is one the user maintains by hand.
 */
const LEGACY_LEADING_ZERO_FORMAT = "LEGACY_LEADING_ZERO";

/**
 * Claims exactly the integers above and stringifies them from the text they were
 * parsed from, so they survive a round trip byte for byte. `resolve` matches the
 * built-in decimal tag, so nothing reading the parsed document sees a different
 * value than it did before.
 */
const legacyLeadingZeroInt: ScalarTag = {
    // Has to claim numbers: the stringifier only considers tags whose identify()
    // accepts the value, and without this it falls back to the built-in int tag,
    // which writes the parsed number and drops the original text
    identify: (value: unknown) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: LEGACY_LEADING_ZERO_FORMAT,
    // A strict subset of the built-in decimal int test, /^[-+]?[0-9]+$/, so this
    // only ever claims tokens that tag would have claimed (and mangled) anyway
    test: /^[-+]?0[0-9]+$/,
    resolve: (str: string) => parseInt(str, 10),
    stringify: (item: Scalar) => typeof item.source === "string" ? item.source : String(item.value),
};

/**
 * Every parseDocument() and Document in this module has to be given these, or a
 * value parsed with the tag above is stringified without it and mangled anyway.
 */
const YAML_OPTIONS = {
    customTags: (tags: Tags): Tags => [ legacyLeadingZeroInt, ...tags ],
};

export class ComposeDocument {

    public readonly composeData: ComposeData;
    protected doc: Document;

    constructor(composeYAML?: string, composeENV?: string) {
        if (composeYAML) {
            const mainDoc = this.parseYAML(composeYAML);

            const envsubstData = composeENV ? this.parseYAML(envsubstYAML(composeYAML, dotenv.parse(composeENV))).data : mainDoc.data;

            this.doc = mainDoc.doc;
            this.composeData = {
                data: mainDoc.data,
                envsubstData
            };
        } else {
            this.composeData = {
                data: {},
                envsubstData: {}
            };
            this.doc = new Document();
        }
    }

    private parseYAML(yaml: string) {
        const doc = parseDocument(yaml, YAML_OPTIONS);
        if (doc.errors.length > 0) {
            throw doc.errors[0];
        }

        const data = doc.toJS() ?? {};

        // "services" must be an object
        if (!data.services) {
            data.services = {};
        }
        if (Array.isArray(data.services) || typeof data.services !== "object") {
            throw new Error("Services must be an object");
        }

        return {
            data,
            doc
        };
    }

    get networks(): ComposeNetworks {
        return new ComposeNetworks(this.composeData);
    }

    get services(): ComposeServices {
        return new ComposeServices(this.composeData);
    }

    get xDockge(): ComposeDockge {
        return new ComposeDockge(this.composeData);
    }

    toYAML(): string {
        // Build a fresh document from the (possibly edited) data. Disable automatic
        // anchoring of duplicate objects so the only anchors/aliases in the output are
        // the ones the user actually wrote, which we restore below from the original
        // document. Without this, toJS() flattens anchors (scalars lose them entirely)
        // and the rebuilt document either drops them or renames them to "a1", "a2"...
        const doc = new Document(this.composeData.data, { aliasDuplicateObjects: false,
            ...YAML_OPTIONS });

        // Stick back the yaml comments
        copyYAMLComments(doc, this.doc);

        // Restore the original YAML anchors and aliases (e.g. &env / *env)
        restoreYAMLAnchors(doc, this.doc);

        // Restore integers written with a leading zero, which are only numbers by
        // the time they reach composeData and would be rebuilt without the zero
        restoreYAMLScalarSources(doc, this.doc);

        return doc.toString();
    }
}

/** The key compose files reuse a shared block under: `<<: *common` */
const MERGE_KEY = "<<";

/**
 * Read a key off a map, falling back to the blocks it merges in.
 *
 * The document is deliberately parsed without resolving merge keys, so that
 * writing it back out keeps saying `<<: *common` instead of copying the shared
 * block under every service that referenced it. That leaves the inherited
 * values to be found here, when they are read.
 * @param data The map to read from
 * @param key The key to look for
 * @returns The value, the inherited one, or undefined
 */
function getWithInherited(data: any, key: string): any {
    if (!data || typeof data !== "object") {
        return undefined;
    }

    // What the map says itself wins, which is also where an edit is written
    if (data[key] !== undefined) {
        return data[key];
    }

    const merged = data[MERGE_KEY];

    if (!merged) {
        return undefined;
    }

    // "<<" takes either one block or a list of them, the earlier winning
    for (const source of Array.isArray(merged) ? merged : [ merged ]) {
        if (source && typeof source === "object" && source[key] !== undefined) {
            return source[key];
        }
    }

    return undefined;
}

export abstract class ComposeNode {
    public readonly composeData: ComposeData;

    protected valid = true;

    constructor(public name: string, protected baseComposeData: ComposeData, protected parentNode?: ComposeNode) {
        this.composeData = {
            data: this.check(baseComposeData.data[name]),
            envsubstData: this.check(baseComposeData.envsubstData[name])
        };
    }

    private check(data: any) {
        if (data) {
            if (this.checkType(data)) {
                return data;
            } else {
                this.valid = false;
                return this.createData();
            }
        } else {
            return this.createData();
        }
    }

    protected abstract checkType(data: any): boolean;

    protected abstract createData(): any;

    abstract isEmpty(): boolean;

    isValid(): boolean {
        return this.valid;
    }

    get exists() {
        return this.name in this.baseComposeData.data;
    }

    replace(data: any) {
        if (this.checkType(data)) {
            this.prepareWrite();
            this.composeData.data = data;
            this.baseComposeData.data[this.name] = data;
        } else {
            throw new Error("Invalid type '" + (typeof data) + "' for '" + this.constructor.name + "'");
        }
    }

    prepareWrite() {
        if (this.parentNode) {
            this.parentNode.prepareWrite();
        }

        let nodeData = this.baseComposeData.data[this.name];
        if (!nodeData) {
            this.baseComposeData.data[this.name] = this.composeData.data;
        }
    }

    removeIfEmpty() {
        if (this.isEmpty() && this.exists) {
            delete this.baseComposeData.data[this.name];
        }
    }
}

export class ComposeMap extends ComposeNode {

    constructor(public name: string, protected baseComposeData: ComposeData, protected parentNode?: ComposeNode) {
        super(name, baseComposeData, parentNode);
    }

    protected checkType(data: any): boolean {
        return typeof data === "object";
    }

    protected createData(): any {
        return {};
    }

    isEmpty(): boolean {
        return this.names.length === 0;
    }

    get names() {
        return Object.keys(this.composeData.data);
    }

    entries<T = any>(mapFct: (key: any) => T = (key => this.get(key))): Record<string, T> {
        return this.names.reduce<Record<string, T>>(
            (acc, name) => {
                acc[name] = mapFct(name);
                return acc;
            },
            {} as Record<string, T>
        );
    }

    has(name: string) {
        return !!this.composeData.data[name];
    }

    get(name: string, defaultVal: any = undefined, envsubst: boolean = false): any {
        const val = getWithInherited(envsubst ? this.composeData.envsubstData : this.composeData.data, name);
        return val !== undefined ? val : defaultVal;
    }

    getComposeArray(name: string) {
        return new ComposeArray(name, this.composeData, this);
    }

    getComposeMap(name: string) {
        return new ComposeMap(name, this.composeData, this);
    }

    set(name: string, value: any) {
        this.prepareWrite();
        this.composeData.data[name] = value;
    }

    delete(name: string) {
        if (name in this.composeData.data) {
            delete this.composeData.data[name];
        }
    }
}

export class ComposeArray extends ComposeNode {
    constructor(public name: string, protected baseComposeData: ComposeData, protected parentNode?: ComposeNode) {
        super(name, baseComposeData, parentNode);
    }

    protected checkType(data: any): boolean {
        return Array.isArray(data);
    }

    protected createData(): any {
        return [];
    }

    isEmpty(): boolean {
        return this.composeData.data.length === 0;
    }

    containsObjects(): boolean {
        for (const item of this.values) {
            if (typeof item === "object") {
                return true;
            }
        }
        return false;
    }

    get values(): any[] {
        return this.composeData.envsubstData;
    }

    set values(values: any[]) {
        this.replace(values);
    }

    add(value: any) {
        this.prepareWrite();
        this.composeData.data.push(value);
    }

    delete(index: number) {
        this.prepareWrite();
        this.composeData.data.splice(index, 1);
    }
}

export class ComposeNetworks extends ComposeMap {

    constructor(protected baseComposeData: ComposeData) {
        super("networks", baseComposeData);
    }

    getNetwork(name: string): ComposeNetwork {
        return new ComposeNetwork(name, this);
    }

    getNetworks(): Record<string, ComposeNetwork> {
        return this.entries((name: string) => this.getNetwork(name));
    }
}

export class ComposeNetwork extends ComposeMap {

    constructor(public name: string, protected networks: ComposeNetworks) {
        super(name, networks.composeData, networks);
    }

    get external(): boolean {
        return convertToBoolean(this.composeData.data.external, false) as boolean;
    }

    set external(set: boolean) {
        this.prepareWrite();
        if (set) {
            this.composeData.data.external = true;
        } else {
            delete this.composeData.data.external;
        }
    }
}

export class ComposeServices extends ComposeMap {

    constructor(protected baseComposeData: ComposeData) {
        super("services", baseComposeData);
    }

    getService(name: string): ComposeService {
        return new ComposeService(name, this);
    }

    getServices(): Record<string, ComposeService> {
        return this.entries((name: string) => this.getService(name));
    }
}

export class ComposeService extends ComposeMap {

    constructor(public name: string, protected services: ComposeServices) {
        super(name, services.composeData, services);
    }

    get networks() : ComposeArray {
        return this.getComposeArray("networks");
    }

    get ports(): ComposeArray {
        return this.getComposeArray("ports");
    }

    get volumes(): ComposeArray {
        return this.getComposeArray("volumes");
    }

    get environment(): ComposeArray {
        return this.getComposeArray("environment");
    }

    get dependsOn(): ComposeArray {
        return this.getComposeArray("depends_on");
    }

    get image(): string {
        return getWithInherited(this.composeData.envsubstData, "image");
    }

    set image(image: string) {
        this.set("image", image);
    }

    get imageName(): string {
        if (this.image) {
            return this.image.split(":")[0];
        } else {
            return "";
        }
    }

    get imageTag(): string {
        if (this.image) {
            let tag = this.image.split(":")[1];
            return tag ? tag : "latest";
        } else {
            return "";
        }
    }

    get containerName(): string {
        return this.get("container_name");
    }

    set containerName(name: string) {
        this.set("container_name", name);
    }

    get restart(): string {
        return this.get("restart", "");
    }

    set restart(value: string) {
        this.set("restart", value);
    }

    get labels(): ComposeLabels {
        return new ComposeLabels(this.composeData, this);
    }
}

export const AUTO_UPDATE_KEY = "auto-update";

export const NOTES_KEY = "notes";

export class ComposeDockge extends ComposeMap {

    constructor(protected baseComposeData: ComposeData) {
        super(X_DOCKGE, baseComposeData);
    }

    get urls(): ComposeArray {
        return this.getComposeArray("urls");
    }

    /**
     * The stack's auto update preference, `x-dockge.auto-update`.
     *
     * Tri-state: `true` or `false` when the key is set explicitly, `undefined`
     * when it is absent, in which case the global default in Settings decides.
     */
    get autoUpdate(): boolean | undefined {
        return convertToBoolean(this.get(AUTO_UPDATE_KEY));
    }

    /**
     * Free-text notes kept with the stack, `x-dockge.notes`.
     *
     * In the compose file rather than Dockge's database so they travel with the
     * stack: back the directory up, or move it to another host, and the notes
     * come too.
     */
    get notes(): string {
        const value = this.get(NOTES_KEY, "");
        return typeof value === "string" ? value : String(value);
    }

    set notes(value: string) {
        const text = value ?? "";

        // Stored as typed. This runs on every keystroke behind a v-model, so
        // trimming here would take away the space the user just pressed.
        if (text.trim()) {
            this.set(NOTES_KEY, text);
            return;
        }

        this.delete(NOTES_KEY);

        // Cleared notes on a stack with nothing else under x-dockge would
        // otherwise leave an empty block behind in the file
        this.removeIfEmpty();
    }
}

/**
 * Set, or with `undefined` remove, `x-dockge.auto-update` in a compose file.
 *
 * This edits the parsed YAML in place rather than going through
 * ComposeDocument.toYAML(), which rebuilds the document from scratch: we are
 * writing to a file the user maintains by hand, so everything we are not
 * touching — comments, blank lines, quoting style — must survive untouched.
 * An `x-dockge` block that is left empty is removed as well, so a stack that
 * never had one ends up exactly as it started.
 * @param composeYAML The current compose file contents
 * @param autoUpdate true, false, or undefined to remove the key
 * @returns The updated compose file contents
 */
export function setAutoUpdateInYAML(composeYAML: string, autoUpdate: boolean | undefined): string {
    const doc = parseDocument(composeYAML, YAML_OPTIONS);
    if (doc.errors.length > 0) {
        throw doc.errors[0];
    }

    // Note: yaml's setIn()/deleteIn() throw when the x-dockge block is missing or
    // is not a mapping, so every one of those cases is handled before calling them.
    const xDockge = doc.get(X_DOCKGE);

    if (autoUpdate === undefined) {
        if (!isMap(xDockge) || !xDockge.has(AUTO_UPDATE_KEY)) {
            // Nothing to remove: the stack already follows the global default,
            // so hand back the file exactly as it came in
            return composeYAML;
        }

        xDockge.delete(AUTO_UPDATE_KEY);

        if (xDockge.items.length === 0) {
            doc.delete(X_DOCKGE);
        }
    } else {
        if (!isMap(xDockge)) {
            if (xDockge !== undefined) {
                throw new Error(`"${X_DOCKGE}" in the compose file must be a mapping`);
            }

            // An "x-dockge:" line with nothing under it reads back as undefined too:
            // drop it so the block below is created as a mapping
            doc.delete(X_DOCKGE);
        }

        // Appended at the end when the file has no x-dockge block yet: inserting it at
        // the top instead would push a leading file comment down below it
        doc.setIn([ X_DOCKGE, AUTO_UPDATE_KEY ], autoUpdate);
    }

    return String(doc);
}

export class ComposeLabels extends ComposeNode {

    constructor(protected baseComposeData: ComposeData, protected parentNode?: ComposeNode) {
        super("labels", baseComposeData, parentNode);
    }

    protected checkType(data: any): boolean {
        // Labels could be defined as array or map
        return typeof data === "object" || Array.isArray(data);
    }

    protected createData() {
        // default is map style
        return {};
    }

    isEmpty(): boolean {
        if (this.isArray) {
            return this.composeData.data.length === 0;
        } else {
            return Object.keys(this.composeData.data).length === 0;
        }
    }

    get isArray() {
        return Array.isArray(this.composeData.data);
    }

    getLabels(envsubst = false): Record<string, any> {
        const data = envsubst ? this.composeData.envsubstData : this.composeData.data;
        if (this.isArray) {
            return (data as string[]).reduce(
                (acc, label) => {
                    const indexOfValue = label.indexOf("=");
                    const key = indexOfValue > 0 ? label.substring(0, indexOfValue) : label;
                    const value = indexOfValue > 0 ? label.substring(indexOfValue + 1) : "";

                    acc[key] = value;
                    return acc;
                },
                {} as Record<string, string>
            );
        } else {
            return data;
        }
    }

    setLabels(labels: Record<string, any>) {
        this.prepareWrite();
        if (this.isArray) {
            this.replace(Object.entries(labels).map(([ key, value ]) => `${key}=${value ? value : ""}`));
        } else {
            this.replace(labels);
        }
    }

    get(key: string, defaultVal: any = undefined, envsubst = false) {
        const value = this.getLabels(envsubst)[key];
        return value ? value : defaultVal;
    }

    set(key: string, value: string) {
        const labels = this.getLabels();
        labels[key] = value;
        this.setLabels(labels);
    }

    delete(key: string) {
        const labels = this.getLabels();
        if (key in labels) {
            delete labels[key];
            this.setLabels(labels);
        }
    }

    isFalse(key: string, envsubst = false) {
        return convertToBoolean(this.getLabels(envsubst)[key]) === false;
    }

    isTrue(key: string, envsubst = false) {
        return convertToBoolean(this.getLabels(envsubst)[key]) === true;
    }

    isSet(key: string, envsubst = false) {
        return key in this.getLabels(envsubst);
    }
}

function envsubst(string : string, variables : LooseObject) : string {
    return replaceVariablesSync(string, variables)[0];
}

/**
 * Traverse all values in the yaml and for each value, if there are template variables, replace it environment variables
 * Emulates the behavior of how docker-compose handles environment variables in yaml files
 * @param content Yaml string
 * @param env Environment variables
 * @returns string Yaml string with environment variables replaced
 */
function envsubstYAML(content : string, env : DotenvParseOutput) : string {
    const doc = parseDocument(content, YAML_OPTIONS);
    if (doc.contents) {
        // @ts-ignore
        for (const item of doc.contents.items) {
            traverseYAML(item, env);
        }
    }
    return doc.toString();
}

/**
 * Used for envsubstYAML(...)
 * @param pair
 * @param env
 */
function traverseYAML(pair : Pair, env : DotenvParseOutput) : void {
    // @ts-ignore
    if (pair.value && pair.value.items) {
        // @ts-ignore
        for (const item of pair.value.items) {
            if (item instanceof Pair) {
                traverseYAML(item, env);
            } else if (item instanceof Scalar) {
                let value = item.value as unknown;

                if (typeof(value) === "string") {
                    item.value = envsubst(value, env);
                }
            }
        }
    // @ts-ignore
    } else if (pair.value && typeof(pair.value.value) === "string") {
        // @ts-ignore
        pair.value.value = envsubst(pair.value.value, env);
    }
}

type YAMLPath = (string | number)[];

type AnchorEntry = {
    path: YAMLPath;
    kind: "anchor" | "alias";
    name: string;
};

/**
 * Walk the source YAML tree and record where every anchor is defined and where
 * every alias references one, keyed by their path from the document root.
 */
function collectYAMLAnchors(node : unknown, path : YAMLPath, out : AnchorEntry[]) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (isAlias(node)) {
        out.push({ path,
            kind: "alias",
            name: node.source });
        return;
    }

    const anchor = (node as Node).anchor;
    if (anchor) {
        out.push({ path,
            kind: "anchor",
            name: anchor });
    }

    if (isMap(node)) {
        for (const pair of node.items) {
            // Only follow scalar keys, which is all docker compose ever uses
            if (pair.key && typeof pair.key === "object" && "value" in pair.key) {
                collectYAMLAnchors(pair.value, [ ...path, pair.key.value as string ], out);
            }
        }
    } else if (isSeq(node)) {
        node.items.forEach((item, index) => collectYAMLAnchors(item, [ ...path, index ], out));
    }
}

/**
 * Re-apply the anchors (&name) and aliases (*name) from the source document onto
 * a freshly rebuilt document, matching nodes by their path. This keeps user-defined
 * anchors intact through an edit round trip instead of expanding them into values.
 * @param doc Document rebuilt from the JS data (no anchors yet)
 * @param src Original parsed document that still carries the anchors/aliases
 */
function restoreYAMLAnchors(doc : Document, src : Document) {
    if (!src.contents) {
        return;
    }

    const entries : AnchorEntry[] = [];
    collectYAMLAnchors(src.contents, [], entries);

    // Set anchors before aliases so the anchored node always exists first
    for (const entry of entries.filter(e => e.kind === "anchor")) {
        const node = doc.getIn(entry.path, true);
        if (node && typeof node === "object") {
            (node as Node).anchor = entry.name;
        }
    }

    for (const entry of entries.filter(e => e.kind === "alias")) {
        if (entry.path.length > 0 && doc.hasIn(entry.path)) {
            doc.setIn(entry.path, new Alias(entry.name));
        }
    }
}

type ScalarSourceEntry = {
    path: YAMLPath;
    value: unknown;
    source: string;
};

/**
 * Walk the source YAML tree and record the original text of every scalar the
 * stringifier would not reproduce on its own, keyed by its path from the
 * document root. Currently that means integers written with a leading zero;
 * see legacyLeadingZeroInt.
 */
function collectYAMLScalarSources(node : unknown, path : YAMLPath, out : ScalarSourceEntry[]) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (isScalar(node)) {
        if (node.format === LEGACY_LEADING_ZERO_FORMAT && typeof node.source === "string") {
            out.push({ path,
                value: node.value,
                source: node.source });
        }
        return;
    }

    if (isMap(node)) {
        for (const pair of node.items) {
            // Only follow scalar keys, which is all docker compose ever uses
            if (pair.key && typeof pair.key === "object" && "value" in pair.key) {
                collectYAMLScalarSources(pair.value, [ ...path, pair.key.value as string ], out);
            }
        }
    } else if (isSeq(node)) {
        node.items.forEach((item, index) => collectYAMLScalarSources(item, [ ...path, index ], out));
    }
}

/**
 * Re-apply those original scalar texts onto a freshly rebuilt document, matching
 * nodes by their path. ComposeDocument.toYAML() builds from plain JS data, where
 * `0755` has already collapsed to the number 755, so without this an edit made
 * anywhere in the GUI rewrites every such value in the file.
 *
 * Only a node whose value still matches is restored, so a field the user actually
 * changed is written out normally rather than reverting to the old text.
 * @param doc Document rebuilt from the JS data
 * @param src Original parsed document that still carries the scalar sources
 */
function restoreYAMLScalarSources(doc : Document, src : Document) {
    if (!src.contents) {
        return;
    }

    const entries : ScalarSourceEntry[] = [];
    collectYAMLScalarSources(src.contents, [], entries);

    for (const entry of entries) {
        if (entry.path.length === 0) {
            continue;
        }

        const node = doc.getIn(entry.path, true);
        if (isScalar(node) && node.value === entry.value) {
            node.format = LEGACY_LEADING_ZERO_FORMAT;
            node.source = entry.source;
        }
    }
}

function copyYAMLComments(doc : Document, src : Document) {
    doc.comment = src.comment;
    doc.commentBefore = src.commentBefore;

    if (doc && doc.contents && src && src.contents) {
        // @ts-ignore
        copyYAMLCommentsItems(doc.contents.items, src.contents.items);
    }
}

/**
 * Copy yaml comments from srcItems to items
 * Attempts to preserve comments by matching content rather than just array indices
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function copyYAMLCommentsItems(items: any, srcItems: any) {
    if (!items || !srcItems) {
        return;
    }

    // First pass - try to match items by their content
    for (let i = 0; i < items.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const item: any = items[i];

        // Try to find matching source item by content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const srcIndex = srcItems.findIndex((srcItem: any) =>
            JSON.stringify(srcItem.value) === JSON.stringify(item.value) &&
            JSON.stringify(srcItem.key) === JSON.stringify(item.key)
        );

        if (srcIndex !== -1) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const srcItem: any = srcItems[srcIndex];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nextSrcItem: any = srcItems[srcIndex + 1];

            if (item.key && srcItem.key) {
                item.key.comment = srcItem.key.comment;
                item.key.commentBefore = srcItem.key.commentBefore;
            }

            if (srcItem.comment) {
                item.comment = srcItem.comment;
            }

            // Handle comments between array items
            if (nextSrcItem && nextSrcItem.commentBefore) {
                if (items[i + 1]) {
                    items[i + 1].commentBefore = nextSrcItem.commentBefore;
                }
            }

            // Handle trailing comments after array items
            if (srcItem.value && srcItem.value.comment) {
                if (item.value) {
                    item.value.comment = srcItem.value.comment;
                }
            }

            if (item.value && srcItem.value) {
                if (typeof item.value === "object" && typeof srcItem.value === "object") {
                    item.value.comment = srcItem.value.comment;
                    item.value.commentBefore = srcItem.value.commentBefore;

                    if (item.value.items && srcItem.value.items) {
                        copyYAMLCommentsItems(item.value.items, srcItem.value.items);
                    }
                }
            }
        }
    }
}
