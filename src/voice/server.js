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
    .quick-panel { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 12px; align-items: center; margin-top: 10px; padding: 12px; border: 1px solid #cbd8cf; border-radius: 8px; background: #f8fbf8; }
    .quick-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .label { color: #59615a; font-size: 13px; margin-bottom: 4px; }
    .value { font-size: 18px; min-height: 28px; }
    .summary { color: #59615a; font-size: 14px; min-height: 22px; }
    .summary.warning { color: #9a5b16; font-weight: 600; }
    #status { color: #59615a; }
    #status.error { color: #a33a2b; font-weight: 600; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #202622; color: #eef5ed; border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; }
    audio { width: 100%; }
    @media (max-width: 720px) {
      .quick-panel { grid-template-columns: 1fr; }
      .quick-actions { justify-content: flex-start; }
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
      <div class="quick-panel">
        <div>
          <div class="label">Live CPR 测试</div>
          <div class="summary">先进入 S7_CPR_LOOP，再连续测试视觉纠正和语音问题。</div>
        </div>
        <div class="quick-actions">
          <button id="runCprSetup" class="secondary" type="button">进入 CPR 测试状态</button>
          <button id="quickQuality" class="secondary" type="button">手位偏左 + 我按得对吗</button>
          <button id="quickStop" class="secondary" type="button">能不能停</button>
          <button id="quickAed" class="secondary" type="button">AED 来了怎么办</button>
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
        <button id="send" type="submit">发送回合</button>
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
    const runCprSetup = document.querySelector("#runCprSetup");
    const quickQuality = document.querySelector("#quickQuality");
    const quickStop = document.querySelector("#quickStop");
    const quickAed = document.querySelector("#quickAed");
    const mockSummary = document.querySelector("#mockSummary");
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
        summary: "建议在 CPR 中测试：vision_patient aed_available=true",
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
      await runLiveCprQuestion("aed_arrived", "AED 来了怎么办");
    });

    mockVision.addEventListener("change", updateMockSummary);

    document.querySelector("#reset").addEventListener("click", async () => {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      render({});
      currentStage = "";
      updateMockSummary();
      setStatus("reset");
    });

    record.addEventListener("click", async () => {
      if (mediaRecorder?.state === "recording") {
        setStatus("正在停止录音...");
        record.disabled = true;
        mediaRecorder.stop();
        return;
      }

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
            setStatus("录音已准备好，点“发送回合”进行 STT");
          } catch (error) {
            setStatus(error.message || "录音处理失败", true);
          } finally {
            record.textContent = "录音";
            record.disabled = false;
            mediaRecorder = null;
          }
        };
        mediaRecorder.start();
        record.textContent = "停止录音";
        record.disabled = false;
        setStatus("录音中... 再点一次停止");
      } catch (error) {
        record.textContent = "录音";
        record.disabled = false;
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
        setStatus("音频已准备好，点“发送回合”进行 STT");
      } catch (error) {
        setStatus(error.message || "音频文件读取失败", true);
      } finally {
        audioFile.value = "";
      }
    });

    async function sendTurn(payload, options = {}) {
      setStatus("sending...");
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload })
      });
      const json = await response.json();
      render(json, options);
      setStatus(json.ok ? "ok" : "error", !json.ok);
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
      const audio = document.querySelector("#audio");
      audio.src = json.tts?.audio?.url || json.tts?.audio?.data_url || "";
      if (audio.src && options.playAudio !== false) audio.play().catch(() => {});
      document.querySelector("#raw").textContent = JSON.stringify(json, null, 2);
      updateMockSummary();
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
