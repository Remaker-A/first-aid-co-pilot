import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runDemoPipeline } from "../agent/runPipeline.js";
import { SessionMode } from "../domain/types.js";
import { generatePracticeDebrief } from "../report/practiceDebrief.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const scriptPath = resolve(root, "knowledge", "demo_script_cpr_main_v1.json");

const script = JSON.parse(await readFile(scriptPath, "utf8"));
const practice = process.argv.includes("--practice");
const result = runDemoPipeline({
  script,
  sessionMode: practice ? SessionMode.PRACTICE : SessionMode.EMERGENCY,
});

console.log(`FirstAid Copilot demo replay (${practice ? "practice" : "emergency"})`);
console.log(`Final stage: ${result.state.current_stage}`);
console.log(`Session mode: ${result.state.session_mode}`);
console.log(`Actions: ${result.actions.length}`);
console.log(`Timeline events: ${result.log.entries.length}`);
console.log("");
console.log(
  practice
    ? generatePracticeDebrief(result.log, result.state).text
    : result.report.text
);
