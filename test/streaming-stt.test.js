import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildStreamingSttInvocation,
  createStreamingStt,
  resolveStreamingSttPlan,
} from "../src/voice/streamingStt.js";

test("resolveStreamingSttPlan defaults to bundled stream script and stt-stream model dir", () => {
  const plan = resolveStreamingSttPlan({});
  assert.match(plan.script, /scripts[\\/]speech[\\/]sherpa_stt_stream\.py$/);
  assert.match(plan.modelDir, /models[\\/]speech[\\/]stt-stream$/);
  assert.equal(plan.sampleRate, 16000);
  assert.equal(plan.numThreads, 1);
  assert.equal(plan.provider, "cpu");

  const invocation = buildStreamingSttInvocation({
    ...plan,
    command: "python",
    script: "/opt/sherpa_stt_stream.py",
    modelDir: "/models/stt-stream",
  });
  assert.equal(invocation.command, "python");
  assert.deepEqual(invocation.args.slice(0, 4), [
    path.resolve("/opt/sherpa_stt_stream.py"),
    "--model-dir",
    path.resolve("/models/stt-stream"),
    "--sample-rate",
  ]);
});

test("StreamingSttSession emits partial and final transcripts with inferred intent", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-streaming-stt-"));
  const fixturePath = path.join(tmpDir, "fake-streaming-stt.cjs");
  const fixtureSource =
    'process.stdout.write(JSON.stringify({ type: "ready", sample_rate: 16000 }) + "\\n");\n' +
    'let buffer = "";\n' +
    'process.stdin.setEncoding("utf8");\n' +
    'process.stdin.on("data", (chunk) => {\n' +
    '  buffer += chunk;\n' +
    '  let newline = buffer.indexOf("\\n");\n' +
    '  while (newline >= 0) {\n' +
    '    const line = buffer.slice(0, newline).trim();\n' +
    '    buffer = buffer.slice(newline + 1);\n' +
    '    if (line) {\n' +
    '      const request = JSON.parse(line);\n' +
    '      if (request.type === "audio") {\n' +
    '        process.stdout.write(JSON.stringify({ type: "partial", text: "现场安全" }) + "\\n");\n' +
    '      }\n' +
    '      if (request.type === "end") {\n' +
    '        process.stdout.write(JSON.stringify({ type: "final", text: "现场安全了" }) + "\\n");\n' +
    '      }\n' +
    '    }\n' +
    '    newline = buffer.indexOf("\\n");\n' +
    '  }\n' +
    '});\n';

  await fs.writeFile(fixturePath, fixtureSource, "utf8");

  const session = createStreamingStt({
    python: process.execPath,
    script: fixturePath,
    modelDir: tmpDir,
    readyTimeoutMs: 2000,
  });

  try {
    await session.waitUntilReady();

    const partialPromise = once(session, "partial");
    session.feed(Buffer.from([0, 0, 1, 0]));
    const [partial] = await partialPromise;
    assert.equal(partial.text, "现场安全");

    const finalPromise = once(session, "final");
    session.end();
    const [final] = await finalPromise;
    assert.equal(final.text, "现场安全了");
    assert.equal(final.transcript, "现场安全了");
    assert.equal(final.intent, "scene_safe");
  } finally {
    session.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
