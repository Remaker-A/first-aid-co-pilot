import { writeFileSync } from "node:fs";
import { selectRuleFeedback, createRuleFeedbackAction } from "./src/engine/ruleFeedbackEngine.js";
import { AgentStage } from "./src/domain/stages.js";
import { classifyIntent } from "./src/voice/stt.js";

const lines = [];
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  lines.push(`[${pass ? "PASS" : "FAIL"}] ${name} :: ${detail}`);
}

// ---- Check 1: S7 interruption (stopped hands) -> correct_compression_interruption (critical) ----
const state1 = { current_stage: AgentStage.S7_CPR_LOOP, session_id: "sc1" };
const ev1 = {
  stage_hint: AgentStage.S7_CPR_LOOP,
  cpr_quality: { interruption_seconds: 4, current_rate: 0, compressions_started: false },
};
const fb1 = selectRuleFeedback(state1, ev1);
const act1 = createRuleFeedbackAction(state1, ev1);
const act1Json = JSON.stringify(act1);
const c1 =
  !!fb1 &&
  fb1.intent === "correct_compression_interruption" &&
  fb1.priority === "critical" &&
  typeof fb1.tts?.text === "string" &&
  fb1.tts.text.includes("不要停，继续按压") &&
  !!act1 &&
  act1Json.includes("correct_compression_interruption") &&
  act1Json.includes("不要停，继续按压");
record(
  "C1 S7 interruption(stopped) -> correct_compression_interruption/critical",
  c1,
  `selectRuleFeedback.intent=${fb1?.intent} priority=${fb1?.priority} tts="${fb1?.tts?.text}" | action.intent=${act1?.intent} action.priority=${act1?.priority} action.tts="${act1?.tts?.text}"`
);

// ---- Check 2: S7 slow rate (no interruption) -> correct_compression_rate, "跟着节拍", NOT "震动" ----
const state2 = { current_stage: AgentStage.S7_CPR_LOOP, session_id: "sc2" };
const ev2 = {
  stage_hint: AgentStage.S7_CPR_LOOP,
  cpr_quality: { interruption_seconds: 0, compression_rate: 80 },
};
const fb2 = selectRuleFeedback(state2, ev2);
const c2 =
  !!fb2 &&
  fb2.intent === "correct_compression_rate" &&
  fb2.type === "rate_low" &&
  typeof fb2.tts?.text === "string" &&
  fb2.tts.text.includes("跟着节拍") &&
  !fb2.tts.text.includes("震动");
record(
  "C2 S7 slow-rate -> correct_compression_rate, has 跟着节拍, no 震动",
  c2,
  `intent=${fb2?.intent} type=${fb2?.type} tts="${fb2?.tts?.text}" has_节拍=${!!fb2?.tts?.text?.includes("跟着节拍")} has_震动=${!!fb2?.tts?.text?.includes("震动")}`
);

// ---- Check 3: classifyIntent mappings ----
const i_dong = classifyIntent("他动了");
const i_breath = classifyIntent("又有呼吸了");
const i_ready = classifyIntent("准备好了");
const c3a = i_dong.intent === "signs_of_life";
const c3b = i_breath.intent === "signs_of_life";
const c3c = i_ready.intent !== "step_done";
record("C3a 他动了 -> signs_of_life", c3a, `intent=${i_dong.intent}`);
record("C3b 又有呼吸了 -> signs_of_life", c3b, `intent=${i_breath.intent}`);
record("C3c 准备好了 != step_done", c3c, `intent=${i_ready.intent === null ? "null" : i_ready.intent}`);

const allPass = results.every(Boolean);
lines.unshift(`SELFCHECK_SUMMARY total=${results.length} pass=${results.filter(Boolean).length} fail=${results.filter((x) => !x).length} overall=${allPass ? "ALL_PASS" : "HAS_FAIL"}`);

writeFileSync("_tmp_selfcheck_out.txt", lines.join("\n") + "\n", "utf8");
console.log("DONE selfcheck overall=" + (allPass ? "ALL_PASS" : "HAS_FAIL"));
