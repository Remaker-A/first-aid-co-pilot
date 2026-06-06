import test from "node:test";
import assert from "node:assert/strict";

import { AgentStage } from "../src/domain/stages.js";
import { resolvePhoneticIntent, loadPhoneticIntentConfig } from "../src/voice/phoneticIntent.js";
import { classifyIntent } from "../src/voice/stt.js";
import { resolveUserIntent } from "../src/voice/intentResolver.js";

// Hermetic options: never let an ambient INTENT_NLU leak the regex source into "stt".
const RESOLVE_OPTS = { env: {} };

test("shared phonetic config ships the critical closed-set intents and a pinyin table", () => {
  const config = loadPhoneticIntentConfig();
  assert.ok(config, "phonetic_intents.json must load");
  const intents = config.intents.map((entry) => entry.intent).sort();
  assert.deepEqual(intents, [
    "aed_available",
    "ask_aed_cpr_alternation",
    "ask_aed_help",
    "ask_can_stop",
    "ask_cpr_quality",
    "ask_emergency_call",
  ]);
  assert.deepEqual([...config.stages].sort(), ["S6_CPR_READY", "S7_CPR_LOOP", "S8_ASSISTANCE"]);
  // The documented mishearing's characters must be covered by the pinyin table.
  for (const ch of "出差移除颤仪心脏起搏器交替配合轮换我爱的得对位置节奏质量样压行数术异") {
    assert.ok(config.pinyin[ch], `pinyin table must cover ${ch}`);
  }
});

test("rescues the documented AED mishearing the regex cannot catch (除颤仪 -> 出差移)", () => {
  // Precondition: the regex classifier genuinely misses this — otherwise the
  // phonetic net would be redundant for it.
  assert.equal(classifyIntent("出差移来了怎么办").intent, null);

  const match = resolvePhoneticIntent("出差移来了怎么办", AgentStage.S7_CPR_LOOP);
  assert.ok(match, "phonetic matcher must rescue the mishearing");
  assert.equal(match.intent, "aed_available");
  assert.equal(match.source, "phonetic_fuzzy");
  assert.ok(match.score >= 0.7, `score ${match.score} should clear the floor`);
});

test("matches further AED homophone variants in any CPR-live stage", () => {
  assert.equal(resolvePhoneticIntent("出差仪到了怎么用", AgentStage.S8_ASSISTANCE)?.intent, "aed_available");
  assert.equal(resolvePhoneticIntent("出柴疑来了怎么办", AgentStage.S7_CPR_LOOP)?.intent, "aed_available");
  // A correctly-heard device word still resolves (the net is a superset).
  assert.equal(resolvePhoneticIntent("除颤仪在哪", AgentStage.S7_CPR_LOOP)?.intent, "ask_aed_help");
  assert.equal(resolvePhoneticIntent("数差异怎么用", AgentStage.S7_CPR_LOOP)?.intent, "ask_aed_help");
  assert.equal(resolvePhoneticIntent("心脏起搏器来了", AgentStage.S7_CPR_LOOP)?.intent, "aed_available");
});

test("rescues AED and compression alternation wording as a closed-set question", () => {
  assert.equal(classifyIntent("出差移和按压怎么交替").intent, null);
  assert.equal(
    resolvePhoneticIntent("出差移和按压怎么交替", AgentStage.S8_ASSISTANCE)?.intent,
    "ask_aed_cpr_alternation"
  );
});

test("rescues CPR quality homophone wording as a closed-set question", () => {
  assert.equal(classifyIntent("我爱的可以吗").intent, null);
  const match = resolvePhoneticIntent("我爱的可以吗", AgentStage.S7_CPR_LOOP);
  assert.ok(match, "phonetic matcher must rescue the quality-question mishearing");
  assert.equal(match.intent, "ask_cpr_quality");
  assert.equal(match.source, "phonetic_fuzzy");
  assert.ok(match.score >= 0.7, `score ${match.score} should clear the floor`);
  assert.equal(resolvePhoneticIntent("我爱你", AgentStage.S7_CPR_LOOP), null);
});

test("rescues can-stop and emergency-call homophones the regex enumeration misses", () => {
  assert.equal(classifyIntent("能不能婷").intent, null);
  assert.equal(resolvePhoneticIntent("能不能婷", AgentStage.S7_CPR_LOOP)?.intent, "ask_can_stop");

  assert.equal(classifyIntent("急就电话要不要打").intent, null);
  assert.equal(resolvePhoneticIntent("急就电话要不要打", AgentStage.S7_CPR_LOOP)?.intent, "ask_emergency_call");
});

test("does not fire outside CPR-live stages", () => {
  assert.equal(resolvePhoneticIntent("出差移来了怎么办", AgentStage.S2_CHECK_RESPONSE), null);
  assert.equal(resolvePhoneticIntent("出差移来了怎么办", AgentStage.S1_SCENE_SAFE), null);
});

test("does not false-trigger on unrelated speech or trigger-only utterances", () => {
  // Unrelated worry with a question suffix but no device/stop/call keyword.
  assert.equal(resolvePhoneticIntent("我有点紧张怎么办", AgentStage.S7_CPR_LOOP), null);
  // A trigger word alone (no keyword) must not synthesize an intent.
  assert.equal(resolvePhoneticIntent("在哪里", AgentStage.S7_CPR_LOOP), null);
  // Coaching phrase, not a question.
  assert.equal(resolvePhoneticIntent("继续保持节奏", AgentStage.S7_CPR_LOOP), null);
  // Empty / whitespace.
  assert.equal(resolvePhoneticIntent("   ", AgentStage.S7_CPR_LOOP), null);
});

test("require_trigger guards keyword-only mentions (除颤仪 with no question form)", () => {
  // Stating "I'll go grab the AED" should not be answered as an AED question.
  assert.equal(resolvePhoneticIntent("我去拿除颤仪", AgentStage.S7_CPR_LOOP), null);
});

test("a shared prefix must not carry a match across a genuinely different syllable", () => {
  // "能不能救回来呀" (can he be saved?) shares 能不能 with 能不能停 but 救/jiu is a
  // different syllable from 停/ting — the per-syllable ceiling must reject it so it
  // stays an open question instead of becoming a closed-set ask_can_stop.
  assert.equal(classifyIntent("他还能不能救回来呀").intent, null);
  assert.equal(resolvePhoneticIntent("他还能不能救回来呀", AgentStage.S7_CPR_LOOP), null);
});

test("resolveUserIntent adopts the phonetic intent as a deterministic fast path", async () => {
  const resolved = await resolveUserIntent({
    transcript: "出差移来了怎么办",
    stage: AgentStage.S7_CPR_LOOP,
    options: RESOLVE_OPTS,
  });

  assert.equal(resolved.intent, "aed_available");
  assert.equal(resolved.source, "phonetic_fuzzy");
  assert.equal(resolved.escalationReason, "phonetic_fuzzy_fast_path");
  assert.equal(resolved.escalated, false);
  assert.equal(resolved.needsClarification, false);
  // Critical safety net: it must never fabricate observation facts (breathing/responsive).
  assert.deepEqual(resolved.slots, {});
});

test("resolveUserIntent keeps the regex result when the regex is confident", async () => {
  // Cleanly-heard AED arrival: regex owns it, phonetic must not change the source.
  const aed = await resolveUserIntent({
    transcript: "除颤仪来了怎么办",
    stage: AgentStage.S7_CPR_LOOP,
    options: RESOLVE_OPTS,
  });
  assert.equal(aed.intent, "aed_available");
  assert.equal(aed.source, "regex");

  // A confident, unrelated regex intent must be left untouched.
  const unresponsive = await resolveUserIntent({
    transcript: "他没有反应",
    stage: AgentStage.S7_CPR_LOOP,
    options: RESOLVE_OPTS,
  });
  assert.equal(unresponsive.intent, "patient_unresponsive");
  assert.equal(unresponsive.source, "regex");
});

test("resolveUserIntent does not engage the phonetic net before CPR-live", async () => {
  const resolved = await resolveUserIntent({
    transcript: "出差移来了怎么办",
    stage: AgentStage.S1_SCENE_SAFE,
    options: RESOLVE_OPTS,
  });
  assert.equal(resolved.intent, null);
  assert.equal(resolved.source, "regex");
  assert.equal(resolved.needsClarification, true);
});
