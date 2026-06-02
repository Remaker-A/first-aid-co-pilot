import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runDemoPipeline } from "../agent/runPipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const scriptPath = resolve(root, "knowledge", "demo_script_cpr_main_v1.json");

const script = JSON.parse(await readFile(scriptPath, "utf8"));
const result = runDemoPipeline({ script });

console.log("FirstAid Copilot demo replay");
console.log(`Final stage: ${result.state.current_stage}`);
console.log(`Actions: ${result.actions.length}`);
console.log(`Timeline events: ${result.log.entries.length}`);
console.log("");
console.log(result.report.text);
