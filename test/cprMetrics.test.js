import assert from "node:assert/strict";
import test from "node:test";
import { createCprMetricsTracker } from "../src/vision/cprMetrics.js";

// MediaPipe BlazePose 关键索引。
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;
const L_HIP = 23;
const R_HIP = 24;

function pt(x, y, visibility = 1) {
  return { x, y, visibility };
}

/**
 * 构造一帧 33 点关键点。默认是一个上半身居中、手臂竖直（接近 180°）的姿势，
 * 手腕落在胸口纵向区间内，便于按需覆盖各分支。
 */
function frame({
  wristX = 0.5,
  wristY = 0.45,
  visibility = 1,
  leftElbow = pt(0.4, 0.5),
  rightElbow = pt(0.6, 0.5),
  leftWrist,
  rightWrist,
} = {}) {
  const arr = new Array(33).fill(null);
  arr[L_SHOULDER] = pt(0.4, 0.3, visibility);
  arr[R_SHOULDER] = pt(0.6, 0.3, visibility);
  arr[L_ELBOW] = { ...leftElbow, visibility: leftElbow.visibility ?? visibility };
  arr[R_ELBOW] = { ...rightElbow, visibility: rightElbow.visibility ?? visibility };
  arr[L_WRIST] = leftWrist ?? pt(wristX, wristY, visibility);
  arr[R_WRIST] = rightWrist ?? pt(wristX, wristY, visibility);
  arr[L_HIP] = pt(0.42, 0.7, visibility);
  arr[R_HIP] = pt(0.58, 0.7, visibility);
  return arr;
}

test("合成 110bpm 腕部正弦 → compression_rate 与 average_rate 落在 [105,115]", () => {
  const tracker = createCprMetricsTracker({ minConfidence: 0.5, source: "test" });
  const fps = 50;
  const durationSec = 6;
  const bpm = 110;
  let last;
  for (let i = 0; i <= fps * durationSec; i += 1) {
    const tSec = i / fps;
    const y = 0.45 + 0.05 * Math.sin(2 * Math.PI * (bpm / 60) * tSec);
    last = tracker.update(frame({ wristX: 0.5, wristY: y }), tSec * 1000);
  }

  assert.ok(
    last.compression_rate >= 105 && last.compression_rate <= 115,
    `compression_rate=${last.compression_rate}`
  );
  assert.equal(last.current_rate, last.compression_rate);
  assert.ok(
    last.average_rate >= 105 && last.average_rate <= 115,
    `average_rate=${last.average_rate}`
  );
  assert.equal(last.compressions_started, true);
  assert.equal(last.started, true);
  assert.ok(last.total_compressions >= 8, `total_compressions=${last.total_compressions}`);
});

test("振幅骤降 → interruption_seconds 累计；恢复后清零", () => {
  const tracker = createCprMetricsTracker();
  const fps = 50;
  const step = 1000 / fps;
  const bpm = 110;
  const motion = (tMs) => 0.45 + 0.05 * Math.sin(2 * Math.PI * (bpm / 60) * (tMs / 1000));

  let t = 0;
  for (; t < 3000; t += step) {
    tracker.update(frame({ wristY: motion(t) }), t);
  }

  let afterPause;
  for (; t < 6500; t += step) {
    afterPause = tracker.update(frame({ wristY: 0.45 }), t);
  }
  assert.ok(afterPause.interruption_seconds >= 2, `interruption=${afterPause.interruption_seconds}`);

  let afterResume;
  for (; t < 8000; t += step) {
    afterResume = tracker.update(frame({ wristY: motion(t) }), t);
  }
  assert.ok(
    afterResume.interruption_seconds <= 0.5,
    `恢复后未清零 interruption=${afterResume.interruption_seconds}`
  );
});

test("腕部横向偏移 → hand_position 判 left / right；居中 → center", () => {
  const left = createCprMetricsTracker().update(frame({ wristX: 0.35, wristY: 0.45 }), 1000);
  const right = createCprMetricsTracker().update(frame({ wristX: 0.65, wristY: 0.45 }), 1000);
  const center = createCprMetricsTracker().update(frame({ wristX: 0.5, wristY: 0.45 }), 1000);

  assert.equal(left.hand_position, "left");
  assert.equal(right.hand_position, "right");
  assert.equal(center.hand_position, "center");
});

test("肘角 < ~155° → arm_straight=false；接近 180° → true", () => {
  // 弯肘：肩(0.4,0.3)-肘(0.4,0.5)-腕(0.5,0.5) 夹角约 90°。
  const bent = createCprMetricsTracker().update(
    frame({
      leftElbow: pt(0.4, 0.5),
      rightElbow: pt(0.6, 0.5),
      leftWrist: pt(0.5, 0.5),
      rightWrist: pt(0.5, 0.5),
    }),
    0
  );
  assert.equal(bent.arm_straight, false);
  assert.equal(bent.arm_posture, "bent");

  // 直臂：肩-肘-腕 竖直共线，夹角约 180°。
  const straight = createCprMetricsTracker().update(
    frame({
      leftElbow: pt(0.4, 0.5),
      rightElbow: pt(0.6, 0.5),
      leftWrist: pt(0.4, 0.7),
      rightWrist: pt(0.6, 0.7),
    }),
    0
  );
  assert.equal(straight.arm_straight, true);
  assert.equal(straight.arm_posture, "straight");
});

test("关键点 visibility 很低 → 依赖姿态的字段为 null，仅返回 confidence", () => {
  const out = createCprMetricsTracker({ minConfidence: 0.5 }).update(
    frame({ visibility: 0.2 }),
    1000
  );

  assert.equal(out.compression_rate, null);
  assert.equal(out.current_rate, null);
  assert.equal(out.average_rate, null);
  assert.equal(out.hand_position, null);
  assert.equal(out.arm_straight, null);
  assert.equal(out.arm_posture, null);
  assert.equal(out.quality_score, null);
  assert.equal(out.compressions_started, false);
  assert.ok(out.confidence < 0.5, `confidence=${out.confidence}`);
});

test("单目无尺度：输出不包含任何按压深度字段", () => {
  const out = createCprMetricsTracker().update(frame({ wristX: 0.5, wristY: 0.45 }), 1000);
  assert.equal("depth" in out, false);
  assert.equal("compression_depth" in out, false);
  assert.equal("compression_depth_cm" in out, false);
});
