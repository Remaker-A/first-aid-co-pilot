import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVoiceDemoService } from "./service.js";
import { getRuntimeDir } from "./tts.js";
import { attachVoiceWsGateway } from "./wsGateway.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function createVoiceServer(options = {}) {
  const service = options.service || createVoiceDemoService(options.serviceOptions || {});

  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, service);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: {
          message: error?.message || "Internal server error.",
          code: error?.code,
        },
      });
    }
  });
  attachVoiceWsGateway(server, {
    ...(options.ws || {}),
    service,
    ttsOptions: options.serviceOptions?.tts || options.tts || {},
  });
  return server;
}

export async function startVoiceServer(options = {}) {
  const host = options.host || process.env.VOICE_HOST || DEFAULT_HOST;
  const port = Number(options.port || process.env.VOICE_PORT || DEFAULT_PORT);
  const server = createVoiceServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

async function routeRequest(req, res, service) {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "OPTIONS") {
    sendCors(res, 204);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, renderDemoPage());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "firstaid-voice-server",
      live_ws_path: "/ws/live",
      tts_provider: process.env.SHERPA_ONNX_TTS_COMMAND ? "sherpa-onnx" : "mock",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/vision/cprMetrics.js") {
    await sendCprMetricsModule(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/turn") {
    const body = await readJsonBody(req);
    const result = await service.handleTurn(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJsonBody(req);
    sendJson(res, 200, service.reset(body.sessionId || body.session_id));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/audio/")) {
    await sendRuntimeAudio(res, decodeURIComponent(url.pathname.slice("/api/audio/".length)));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/vision-test-assets/")) {
    await sendVisionTestAsset(req, res, decodeURIComponent(url.pathname.slice("/vision-test-assets/".length)));
    return;
  }

  sendJson(res, 404, { ok: false, error: { message: "Not found." } });
}

async function sendCprMetricsModule(res) {
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vision/cprMetrics.js");
  sendCorsHeaders(res);
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
  });

  try {
    res.end(await fs.readFile(modulePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.end('throw new Error("src/vision/cprMetrics.js is not available yet.");\n');
      return;
    }
    throw error;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Expected JSON request body."));
      }
    });
  });
}

async function sendRuntimeAudio(res, fileName) {
  if (!/^[\w.-]+\.wav$/i.test(fileName)) {
    sendJson(res, 400, { ok: false, error: { message: "Invalid audio file name." } });
    return;
  }

  const fullPath = path.join(getRuntimeDir(), fileName);
  const data = await fs.readFile(fullPath);
  sendCorsHeaders(res);
  res.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

async function sendVisionTestAsset(req, res, fileName) {
  if (!/^[\w.-]+\.(mp4|mov|webm)$/i.test(fileName)) {
    sendJson(res, 400, { ok: false, error: { message: "Invalid vision test asset name." } });
    return;
  }

  const assetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../artifacts/vision-tests");
  const fullPath = path.join(assetDir, fileName);
  const stat = await fs.stat(fullPath);
  const ext = path.extname(fileName).toLowerCase();
  const contentType = ext === ".mp4"
    ? "video/mp4"
    : ext === ".mov"
      ? "video/quicktime"
      : "video/webm";
  const range = parseRangeHeader(req.headers.range, stat.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const data = req.method === "HEAD" ? null : (await fs.readFile(fullPath)).subarray(start, end + 1);
  sendCorsHeaders(res);
  res.writeHead(range ? 206 : 200, {
    "content-type": contentType,
    "content-length": range ? end - start + 1 : stat.size,
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}),
    "cache-control": "no-store",
  });
  res.end(data);
}

function parseRangeHeader(value, size) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  const start = rawStart === "" ? 0 : Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendJson(res, statusCode, value) {
  sendCorsHeaders(res);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res, html) {
  sendCorsHeaders(res);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendCors(res, statusCode) {
  sendCorsHeaders(res);
  res.writeHead(statusCode);
  res.end();
}

function sendCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

export function renderDemoPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FirstAid Voice Demo</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #181a1b; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    h1 { font-size: 24px; margin: 0; }
    section, form { background: white; border: 1px solid #d9ddd6; border-radius: 8px; padding: 16px; }
    textarea, select { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid #b9c0b4; border-radius: 6px; background: white; }
    textarea { min-height: 92px; resize: vertical; }
    button { border: 1px solid #1c5d48; background: #1f7a5a; color: white; border-radius: 6px; padding: 9px 12px; font: inherit; cursor: pointer; }
    button.secondary { background: white; color: #1c5d48; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .field { flex: 1 1 300px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .start-panel { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px; align-items: center; margin-top: 10px; padding: 12px; border: 1px solid #bdd3c8; border-radius: 8px; background: #f5fbf7; }
    .start-panel button { font-weight: 700; padding-inline: 18px; }
    .quick-panel { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 12px; align-items: center; margin-top: 10px; padding: 12px; border: 1px solid #cbd8cf; border-radius: 8px; background: #f8fbf8; }
    .quick-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .live-panel { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px; align-items: center; margin-top: 10px; padding: 12px; border: 1px solid #c7d3df; border-radius: 8px; background: #f7fbff; }
    .live-controls { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; align-items: center; }
    .live-toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; color: #1f3f55; }
    .live-state { display: inline-flex; gap: 6px; align-items: center; min-width: 118px; padding: 6px 9px; border-radius: 999px; background: #e8eef5; color: #1f3f55; font-size: 14px; }
    .live-dot { width: 9px; height: 9px; border-radius: 999px; background: #8292a3; }
    .live-state[data-state="Listening"] .live-dot { background: #2e8b57; }
    .live-state[data-state="Capturing"] .live-dot { background: #d87916; }
    .live-state[data-state="Uploading"], .live-state[data-state="Thinking"] { background: #fff3d9; color: #74480d; }
    .live-state[data-state="Uploading"] .live-dot, .live-state[data-state="Thinking"] .live-dot { background: #d8911b; }
    .live-state[data-state="Speaking"] { background: #e7e4ff; color: #393174; }
    .live-state[data-state="Speaking"] .live-dot { background: #6657d8; }
    .live-state[data-state="Error"], .live-state[data-state="Off"] { background: #f5e8e6; color: #8b3027; }
    .live-state[data-state="Error"] .live-dot, .live-state[data-state="Off"] .live-dot { background: #b84636; }
    .vision-panel { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(180px, 240px); gap: 12px; align-items: center; margin-top: 10px; padding: 12px; border: 1px solid #d7c7a8; border-radius: 8px; background: #fffaf0; }
    .vision-controls { display: grid; gap: 8px; justify-items: start; }
    .vision-toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; color: #5f4314; }
    .vision-state { display: inline-flex; gap: 6px; align-items: center; min-width: 134px; padding: 6px 9px; border-radius: 999px; background: #f0e6d6; color: #5f4314; font-size: 14px; }
    .vision-dot { width: 9px; height: 9px; border-radius: 999px; background: #9b825d; }
    .vision-state[data-state="Running"] { background: #e6f3e8; color: #275a34; }
    .vision-state[data-state="Running"] .vision-dot { background: #2e8b57; }
    .vision-state[data-state="Loading"] { background: #fff3d9; color: #74480d; }
    .vision-state[data-state="Loading"] .vision-dot { background: #d8911b; }
    .vision-state[data-state="Paused"] { background: #e9eef5; color: #35445a; }
    .vision-state[data-state="Paused"] .vision-dot { background: #65758b; }
    .vision-state[data-state="Error"], .vision-state[data-state="Off"] { background: #f5e8e6; color: #8b3027; }
    .vision-state[data-state="Error"] .vision-dot, .vision-state[data-state="Off"] .vision-dot { background: #b84636; }
    #realVisionVideo { width: 100%; max-height: 160px; border-radius: 8px; background: #222; object-fit: cover; }
    #realVisionVideo[data-source="camera"] { transform: scaleX(-1); }
    .label { color: #59615a; font-size: 13px; margin-bottom: 4px; }
    .value { font-size: 18px; min-height: 28px; }
    .summary { color: #59615a; font-size: 14px; min-height: 22px; }
    .summary.warning { color: #9a5b16; font-weight: 600; }
    #status { color: #59615a; }
    #status.error { color: #a33a2b; font-weight: 600; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #202622; color: #eef5ed; border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; }
    audio { width: 100%; }
    @media (max-width: 720px) {
      .start-panel { grid-template-columns: 1fr; }
      .quick-panel { grid-template-columns: 1fr; }
      .live-panel { grid-template-columns: 1fr; }
      .vision-panel { grid-template-columns: 1fr; }
      .quick-actions { justify-content: flex-start; }
      .live-controls { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>FirstAid Voice Demo</h1>
      <button id="reset" class="secondary" type="button">Reset</button>
    </header>
    <form id="turnForm">
      <div class="label">输入文本，或录一段音频走 STT</div>
      <textarea id="text" placeholder="例如：现场安全了 / 他没有反应 / 没有正常呼吸 / 120 已经拨打 / 急救员到了"></textarea>
      <div class="start-panel">
        <div>
          <div class="label">Demo 主线</div>
          <div class="summary">从安全确认开始，再按反应、呼吸、120 和 CPR 的设计流程推进。</div>
        </div>
        <button id="startEmergency" type="button">一键急救</button>
      </div>
      <div class="quick-panel">
        <div>
          <div class="label">调试入口</div>
          <div class="summary">跳到 S7_CPR_LOOP 后，测试视觉纠正和语音问题。</div>
        </div>
        <div class="quick-actions">
          <button id="runCprSetup" class="secondary" type="button">跳到 CPR 调试状态</button>
          <button id="quickQuality" class="secondary" type="button">手位偏左 + 我按得对吗</button>
          <button id="quickStop" class="secondary" type="button">能不能停</button>
          <button id="quickAed" class="secondary" type="button">AED 来了怎么办</button>
        </div>
      </div>
      <div class="live-panel">
        <div>
          <div class="label">Live 语音模式</div>
          <div id="liveHint" class="summary">点击“一键急救”后请求麦克风；说完后自动识别、决策和播报。</div>
        </div>
        <div class="live-controls">
          <label class="live-toggle"><input id="liveToggle" type="checkbox"> Live 开</label>
          <span id="liveState" class="live-state" data-state="Idle"><span class="live-dot"></span><span id="liveStateText">准备中</span></span>
          <span id="liveMeter" class="summary"></span>
        </div>
      </div>
      <div class="vision-panel">
        <div>
          <div class="label">Real Vision（实验）</div>
          <div id="realVisionHint" class="summary">使用浏览器摄像头 + MediaPipe Pose，仅在 S6/S7 且置信度足够时上报 CPR 质量；失败时继续用 Mock Vision。</div>
          <div class="vision-controls" style="margin-top: 8px;">
            <label class="vision-toggle"><input id="realVisionToggle" type="checkbox"> 真实视觉开</label>
            <button id="pickVisionVideo" class="secondary" type="button">选择测试视频</button>
            <input id="realVisionVideoFile" type="file" accept="video/*" style="display: none;">
            <span id="realVisionState" class="vision-state" data-state="Off"><span class="vision-dot"></span><span id="realVisionStateText">Off</span></span>
            <span id="realVisionSource" class="summary">来源：摄像头</span>
            <span id="realVisionStatus" class="summary">未启用</span>
          </div>
        </div>
        <video id="realVisionVideo" playsinline muted></video>
      </div>
      <div class="row" style="margin-top: 10px;">
        <label class="field">
          <div class="label">Mock Vision</div>
          <select id="mockVision"></select>
        </label>
        <button id="injectMock" class="secondary" type="button">注入 Mock（不发语音）</button>
        <span id="mockSummary" class="summary"></span>
      </div>
      <div class="row" style="margin-top: 10px;">
        <button id="send" type="submit">发送文本 + Mock</button>
        <button id="record" class="secondary" type="button">录音</button>
        <button id="pickAudio" class="secondary" type="button">选择音频</button>
        <input id="audioFile" type="file" accept="audio/*" style="display: none;">
        <span id="status"></span>
      </div>
    </form>
    <section class="grid">
      <div><div class="label">Transcript</div><div id="transcript" class="value"></div></div>
      <div><div class="label">Stage</div><div id="stage" class="value"></div></div>
      <div><div class="label">STT Intent</div><div id="sttIntent" class="value"></div></div>
      <div><div class="label">Patch Intent</div><div id="intent" class="value"></div></div>
      <div><div class="label">Event Source</div><div id="eventSource" class="value"></div></div>
      <div><div class="label">Guidance Source</div><div id="guidanceSource" class="value"></div></div>
      <div><div class="label">Response Type</div><div id="responseType" class="value"></div></div>
      <div><div class="label">Live Driver</div><div id="liveDriverSource" class="value"></div></div>
      <div><div class="label">Gemma</div><div id="gemmaStatus" class="value"></div></div>
      <div><div class="label">Timings</div><div id="timings" class="value"></div></div>
    </section>
    <section>
      <div class="label">TTS</div>
      <div id="ttsText" class="value"></div>
      <audio id="audio" controls></audio>
    </section>
    <section>
      <div class="label">Raw Response</div>
      <pre id="raw">{}</pre>
    </section>
  </main>
  <script>
    const sessionId = "voice_demo_" + Math.random().toString(16).slice(2);
    const form = document.querySelector("#turnForm");
    const text = document.querySelector("#text");
    const statusEl = document.querySelector("#status");
    const record = document.querySelector("#record");
    const pickAudio = document.querySelector("#pickAudio");
    const audioFile = document.querySelector("#audioFile");
    const mockVision = document.querySelector("#mockVision");
    const injectMock = document.querySelector("#injectMock");
    const startEmergency = document.querySelector("#startEmergency");
    const runCprSetup = document.querySelector("#runCprSetup");
    const quickQuality = document.querySelector("#quickQuality");
    const quickStop = document.querySelector("#quickStop");
    const quickAed = document.querySelector("#quickAed");
    const mockSummary = document.querySelector("#mockSummary");
    const liveToggle = document.querySelector("#liveToggle");
    const liveState = document.querySelector("#liveState");
    const liveStateText = document.querySelector("#liveStateText");
    const liveHint = document.querySelector("#liveHint");
    const liveMeter = document.querySelector("#liveMeter");
    const realVisionToggle = document.querySelector("#realVisionToggle");
    const pickVisionVideo = document.querySelector("#pickVisionVideo");
    const realVisionVideoFile = document.querySelector("#realVisionVideoFile");
    const realVisionState = document.querySelector("#realVisionState");
    const realVisionStateText = document.querySelector("#realVisionStateText");
    const realVisionSource = document.querySelector("#realVisionSource");
    const realVisionStatus = document.querySelector("#realVisionStatus");
    const realVisionHint = document.querySelector("#realVisionHint");
    const realVisionVideo = document.querySelector("#realVisionVideo");
    const audio = document.querySelector("#audio");
    let recordedAudio = null;
    let mediaRecorder = null;
    let chunks = [];
    let currentStage = "";
    let selectedVisionVideoUrl = null;
    let selectedVisionVideoName = "";

    const MOCK_PRESETS = [
      {
        id: "none",
        label: "No mock",
        summary: "voice / text only",
        payload: {}
      },
      {
        id: "scene_safe",
        label: "Scene safe",
        summary: "vision_patient: scene_safe=true",
        payload: {
          eventSource: "vision_patient",
          eventType: "patient_state_update",
          patientState: {
            adult_likely: true,
            lying_down: true,
            responsive: null,
            normal_breathing: null,
            agonal_breathing: null,
            chest_movement: "unknown",
            confidence: 0.86
          },
          metadata: { scene_safe: true, scene_note: "mock_scene_safe" }
        }
      },
      {
        id: "unresponsive",
        label: "No response",
        summary: "vision_patient: responsive=false",
        payload: {
          eventSource: "vision_patient",
          eventType: "patient_state_update",
          patientState: {
            adult_likely: true,
            lying_down: true,
            responsive: false,
            normal_breathing: null,
            agonal_breathing: null,
            chest_movement: "unknown",
            confidence: 0.91
          },
          metadata: { scene_note: "mock_unresponsive" }
        }
      },
      {
        id: "no_breathing",
        label: "No normal breathing",
        summary: "vision_patient: normal_breathing=false",
        payload: {
          eventSource: "vision_patient",
          eventType: "breathing_update",
          patientState: {
            adult_likely: true,
            lying_down: true,
            responsive: false,
            normal_breathing: false,
            agonal_breathing: true,
            chest_movement: "irregular",
            confidence: 0.9
          },
          metadata: { scene_note: "mock_no_normal_breathing" }
        }
      },
      {
        id: "call_started",
        label: "120 started",
        summary: "device: emergency_call_started=true",
        payload: {
          eventSource: "device",
          eventType: "device_state_update",
          deviceState: {
            emergency_call_started: true,
            emergency_call_status: "started",
            gps_attached: true,
            recording: true,
            network: "offline"
          },
          metadata: { scene_note: "mock_call_started" }
        }
      },
      {
        id: "cpr_ready",
        label: "CPR ready",
        summary: "需先完成安全、反应、呼吸和 120：vision_patient ready for compressions",
        requiresCprSetup: true,
        payload: {
          eventSource: "vision_patient",
          eventType: "patient_state_update",
          patientState: {
            adult_likely: true,
            lying_down: true,
            responsive: false,
            normal_breathing: false,
            agonal_breathing: true,
            chest_movement: "irregular",
            confidence: 0.89
          },
          metadata: { scene_note: "mock_cpr_ready" }
        }
      },
      {
        id: "cpr_start",
        label: "CPR started",
        summary: "需先进入 CPR：vision_cpr quality_score=35",
        requiresCprSetup: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: true,
            current_rate: 100,
            average_rate: 100,
            quality_score: 35,
            hand_position: "center",
            arm_posture: "straight",
            interruption_seconds: 0,
            total_compressions: 10
          }
        }
      },
      {
        id: "hand_left",
        label: "Hand left",
        summary: "仅 CPR 中有效：vision_cpr hand_position=left",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: true,
            current_rate: 110,
            average_rate: 105,
            quality_score: 42,
            hand_position: "left",
            arm_posture: "straight",
            interruption_seconds: 0,
            total_compressions: 40
          }
        }
      },
      {
        id: "rate_low",
        label: "Rate low",
        summary: "仅 CPR 中有效：vision_cpr current_rate=82",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: true,
            current_rate: 82,
            average_rate: 95,
            quality_score: 50,
            hand_position: "center",
            arm_posture: "straight",
            interruption_seconds: 0,
            total_compressions: 70
          }
        }
      },
      {
        id: "arm_bent",
        label: "Arm bent",
        summary: "仅 CPR 中有效：vision_cpr arm_posture=bent",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: true,
            current_rate: 112,
            average_rate: 102,
            quality_score: 58,
            hand_position: "center",
            arm_posture: "bent",
            interruption_seconds: 0,
            total_compressions: 100
          }
        }
      },
      {
        id: "interrupted",
        label: "Interrupted",
        summary: "仅 CPR 中有效：vision_cpr interruption_seconds=4",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: false,
            current_rate: 0,
            average_rate: 100,
            quality_score: 55,
            hand_position: "center",
            arm_posture: "straight",
            interruption_seconds: 4,
            total_compressions: 120
          }
        }
      },
      {
        id: "quality_good",
        label: "Quality good",
        summary: "仅 CPR 中有效：vision_cpr quality_score=90",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_cpr",
          eventType: "cpr_quality_update",
          cprQuality: {
            compressions_started: true,
            current_rate: 110,
            average_rate: 109,
            quality_score: 90,
            hand_position: "center",
            arm_posture: "straight",
            interruption_seconds: 0,
            total_compressions: 240
          }
        }
      },
      {
        id: "fatigue",
        label: "Rescuer fatigue",
        summary: "仅 CPR 中有效：vision_rescuer fatigue_level=high",
        requiresCprLoop: true,
        payload: {
          eventSource: "vision_rescuer",
          eventType: "rescuer_state_update",
          rescuerState: {
            emotion: "anxious",
            fatigue_level: "high",
            hesitation_seconds: 0,
            confidence: 0.8
          }
        }
      },
      {
        id: "aed_arrived",
        label: "AED arrived",
        summary: "CPR 中的视觉 AED 到达事件：会进入 S8_ASSISTANCE，TTS 应继续按压并听设备提示",
        bestAfterCprSetup: true,
        payload: {
          eventSource: "vision_patient",
          eventType: "patient_state_update",
          metadata: {
            aed_available: true,
            helper_arrived: true,
            scene_note: "mock_aed_arrived"
          }
        }
      },
      {
        id: "ems_arrived",
        label: "EMS arrived",
        summary: "vision_patient: handover_requested",
        payload: {
          eventSource: "vision_patient",
          eventType: "handover_requested",
          metadata: {
            ems_arrived: true,
            scene_note: "mock_ems_arrived"
          }
        }
      },
      {
        id: "report_ready",
        label: "Report ready",
        summary: "device: handover_report_generated=true",
        payload: {
          eventSource: "device",
          eventType: "tool_result",
          metadata: {
            handover_report_generated: true,
            local_video_saved: true,
            scene_note: "mock_report_ready"
          },
          toolResult: {
            type: "generate_handover_report",
            status: "ok"
          }
        }
      }
    ];

    populateMockVision();
    const liveController = createLiveController();
    const realVisionController = createRealVisionController();
    hydrateVisionVideoFromQuery();
    liveToggle.addEventListener("change", () => {
      if (liveToggle.checked) {
        liveController.startIfEnabled();
      } else {
        liveController.stop();
      }
    });
    realVisionToggle.addEventListener("change", () => {
      if (realVisionToggle.checked) {
        realVisionController.startIfEnabled();
      } else {
        realVisionController.stop();
      }
    });
    pickVisionVideo.addEventListener("click", () => realVisionVideoFile.click());
    realVisionVideoFile.addEventListener("change", () => {
      const file = realVisionVideoFile.files?.[0];
      if (!file) {
        return;
      }
      if (selectedVisionVideoUrl) {
        URL.revokeObjectURL(selectedVisionVideoUrl);
      }
      selectedVisionVideoUrl = URL.createObjectURL(file);
      selectedVisionVideoName = file.name;
      realVisionSource.textContent = "来源：测试视频 · " + file.name;
      realVisionController.stop({ keepSelection: true });
      realVisionToggle.checked = true;
      realVisionController.startIfEnabled();
    });
    realVisionVideo.addEventListener("play", () => realVisionController.onVideoPlaybackResumed());
    realVisionVideo.addEventListener("pause", () => realVisionController.onVideoPlaybackPaused());
    audio.addEventListener("ended", () => liveController.onPlaybackEnd());
    audio.addEventListener("error", () => liveController.onPlaybackEnd());
    queueMicrotask(() => liveController.startIfEnabled());

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendTurn({ ...selectedMockPayload(), text: text.value, ...recordedAudio });
      recordedAudio = null;
    });

    injectMock.addEventListener("click", async () => {
      const payload = selectedMockPayload();
      if (!Object.keys(payload).length) {
        setStatus("select a mock");
        return;
      }
      await sendTurn(payload);
    });

    startEmergency.addEventListener("click", async () => {
      setQuickButtonsDisabled(true);
      liveController.stop();
      try {
        await resetSession();
        const started = await sendTurn({
          eventSource: "demo_script",
          eventType: "session_started",
          deviceState: {
            camera_available: true,
            mic_available: true,
            gps_available: true,
            recording: true,
            emergency_call_started: false,
            network: "offline"
          },
          metadata: {
            adult_likely: true,
            recording: true,
            scene_note: "one_key_first_aid"
          }
        });
        if (started.ok) {
          liveToggle.checked = true;
          liveController.startIfEnabled();
          realVisionController.updateContext();
          setStatus("急救流程已开始");
        }
      } finally {
        setQuickButtonsDisabled(false);
      }
    });

    runCprSetup.addEventListener("click", async () => {
      await runCprSetupSequence();
    });

    quickQuality.addEventListener("click", async () => {
      await runLiveCprQuestion("hand_left", "我按得对吗");
    });

    quickStop.addEventListener("click", async () => {
      await runLiveCprQuestion("none", "我能不能停");
    });

    quickAed.addEventListener("click", async () => {
      await runLiveCprQuestion("none", "AED 来了怎么办");
    });

    mockVision.addEventListener("change", () => {
      updateMockSummary();
      liveController.updateContext();
      realVisionController.updateContext();
    });

    document.querySelector("#reset").addEventListener("click", async () => {
      liveController.stop();
      liveToggle.checked = false;
      realVisionController.stop();
      realVisionToggle.checked = false;
      await resetSession();
      setStatus("reset");
    });

    async function resetSession() {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      render({});
      currentStage = "";
      recordedAudio = null;
      updateMockSummary();
      realVisionController.updateContext();
    }

    record.addEventListener("click", async () => {
      if (mediaRecorder?.state === "recording") {
        setStatus("正在停止录音...");
        record.disabled = true;
        mediaRecorder.stop();
        return;
      }

      liveController.pauseForManualInput();
      setStatus("正在请求麦克风权限...");
      record.disabled = true;

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("当前浏览器不支持麦克风录音，请用“选择音频”上传一段录音。");
        }
        if (typeof MediaRecorder === "undefined") {
          throw new Error("当前浏览器不支持 MediaRecorder，请用“选择音频”上传一段录音。");
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = pickRecordingMimeType();
        chunks = [];
        mediaRecorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (event) => {
          if (event.data?.size > 0) {
            chunks.push(event.data);
          }
        };
        mediaRecorder.onerror = (event) => {
          stream.getTracks().forEach((track) => track.stop());
          liveController.resumeAfterManualInput();
          setStatus("录音失败：" + (event.error?.message || "浏览器录音错误"), true);
          record.textContent = "录音";
          record.disabled = false;
          mediaRecorder = null;
        };
        mediaRecorder.onstop = async () => {
          try {
            stream.getTracks().forEach((track) => track.stop());
            if (chunks.length === 0) {
              throw new Error("没有录到音频，请确认麦克风权限和输入设备。");
            }
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
            recordedAudio = {
              audioBase64: await blobToBase64(blob),
              mimeType: blob.type || "audio/webm"
            };
            setStatus("录音已准备好，点“发送文本 + Mock”进行 STT");
          } catch (error) {
            setStatus(error.message || "录音处理失败", true);
          } finally {
            record.textContent = "录音";
            record.disabled = false;
            mediaRecorder = null;
            liveController.resumeAfterManualInput();
          }
        };
        mediaRecorder.start();
        record.textContent = "停止录音";
        record.disabled = false;
        setStatus("录音中... 再点一次停止");
      } catch (error) {
        record.textContent = "录音";
        record.disabled = false;
        liveController.resumeAfterManualInput();
        setStatus(normalizeMediaError(error), true);
      }
    });

    pickAudio.addEventListener("click", () => {
      audioFile.click();
    });

    audioFile.addEventListener("change", async () => {
      const file = audioFile.files?.[0];
      if (!file) {
        return;
      }
      try {
        setStatus("正在读取音频文件...");
        recordedAudio = {
          audioBase64: await blobToBase64(file),
          mimeType: file.type || "application/octet-stream"
        };
        setStatus("音频已准备好，点“发送文本 + Mock”进行 STT");
      } catch (error) {
        setStatus(error.message || "音频文件读取失败", true);
      } finally {
        audioFile.value = "";
      }
    });

    async function sendTurn(payload, options = {}) {
      if (options.live) {
        liveController.setState("Thinking", "正在识别和生成回复...");
      }
      setStatus("sending...");
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload })
      });
      const json = await response.json();
      render(json, options);
      setStatus(json.ok ? "ok" : "error", !json.ok);
      if (options.live && !json.ok) {
        liveController.onPlaybackEnd();
      }
      return json;
    }

    function render(json, options = {}) {
      document.querySelector("#transcript").textContent = json.transcript || "";
      currentStage = json.state?.current_stage || "";
      document.querySelector("#stage").textContent = currentStage;
      document.querySelector("#sttIntent").textContent = json.stt?.intent || json.event?.user_input?.intent || "";
      document.querySelector("#intent").textContent = json.guidance_action?.intent || json.action_patch?.intent || "";
      document.querySelector("#eventSource").textContent = json.event?.source || "";
      document.querySelector("#guidanceSource").textContent = json.guidance_source || "";
      document.querySelector("#responseType").textContent = json.response_type || "";
      document.querySelector("#liveDriverSource").textContent = json.live_driver_source || json.tts_arbitration_reason || "";
      document.querySelector("#gemmaStatus").textContent = json.gemma_live?.stale
        ? "live timeout: " + (json.gemma_live.timeout_ms || 0) + "ms"
        : json.gemma?.fallback
        ? "fallback: " + (json.gemma.fallbackReason || json.gemma.reason || "unknown")
        : json.gemma?.skipped
          ? "skipped: " + (json.gemma.skipReason || "unknown")
        : json.gemma?.patch
          ? "patch parsed"
          : "";
      const timings = json.timings || {};
      document.querySelector("#timings").textContent = timings.total_ms
        ? "total " + timings.total_ms + "ms / gemma " + (timings.gemma_ms ?? 0) + "ms / stt " + (timings.stt_ms ?? 0) + "ms / tts " + (timings.tts_ms ?? 0) + "ms"
        : "";
      document.querySelector("#ttsText").textContent = json.guidance_action?.tts?.text || json.state_action?.tts?.text || "";
      const audioSrc = json.tts?.audio?.url || json.tts?.audio?.data_url || "";
      audio.src = audioSrc;
      if (audioSrc && options.playAudio !== false) {
        liveController.onPlaybackStart();
        audio.play().catch(() => liveController.onPlaybackEnd());
      } else if (options.live) {
        liveController.onPlaybackEnd();
      }
      document.querySelector("#raw").textContent = JSON.stringify(json, null, 2);
      updateMockSummary();
      realVisionController.updateContext();
    }

    function createLiveController() {
      const config = {
        targetSampleRate: 16000,
        minRms: 0.014,
        noiseMultiplier: 3.2,
        // Barge-in must clear a clearly higher, *sustained* energy than plain
        // listening so the assistant's own playback echo or a brief noise can no
        // longer cut its own prompt off (issue: 收音太敏感).
        bargeInMinRms: 0.15,
        bargeInNoiseMultiplier: 8,
        bargeInSpeechMs: 600,
        contextRefreshMs: 500,
        // Endpoint after a longer pause so a mid-sentence breath no longer commits
        // half an utterance, and require a minimum amount of real speech before a
        // commit so stray noise never fires a spurious turn (issue: 录音太短).
        commitSilenceMs: 1200,
        minUtteranceMs: 250
      };
      let stream = null;
      let audioContext = null;
      let playbackContext = null;
      let source = null;
      let processor = null;
      let workletUrl = "";
      let ws = null;
      let state = "Idle";
      let manualPaused = false;
      let noiseFloor = 0.004;
      let lastContextAt = 0;
      let bargeInSent = false;
      let bargeInVoicedMs = 0;
      let playbackCursor = 0;
      let playbackSources = [];
      let playbackEndTimer = 0;
      let pendingAudio = null;
      let utteranceActive = false;
      let lastVoiceAt = 0;
      let voicedMsInUtterance = 0;

      return {
        startIfEnabled,
        stop,
        setState,
        onPlaybackStart,
        onPlaybackEnd,
        pauseForManualInput,
        resumeAfterManualInput,
        updateContext
      };

      async function startIfEnabled() {
        if (!liveToggle.checked || stream) {
          return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          setState("Error", "当前浏览器不支持 getUserMedia，请使用手动录音或上传音频。");
          return;
        }

        try {
          setState("Idle", "正在连接 Live WebSocket...");
          connectWebSocket();
          setState("Idle", "正在请求麦克风权限...");
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          audioContext = new AudioContextCtor();
          source = audioContext.createMediaStreamSource(stream);
          await attachProcessor();
          await resumeAudioContext();
          updateContext(true);
          setState("Listening", "Live 流式聆听中，可在播报时直接打断。");
          window.addEventListener("pointerdown", resumeAudioContext, { once: true });
          window.addEventListener("keydown", resumeAudioContext, { once: true });
        } catch (error) {
          cleanupAudio();
          closeWebSocket();
          setState("Error", normalizeMediaError(error));
        }
      }

      function stop() {
        liveToggle.checked = false;
        stopPlayback();
        cleanupAudio();
        closeWebSocket();
        setState("Off", "Live 已关闭，可使用手动录音或选择音频。");
      }

      function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(protocol + "//" + location.host + "/ws/live");
        ws.binaryType = "arraybuffer";
        ws.addEventListener("open", () => {
          sendControl({ type: "start", sessionId, mode: "demo_assisted", context: selectedMockPayload() });
          setState("Listening", "Live 已连接，正在流式聆听。");
        });
        ws.addEventListener("message", handleWsMessage);
        ws.addEventListener("close", () => {
          if (liveToggle.checked) {
            setState("Error", "Live WebSocket 已断开，可关闭后重试或使用旧按钮回退。");
          }
        });
        ws.addEventListener("error", () => {
          setState("Error", "Live WebSocket 连接失败，可使用手动录音或文本回退。");
        });
      }

      function closeWebSocket() {
        if (ws) {
          ws.close();
        }
        ws = null;
      }

      function sendControl(payload) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      }

      function updateContext(force = false) {
        const now = performance.now();
        if (!force && now - lastContextAt < config.contextRefreshMs) {
          return;
        }
        lastContextAt = now;
        sendControl({ type: "context", payload: selectedMockPayload() });
      }

      async function attachProcessor() {
        if (audioContext.audioWorklet) {
          const workletCode = [
            "class LivePcmProcessor extends AudioWorkletProcessor {",
            "  process(inputs, outputs) {",
            "    const input = inputs[0] && inputs[0][0];",
            "    const output = outputs[0] && outputs[0][0];",
            "    if (output) output.fill(0);",
            "    if (input) this.port.postMessage(input.slice(0));",
            "    return true;",
            "  }",
            "}",
            "registerProcessor('live-pcm-processor', LivePcmProcessor);"
          ].join("\\n");
          workletUrl = URL.createObjectURL(new Blob([workletCode], { type: "text/javascript" }));
          await audioContext.audioWorklet.addModule(workletUrl);
          processor = new AudioWorkletNode(audioContext, "live-pcm-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          processor.port.onmessage = (event) => processFrame(event.data);
          source.connect(processor);
          processor.connect(audioContext.destination);
          return;
        }

        processor = audioContext.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          event.outputBuffer.getChannelData(0).fill(0);
          processFrame(new Float32Array(input));
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
      }

      async function resumeAudioContext() {
        if (audioContext?.state === "suspended") {
          await audioContext.resume().catch(() => {});
        }
      }

      function processFrame(frame) {
        if (!liveToggle.checked || manualPaused) {
          return;
        }

        const pcm = frame instanceof Float32Array ? frame : new Float32Array(frame);
        const level = rms(pcm);
        const sampleRate = audioContext?.sampleRate || config.targetSampleRate;
        const frameMs = (pcm.length / sampleRate) * 1000;
        const listenThreshold = Math.max(config.minRms, noiseFloor * config.noiseMultiplier);
        const bargeThreshold = Math.max(config.bargeInMinRms, noiseFloor * config.bargeInNoiseMultiplier);
        const voiced = level >= listenThreshold;
        updateMeter(level, state === "Speaking" ? bargeThreshold : listenThreshold);
        updateContext();

        if (state !== "Speaking") {
          noiseFloor = noiseFloor * 0.97 + Math.min(level, 0.05) * 0.03;
        }

        if (state === "Speaking") {
          // Only treat playback-time input as a real barge-in once it stays clearly
          // above the higher threshold for a sustained window; a single sub-threshold
          // frame resets it so echo transients can no longer self-interrupt.
          if (level >= bargeThreshold) {
            bargeInVoicedMs += frameMs;
          } else {
            bargeInVoicedMs = 0;
          }
          if (bargeInVoicedMs >= config.bargeInSpeechMs && !bargeInSent) {
            bargeInSent = true;
            bargeInVoicedMs = 0;
            sendControl({ type: "barge_in" });
            stopPlayback();
            setState("Capturing", "检测到持续说话，已停止播报并继续聆听。");
          }
        } else {
          if (voiced && state !== "Capturing") {
            setState("Capturing", "检测到语音，正在流式上传...");
          } else if (!voiced && state === "Capturing") {
            setState("Listening", "等待 final 识别结果...");
          }

          const nowMs = performance.now();
          if (voiced) {
            utteranceActive = true;
            lastVoiceAt = nowMs;
            voicedMsInUtterance += frameMs;
          } else if (utteranceActive && nowMs - lastVoiceAt >= config.commitSilenceMs) {
            const hadEnoughSpeech = voicedMsInUtterance >= config.minUtteranceMs;
            utteranceActive = false;
            voicedMsInUtterance = 0;
            // Drop sub-threshold blips silently; only commit a real utterance.
            if (hadEnoughSpeech) {
              sendControl({ type: "commit" });
            }
          }
        }

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const downsampled = downsamplePcm(pcm, audioContext.sampleRate, config.targetSampleRate);
        const pcm16 = floatToPcm16(downsampled);
        if (pcm16.byteLength > 0) {
          ws.send(pcm16);
        }
      }

      async function handleWsMessage(event) {
        if (event.data instanceof ArrayBuffer) {
          playPcmChunk(event.data, pendingAudio);
          return;
        }

        let message = null;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === "partial") {
          document.querySelector("#transcript").textContent = message.text || "";
          if (message.text) {
            setState("Capturing", "实时字幕：" + message.text);
          }
          return;
        }

        if (message.type === "final") {
          document.querySelector("#transcript").textContent = message.text || "";
          document.querySelector("#sttIntent").textContent = message.intent || "";
          setState("Thinking", "final 已提交，正在生成指导...");
          return;
        }

        if (message.type === "guidance") {
          const action = message.action || {};
          document.querySelector("#intent").textContent = action.intent || "";
          document.querySelector("#guidanceSource").textContent = message.source || "";
          document.querySelector("#responseType").textContent = message.response_type || "";
          document.querySelector("#liveDriverSource").textContent = message.source || "";
          document.querySelector("#ttsText").textContent = action.tts?.text || "";
          document.querySelector("#raw").textContent = JSON.stringify(message, null, 2);
          setStatus("live ok");
          return;
        }

        if (message.type === "state") {
          if (message.current_stage !== undefined) {
            currentStage = message.current_stage || "";
            document.querySelector("#stage").textContent = currentStage;
            updateMockSummary();
          }
          return;
        }

        if (message.type === "audio_begin") {
          pendingAudio = {
            actionId: message.action_id || message.actionId,
            sampleRate: message.sample_rate || message.sampleRate || config.targetSampleRate,
            channels: message.channels || 1
          };
          onPlaybackStart();
          return;
        }

        if (message.type === "audio_end") {
          schedulePlaybackEnd();
          return;
        }

        if (message.type === "audio_cancel") {
          stopPlayback();
          return;
        }

        if (message.type === "error") {
          setStatus(message.error?.message || "Live error", true);
          setState("Error", message.error?.message || "Live error");
        }
      }

      function onPlaybackStart() {
        if (!liveToggle.checked) {
          return;
        }
        bargeInSent = false;
        bargeInVoicedMs = 0;
        setState("Speaking", "正在播报，麦克风保持开启，可直接打断。");
      }

      function onPlaybackEnd() {
        if (!liveToggle.checked) {
          return;
        }
        pendingAudio = null;
        resetCapture();
        setState("Listening", "播报结束，继续流式聆听。");
      }

      function resetCapture() {
        bargeInSent = false;
        bargeInVoicedMs = 0;
        utteranceActive = false;
        voicedMsInUtterance = 0;
      }

      function pauseForManualInput() {
        manualPaused = true;
        resetCapture();
        if (liveToggle.checked) {
          setState("Off", "手动录音中，Live 暂停。");
        }
      }

      function resumeAfterManualInput() {
        manualPaused = false;
        if (liveToggle.checked && stream) {
          setState("Listening", "手动录音结束，Live 继续聆听。");
        }
      }

      function setState(nextState, hint) {
        state = nextState;
        liveState.dataset.state = nextState;
        liveStateText.textContent = nextState;
        if (hint) {
          liveHint.textContent = hint;
        }
      }

      function cleanupAudio() {
        if (processor) {
          processor.disconnect?.();
          processor.port && (processor.port.onmessage = null);
          processor.onaudioprocess = null;
        }
        source?.disconnect?.();
        stream?.getTracks().forEach((track) => track.stop());
        audioContext?.close?.();
        if (workletUrl) {
          URL.revokeObjectURL(workletUrl);
        }
        stream = null;
        audioContext = null;
        source = null;
        processor = null;
        workletUrl = "";
        liveMeter.textContent = "";
      }

      function ensurePlaybackContext(sampleRate) {
        if (!playbackContext) {
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          playbackContext = new AudioContextCtor({ sampleRate });
        }
        if (playbackContext.state === "suspended") {
          playbackContext.resume().catch(() => {});
        }
        if (!playbackCursor || playbackCursor < playbackContext.currentTime + 0.02) {
          playbackCursor = playbackContext.currentTime + 0.02;
        }
        return playbackContext;
      }

      function playPcmChunk(arrayBuffer, audioMeta) {
        const meta = audioMeta || { sampleRate: config.targetSampleRate, channels: 1 };
        const ctx = ensurePlaybackContext(meta.sampleRate);
        const pcm16 = new Int16Array(arrayBuffer);
        const channels = Math.max(1, meta.channels || 1);
        const frames = Math.floor(pcm16.length / channels);
        if (frames <= 0) {
          return;
        }

        const audioBuffer = ctx.createBuffer(channels, frames, meta.sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
          const out = audioBuffer.getChannelData(channel);
          for (let i = 0; i < frames; i += 1) {
            out[i] = pcm16[i * channels + channel] / 0x8000;
          }
        }

        const node = ctx.createBufferSource();
        node.buffer = audioBuffer;
        node.connect(ctx.destination);
        node.start(playbackCursor);
        playbackCursor += audioBuffer.duration;
        playbackSources.push(node);
      }

      function schedulePlaybackEnd() {
        clearTimeout(playbackEndTimer);
        const delayMs = playbackContext
          ? Math.max(0, (playbackCursor - playbackContext.currentTime) * 1000 + 40)
          : 0;
        playbackEndTimer = window.setTimeout(() => {
          playbackSources = [];
          onPlaybackEnd();
        }, delayMs);
      }

      function stopPlayback() {
        clearTimeout(playbackEndTimer);
        playbackSources.forEach((node) => {
          try { node.stop(); } catch {}
        });
        playbackSources = [];
        pendingAudio = null;
        playbackCursor = playbackContext?.currentTime || 0;
        if (liveToggle.checked) {
          setState("Listening", "已停止播报，继续流式聆听。");
        }
      }

      function updateMeter(level, threshold) {
        liveMeter.textContent = "RMS " + level.toFixed(3) + " / 阈值 " + threshold.toFixed(3);
      }

      function rms(frame) {
        let sum = 0;
        for (let i = 0; i < frame.length; i += 1) {
          sum += frame[i] * frame[i];
        }
        return Math.sqrt(sum / Math.max(frame.length, 1));
      }

      function captureDurationMs(frames) {
        const samples = frames.reduce((sum, item) => sum + item.length, 0);
        return (samples / audioContext.sampleRate) * 1000;
      }

      function floatToPcm16(samples) {
        const buffer = new ArrayBuffer(samples.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < samples.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, samples[i]));
          view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }
        return buffer;
      }
    }

    function createRealVisionController() {
      const config = {
        minConfidence: 0.75,
        minPostIntervalMs: 900,
        inferenceIntervalMs: 100,
        readinessDropGraceMs: 2500,
        recordingOnlyDelayMs: 5000,
        modelUrl: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
        wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
        tasksVisionUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35"
      };
      let stream = null;
      let poseLandmarker = null;
      let metricsTracker = null;
      let animationId = 0;
      let lastInferenceAt = 0;
      let lastPostAt = 0;
      let lastLiveRecognitionAt = 0;
      let readinessFailureStartedAt = 0;
      let lastVideoFrameTime = null;
      let lastVideoFrameTimestampMs = null;
      let posting = false;
      let started = false;
      let inputSource = "camera";

      return {
        startIfEnabled,
        stop,
        updateContext,
        onVideoPlaybackResumed,
        onVideoPlaybackPaused
      };

      async function startIfEnabled() {
        if (!realVisionToggle.checked || started) {
          return;
        }
        inputSource = selectedVisionVideoUrl ? "video_file" : "camera";
        if (inputSource === "camera" && !navigator.mediaDevices?.getUserMedia) {
          setState("Error", "当前浏览器不支持摄像头 getUserMedia，请继续使用 Mock Vision。");
          return;
        }

        started = true;
        try {
          setState("Loading", "正在加载 MediaPipe Pose 和 CPR 指标模块...");
          const [{ FilesetResolver, PoseLandmarker }, metricsModule] = await Promise.all([
            import(config.tasksVisionUrl),
            import("/vision/cprMetrics.js")
          ]);
          if (typeof metricsModule.createCprMetricsTracker !== "function") {
            throw new Error("cprMetrics 模块缺少 createCprMetricsTracker(options) 导出。");
          }
          const vision = await FilesetResolver.forVisionTasks(config.wasmUrl);
          poseLandmarker = await createPoseLandmarker(PoseLandmarker, vision);
          metricsTracker = metricsModule.createCprMetricsTracker({
            minConfidence: config.minConfidence,
            source: "web_mediapipe_pose",
            mirrorX: inputSource === "camera",
            handPositionReference: "calibrated"
          });

          if (inputSource === "video_file") {
            setState("Loading", "正在加载测试视频：" + selectedVisionVideoName);
            stream = null;
            realVisionVideo.srcObject = null;
            realVisionVideo.muted = true;
            realVisionVideo.playsInline = true;
            realVisionVideo.autoplay = true;
            realVisionVideo.preload = "auto";
            realVisionVideo.src = selectedVisionVideoUrl;
            realVisionVideo.loop = true;
            realVisionVideo.controls = true;
            realVisionVideo.dataset.source = "video";
            realVisionVideo.load();
          } else {
            setState("Loading", "正在请求摄像头权限...");
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 }
              },
              audio: false
            });
            realVisionVideo.removeAttribute("src");
            realVisionVideo.srcObject = stream;
            realVisionVideo.controls = false;
            realVisionVideo.dataset.source = "camera";
          }
          const playbackReady = inputSource === "video_file"
            ? await startTestVideoPlayback()
            : await startCameraPlayback();
          if (!started) {
            return;
          }
          setState(playbackReady ? "Running" : "Paused", playbackReady
            ? isRealVisionStage()
              ? runningMessage()
              : "真实视觉已就绪，等待流程进入 S6/S7。"
            : pausedVideoMessage());
          scheduleLoop();
        } catch (error) {
          stop();
          setState("Error", normalizeRealVisionError(error));
        }
      }

      function stop(options = {}) {
        started = false;
        if (animationId) {
          cancelAnimationFrame(animationId);
        }
        animationId = 0;
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        realVisionVideo.pause();
        if (!options.keepSelection) {
          realVisionVideo.removeAttribute("src");
        }
        realVisionVideo.srcObject = null;
        realVisionVideo.removeAttribute("data-source");
        poseLandmarker?.close?.();
        poseLandmarker = null;
        metricsTracker = null;
        lastLiveRecognitionAt = 0;
        readinessFailureStartedAt = 0;
        lastVideoFrameTime = null;
        lastVideoFrameTimestampMs = null;
        posting = false;
        if (!realVisionToggle.checked) {
          setState("Off", "真实视觉已关闭，Mock Vision 仍可使用。");
        }
      }

      function updateContext() {
        if (!started) {
          return;
        }
        if (isRealVisionStage()) {
          setState(inputSource === "video_file" && realVisionVideo.paused ? "Paused" : "Running",
            inputSource === "video_file" && realVisionVideo.paused ? pausedVideoMessage() : runningMessage());
        } else {
          setState(inputSource === "video_file" && realVisionVideo.paused ? "Paused" : "Running",
            inputSource === "video_file" && realVisionVideo.paused
              ? pausedVideoMessage()
              : "真实视觉已就绪，等待流程进入 S6/S7。");
        }
      }

      function onVideoPlaybackResumed() {
        if (!started || inputSource !== "video_file") {
          return;
        }
        setState("Running", isRealVisionStage()
          ? runningMessage()
          : "测试视频已恢复播放，真实视觉已就绪，等待流程进入 S6/S7。");
      }

      function onVideoPlaybackPaused() {
        if (!started || inputSource !== "video_file" || realVisionVideo.ended) {
          return;
        }
        setState("Paused", pausedVideoMessage());
      }

      function runningMessage() {
        return inputSource === "video_file"
          ? "测试视频回放中，正在用 MediaPipe 分析 CPR 姿态。"
          : "真实视觉运行中，正在分析 CPR 姿态。";
      }

      function pausedVideoMessage() {
        return "测试视频已加载，但浏览器暂停了自动播放；可点视频播放继续动态回放，当前仍会分析已加载帧。";
      }

      function scheduleLoop() {
        animationId = requestAnimationFrame(loop);
      }

      async function loop(timestampMs) {
        if (!started || !poseLandmarker || !metricsTracker) {
          return;
        }
        try {
          syncVideoPlaybackStateBadge();
          if (isRealVisionStage() && realVisionVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            await maybeProcessFrame(timestampMs);
          }
        } catch (error) {
          setState("Error", normalizeRealVisionError(error));
        } finally {
          if (started) {
            scheduleLoop();
          }
        }
      }

      function syncVideoPlaybackStateBadge() {
        if (inputSource !== "video_file") {
          return;
        }
        const nextState = realVisionVideo.paused ? "Paused" : "Running";
        if (realVisionStateText.textContent !== nextState) {
          realVisionState.dataset.state = nextState;
          realVisionStateText.textContent = nextState;
        }
      }

      async function startCameraPlayback() {
        await realVisionVideo.play();
        return true;
      }

      async function startTestVideoPlayback() {
        await waitForVideoReady();
        try {
          await realVisionVideo.play();
          return !realVisionVideo.paused;
        } catch (error) {
          console.warn("Real Vision test video autoplay was blocked; continuing with loaded frames.", error);
          return false;
        }
      }

      function waitForVideoReady(timeoutMs = 3500) {
        if (realVisionVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          let timeoutId = 0;
          const cleanup = () => {
            clearTimeout(timeoutId);
            realVisionVideo.removeEventListener("loadeddata", onReady);
            realVisionVideo.removeEventListener("canplay", onReady);
            realVisionVideo.removeEventListener("error", onError);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(realVisionVideo.error || new Error("测试视频加载失败。"));
          };
          timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("测试视频加载超时。"));
          }, timeoutMs);
          realVisionVideo.addEventListener("loadeddata", onReady, { once: true });
          realVisionVideo.addEventListener("canplay", onReady, { once: true });
          realVisionVideo.addEventListener("error", onError, { once: true });
        });
      }

      async function maybeProcessFrame(timestampMs) {
        if (timestampMs - lastInferenceAt < config.inferenceIntervalMs) {
          return;
        }
        lastInferenceAt = timestampMs;
        resetVideoMetricsOnTimelineJump(timestampMs);

        const result = poseLandmarker.detectForVideo(realVisionVideo, timestampMs);
        const landmarks = result?.landmarks?.[0] || null;
        if (!landmarks?.length) {
          setCaptureContinuousStatus(timestampMs, null, "未检测到人体姿态；请让上半身和双臂进入画面。");
          return;
        }

        const rawQuality = metricsTracker.update(landmarks, timestampMs);
        const cprQuality = normalizeCprQualityForEvent(rawQuality);
        const confidence = firstNumber(cprQuality.confidence, estimatePoseConfidence(landmarks));
        cprQuality.confidence = confidence;

        if (confidence < config.minConfidence) {
          setCaptureContinuousStatus(timestampMs, { confidence }, "姿态置信度低 " + confidence.toFixed(2) + "，暂不上报。");
          return;
        }
        if (cprQuality.vision_ready !== true) {
          setCaptureContinuousStatus(timestampMs, cprQuality, summarizeVisionReadiness(cprQuality));
          return;
        }
        if (!hasUsefulCprQuality(cprQuality)) {
          markLiveRecognition(timestampMs);
          realVisionStatus.textContent = "采集持续：姿态已识别，等待 CPR 质量指标稳定。";
          return;
        }
        markLiveRecognition(timestampMs);
        if (posting || timestampMs - lastPostAt < config.minPostIntervalMs) {
          realVisionStatus.textContent = summarizeCprQuality(cprQuality, "已识别");
          return;
        }

        posting = true;
        lastPostAt = timestampMs;
        try {
          realVisionStatus.textContent = summarizeCprQuality(cprQuality, "上报中");
          const response = await sendTurn({
            eventSource: "vision_cpr",
            eventType: "cpr_quality_update",
            cprQuality,
            metadata: {
              perception_mode: "real_perception",
              perception_provider: "mediapipe_tasks_vision",
              model: "pose_landmarker_lite",
              model_asset: "cdn",
              stage_at_capture: currentStage,
              vision_input_source: inputSource,
              camera_facing: inputSource === "camera" ? "front" : "unknown",
              camera_mount: inputSource === "camera" ? "side_fixed" : "unknown",
              mirrored: inputSource === "camera",
              vision_ready: cprQuality.vision_ready,
              pose_coverage: cprQuality.pose_coverage,
              frame_stability: cprQuality.frame_stability,
              observed_window_ms: cprQuality.observed_window_ms
            }
          }, { vision: true });
          realVisionStatus.textContent = summarizeCprQuality(cprQuality, response.ok ? "已上报" : "上报失败");
        } finally {
          posting = false;
        }
      }

      function resetVideoMetricsOnTimelineJump(timestampMs) {
        if (inputSource !== "video_file") {
          return;
        }
        const currentTime = realVisionVideo.currentTime;
        if (!Number.isFinite(currentTime)) {
          return;
        }
        let hasTimelineJump = false;
        if (lastVideoFrameTime !== null) {
          const videoDelta = currentTime - lastVideoFrameTime;
          const wallDelta = Number.isFinite(timestampMs) && lastVideoFrameTimestampMs !== null
            ? Math.max(0, (timestampMs - lastVideoFrameTimestampMs) / 1000)
            : 0;
          hasTimelineJump =
            videoDelta < -0.25 ||
            videoDelta > Math.max(4, wallDelta + 2.5);
        }
        if (hasTimelineJump) {
          metricsTracker?.reset?.();
          lastPostAt = 0;
          posting = false;
        }
        lastVideoFrameTime = currentTime;
        lastVideoFrameTimestampMs = Number.isFinite(timestampMs) ? timestampMs : null;
      }

      function markLiveRecognition(timestampMs) {
        lastLiveRecognitionAt = Number.isFinite(timestampMs) ? timestampMs : performance.now();
        readinessFailureStartedAt = 0;
      }

      function setCaptureContinuousStatus(timestampMs, cprQuality, detail) {
        const now = Number.isFinite(timestampMs) ? timestampMs : performance.now();
        const hasRecentLive =
          lastLiveRecognitionAt > 0 &&
          now - lastLiveRecognitionAt <= config.readinessDropGraceMs;
        if (hasRecentLive) {
          realVisionStatus.textContent = "采集持续：识别信号短暂波动，暂不切换模式。 " + detail;
          return;
        }

        if (!readinessFailureStartedAt) {
          readinessFailureStartedAt = now;
        }
        const failedForMs = now - readinessFailureStartedAt;
        const prefix = failedForMs >= config.recordingOnlyDelayMs
          ? "采集持续：实时识别暂未就绪，继续采集。 "
          : "采集持续：正在等待画面稳定。 ";
        realVisionStatus.textContent = prefix + detail;
      }

      function setState(nextState, message) {
        realVisionState.dataset.state = nextState;
        realVisionStateText.textContent = nextState;
        realVisionStatus.textContent = message;
        realVisionHint.textContent = message;
      }

      function isRealVisionStage() {
        return currentStage === "S6_CPR_READY" || currentStage === "S7_CPR_LOOP";
      }

      function normalizeCprQualityForEvent(rawQuality) {
        const source = rawQuality?.cprQuality && typeof rawQuality.cprQuality === "object"
          ? rawQuality.cprQuality
          : rawQuality && typeof rawQuality === "object"
            ? rawQuality
            : {};
        const compressionRate = firstNumber(source.compression_rate, source.compressionRate, source.current_rate, source.currentRate, source.rate);
        const interruptionSeconds = firstNumber(source.interruption_seconds, source.interruptionSeconds, source.last_interruption_seconds);
        const handPosition = source.hand_position ?? source.handPosition ?? null;
        const armStraight = source.arm_straight ?? source.armStraight ?? source.arms_straight ?? null;
        const totalCompressions = firstNumber(source.total_compressions, source.totalCompressions, source.compression_count, source.compressions);
        const qualityScore = firstNumber(source.quality_score, source.qualityScore, source.score);
        const averageRate = firstNumber(source.average_rate, source.averageRate, source.avg_rate);
        const compressionsStarted = source.compressions_started ?? source.compressionsStarted ?? source.started;

        return removeUndefined({
          ...source,
          compressions_started: compressionsStarted,
          compression_rate: compressionRate,
          current_rate: compressionRate,
          average_rate: averageRate,
          quality_score: qualityScore,
          hand_position: handPosition,
          arm_straight: armStraight,
          arm_posture: armStraight === false ? "bent" : armStraight === true ? "straight" : source.arm_posture,
          interruption_seconds: interruptionSeconds,
          total_compressions: totalCompressions,
          vision_ready: source.vision_ready,
          pose_coverage: firstNumber(source.pose_coverage, source.poseCoverage),
          frame_stability: firstNumber(source.frame_stability, source.frameStability),
          observed_window_ms: firstNumber(source.observed_window_ms, source.observedWindowMs),
          confidence: firstNumber(source.confidence, source.pose_confidence, source.visibility)
        });
      }

      function hasUsefulCprQuality(cprQuality) {
        return (
          cprQuality.compressions_started != null ||
          cprQuality.compression_rate != null ||
          cprQuality.interruption_seconds != null ||
          cprQuality.hand_position != null ||
          cprQuality.arm_straight != null ||
          cprQuality.quality_score != null
        );
      }

      async function createPoseLandmarker(PoseLandmarker, vision) {
        const baseOptions = {
          modelAssetPath: config.modelUrl
        };
        const commonOptions = {
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        };
        try {
          return await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { ...baseOptions, delegate: "GPU" },
            ...commonOptions
          });
        } catch {
          return PoseLandmarker.createFromOptions(vision, {
            baseOptions,
            ...commonOptions
          });
        }
      }

      function estimatePoseConfidence(landmarks) {
        const indexes = [11, 12, 13, 14, 15, 16, 23, 24];
        let sum = 0;
        let count = 0;
        for (const index of indexes) {
          const landmark = landmarks[index];
          const value = firstNumber(landmark?.visibility, landmark?.presence);
          if (value !== null) {
            sum += value;
            count += 1;
          }
        }
        return count ? sum / count : 0;
      }

      function summarizeCprQuality(cprQuality, prefix) {
        const rate = firstNumber(cprQuality.compression_rate, cprQuality.current_rate);
        const score = firstNumber(cprQuality.quality_score);
        const confidence = firstNumber(cprQuality.confidence);
        return prefix + ": rate " + (rate === null ? "-" : Math.round(rate)) +
          " / hand " + (cprQuality.hand_position ?? "-") +
          " / arm " + (cprQuality.arm_straight === false ? "bent" : cprQuality.arm_straight === true ? "straight" : "-") +
          " / score " + (score === null ? "-" : Math.round(score)) +
          " / conf " + (confidence === null ? "-" : confidence.toFixed(2));
      }

      function summarizeVisionReadiness(cprQuality) {
        const coverage = firstNumber(cprQuality.pose_coverage);
        const stability = firstNumber(cprQuality.frame_stability);
        const observedMs = firstNumber(cprQuality.observed_window_ms);
        return "coverage " + formatRatio(coverage) +
          " / stability " + formatRatio(stability) +
          " / window " + (observedMs === null ? "-" : Math.round(observedMs) + "ms") +
          "，暂不上报实时识别。";
      }
    }

    function hydrateVisionVideoFromQuery() {
      const value = new URLSearchParams(location.search).get("vision_video");
      if (!value) {
        return;
      }
      const videoUrl = new URL(value, location.href);
      if (videoUrl.origin !== location.origin || !videoUrl.pathname.startsWith("/vision-test-assets/")) {
        realVisionSource.textContent = "来源：测试视频参数无效";
        return;
      }
      selectedVisionVideoUrl = videoUrl.pathname + videoUrl.search;
      selectedVisionVideoName = decodeURIComponent(videoUrl.pathname.split("/").pop() || "test-video");
      realVisionSource.textContent = "来源：测试视频 · " + selectedVisionVideoName;
    }

    function flattenFrames(frames) {
      const length = frames.reduce((sum, frame) => sum + frame.length, 0);
      const out = new Float32Array(length);
      let offset = 0;
      for (const frame of frames) {
        out.set(frame, offset);
        offset += frame.length;
      }
      return out;
    }

    function downsamplePcm(input, sourceRate, targetRate) {
      if (sourceRate === targetRate) {
        return input;
      }
      const ratio = sourceRate / targetRate;
      const outputLength = Math.max(1, Math.floor(input.length / ratio));
      const output = new Float32Array(outputLength);
      for (let i = 0; i < outputLength; i += 1) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j += 1) {
          sum += input[j];
          count += 1;
        }
        output[i] = count ? sum / count : input[start] || 0;
      }
      return output;
    }

    function encodeWavBase64(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      writeAscii(view, 0, "RIFF");
      view.setUint32(4, 36 + samples.length * 2, true);
      writeAscii(view, 8, "WAVE");
      writeAscii(view, 12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(view, 36, "data");
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return arrayBufferToBase64(buffer);
    }

    function writeAscii(view, offset, value) {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }

    async function runCprSetupSequence(options = {}) {
      runCprSetup.disabled = true;
      setStatus("running CPR setup...");
      const sequence = [
        ["scene_safe", "现场安全了"],
        ["unresponsive", "他没有反应"],
        ["no_breathing", "没有正常呼吸"],
        ["call_started", "120 已经拨打"],
        ["cpr_ready", "准备好了"],
        ["cpr_start", "开始按压"]
      ];

      try {
        let last = null;
        for (const [presetId, spokenText] of sequence) {
          const preset = MOCK_PRESETS.find((item) => item.id === presetId);
          last = await sendTurn(
            { ...(JSON.parse(JSON.stringify(preset?.payload || {}))), text: spokenText },
            { playAudio: false }
          );
        }
        if (last) render(last, { playAudio: options.playFinalAudio !== false });
        setStatus("CPR setup ready");
      } finally {
        runCprSetup.disabled = false;
      }
    }

    async function runLiveCprQuestion(presetId, spokenText) {
      setQuickButtonsDisabled(true);
      try {
        if (currentStage !== "S7_CPR_LOOP") {
          await runCprSetupSequence({ playFinalAudio: false });
        }
        const preset = MOCK_PRESETS.find((item) => item.id === presetId) || MOCK_PRESETS[0];
        mockVision.value = preset.id;
        text.value = spokenText;
        updateMockSummary();
        await sendTurn({ ...(JSON.parse(JSON.stringify(preset.payload || {}))), text: spokenText });
      } finally {
        setQuickButtonsDisabled(false);
      }
    }

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.classList.toggle("error", isError);
    }

    function pickRecordingMimeType() {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4"
      ];
      if (typeof MediaRecorder.isTypeSupported !== "function") {
        return "";
      }
      return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
    }

    function normalizeMediaError(error) {
      const name = error?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        return "麦克风权限被拒绝。请允许此页面使用麦克风，或用“选择音频”上传录音。";
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return "没有找到麦克风设备，请检查输入设备，或用“选择音频”上传录音。";
      }
      if (name === "NotReadableError" || name === "TrackStartError") {
        return "麦克风正被其他应用占用，请关闭占用程序后重试。";
      }
      return error?.message || "无法开始录音，请检查浏览器麦克风权限。";
    }

    function normalizeRealVisionError(error) {
      const name = error?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        return "摄像头权限被拒绝。真实视觉已回退，请使用 Mock Vision 下拉。";
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return "没有找到摄像头。真实视觉已回退，请使用 Mock Vision 下拉。";
      }
      if (name === "NotReadableError" || name === "TrackStartError") {
        return "摄像头正被其他应用占用。真实视觉已回退，请使用 Mock Vision 下拉。";
      }
      return (error?.message || "真实视觉加载失败") + "；请继续使用 Mock Vision 下拉。";
    }

    function firstNumber(...values) {
      for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
      }
      return null;
    }

    function removeUndefined(value) {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    }

    function formatRatio(value) {
      return value === null ? "-" : value.toFixed(2);
    }

    function setQuickButtonsDisabled(disabled) {
      startEmergency.disabled = disabled;
      runCprSetup.disabled = disabled;
      quickQuality.disabled = disabled;
      quickStop.disabled = disabled;
      quickAed.disabled = disabled;
    }

    function populateMockVision() {
      for (const preset of MOCK_PRESETS) {
        const option = document.createElement("option");
        option.value = preset.id;
        option.textContent = preset.label;
        mockVision.appendChild(option);
      }
      updateMockSummary();
    }

    function updateMockSummary() {
      const preset = selectedMockPreset();
      let summary = preset?.summary || "";
      const needsCprSetup = preset?.requiresCprLoop || preset?.requiresCprSetup || preset?.bestAfterCprSetup;
      const warn = Boolean(needsCprSetup && currentStage !== "S7_CPR_LOOP");
      if (warn) {
        const stage = currentStage || "未开始";
        summary += " · 当前阶段 " + stage + "，请先点“进入 CPR 测试状态”。";
      }
      mockSummary.textContent = summary;
      mockSummary.classList.toggle("warning", warn);
    }

    function selectedMockPreset() {
      return MOCK_PRESETS.find((preset) => preset.id === mockVision.value) || MOCK_PRESETS[0];
    }

    function selectedMockPayload() {
      const preset = selectedMockPreset();
      return JSON.parse(JSON.stringify(preset?.payload || {}));
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  </script>
</body>
</html>`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { loadEnv } = await import("../config/loadEnv.js");
  loadEnv();
  const started = await startVoiceServer();
  console.log(`FirstAid voice server listening at ${started.url}`);
}
