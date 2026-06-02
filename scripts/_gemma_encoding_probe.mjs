// Probe: capture RAW bytes from litert-lm stdout (no setEncoding) and decode
// as both utf8 and gbk to verify the output encoding. Read-only diagnostic.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "_gemma_encoding_probe_result.json");

const command = process.env.GEMMA_COMMAND || process.env.LITERT_LM_COMMAND || "litert-lm";
const model = path.resolve(
  __dirname,
  "..",
  "models",
  "gemma",
  "gemma-4-E2B-it-litert-lm",
  "gemma-4-E2B-it.litertlm"
);
const prompt =
  "只用中文回答，输出一句关于胸外按压的简短提示，不要解释，只输出一句话：";

const child = spawn(command, ["run", model, "--backend=cpu", `--prompt=${prompt}`], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

const stdoutChunks = [];
const stderrChunks = [];
child.stdout.on("data", (c) => stdoutChunks.push(c));
child.stderr.on("data", (c) => stderrChunks.push(c));

child.on("close", (code) => {
  const raw = Buffer.concat(stdoutChunks);
  const utf8 = raw.toString("utf8");
  let gbk = "<gbk decode unavailable>";
  try {
    gbk = new TextDecoder("gbk").decode(raw);
  } catch (e) {
    gbk = `<error: ${e.message}>`;
  }
  const cjk = /[\u4e00-\u9fff]/;
  const payload = {
    exit_code: code,
    command,
    raw_byte_length: raw.length,
    utf8_has_cjk: cjk.test(utf8),
    gbk_has_cjk: cjk.test(gbk),
    utf8_decode: utf8,
    gbk_decode: gbk,
    raw_hex_head: raw.subarray(0, 400).toString("hex"),
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `[probe] exit=${code} bytes=${raw.length} utf8_cjk=${payload.utf8_has_cjk} gbk_cjk=${payload.gbk_has_cjk}`
  );
  console.log(`[probe] result: ${OUT}`);
});
