import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEnvFlag,
  parsePositiveNumber,
  resolveLiveSessionEnvOptions,
  mergeLiveSessionEnvOptions,
} from "../src/voice/liveSessionEnv.js";

test("parseEnvFlag recognizes truthy/falsy and treats unknown/unset as undefined", () => {
  for (const v of ["1", "on", "ON", " true ", "yes", "enable", "enabled"]) {
    assert.equal(parseEnvFlag(v), true, `${v} should be truthy`);
  }
  for (const v of ["0", "off", "false", "no", "disable", "disabled"]) {
    assert.equal(parseEnvFlag(v), false, `${v} should be falsy`);
  }
  assert.equal(parseEnvFlag(undefined), undefined);
  assert.equal(parseEnvFlag(""), undefined);
  assert.equal(parseEnvFlag("maybe"), undefined);
});

test("parsePositiveNumber accepts finite positives only", () => {
  assert.equal(parsePositiveNumber("0.08"), 0.08);
  assert.equal(parsePositiveNumber("320"), 320);
  assert.equal(parsePositiveNumber("0"), undefined);
  assert.equal(parsePositiveNumber("-1"), undefined);
  assert.equal(parsePositiveNumber("abc"), undefined);
  assert.equal(parsePositiveNumber(undefined), undefined);
});

test("default (empty env) resolves to no options — safety switches stay OFF", () => {
  assert.deepEqual(resolveLiveSessionEnvOptions({}), {});
});

test("STT_FINAL_REVIEW=on enables final review only", () => {
  assert.deepEqual(resolveLiveSessionEnvOptions({ STT_FINAL_REVIEW: "on" }), {
    finalReview: true,
  });
  // An explicit falsy value must not enable it.
  assert.deepEqual(resolveLiveSessionEnvOptions({ STT_FINAL_REVIEW: "off" }), {});
});

test("energy barge-in gate + tuning params resolve under bargeIn", () => {
  const resolved = resolveLiveSessionEnvOptions({
    VOICE_BARGE_IN_ENERGY_GATE: "1",
    VOICE_BARGE_IN_RMS: "0.12",
    VOICE_BARGE_IN_MIN_SPEECH_MS: "300",
  });
  assert.deepEqual(resolved, {
    bargeIn: { energyGate: true, rmsThreshold: 0.12, minSpeechMs: 300 },
  });
});

test("tuning params apply even when the gate flag is left to the caller", () => {
  // Setting only thresholds (no gate flag) still surfaces them so a caller that
  // turns the gate on programmatically inherits the tuned numbers.
  assert.deepEqual(resolveLiveSessionEnvOptions({ VOICE_BARGE_IN_RMS: "0.2" }), {
    bargeIn: { rmsThreshold: 0.2 },
  });
});

test("explicit injected options always win over env, with shallow bargeIn merge", () => {
  const env = {
    STT_FINAL_REVIEW: "on",
    VOICE_BARGE_IN_ENERGY_GATE: "on",
    VOICE_BARGE_IN_RMS: "0.1",
  };
  const merged = mergeLiveSessionEnvOptions(
    { finalReview: false, bargeIn: { rmsThreshold: 0.25 } },
    env
  );
  // finalReview explicitly disabled wins over env.
  assert.equal(merged.finalReview, false);
  // bargeIn merges: env keeps energyGate, explicit overrides rmsThreshold.
  assert.deepEqual(merged.bargeIn, { energyGate: true, rmsThreshold: 0.25 });
});

test("merge with empty explicit + empty env yields an empty object", () => {
  assert.deepEqual(mergeLiveSessionEnvOptions({}, {}), {});
  assert.deepEqual(mergeLiveSessionEnvOptions(undefined, {}), {});
});
