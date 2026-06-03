import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVoiceDemoService } from "./service.js";
import { getRuntimeDir } from "./tts.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function createVoiceServer(options = {}) {
  const service = options.service || createVoiceDemoService(options.serviceOptions || {});

  return http.createServer(async (req, res) => {
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
      tts_provider: process.env.SHERPA_ONNX_TTS_COMMAND ? "sherpa-onnx" : "mock",
    });
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

  sendJson(res, 404, { ok: false, error: { message: "Not found." } });
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

function renderDemoPage() {
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
    const audio = document.querySelector("#audio");
    let recordedAudio = null;
    let mediaRecorder = null;
    let chunks = [];
    let currentStage = "";

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
    liveToggle.addEventListener("change", () => {
      if (liveToggle.checked) {
        liveController.startIfEnabled();
      } else {
        liveController.stop();
      }
    });
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

    mockVision.addEventListener("change", updateMockSummary);

    document.querySelector("#reset").addEventListener("click", async () => {
      liveController.stop();
      liveToggle.checked = false;
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
    }

    function createLiveController() {
      const config = {
        targetSampleRate: 16000,
        minSpeechMs: 300,
        endSilenceMs: 600,
        maxSpeechMs: 15000,
        preRollMs: 250,
        minRms: 0.014,
        noiseMultiplier: 3.2
      };
      let stream = null;
      let audioContext = null;
      let source = null;
      let processor = null;
      let workletUrl = "";
      let state = "Idle";
      let manualPaused = false;
      let captureFrames = [];
      let preRollFrames = [];
      let captureMs = 0;
      let speechMs = 0;
      let silenceMs = 0;
      let noiseFloor = 0.004;
      let flushing = false;

      return {
        startIfEnabled,
        stop,
        setState,
        onPlaybackStart,
        onPlaybackEnd,
        pauseForManualInput,
        resumeAfterManualInput
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
          setState("Listening", "聆听中，说完后会自动提交。");
          window.addEventListener("pointerdown", resumeAudioContext, { once: true });
          window.addEventListener("keydown", resumeAudioContext, { once: true });
        } catch (error) {
          cleanupAudio();
          setState("Error", normalizeMediaError(error));
        }
      }

      function stop() {
        liveToggle.checked = false;
        resetCapture();
        cleanupAudio();
        setState("Off", "Live 已关闭，可使用手动录音或选择音频。");
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
        if (!liveToggle.checked || manualPaused || flushing || state === "Uploading" || state === "Thinking" || state === "Speaking") {
          return;
        }

        const pcm = frame instanceof Float32Array ? frame : new Float32Array(frame);
        const frameMs = (pcm.length / audioContext.sampleRate) * 1000;
        const level = rms(pcm);
        const threshold = Math.max(config.minRms, noiseFloor * config.noiseMultiplier);
        const voiced = level >= threshold;
        updateMeter(level, threshold);

        if (state !== "Capturing") {
          noiseFloor = noiseFloor * 0.97 + Math.min(level, 0.05) * 0.03;
          pushPreRoll(pcm);
          if (voiced) {
            captureFrames = preRollFrames.map((item) => item.slice(0));
            captureFrames.push(pcm.slice(0));
            captureMs = captureDurationMs(captureFrames);
            speechMs = frameMs;
            silenceMs = 0;
            setState("Capturing", "检测到语音，正在收声...");
          } else if (state !== "Listening") {
            setState("Listening", "聆听中，说完后会自动提交。");
          }
          return;
        }

        captureFrames.push(pcm.slice(0));
        captureMs += frameMs;
        if (voiced) {
          speechMs += frameMs;
          silenceMs = 0;
        } else {
          silenceMs += frameMs;
        }

        if (speechMs < config.minSpeechMs && silenceMs >= config.endSilenceMs) {
          resetCapture();
          setState("Listening", "语音过短，继续聆听。");
          return;
        }

        if (captureMs >= config.maxSpeechMs || (speechMs >= config.minSpeechMs && silenceMs >= config.endSilenceMs)) {
          flushCapture();
        }
      }

      async function flushCapture() {
        if (flushing) {
          return;
        }
        flushing = true;
        const frames = captureFrames;
        const speechDuration = speechMs;
        resetCapture();

        if (speechDuration < config.minSpeechMs) {
          flushing = false;
          setState("Listening", "语音过短，继续聆听。");
          return;
        }

        try {
          setState("Uploading", "正在编码 16k WAV 并提交...");
          await nextFrame();
          const pcm = flattenFrames(frames);
          const downsampled = downsamplePcm(pcm, audioContext.sampleRate, config.targetSampleRate);
          const audioBase64 = encodeWavBase64(downsampled, config.targetSampleRate);
          await sendTurn({
            ...selectedMockPayload(),
            audioBase64,
            mimeType: "audio/wav"
          }, { live: true });
        } catch (error) {
          setStatus(error?.message || "Live 语音提交失败", true);
          setState("Listening", "提交失败，继续聆听。");
        } finally {
          flushing = false;
        }
      }

      function onPlaybackStart() {
        if (!liveToggle.checked) {
          return;
        }
        resetCapture();
        setState("Speaking", "正在播报，已暂停收声。");
      }

      function onPlaybackEnd() {
        if (!liveToggle.checked) {
          return;
        }
        resetCapture();
        setState("Listening", "播报结束，继续聆听。");
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

      function resetCapture() {
        captureFrames = [];
        captureMs = 0;
        speechMs = 0;
        silenceMs = 0;
      }

      function pushPreRoll(frame) {
        preRollFrames.push(frame.slice(0));
        const maxSamples = Math.ceil((audioContext.sampleRate * config.preRollMs) / 1000);
        let total = preRollFrames.reduce((sum, item) => sum + item.length, 0);
        while (total > maxSamples && preRollFrames.length > 1) {
          total -= preRollFrames.shift().length;
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
