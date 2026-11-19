// node tools/mecanicas.mjs > download/mecanicas.json
// The mechanics of ui/data.js as the JSON the app downloads (ui/remote.js).
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/data.js", import.meta.url), "utf8"), ctx);
const d = ctx.window.LUDRA_BR;
const version = new Date().toISOString().slice(0, 16).replace("T", " ");
console.log(JSON.stringify({ version, bosses: d.bosses, minBossHp: d.minBossHp }, null, 1));
