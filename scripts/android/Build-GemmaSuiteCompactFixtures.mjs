// Build-GemmaSuiteCompactFixtures.mjs
//
// Latency-optimization variant of the Gemma probe suite. On CPU each generation
// runs ~45s and prefill dominates, so a shorter prompt directly speeds up every
// run. This script produces android/app/src/main/assets/gemma_suite_compact/:
// a drop-in replacement suite whose `expected` judging metadata is IDENTICAL to
// the canonical gemma_suite, but whose `prompt` is a controlled, compressed
// rebuild of the exact canonical prompt string.
//
// Design (anti-drift / drop-in safe):
//   - At RUNTIME we read every canonical case file
//     android/app/src/main/assets/gemma_suite/<caseId>.json and copy
//     functionId / caseId / label / runs / expected VERBATIM (so handover's
//     expected.allowedNumbers etc. stay byte-for-byte identical, never recomputed).
//   - Only `prompt` is replaced. The compressed prompt is derived from the
//     canonical prompt (itself produced by the src/gemma/* production builders)
//     via a deterministic compression pipeline encoded below as drop-lists /
//     JSON minify / compact whitespace. No JSON is hand-edited.
//
// Compression levers (largest win first):
//   USER section
//     1. Drop the trailing redundant "[DecisionFrame JSON]" / "[NluFrame JSON]"
//        dump - it restates every labeled section already present above it.
//     2. Minify all pretty-printed JSON blocks (facts / schema / markers /
//        safety_phrases) to single lines.
//     3. handover: drop deterministic_report boilerplate lines (patient/session/
//        location/120-broadcast/rescuer) - facts JSON remains the authoritative
//        number source, so every required number survives.
//   SYSTEM section
//     4. Drop the minimal-example block (last section).
//     5. Drop optional schema fields visual_overlay / log_suggestion.
//     6. Strip "// ..." schema annotations and collapse alignment whitespace.
//   Global
//     7. Normalize CRLF->LF, drop a few English-only restatements that the
//        Chinese lines already cover, collapse multi-space / blank-line runs.
//
// MUST be preserved (asserted per case): role/safety hard limits, output JSON
// schema key fields, the intent whitelist + allowed_slots, key safety strings,
// and (handover) every expected number. Plus token <= ~900 and expected deep-eq.
//
// Usage: node scripts/android/Build-GemmaSuiteCompactFixtures.mjs

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ASSETS_DIR = path.join(REPO_ROOT, "android", "app", "src", "main", "assets");
const SRC_DIR = path.join(ASSETS_DIR, "gemma_suite");
const OUT_DIR = path.join(ASSETS_DIR, "gemma_suite_compact");

const SEP = "\n\nUSER:\n";
const TOKEN_BUDGET = 900;
const COMPACT_VERSION = "gemma_suite_compact_v1";

// ---------------------------------------------------------------------------
// Token estimate: Chinese ~1 token/char; non-CJK ~4 chars/token. Approximate by
// design (budget is "~900"), but stable and conservative for ASCII-heavy JSON.
// ---------------------------------------------------------------------------
const CJK_RE =
  /[\u2e80-\u2eff\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;

function estimateTokens(text) {
  const s = String(text || "");
  const cjk = (s.match(CJK_RE) || []).length;
  const rest = s.replace(CJK_RE, " ").replace(/\s+/g, " ").trim();
  const restTokens = rest.length > 0 ? Math.ceil(rest.length / 4) : 0;
  return cjk + restTokens;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Generic compression primitives.
// ---------------------------------------------------------------------------
function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// The full-frame dump is always the terminal block of the USER section for the
// patch / open_question / nlu prompts; truncating from its header to EOF removes
// it and nothing else. handover has no such block (no match -> no-op).
function dropTrailingFrameJsonBlock(userText) {
  return userText.replace(/\n\[[A-Za-z]+Frame JSON\][\s\S]*$/, "\n");
}

function dropLinesByPrefix(text, prefixes) {
  if (prefixes.length === 0) return text;
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !prefixes.some((prefix) => trimmed.startsWith(prefix));
    })
    .join("\n");
}

function dropExactEnglishLines(text, exact) {
  const set = new Set(exact);
  return text
    .split("\n")
    .filter((line) => !set.has(line.replace(/^\s*-\s*/, "").trim()))
    .join("\n");
}

// Replace every multi-line pretty-printed JSON object/array (a line that is just
// "{" or "[") with its minified single-line form. Brace depth is tracked across
// lines; JSON.parse guards correctness (on any failure the block is left as-is).
function minifyPrettyJsonBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "{" || trimmed === "[") {
      let depth = 0;
      let started = false;
      let end = i;
      const buf = [];
      for (let j = i; j < lines.length; j += 1) {
        buf.push(lines[j]);
        for (const ch of lines[j]) {
          if (ch === "{" || ch === "[") {
            depth += 1;
            started = true;
          } else if (ch === "}" || ch === "]") {
            depth -= 1;
          }
        }
        if (started && depth <= 0) {
          end = j;
          break;
        }
      }
      if (started && depth === 0) {
        try {
          const parsed = JSON.parse(buf.join("\n"));
          out.push(JSON.stringify(parsed));
          i = end;
          continue;
        } catch {
          // Not valid JSON after all - fall through and keep the original line.
        }
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// Drop a "key": { ... } block (multi-line, brace-balanced) whose opening line
// trims to start with one of `startTokens`. Used to remove optional schema
// fields from the SYSTEM schema sketch.
function dropBraceBlocks(lines, startTokens) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (startTokens.some((tok) => trimmed.startsWith(tok))) {
      let depth = 0;
      let started = false;
      let end = i;
      for (let j = i; j < lines.length; j += 1) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth += 1;
            started = true;
          } else if (ch === "}") {
            depth -= 1;
          }
        }
        if (started && depth <= 0) {
          end = j;
          break;
        }
      }
      if (started) {
        i = end;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section compressors.
// ---------------------------------------------------------------------------
const DET_REPORT_DROP_PREFIXES = [
  "患者ID",
  "会话ID",
  "初判时间",
  "位置：",
  "120 播报摘要",
  "施救者状态",
];

// SYSTEM lines that are guidance (not hard limits) and can be dropped. handover's
// "尽量覆盖（...）" bullet just enumerates the facts field names again.
const SYSTEM_DROP_PREFIXES = ["- 尽量覆盖"];

const ENGLISH_DROP_LINES = [
  "Do not wrap the JSON in GuidanceActionPatch, patch, action, markdown fences, or explanatory text.",
  "Do not use wrapper keys such as GuidanceActionPatch, patch, or action.",
  "The first character must be { and the last character must be }.",
];

function compressSystem(systemBody) {
  let lines = systemBody.split("\n");

  // 4. Drop the minimal-example block (always the final SYSTEM section).
  const exampleIdx = lines.findIndex((line) =>
    /^(最小合法.*示例|示例)：?\s*$/.test(line.trim())
  );
  if (exampleIdx >= 0) {
    lines = lines.slice(0, exampleIdx);
  }

  // 5. Drop optional schema fields.
  lines = dropBraceBlocks(lines, ['"visual_overlay"', '"log_suggestion"']);

  // Drop non-safety guidance bullets (handover coverage enumeration).
  lines = lines.filter(
    (line) => !SYSTEM_DROP_PREFIXES.some((prefix) => line.trim().startsWith(prefix))
  );

  // 6. Strip "// ..." schema annotations + collapse alignment whitespace.
  //    First collapse in-string annotations ("key": "type   // note", -> "key":
  //    "type",) so the schema stays well-formed, then strip any remaining
  //    end-of-line comments (e.g. on numeric values).
  lines = lines.map((line) =>
    line
      .replace(/^(\s*"[A-Za-z0-9_]+":\s*"[^"\n]*?)\s+\/\/[^"\n]*"(,?)\s*$/, '$1"$2')
      .replace(/\s*\/\/.*$/, "")
      .replace(/ {2,}/g, " ")
      .replace(/[ \t]+$/, "")
  );

  return lines.join("\n");
}

function compressUser(userText) {
  let text = dropTrailingFrameJsonBlock(userText); // 1
  text = dropLinesByPrefix(text, DET_REPORT_DROP_PREFIXES); // 3 (handover only)

  // handover-only redundancy collapse (keyed on unique labels; no-op elsewhere):
  // the deterministic_report fully duplicates the authoritative facts JSON, and
  // the USER "要求" block restates SYSTEM 数字硬性限制. Drop both; keep facts JSON.
  text = text.replace(/\ndeterministic_report（[^\n]*\n[\s\S]*?(?=\n请输出唯一的顶层)/, "");
  text = text.replace(/\n要求：\n(?:-[^\n]*\n)+/, "\n");
  text = text.replace(
    "你将收到一份结构化交接事实（facts）与一份确定性交接报告文本（deterministic_report）。请只依据它们生成交接叙述。",
    "你将收到结构化交接事实（facts）。请只依据它生成交接叙述。"
  );

  // Drop the USER preamble / "输出契约" restatement: everything before the first
  // "[Section]" header. SYSTEM already carries the output format + intent rules,
  // so the labeled sections below are the only unique USER payload. handover has
  // no "[...]" headers and is therefore left intact.
  const lines = text.split("\n");
  const firstHeader = lines.findIndex((line) => /^\[[^\]]+\]\s*$/.test(line.trim()));
  if (firstHeader > 0) {
    text = lines.slice(firstHeader).join("\n");
  }

  text = minifyPrettyJsonBlocks(text); // 2
  return text;
}

function globalCleanup(prompt) {
  let text = prompt.replaceAll(
    "Generate only one top-level GuidanceActionPatch JSON object.",
    ""
  ); // 7: drop bilingual English clause; Chinese "只输出一个顶层 JSON 对象" remains.
  text = dropExactEnglishLines(text, ENGLISH_DROP_LINES);
  text = text
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").replace(/[ \t]+$/, ""))
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text;
}

function compressPrompt(prompt) {
  const normalized = normalizeNewlines(prompt);
  const idx = normalized.indexOf(SEP);
  if (idx < 0) {
    throw new Error("prompt is missing the SYSTEM/USER separator");
  }
  const systemFull = normalized.slice(0, idx);
  const userText = normalized.slice(idx + SEP.length);
  const systemBody = systemFull.replace(/^SYSTEM:\n/, "");

  const system = compressSystem(systemBody).replace(/\n+$/, "");
  const user = compressUser(userText).replace(/\n+$/, "");

  let out = `SYSTEM:\n${system}${SEP}${user}`;
  out = globalCleanup(out);
  return out.replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// Per-case self-verification: the safety/role/schema content that must NOT be
// compressed away, derived from the (preserved) canonical `expected`.
// ---------------------------------------------------------------------------
function requiredSubstrings(expected) {
  const required = [];
  if (expected.kind === "guidance_patch") {
    required.push("角色边界", "硬性限制", "心梗", "一定能救活", "intent", "tts");
    for (const intent of expected.allowedIntents || []) required.push(intent);
  } else if (expected.kind === "nlu") {
    required.push(
      "角色边界",
      "硬性限制",
      "suspected_cardiac_arrest",
      "needs_clarification",
      "slots"
    );
    for (const intent of expected.allowedIntents || []) required.push(intent);
    for (const slot of Object.keys(expected.requireSlots || {})) required.push(slot);
  } else if (expected.kind === "handover_narrative") {
    required.push("角色边界", "未记录", "narrative", "心梗", "一定能救活", "facts");
    for (const num of expected.expectedNumbers || []) required.push(num);
  }
  return [...new Set(required)];
}

// Non-throwing per-case verification: returns the list of contract violations so
// the caller can still print the full token table for every case before failing.
function collectProblems(canonical, compactPrompt, tokens) {
  const { expected } = canonical;
  const problems = [];

  if (!compactPrompt || compactPrompt.trim().length === 0) {
    problems.push("compact prompt is empty");
    return problems;
  }
  if (!compactPrompt.startsWith("SYSTEM:\n") || !compactPrompt.includes(SEP)) {
    problems.push("lost SYSTEM/USER structure");
  }
  if (tokens > TOKEN_BUDGET) {
    problems.push(`~${tokens} tokens exceeds budget ${TOKEN_BUDGET}`);
  }

  const missing = requiredSubstrings(expected).filter(
    (needle) => !compactPrompt.includes(needle)
  );
  if (missing.length > 0) {
    problems.push(`dropped required content: ${missing.join(", ")}`);
  }

  // handover number-restatement contract: every must-restate number has to remain
  // visible to the model in the compact prompt (allowedNumbers stays canonical).
  if (expected.kind === "handover_narrative") {
    const absent = (expected.expectedNumbers || []).filter(
      (num) => !new RegExp(`(?<!\\d)${num}(?!\\d)`).test(compactPrompt)
    );
    if (absent.length > 0) {
      problems.push(`expected numbers absent: ${absent.join(", ")}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main() {
  const srcManifest = JSON.parse(
    readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8")
  );
  const caseFiles = Array.isArray(srcManifest.cases) ? srcManifest.cases : [];
  if (caseFiles.length === 0) {
    throw new Error("canonical manifest lists no cases");
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const rows = [];
  const failures = [];
  for (const file of caseFiles) {
    const canonical = JSON.parse(readFileSync(path.join(SRC_DIR, file), "utf8"));
    if (file !== `${canonical.caseId}.json`) {
      throw new Error(`manifest file ${file} does not match caseId ${canonical.caseId}`);
    }

    const compactPrompt = compressPrompt(canonical.prompt);

    const compact = {
      functionId: canonical.functionId,
      caseId: canonical.caseId,
      label: canonical.label,
      runs: canonical.runs,
      prompt: compactPrompt,
      expected: canonical.expected,
    };

    // expected must be a verbatim, drop-in copy of canonical.
    if (!deepEqual(compact.expected, canonical.expected)) {
      throw new Error(`case ${canonical.caseId}: expected diverged from canonical`);
    }

    const compactTokens = estimateTokens(compactPrompt);
    const canonicalTokens = estimateTokens(normalizeNewlines(canonical.prompt));
    const problems = collectProblems(canonical, compactPrompt, compactTokens);
    if (problems.length > 0) {
      failures.push(`${canonical.caseId}: ${problems.join("; ")}`);
    }

    // Always write (persist progress even if a contract check fails).
    writeFileSync(
      path.join(OUT_DIR, `${canonical.caseId}.json`),
      `${JSON.stringify(compact, null, 2)}\n`,
      "utf8"
    );

    rows.push({
      caseId: canonical.caseId,
      functionId: canonical.functionId,
      kind: canonical.expected.kind,
      canonicalTokens,
      compactTokens,
      canonicalChars: normalizeNewlines(canonical.prompt).length,
      compactChars: compactPrompt.length,
    });
  }

  const outManifest = {
    version: COMPACT_VERSION,
    generatedAt: new Date().toISOString(),
    source: srcManifest.version || "gemma_suite_v1",
    note: "Compressed prompts for latency; expected metadata is identical to gemma_suite.",
    cases: caseFiles,
  };
  writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(outManifest, null, 2)}\n`,
    "utf8"
  );

  // ASCII-safe console output (Windows consoles mangle CJK); the Chinese content
  // lives in the UTF-8 JSON files.
  console.log(`[gemma-suite-compact] output dir: ${OUT_DIR}`);
  console.log(
    `[gemma-suite-compact] manifest: manifest.json version=${COMPACT_VERSION} (${caseFiles.length} cases)`
  );
  console.log(
    "[gemma-suite-compact] caseId                   fn            kind              tokens(canon->compact)   saved   chars(canon->compact)"
  );

  let totalCanon = 0;
  let totalCompact = 0;
  for (const row of rows) {
    totalCanon += row.canonicalTokens;
    totalCompact += row.compactTokens;
    const saved = row.canonicalTokens - row.compactTokens;
    const pct =
      row.canonicalTokens > 0
        ? ((saved / row.canonicalTokens) * 100).toFixed(1)
        : "0.0";
    console.log(
      `[gemma-suite-compact] ${row.caseId.padEnd(24, " ")} ${row.functionId.padEnd(13, " ")} ${row.kind.padEnd(
        17,
        " "
      )} ${String(row.canonicalTokens).padStart(5, " ")} -> ${String(row.compactTokens).padStart(
        5,
        " "
      )}            -${String(saved).padStart(4, " ")} (${pct.padStart(5, " ")}%)   ${String(
        row.canonicalChars
      ).padStart(5, " ")} -> ${String(row.compactChars).padStart(5, " ")}`
    );
  }

  const totalSaved = totalCanon - totalCompact;
  const totalPct =
    totalCanon > 0 ? ((totalSaved / totalCanon) * 100).toFixed(1) : "0.0";
  console.log(
    `[gemma-suite-compact] TOTAL tokens ${totalCanon} -> ${totalCompact} (saved ${totalSaved}, ${totalPct}%), budget/case <= ${TOKEN_BUDGET}`
  );

  if (failures.length > 0) {
    console.error(`[gemma-suite-compact] FAILED ${failures.length} case(s):`);
    for (const failure of failures) {
      console.error(`[gemma-suite-compact]   - ${failure}`);
    }
    process.exit(1);
  }

  console.log("[gemma-suite-compact] all cases passed self-checks. done.");
}

main();
