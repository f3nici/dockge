import { R } from "redbean-node";
import { log } from "./log";
import { LooseObject } from "../common/util-common";

export class Settings {

    /**
     *  Example:
     *      {
     *         key1: {
     *             value: "value2",
     *             timestamp: 12345678
     *         },
     *         key2: {
     *             value: 2,
     *             timestamp: 12345678
     *         },
     *     }
     */
    static cacheList : LooseObject = {

    };

    static cacheCleaner? : NodeJS.Timeout;

    /**
     * Retrieve value of setting based on key
     * @param key Key of setting to retrieve
     * @returns Value
     */
    static async get(key : string) {

        // Start cache clear if not started yet
        if (!Settings.cacheCleaner) {
            Settings.cacheCleaner = setInterval(() => {
                log.debug("settings", "Cache Cleaner is just started.");
                for (const cacheKey in Settings.cacheList) {
                    if (Date.now() - Settings.cacheList[cacheKey].timestamp > 60 * 1000) {
                        log.debug("settings", "Cache Cleaner deleted: " + cacheKey);
                        delete Settings.cacheList[cacheKey];
                    }
                }

            }, 60 * 1000);
        }

        // Query from cache
        if (key in Settings.cacheList) {
            const v = Settings.cacheList[key].value;
            log.debug("settings", `Get Setting (cache): ${key}: ${v}`);
            return v;
        }

        const value = await R.getCell("SELECT `value` FROM setting WHERE `key` = ? ", [
            key,
        ]);

        try {
            const v = JSON.parse(value);
            log.debug("settings", `Get Setting: ${key}: ${v}`);

            Settings.cacheList[key] = {
                value: v,
                timestamp: Date.now()
            };

            return v;
        } catch (e) {
            return value;
        }
    }

    /**
     * Sets the specified setting to specified value
     * @param key Key of setting to set
     * @param value Value to set to
     * @param {?string} type Type of setting
     * @returns {Promise<void>}
     */
    static async set(key : string, value : object | string | number | boolean, type : string | null = null) {

        let bean = await R.findOne("setting", " `key` = ? ", [
            key,
        ]);
        if (!bean) {
            bean = R.dispense("setting");
            bean.key = key;
        }
        bean.type = type;
        bean.value = JSON.stringify(value);
        await R.store(bean);

        Settings.deleteCache([ key ]);
    }

    /**
     * Get settings based on type
     * @param type The type of setting
     * @returns Settings
     */
    static async getSettings(type : string) {
        const list = await R.getAll("SELECT `key`, `value` FROM setting WHERE `type` = ? ", [
            type,
        ]);

        const result : LooseObject = {};

        for (const row of list) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch (e) {
                result[row.key] = row.value;
            }
        }

        return result;
    }

    /**
     * Set settings based on type
     *
     * A key already stored under a different type is left alone: `setting.key`
     * is unique across all types, and this is what stops a client from
     * overwriting something like `jwtSecret` through a settings write. Keys are
     * therefore worth namespacing per feature - a clash here does not save.
     *
     * The skipped keys are returned rather than only logged. A caller that
     * cannot do its job without the write - storing registry logins, say - has
     * to be able to tell the user it did not happen instead of reporting
     * success and losing the values at the next restart.
     * @param type Type of settings to set
     * @param data Values of settings
     * @returns {Promise<string[]>} The keys that were not written, because they
     * are already stored under a different type
     */
    static async setSettings(type : string, data : LooseObject) : Promise<string[]> {
        const keyList = Object.keys(data);

        const promiseList = [];
        const skipped : string[] = [];

        for (const key of keyList) {
            let bean = await R.findOne("setting", " `key` = ? ", [
                key
            ]);

            if (bean == null) {
                bean = R.dispense("setting");
                bean.type = type;
                bean.key = key;
            }

            if (bean.type === type) {
                bean.value = JSON.stringify(data[key]);
                promiseList.push(R.store(bean));
            } else {
                log.warn("settings", `Not saving "${key}" as ${type}: it is already stored as ${bean.type}`);
                skipped.push(key);
            }
        }

        await Promise.all(promiseList);

        Settings.deleteCache(keyList);

        return skipped;
    }

    /**
     * Set settings, and fail loudly if any of them could not be written.
     *
     * For the callers whose feature is broken by a silently dropped key.
     * @param type Type of settings to set
     * @param data Values of settings
     * @returns {Promise<void>}
     * @throws When a key is already stored under a different type
     */
    static async setSettingsStrict(type : string, data : LooseObject) : Promise<void> {
        const skipped = await Settings.setSettings(type, data);

        if (skipped.length > 0) {
            throw new Error(`Could not save ${skipped.map((key) => `"${key}"`).join(", ")}: `
                + "already stored under a different setting type. Remove the conflicting row and try again.");
        }
    }

    /**
     * Delete selected keys from settings cache
     * @param {string[]} keyList Keys to remove
     * @returns {void}
     */
    static deleteCache(keyList : string[]) {
        for (const key of keyList) {
            delete Settings.cacheList[key];
        }
    }

    /**
     * Stop the cache cleaner if running
     * @returns {void}
     */
    static stopCacheCleaner() {
        if (Settings.cacheCleaner) {
            clearInterval(Settings.cacheCleaner);
            Settings.cacheCleaner = undefined;
        }
    }
}

