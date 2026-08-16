/**
 * DSH home resolution — shared by the gateway and the bridge node.
 * @module dsh-wechat-bridge/home
 */
import os from 'node:os';
import path from 'node:path';
/** Resolve $DSH_HOME (env override first, then the platform home). */
export function resolveDshHome() {
    return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}
//# sourceMappingURL=home.js.map