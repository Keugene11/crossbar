import { getDb } from "./client.js";

const handle = getDb();
await handle.migrate();
console.log(`[crossbar] migrations applied (${handle.driver})`);
await handle.close();
