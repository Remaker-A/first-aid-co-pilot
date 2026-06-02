import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentStage, runAgentPipeline, runDemoPipeline } from "../src/index.js";
import { DemoEventPlayer } from "../src/demo/demoEventPlayer.js";

const SCRIPT_PATH = resolve("knowledge", "demo_script_cpr_main_v1.json");

async function loadScript() {
  return JSON.parse(await readFile(SCRIPT_PATH, "utf8"));
}

// Picks the first concrete (non-special) intent the state machine allows for the
// current stage, so the synthetic patch always survives the ActionValidator.
function stageEchoRuntime() {
  const runtime = {
    calls: [],
    async generatePatch(frame) {
      runtime.calls.push(frame);
      const intent =
        (frame.allowed_intents || []).find(
          (item) => item && !["defer_to_rule_feedback", "fallback_template"].includes(item)
        ) || "fallback_template";
      return {
        ok: true,
        patch: {
          intent,
          tts: { text: "请跟着提示继续操作。", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "继续", secondary_text: "" },
          reason: "gemma_supplement",
          confidence: 0.82
        }
      };
    }
  };
  return runtime;
}

// Emulates the real runtime when no model is installed: ok:true but fallback:true.
function modelMissingRuntime() {
  return {
    async generatePatch() {
      return {
        ok: true,
        fallback: true,
        fallbackReason: "model_missing",
        reason: "model_missing",
        patch: {
          intent: "fallback_template",
          tts: { text: "", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "", secondary_text: "" },
          reason: "model_missing",
          confidence: 0.6
        }
      };
    }
  };
}

// Returns a real (non-fallback) patch that must be rejected by the ActionValidator.
function unsafeRuntime() {
  return {
    async generatePatch() {
      return {
        ok: true,
        patch: {
          intent: "state_suspected_arrest_handling",
          tts: { text: "他已经心脏骤停了。", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "诊断", secondary_text: "" },
          reason: "should_be_blocked",
          confidence: 0.95
        }
      };
    }
  };
}

test("runAgentPipeline stays synchronous when useGemma is explicitly off", () => {
  const result = runAgentPipeline({ events: [], useGemma: false });
  assert.equal(typeof result.then, "undefined");
  assert.ok(Array.isArray(result.actions));
  assert.equal(result.gemma, undefined);
});

test("runAgentPipeline returns a promise when useGemma is on", async () => {
  const pending = runAgentPipeline({ events: [], useGemma: true, gemmaRuntime: stageEchoRuntime() });
  assert.equal(typeof pending.then, "function");
  const result = await pending;
  assert.ok(Array.isArray(result.actions));
  assert.equal(result.gemma.used, true);
});

test("runAgentPipeline defaults the Gemma supplement ON when useGemma is omitted", async () => {
  const script = await loadScript();
  const events = new DemoEventPlayer({
    script,
    mode: "demo_assisted",
    sessionId: "sess_default_on"
  }).events();
  const runtime = stageEchoRuntime();

  // No useGemma flag passed -> must default to the async Gemma-assisted path.
  const pending = runAgentPipeline({
    events,
    mode: "demo_assisted",
    sessionId: "sess_default_on",
    gemmaRuntime: runtime
  });
  assert.equal(typeof pending.then, "function", "omitting useGemma should default to the async Gemma path");

  const result = await pending;
  assert.equal(result.gemma.used, true);
  // The mocked runtime (not a real model) was actually consulted by default.
  assert.ok(runtime.calls.length > 0, "Gemma runtime should be consulted by default");
  assert.ok(
    result.gemma.guidance.some((g) => g.source === "gemma_agent"),
    "at least one non-critical turn should be supplemented by Gemma by default"
  );
  // Critical/tool flow is still rule-driven, and handover is still reached.
  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(
    result.actions.filter((a) => a.intent === "generate_handover_report").length,
    1
  );
});

test("demo replay with useGemma=false is unchanged", async () => {
  const script = await loadScript();
  const result = runDemoPipeline({ script });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(result.actions.filter((a) => a.intent === "generate_handover_report").length, 1);
  assert.equal(result.actions.at(-1).intent, "explain_handover");
  assert.equal(result.gemma, undefined);
});

test("Gemma supplements non-critical turns but never replaces critical/tool actions", async () => {
  const script = await loadScript();
  const runtime = stageEchoRuntime();
  const result = await runDemoPipeline({ script, useGemma: true, gemmaRuntime: runtime });

  // Critical flow stays intact: handover stage reached and the tool-bearing
  // generate_handover_report action is preserved exactly once.
  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(result.actions.filter((a) => a.intent === "generate_handover_report").length, 1);

  assert.equal(result.gemma.used, true);

  const handoverGuidance = result.gemma.guidance.find((g) => g.intent === "generate_handover_report");
  assert.ok(handoverGuidance, "expected a generate_handover_report guidance entry");
  assert.equal(handoverGuidance.source, "state_machine_critical");

  // At least one non-critical turn was actually supplemented by Gemma.
  assert.ok(result.gemma.guidance.some((g) => g.source === "gemma_agent"));
  // Gemma was consulted at least once.
  assert.ok(runtime.calls.length > 0);
});

test("Gemma unavailable falls back seamlessly to the state-machine actions", async () => {
  const script = await loadScript();
  const baseline = runDemoPipeline({ script });
  const result = await runDemoPipeline({ script, useGemma: true, gemmaRuntime: modelMissingRuntime() });

  assert.deepEqual(
    result.actions.map((a) => a.intent),
    baseline.actions.map((a) => a.intent)
  );
  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  // Every non-critical decision recorded a fallback reason and stayed state-driven.
  assert.ok(
    result.gemma.guidance.every((g) => g.source === "state_machine" || g.source === "state_machine_critical")
  );
});

test("Invalid Gemma patch is rejected by ActionValidator and never overrides the rule action", async () => {
  const script = await loadScript();
  const baseline = runDemoPipeline({ script });
  const result = await runDemoPipeline({ script, useGemma: true, gemmaRuntime: unsafeRuntime() });

  assert.deepEqual(
    result.actions.map((a) => a.intent),
    baseline.actions.map((a) => a.intent)
  );
  assert.ok(
    result.gemma.guidance.some((g) => (g.gemma_violations || []).includes("forbidden_speech"))
  );
  assert.ok(result.gemma.guidance.every((g) => g.source !== "gemma_agent"));
});
