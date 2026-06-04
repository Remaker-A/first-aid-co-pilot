import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createCprMetricsTracker,
  createVoiceDemoService,
  createVoiceServer,
  renderDemoPage,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CPR_METRICS_SOURCE = path.resolve(HERE, "../src/vision/cprMetrics.js");

// Boot an ephemeral server (port 0) so we never collide with a long-running
// demo on 8787, and always tear it down so `node --test` exits cleanly.
async function withServer(options, run) {
  const server = createVoiceServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await run(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
}

// Send `rawPath` verbatim (no URL normalization) so path-safety probes reach
// the server exactly as written.
function sendRequest(base, rawPath, { method = "GET", json = null, headers = {} } = {}) {
  const { hostname, port } = new URL(base);
  const payload = json == null ? null : Buffer.from(JSON.stringify(json), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path: rawPath,
        method,
        agent: false,
        headers: payload
          ? { ...headers, "content-type": "application/json", "content-length": payload.length }
          : headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function createStubService() {
  const calls = [];
  return {
    calls,
    async handleTurn(input) {
      calls.push(input);
      return { ok: true, echoed: input, state: { current_stage: "S7_CPR_LOOP" } };
    },
    reset(sessionId) {
      return { ok: true, session_id: sessionId ?? null };
    },
    getSession() {
      return null;
    },
  };
}

test("renderDemoPage returns valid HTML with a real-vision toggle and keeps the mock flow", () => {
  const html = renderDemoPage();
  assert.equal(typeof html, "string");
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));

  // The new "real vision" switch and its camera panel are present.
  assert.match(html, /id="realVisionToggle"/);
  assert.match(html, /真实视觉/);
  assert.match(html, /class="vision-panel"/);
  assert.match(html, /id="realVisionVideo"/);
  assert.match(html, /id="pickVisionVideo"/);
  assert.match(html, /id="realVisionVideoFile"/);
  assert.match(html, /accept="video\/\*"/);
  assert.match(html, /id="realVisionSource"/);
  assert.match(html, /hydrateVisionVideoFromQuery/);
  assert.match(html, /\/vision-test-assets\//);
  assert.match(html, /id="realVisionState"/);

  // The existing mock-perception dropdown flow is untouched and coexists.
  assert.match(html, /id="mockVision"/);
  assert.match(html, /populateMockVision\(\)/);
  assert.match(html, /MOCK_PRESETS/);
  assert.match(html, /id="injectMock"/);
});

test("demo page loads MediaPipe via CDN and reuses the served cprMetrics module", () => {
  const html = renderDemoPage();
  // MediaPipe Tasks Vision is loaded from a CDN (never bundled into Node deps).
  assert.match(html, /@mediapipe\/tasks-vision/);
  assert.match(html, /@mediapipe\/tasks-vision@0\.10\.35/);
  assert.doesNotMatch(html, /@mediapipe\/tasks-vision@0\.10\.22/);
  assert.match(html, /pose_landmarker/);
  // The browser reuses the SSOT algorithm via the static module route.
  assert.match(html, /import\("\/vision\/cprMetrics\.js"\)/);
  assert.match(html, /createCprMetricsTracker/);
});

test("demo page posts canonical vision_cpr cpr_quality_update payloads at 1-2Hz", () => {
  const html = renderDemoPage();
  assert.match(html, /eventSource:\s*"vision_cpr"/);
  assert.match(html, /eventType:\s*"cpr_quality_update"/);
  assert.match(html, /\bcprQuality\b/);
  assert.match(html, /perception_mode:\s*"real_perception"/);
  assert.match(html, /vision_input_source:\s*inputSource/);
  assert.match(html, /camera_facing:\s*inputSource === "camera" \? "front" : "unknown"/);
  assert.match(html, /camera_mount:\s*inputSource === "camera" \? "side_fixed" : "unknown"/);
  assert.match(html, /mirrored:\s*inputSource === "camera"/);
  assert.match(html, /mirrorX:\s*inputSource === "camera"/);
  assert.match(html, /handPositionReference:\s*"calibrated"/);
  assert.match(html, /readinessDropGraceMs:\s*2500/);
  assert.match(html, /recordingOnlyDelayMs:\s*5000/);
  assert.match(html, /lastLiveRecognitionAt/);
  assert.match(html, /readinessFailureStartedAt/);
  assert.match(html, /setCaptureContinuousStatus/);
  assert.match(html, /cprQuality\.vision_ready !== true/);
  assert.match(html, /summarizeVisionReadiness/);
  assert.match(html, /vision_ready:\s*cprQuality\.vision_ready/);
  assert.match(html, /pose_coverage:\s*cprQuality\.pose_coverage/);
  assert.match(html, /frame_stability:\s*cprQuality\.frame_stability/);
  assert.match(html, /observed_window_ms:\s*cprQuality\.observed_window_ms/);

  const throttle = html.match(/minPostIntervalMs:\s*(\d+)/);
  assert.ok(throttle, "expected a minPostIntervalMs throttle in the real-vision controller");
  const intervalMs = Number(throttle[1]);
  assert.ok(
    intervalMs >= 500 && intervalMs <= 1000,
    `post interval ${intervalMs}ms should sit within the 1-2Hz window`
  );
});

test("demo page honestly labels the data source and falls back to mock on low confidence/failure", () => {
  const html = renderDemoPage();
  // Confidence gating and explicit mock fallback labeling.
  assert.match(html, /minConfidence:\s*0\.75/);
  assert.match(html, /Mock Vision/);
  assert.match(html, /normalizeRealVisionError/);
  assert.match(html, /采集持续/);
  assert.match(html, /暂不切换模式/);
  // The status line surfaces the live provenance to the operator.
  assert.match(html, /id="realVisionStatus"/);
});

test("demo page keeps video-file real vision recoverable when autoplay is blocked", () => {
  const html = renderDemoPage();

  assert.match(html, /startTestVideoPlayback/);
  assert.match(html, /waitForVideoReady/);
  assert.match(html, /setState\(playbackReady \? "Running" : "Paused"/);
  assert.match(html, /当前仍会分析已加载帧/);
  assert.match(html, /syncVideoPlaybackStateBadge/);
  assert.match(html, /realVisionVideo\.paused \? "Paused" : "Running"/);
  assert.match(html, /onVideoPlaybackResumed/);
  assert.match(html, /onVideoPlaybackPaused/);
  assert.match(html, /\.vision-state\[data-state="Paused"\]/);
});

test("demo page resets CPR metric windows when test videos seek or loop", () => {
  const html = renderDemoPage();

  assert.match(html, /lastVideoFrameTime/);
  assert.match(html, /lastVideoFrameTimestampMs/);
  assert.match(html, /resetVideoMetricsOnTimelineJump/);
  assert.match(html, /videoDelta < -0\.25/);
  assert.match(html, /Math\.max\(4, wallDelta \+ 2\.5\)/);
  assert.match(html, /metricsTracker\?\.reset\?\.\(\)/);
});

test("GET / serves the demo HTML including the real-vision toggle", async () => {
  await withServer({ service: createStubService() }, async (base) => {
    const res = await sendRequest(base, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /id="realVisionToggle"/);
    assert.match(res.body, /id="mockVision"/);
  });
});

test("GET /vision/cprMetrics.js serves the exact SSOT module with JS content-type and CORS", async () => {
  await withServer({ service: createStubService() }, async (base) => {
    const res = await sendRequest(base, "/vision/cprMetrics.js");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/javascript/);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["cache-control"], "no-store");

    // The browser receives byte-for-byte the same module the engine uses (SSOT).
    const source = await fs.readFile(CPR_METRICS_SOURCE, "utf8");
    assert.equal(res.body, source);
    assert.match(res.body, /export function createCprMetricsTracker/);
  });
});

test("the vision static route is an allowlist of exactly cprMetrics.js (no traversal/sibling leakage)", async () => {
  await withServer({ service: createStubService() }, async (base) => {
    const sibling = await sendRequest(base, "/vision/wsGateway.js");
    assert.equal(sibling.status, 404);

    const traversal = await sendRequest(base, "/vision/../voice/service.js");
    assert.equal(traversal.status, 404);

    const served = await sendRequest(base, "/vision/cprMetrics.js");
    assert.equal(served.status, 200);
    // The served module is the metrics SSOT, never the server internals.
    assert.doesNotMatch(served.body, /createVoiceServer/);
  });
});

test("GET /vision-test-assets serves only local video test assets", async () => {
  const assetDir = path.resolve(HERE, "../artifacts/vision-tests");
  const fileName = "unit-test-cpr.mp4";
  const assetPath = path.join(assetDir, fileName);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(assetPath, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  try {
    await withServer({ service: createStubService() }, async (base) => {
      const served = await sendRequest(base, `/vision-test-assets/${fileName}`);
      assert.equal(served.status, 200);
      assert.match(served.headers["content-type"], /video\/mp4/);
      assert.equal(served.headers["content-length"], "8");
      assert.equal(served.headers["accept-ranges"], "bytes");

      const head = await sendRequest(base, `/vision-test-assets/${fileName}`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-length"], "8");

      const range = await sendRequest(base, `/vision-test-assets/${fileName}`, {
        headers: { range: "bytes=0-3" },
      });
      assert.equal(range.status, 206);
      assert.equal(range.headers["content-range"], "bytes 0-3/8");
      assert.equal(range.headers["content-length"], "4");

      const traversal = await sendRequest(base, "/vision-test-assets/%2e%2e%2fvoice%2fservice.js");
      assert.equal(traversal.status, 400);

      const nonVideo = await sendRequest(base, "/vision-test-assets/not-video.txt");
      assert.equal(nonVideo.status, 400);
    });
  } finally {
    await fs.rm(assetPath, { force: true });
  }
});

test("POST /api/turn forwards the vision_cpr real-perception payload to the service unchanged", async () => {
  const service = createStubService();
  await withServer({ service }, async (base) => {
    const cprQuality = {
      compressions_started: true,
      compression_rate: 112,
      interruption_seconds: 0,
      hand_position: "center",
      arm_straight: true,
      quality_score: 88,
      total_compressions: 40,
      confidence: 0.82,
      vision_ready: true,
      pose_coverage: 0.9,
      frame_stability: 0.86,
      observed_window_ms: 1200,
    };
    const metadata = {
      perception_mode: "real_perception",
      vision_input_source: "camera",
      camera_facing: "front",
      camera_mount: "side_fixed",
      mirrored: true,
      vision_ready: true,
      pose_coverage: 0.9,
      frame_stability: 0.86,
      observed_window_ms: 1200,
    };
    const res = await sendRequest(base, "/api/turn", {
      method: "POST",
      json: {
        sessionId: "vision_demo_test",
        eventSource: "vision_cpr",
        eventType: "cpr_quality_update",
        cprQuality,
        metadata,
      },
    });

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);

    assert.equal(service.calls.length, 1);
    const received = service.calls[0];
    assert.equal(received.sessionId, "vision_demo_test");
    assert.equal(received.eventSource, "vision_cpr");
    assert.equal(received.eventType, "cpr_quality_update");
    assert.deepEqual(received.cprQuality, cprQuality);
    assert.deepEqual(received.metadata, metadata);
  });
});

test("voice service maps a legacy real_perception cpr_quality_update into a canonical CPR vision event", async () => {
  // Inject a no-op runtime so this stays hermetic (no Gemma process / model).
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return { ok: true, patch: null };
      },
    },
  });
  const cprQuality = {
    compressions_started: true,
    compression_rate: 110,
    interruption_seconds: 0,
    hand_position: "center",
    arm_straight: true,
    quality_score: 90,
    total_compressions: 60,
    confidence: 0.8,
  };

  const response = await service.handleTurn({
    sessionId: "vision_event_map",
    eventSource: "real_perception",
    eventType: "cpr_quality_update",
    cprQuality,
  });

  assert.equal(response.ok, true);
  assert.equal(response.event.source, "vision_cpr");
  assert.equal(response.event.event_type, "cpr_quality_update");
  assert.deepEqual(response.event.cpr_quality, cprQuality);
  assert.equal(response.event.metadata.raw_event_source, "real_perception");
  assert.equal(response.event.metadata.perception_mode, "real_perception");
});

test("the served cprMetrics tracker emits the cpr_quality contract the demo posts", () => {
  const tracker = createCprMetricsTracker();
  const frame = tracker.update(syntheticUpperBodyLandmarks(), 0);
  for (const key of [
    "compressions_started",
    "compression_rate",
    "interruption_seconds",
    "hand_position",
    "arm_straight",
    "quality_score",
    "total_compressions",
    "confidence",
    "vision_ready",
    "pose_coverage",
    "frame_stability",
    "observed_window_ms",
  ]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(frame, key),
      `cpr_quality contract is missing ${key}`
    );
  }
});

function syntheticUpperBodyLandmarks() {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  landmarks[11] = { x: 0.42, y: 0.3, visibility: 0.95 };
  landmarks[12] = { x: 0.58, y: 0.3, visibility: 0.95 };
  landmarks[13] = { x: 0.4, y: 0.45, visibility: 0.95 };
  landmarks[14] = { x: 0.6, y: 0.45, visibility: 0.95 };
  landmarks[15] = { x: 0.5, y: 0.5, visibility: 0.95 };
  landmarks[16] = { x: 0.5, y: 0.5, visibility: 0.95 };
  landmarks[23] = { x: 0.45, y: 0.7, visibility: 0.95 };
  landmarks[24] = { x: 0.55, y: 0.7, visibility: 0.95 };
  return landmarks;
}
