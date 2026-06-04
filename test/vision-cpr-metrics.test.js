import assert from "node:assert/strict";
import test from "node:test";
import {
  HandPosition,
  classifyHandPosition,
  computeAngle,
  computeQualityScore,
  createCprMetricsTracker,
  isArmStraight,
} from "../src/vision/cprMetrics.js";

function pt(x, y, visibility = 1) {
  return { x, y, visibility };
}

function makeLandmarks({ ls, rs, le, re, lw, rw, lh, rh }) {
  const arr = new Array(25).fill(null);
  arr[11] = ls;
  arr[12] = rs;
  arr[13] = le;
  arr[14] = re;
  arr[15] = lw;
  arr[16] = rw;
  arr[23] = lh;
  arr[24] = rh;
  return arr;
}

const UPRIGHT = {
  ls: pt(0.4, 0.3),
  rs: pt(0.6, 0.3),
  le: pt(0.4, 0.4),
  re: pt(0.6, 0.4),
  lh: pt(0.4, 0.7),
  rh: pt(0.6, 0.7),
};

function makeStableLandmarks({ dx = 0, wristX = 0.5, wristY = 0.45, visibility = 1 } = {}) {
  const p = (x, y) => pt(x + dx, y, visibility);
  return makeLandmarks({
    ls: p(0.4, 0.3),
    rs: p(0.6, 0.3),
    le: p(0.4, 0.4),
    re: p(0.6, 0.4),
    lw: p(wristX, wristY),
    rw: p(wristX, wristY),
    lh: p(0.4, 0.7),
    rh: p(0.6, 0.7),
  });
}

test("computeAngle returns 90 and 180 for right and straight joints", () => {
  assert.equal(Math.round(computeAngle(pt(0, 1), pt(0, 0), pt(1, 0))), 90);
  assert.equal(Math.round(computeAngle(pt(-1, 0), pt(0, 0), pt(1, 0))), 180);
});

test("isArmStraight detects bent vs straight elbow against the 155 deg threshold", () => {
  assert.equal(isArmStraight(pt(0.4, 0.3), pt(0.4, 0.5), pt(0.5, 0.5), 155), false);
  assert.equal(isArmStraight(pt(0.4, 0.3), pt(0.45, 0.5), pt(0.5, 0.7), 155), true);
});

test("classifyHandPosition maps wrist offsets to the rule-engine enum", () => {
  const shoulderMid = pt(0.5, 0.3);
  const hipMid = pt(0.5, 0.7);
  const shoulderWidth = 0.2; // xTol = 0.35 * 0.2 = 0.07
  const midY = 0.45;
  assert.equal(
    classifyHandPosition({ wrist: pt(0.5, midY), shoulderMid, hipMid, shoulderWidth }),
    HandPosition.CENTER
  );
  assert.equal(
    classifyHandPosition({ wrist: pt(0.35, midY), shoulderMid, hipMid, shoulderWidth }),
    HandPosition.LEFT_OFFSET
  );
  assert.equal(
    classifyHandPosition({ wrist: pt(0.65, midY), shoulderMid, hipMid, shoulderWidth }),
    HandPosition.RIGHT_OFFSET
  );
  assert.equal(
    classifyHandPosition({ wrist: pt(0.5, 0.32), shoulderMid, hipMid, shoulderWidth }),
    HandPosition.TOO_HIGH
  );
  assert.equal(
    classifyHandPosition({ wrist: pt(0.5, 0.6), shoulderMid, hipMid, shoulderWidth }),
    HandPosition.TOO_LOW
  );
});

test("computeQualityScore rewards in-range rate, straight arm, centered hands, low interruption", () => {
  assert.equal(
    computeQualityScore({
      compressionRate: 110,
      armStraight: true,
      handPosition: HandPosition.CENTER,
      interruptionSeconds: 0,
    }),
    100
  );
  assert.ok(
    computeQualityScore({
      compressionRate: 60,
      armStraight: false,
      handPosition: HandPosition.LEFT_OFFSET,
      interruptionSeconds: 5,
    }) < 40
  );
  assert.equal(computeQualityScore({ compressionRate: null }), null);
});

test("tracker mirrorX flips horizontal hand-position before wire output", () => {
  const raw = createCprMetricsTracker();
  const mirrored = createCprMetricsTracker({ mirrorX: true });
  const frame = makeStableLandmarks({ wristX: 0.65 });

  assert.equal(raw.update(frame, 0).hand_position, "right");
  assert.equal(mirrored.update(frame, 0).hand_position, "left");
});

test("tracker readiness reports insufficient keypoint coverage", () => {
  const tracker = createCprMetricsTracker();
  const frame = makeStableLandmarks();
  frame[13] = null;
  frame[14] = null;
  frame[16] = null;

  const out = tracker.update(frame, 0);

  assert.equal(out.pose_coverage, 0.625);
  assert.equal(out.confidence, 1);
  assert.equal(out.vision_ready, false);
});

test("tracker readiness stays false when torso frames are unstable", () => {
  const tracker = createCprMetricsTracker();
  const offsets = [0, 0.12, -0.12, 0.12];
  let out;
  for (let i = 0; i < offsets.length; i += 1) {
    out = tracker.update(makeStableLandmarks({ dx: offsets[i] }), i * 250);
  }

  assert.equal(out.pose_coverage, 1);
  assert.ok(out.observed_window_ms >= 750, `observed_window_ms=${out.observed_window_ms}`);
  assert.ok(out.frame_stability < 0.75, `frame_stability=${out.frame_stability}`);
  assert.equal(out.vision_ready, false);
});

test("tracker readiness allows normal vertical CPR body motion on a fixed camera", () => {
  const tracker = createCprMetricsTracker();
  let out;
  for (let i = 0; i < 14; i += 1) {
    const dy = i % 2 === 0 ? 0.08 : -0.06;
    out = tracker.update(
      makeLandmarks({
        ls: pt(0.4, 0.3 + dy),
        rs: pt(0.6, 0.3 + dy),
        le: pt(0.4, 0.4 + dy),
        re: pt(0.6, 0.4 + dy),
        lw: pt(0.5, 0.45 + dy),
        rw: pt(0.5, 0.45 + dy),
        lh: pt(0.4, 0.7 + dy),
        rh: pt(0.6, 0.7 + dy),
      }),
      i * 100
    );
  }

  assert.equal(out.pose_coverage, 1);
  assert.ok(out.frame_stability >= 0.75, `frame_stability=${out.frame_stability}`);
  assert.equal(out.vision_ready, true);
});

test("tracker readiness becomes true after stable covered frames", () => {
  const tracker = createCprMetricsTracker();
  let out;
  for (const t of [0, 250, 500, 750]) {
    out = tracker.update(makeStableLandmarks(), t);
  }

  assert.equal(out.pose_coverage, 1);
  assert.equal(out.confidence, 1);
  assert.equal(out.observed_window_ms, 750);
  assert.ok(out.frame_stability >= 0.75, `frame_stability=${out.frame_stability}`);
  assert.equal(out.vision_ready, true);
});

test("tracker derives ~110 bpm from a synthetic sine wrist signal", () => {
  const tracker = createCprMetricsTracker();
  const fps = 50;
  const durationSec = 6;
  const bpm = 110;
  let last;
  for (let i = 0; i <= fps * durationSec; i += 1) {
    const tSec = i / fps;
    const y = 0.45 + 0.05 * Math.sin(2 * Math.PI * (bpm / 60) * tSec);
    const wrist = pt(0.5, y);
    last = tracker.update(
      makeLandmarks({ ...UPRIGHT, lw: wrist, rw: wrist }),
      tSec * 1000
    );
  }
  assert.ok(
    last.compression_rate >= 105 && last.compression_rate <= 115,
    `expected rate near 110, got ${last.compression_rate}`
  );
  assert.equal(last.compressions_started, true);
  assert.ok(last.total_compressions >= 8, `total_compressions=${last.total_compressions}`);
});

test("tracker treats sparse but visible wrist motion as active CPR, not interruption", () => {
  const tracker = createCprMetricsTracker();
  let last;
  for (let i = 0; i <= 8; i += 1) {
    const y = i % 2 === 0 ? 0.42 : 0.49;
    last = tracker.update(
      makeLandmarks({ ...UPRIGHT, lw: pt(0.5, y), rw: pt(0.5, y) }),
      i * 1000
    );
  }

  assert.equal(last.compressions_started, true);
  assert.ok(last.interruption_seconds < 1, `interruption=${last.interruption_seconds}`);
});

test("calibrated hand target treats the initial CPR press point as center", () => {
  const tracker = createCprMetricsTracker({ handPositionReference: "calibrated" });
  let out;
  for (let i = 0; i < 15; i += 1) {
    out = tracker.update(makeStableLandmarks({ wristX: 0.5, wristY: 0.64 }), i * 100);
  }

  assert.equal(out.hand_position, "center");
  assert.equal(out.hand_position_basis, "calibrated_target");
});

test("calibrated hand target reports drift after the press point moves", () => {
  const tracker = createCprMetricsTracker({ handPositionReference: "calibrated" });
  let out;
  for (let i = 0; i < 15; i += 1) {
    out = tracker.update(makeStableLandmarks({ wristX: 0.5, wristY: 0.64 }), i * 100);
  }
  out = tracker.update(makeStableLandmarks({ wristX: 0.72, wristY: 0.64 }), 1600);
  assert.equal(out.hand_position, "right");

  out = tracker.update(makeStableLandmarks({ wristX: 0.5, wristY: 0.82 }), 1700);
  assert.equal(out.hand_position, "too_low");
});

test("tracker accumulates interruption seconds once compressions stop", () => {
  const tracker = createCprMetricsTracker();
  const fps = 50;
  const step = 1 / fps;
  const bpm = 110;
  let tSec = 0;
  const frame = (y) =>
    tracker.update(makeLandmarks({ ...UPRIGHT, lw: pt(0.5, y), rw: pt(0.5, y) }), tSec * 1000);

  for (; tSec < 3; tSec += step) {
    frame(0.45 + 0.05 * Math.sin(2 * Math.PI * (bpm / 60) * tSec));
  }
  let last;
  for (let s = 0; s < 3.5; s += step, tSec += step) {
    last = frame(0.45);
  }
  assert.ok(last.interruption_seconds >= 2, `interruption=${last.interruption_seconds}`);
});

test("tracker reports arm_straight=false for a bent elbow frame", () => {
  const tracker = createCprMetricsTracker();
  const out = tracker.update(
    makeLandmarks({
      ls: pt(0.4, 0.3),
      rs: pt(0.6, 0.3),
      le: pt(0.4, 0.5),
      re: pt(0.6, 0.5),
      lw: pt(0.5, 0.5),
      rw: pt(0.5, 0.5),
      lh: pt(0.4, 0.7),
      rh: pt(0.6, 0.7),
    }),
    0
  );
  assert.equal(out.arm_straight, false);
});

test("low visibility gates derived metrics to null without guessing", () => {
  const tracker = createCprMetricsTracker();
  const low = (x, y) => pt(x, y, 0.2);
  const out = tracker.update(
    makeLandmarks({
      ls: low(0.4, 0.3),
      rs: low(0.6, 0.3),
      le: low(0.4, 0.4),
      re: low(0.6, 0.4),
      lw: low(0.5, 0.45),
      rw: low(0.5, 0.45),
      lh: low(0.4, 0.7),
      rh: low(0.6, 0.7),
    }),
    0
  );
  assert.equal(out.compression_rate, null);
  assert.equal(out.hand_position, null);
  assert.equal(out.arm_straight, null);
  assert.equal(out.quality_score, null);
  assert.ok(out.confidence < 0.5);
});
