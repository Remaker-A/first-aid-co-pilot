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
    textarea { width: 100%; min-height: 92px; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid #b9c0b4; border-radius: 6px; resize: vertical; }
    button { border: 1px solid #1c5d48; background: #1f7a5a; color: white; border-radius: 6px; padding: 9px 12px; font: inherit; cursor: pointer; }
    button.secondary { background: white; color: #1c5d48; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .label { color: #59615a; font-size: 13px; margin-bottom: 4px; }
    .value { font-size: 18px; min-height: 28px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #202622; color: #eef5ed; border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; }
    audio { width: 100%; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>FirstAid Voice Demo</h1>
      <button id="reset" class="secondary" type="button">Reset</button>
    </header>
    <form id="turnForm">
      <div class="label">输入文本，或录一段音频走 Mock STT</div>
      <textarea id="text" placeholder="例如：现场安全了 / 他没有反应 / 没有正常呼吸 / 120 已经拨打 / 急救员到了"></textarea>
      <div class="row" style="margin-top: 10px;">
        <button id="send" type="submit">Send Turn</button>
        <button id="record" class="secondary" type="button">Record Audio</button>
        <span id="status"></span>
      </div>
    </form>
    <section class="grid">
      <div><div class="label">Transcript</div><div id="transcript" class="value"></div></div>
      <div><div class="label">Stage</div><div id="stage" class="value"></div></div>
      <div><div class="label">Patch Intent</div><div id="intent" class="value"></div></div>
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
    let recordedAudio = null;
    let mediaRecorder = null;
    let chunks = [];

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendTurn({ text: text.value, ...recordedAudio });
      recordedAudio = null;
    });

    document.querySelector("#reset").addEventListener("click", async () => {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      render({});
      statusEl.textContent = "reset";
    });

    record.addEventListener("click", async () => {
      if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
        recordedAudio = {
          audioBase64: await blobToBase64(blob),
          mimeType: blob.type
        };
        statusEl.textContent = "audio ready";
        record.textContent = "Record Audio";
      };
      mediaRecorder.start();
      record.textContent = "Stop Recording";
      statusEl.textContent = "recording...";
    });

    async function sendTurn(payload) {
      statusEl.textContent = "sending...";
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload })
      });
      const json = await response.json();
      render(json);
      statusEl.textContent = json.ok ? "ok" : "error";
    }

    function render(json) {
      document.querySelector("#transcript").textContent = json.transcript || "";
      document.querySelector("#stage").textContent = json.state?.current_stage || "";
      document.querySelector("#intent").textContent = json.guidance_action?.intent || json.action_patch?.intent || "";
      document.querySelector("#ttsText").textContent = json.guidance_action?.tts?.text || json.state_action?.tts?.text || "";
      const audio = document.querySelector("#audio");
      audio.src = json.tts?.audio?.url || json.tts?.audio?.data_url || "";
      if (audio.src) audio.play().catch(() => {});
      document.querySelector("#raw").textContent = JSON.stringify(json, null, 2);
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
