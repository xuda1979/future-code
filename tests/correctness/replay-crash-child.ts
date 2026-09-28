// An actual process exit at the durable-response/thread-checkpoint boundary.
import { readFileSync } from "node:fs";
import { Store } from "../../src/harness/foundry/store.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
const { root, cfg, capsule, response } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const store = await Store.open(root);
const driver = new SwarmDriver(store, cfg, (async () => Response.json(response)) as typeof fetch);
const checkpoint = driver.journal.checkpoint.bind(driver.journal);
driver.journal.checkpoint = (thread, kind, payload) => {
  if (kind === "model.reply") process.exit(73);
  checkpoint(thread, kind, payload);
};
await driver.execute(capsule, AbortSignal.timeout(15000));
throw new Error("fault injection did not reach the production checkpoint");
