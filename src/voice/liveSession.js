import { EventEmitter } from "node:events";
import { createId } from "../domain/types.js";
import { AgentStage } from "../domain/stages.js";
import { createVoiceDemoService } from "./service.js";
import { createLiveTts } from "./streamingTtsDaemon.js";
import { createStreamingStt } from "./streamingStt.js";
import { createSttReconnectPolicy } from "./sttReconnect.js";
import { inferIntent, transcribeInput } from "./stt.js";

const DEFAULT_PCM_SAMPLE_RATE = 16000;
const DEFAULT_PCM_CHANNELS = 1;
const DEFAULT_PCM_BITS_PER_SAMPLE = 16;
const MAX_BUFFERED_PCM_BYTES = 8 * 1024 * 1024;

// Live-only proactive follow-up: after a user turn lands on a transition stage
// (suspected arrest / call-emergency), synthesize system events so "判定骤停 ->
// 自动拨号 -> 播报 -> 进 CPR 准备" chains in one breath, stopping at S6 where we
// wait for the user. Bounded to <=2 follow-ups; HTTP handleTurn is unaffected.
const MAX_AUTO_ADVANCE_STEPS = 2;
const AUTO_ADVANCE_STAGES = new Set([
  AgentStage.S4_SUSPECTED_ARREST,
  AgentStage.S5_CALL_EMERGENCY,
]);

export function createLiveSession(options = {}) {
  return new LiveSession(options);
}

export class LiveSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || createId("voice_live");
    this.service = options.service || createVoiceDemoService(options.serviceOptions || {});
    this.tts = options.tts || createLiveTts(options.ttsOptions || {});
    this.sttFactory = options.createStreamingStt || createStreamingStt;
    this.sttOptions = options.sttOptions || {};
    this.disableStreamingStt = options.disableStreamingStt === true;
    this.pcmSampleRate = options.pcmSampleRate || DEFAULT_PCM_SAMPLE_RATE;
    this.pcmChannels = options.pcmChannels || DEFAULT_PCM_CHANNELS;
    this.pcmBitsPerSample = options.pcmBitsPerSample || DEFAULT_PCM_BITS_PER_SAMPLE;
    this.maxBufferedPcmBytes = options.maxBufferedPcmBytes || MAX_BUFFERED_PCM_BYTES;
    this.pcmChunks = [];
    this.bufferedPcmBytes = 0;
    this.speaking = false;
    this.closed = false;
    this.turnSeq = 0;
    this.currentSpeechSeq = 0;
    this.context = {};
    this.sttSession = null;
    this.sttReady = false;
    this.sttMode = "pending";
    this.sttStartAttempted = false;

    // STT self-healing: bound auto-restart of a dead/crashing streaming
    // recognizer before degrading to the buffered fallback.
    this.reconnect = createSttReconnectPolicy({
      maxRestarts: numberOr(options.sttMaxRestarts, 2),
      baseDelayMs: numberOr(options.sttRestartDelayMs, 0),
      maxDelayMs: numberOr(options.sttRestartMaxDelayMs, 2000),
    });
    this.sttRestartTimer = null;

    // Optional server-side energy gate as a barge-in backstop for clients
    // without their own VAD. Default OFF: explicit client `barge_in` is the
    // primary, always-on contract.
    const bargeIn = options.bargeIn || {};
    this.bargeInEnergyEnabled = bargeIn.energyGate === true || options.bargeInEnergyGate === true;
    this.bargeInRmsThreshold = firstPositive(bargeIn.rmsThreshold, options.bargeInRmsThreshold) ?? 0.18;
    this.bargeInMinSpeechMs = firstPositive(bargeIn.minSpeechMs, options.bargeInMinSpeechMs) ?? 200;
    this.bargeInActiveMs = 0;

    // Optional offline re-check for safety-critical breathing/negation finals.
    // Inject `reviewFinal(fn)` (used by tests) or set `finalReview: true` to use
    // the bundled sherpa-onnx SenseVoice batch path. Default OFF.
    this.reviewFinalFn = resolveFinalReviewer(options);
    this.reviewFinalEnabled = typeof this.reviewFinalFn === "function";

    // Autonomous loop tick. Two jobs: (a) Stage A S2/S3 observation-window
    // protective advance so silence/ambiguity still funnels to the S6 confirm
    // gate; (b) Stage B silence-default + low-frequency encouragement cadence.
    // OFF by default so the turn-driven path is byte-for-byte unchanged and the
    // feature is trivially reversible; enable via options.autonomousTick or
    // options.tick.enabled. Reuses processTurn's synthetic-event mechanism and
    // is preempted by barge-in / new user turns through the existing turnSeq.
    const tick = options.tick || {};
    this.tickEnabled = tick.enabled === true || options.autonomousTick === true;
    this.tickIntervalMs = numberOr(tick.intervalMs ?? options.tickIntervalMs, 4000);
    this.observationWindowMs = numberOr(tick.observationWindowMs, 12000);
    this.wakeWindowMs = numberOr(tick.wakeWindowMs, 5000);
    this.encouragementIntervalMs = numberOr(tick.encouragementIntervalMs, 20000);
    this.encourageQuietMs = numberOr(tick.encourageQuietMs, 12000);
    this.tickEncourageEnabled = tick.encourage === true;
    this.tickTimer = null;
    this.currentStage = null;
    this.stageEnteredAt = 0;
    this.tickProtectedStage = null;
    this.lastEncouragementAt = 0;
    this.lastCorrectionAt = 0;
    this.wakePhrasePrior = false;
  }

  start(input = {}) {
    if (input.sessionId || input.session_id) {
      this.sessionId = input.sessionId || input.session_id;
    }
    this.emitJson({
      type: "state",
      session_id: this.sessionId,
      live: true,
      status: "connected",
      stt_mode: this.sttMode,
    });
    this.scheduleTick();
  }

  async handleControl(message = {}) {
    const type = normalizeType(message.type);
    switch (type) {
      case "start":
        this.start(message);
        return;
      case "reset":
        await this.reset(message);
        return;
      case "barge_in":
        this.handleBargeIn("client_barge_in");
        return;
      case "context":
        this.context = sanitizeContext(message.payload || message.context || message.event || {});
        return;
      case "turn":
        await this.processTurn(message.payload || message.event || message);
        return;
      case "inject":
        await this.processTurn(message.payload || message.event || message);
        return;
      case "final":
      case "commit_text":
        await this.processTurn({ ...message, text: message.text || message.transcript || "" });
        return;
      case "commit":
      case "end":
      case "end_audio":
        await this.commit(message);
        return;
      default:
        this.emitError(`Unsupported live control message: ${message.type || "<missing>"}`, "bad_control_type");
    }
  }

  handlePcm(chunk) {
    if (this.closed || !chunk?.length) {
      return;
    }

    this.ensureSttStarted();

    const buffer = Buffer.from(chunk);
    // Keep a rolling buffer so the buffered-STT fallback still works when the
    // streaming recognizer is unavailable or mid-reconnect.
    this.pcmChunks.push(buffer);
    this.bufferedPcmBytes += buffer.length;
    while (this.bufferedPcmBytes > this.maxBufferedPcmBytes && this.pcmChunks.length > 1) {
      const removed = this.pcmChunks.shift();
      this.bufferedPcmBytes -= removed.length;
    }

    if (this.speaking) {
      // While speaking we treat incoming PCM as potential echo and do not feed
      // it to the recognizer. The explicit client `barge_in` control always
      // stops playback; the optional energy gate is a server-side backstop.
      this.maybeEnergyBargeIn(buffer);
      return;
    }

    this.resetBargeInEnergy();
    if (this.sttReady && this.sttSession) {
      this.sttSession.feed(buffer, { sampleRate: this.pcmSampleRate });
    }
  }

  // Server-side barge-in backstop: while playback is active, sustained PCM
  // energy clearly above the threshold is treated as the user speaking over the
  // prompt and triggers the same stop-and-flush path as an explicit `barge_in`.
  // A single sub-threshold frame resets the window so brief echo transients do
  // not count. No-op unless explicitly enabled.
  maybeEnergyBargeIn(buffer) {
    if (!this.bargeInEnergyEnabled || !this.speaking) {
      return;
    }
    if (computeRms16(buffer) < this.bargeInRmsThreshold) {
      this.bargeInActiveMs = 0;
      return;
    }
    const frameMs = (buffer.length / 2 / this.pcmSampleRate) * 1000;
    this.bargeInActiveMs += frameMs;
    if (this.bargeInActiveMs >= this.bargeInMinSpeechMs) {
      this.bargeInActiveMs = 0;
      this.handleBargeIn("energy_barge_in");
    }
  }

  resetBargeInEnergy() {
    this.bargeInActiveMs = 0;
  }

  ensureSttStarted() {
    if (this.sttStartAttempted) {
      return;
    }
    this.sttStartAttempted = true;
    if (this.disableStreamingStt) {
      this.sttMode = "buffered";
      return;
    }
    this.startStt();
  }

  startStt() {
    let session;
    try {
      session = this.sttFactory({ sampleRate: this.pcmSampleRate, ...this.sttOptions });
    } catch (error) {
      // Construction threw synchronously: a misconfiguration a restart will not
      // fix, so degrade immediately instead of looping.
      this.fallbackToBufferedStt(error?.message);
      return;
    }

    if (!session) {
      this.fallbackToBufferedStt("streaming STT factory returned no session");
      return;
    }

    this.sttSession = session;
    this.sttReady = false;
    let settled = false;

    const isCurrent = () => !this.closed && this.sttSession === session;

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!isCurrent()) {
        return;
      }
      this.sttReady = true;
      this.sttMode = "streaming";
      // A stable connect earns a fresh restart budget so a later, unrelated
      // crash can still self-heal instead of being permanently degraded.
      this.reconnect.reset();
      this.emitJson({ type: "state", session_id: this.sessionId, stt_mode: "streaming" });
    };

    const fail = (reason) => {
      if (settled) {
        return;
      }
      settled = true;
      if (!isCurrent()) {
        return;
      }
      this.scheduleReconnectOrFallback(reason);
    };

    session.on?.("partial", (event) => {
      if (this.closed || this.speaking || this.sttSession !== session) {
        return;
      }
      const text = (event?.text || "").trim();
      if (text) {
        this.emitJson({ type: "partial", session_id: this.sessionId, text });
      }
    });
    session.on?.("final", (event) => {
      if (this.sttSession !== session) {
        return;
      }
      this.onSttFinal(event);
    });
    session.on?.("error", () => {
      // Keep the session alive; the buffered fallback still runs on commit.
    });
    session.on?.("exit", () => {
      if (this.sttSession !== session) {
        return;
      }
      this.sttReady = false;
      if (!settled) {
        // Exited before ever signalling ready: treat as a failed attempt.
        fail("streaming STT exited before ready");
        return;
      }
      // Exited after running: try to auto-reconnect before degrading.
      this.scheduleReconnectOrFallback("streaming STT exited");
    });

    const ready = session.waitUntilReady?.();
    if (ready && typeof ready.then === "function") {
      ready.then(succeed).catch((error) => {
        this.sttSession?.stop?.();
        fail(error?.message);
      });
    } else {
      succeed();
    }
  }

  // Auto-heal a dead/crashing streaming recognizer: respawn up to the policy's
  // retry budget (with optional backoff), then degrade to buffered STT. Every
  // transition is surfaced to the client as a `state` event so the UI can show
  // "reconnecting" instead of silently losing low latency.
  scheduleReconnectOrFallback(reason) {
    if (this.closed) {
      return;
    }
    this.sttReady = false;
    this.sttSession = null;

    if (this.disableStreamingStt || !this.reconnect.canRestart()) {
      this.fallbackToBufferedStt(reason);
      return;
    }

    const { attempt, delayMs } = this.reconnect.registerRestart();
    this.sttMode = "reconnecting";
    this.emitJson({
      type: "state",
      session_id: this.sessionId,
      stt_mode: "reconnecting",
      stt_restart_attempt: attempt,
      stt_max_restarts: this.reconnect.maxRestarts,
      stt_reconnect_reason: reason || null,
    });

    clearTimeout(this.sttRestartTimer);
    const restart = () => {
      this.sttRestartTimer = null;
      if (this.closed) {
        return;
      }
      this.startStt();
    };
    if (delayMs > 0) {
      this.sttRestartTimer = setTimeout(restart, delayMs);
      this.sttRestartTimer.unref?.();
    } else {
      queueMicrotask(restart);
    }
  }

  fallbackToBufferedStt(reason) {
    clearTimeout(this.sttRestartTimer);
    this.sttRestartTimer = null;
    this.sttReady = false;
    this.sttSession = null;
    this.sttMode = "buffered";
    if (this.closed) {
      return;
    }
    this.emitJson({
      type: "state",
      session_id: this.sessionId,
      stt_mode: "buffered",
      stt_fallback_reason: reason || null,
    });
  }

  async onSttFinal(event) {
    if (this.closed) {
      return;
    }
    let text = (event?.text || event?.transcript || "").trim();
    if (!text) {
      return;
    }
    let intent = event?.intent ?? null;

    // Snapshot the captured utterance *before* clearing so an optional offline
    // re-check can run on the exact audio. Gated to safety-critical breathing /
    // negation finals so it never enters the high-frequency hot path.
    const reviewPcm =
      this.reviewFinalEnabled && this.bufferedPcmBytes > 0 && isCriticalBreathingFinal(text)
        ? Buffer.concat(this.pcmChunks, this.bufferedPcmBytes)
        : null;
    this.clearBufferedAudio();

    if (reviewPcm) {
      const corrected = await this.reviewCriticalFinal(text, reviewPcm);
      if (this.closed) {
        return;
      }
      if (corrected && corrected !== text) {
        text = corrected;
        intent = inferIntent(text);
      }
    }

    this.processTurn({ text, intent });
  }

  // Best-effort offline re-check for safety-critical finals. Never throws into
  // the turn loop; on any error or empty result we keep the streaming text.
  async reviewCriticalFinal(originalText, pcm) {
    if (typeof this.reviewFinalFn !== "function") {
      return null;
    }
    try {
      const wav = encodePcm16Wav(pcm, {
        sampleRate: this.pcmSampleRate,
        channels: this.pcmChannels,
        bitsPerSample: this.pcmBitsPerSample,
      });
      const result = await this.reviewFinalFn({
        text: originalText,
        audioBase64: wav.toString("base64"),
        mimeType: "audio/wav",
        sampleRate: this.pcmSampleRate,
      });
      const reviewed =
        typeof result === "string" ? result : result?.transcript || result?.text || "";
      return (reviewed || "").trim() || null;
    } catch {
      return null;
    }
  }

  async commit(message = {}) {
    if (this.sttReady && this.sttSession) {
      this.sttSession.end();
      this.clearBufferedAudio();
      return;
    }
    await this.commitBufferedAudio(message);
  }

  async commitBufferedAudio(message = {}) {
    if (this.bufferedPcmBytes === 0) {
      this.emitError("No buffered PCM audio to commit.", "empty_audio_commit");
      return;
    }

    const pcm = Buffer.concat(this.pcmChunks, this.bufferedPcmBytes);
    this.clearBufferedAudio();
    const wav = encodePcm16Wav(pcm, {
      sampleRate: message.sampleRate || message.sample_rate || this.pcmSampleRate,
      channels: message.channels || this.pcmChannels,
      bitsPerSample: message.bitsPerSample || message.bits_per_sample || this.pcmBitsPerSample,
    });

    await this.processTurn({
      ...message,
      audioBase64: wav.toString("base64"),
      mimeType: "audio/wav",
    });
  }

  async processTurn(input = {}) {
    if (this.closed) {
      return null;
    }

    const turnSeq = ++this.turnSeq;
    this.cancelSpeech("new_turn");
    const payload = {
      ...this.context,
      ...withoutControlFields(input),
      sessionId: this.sessionId,
    };

    const result = await this.runGuidanceTurn(payload, turnSeq);
    if (result !== null) {
      await this.runAutoAdvance(result, turnSeq);
      // WB open question: after the immediate ack (the user turn above), stream the
      // controlled Q&A answer that was generated asynchronously. Same turnSeq, so a
      // barge-in / new user turn supersedes a still-pending answer.
      await this.speakOpenQuestionAnswer(result, turnSeq);
    }
    // Re-arm the autonomous tick relative to the latest activity so the
    // observation window measures "quiet since the last turn settled".
    this.scheduleTick();
    return result;
  }

  // One guidance segment: emit thinking/final/guidance/state and stream the
  // spoken audio. Shared by the user turn and each proactive auto-advance
  // segment so they all reuse the exact same emission contract.
  async runGuidanceTurn(payload, turnSeq) {
    this.emitJson({ type: "thinking", session_id: this.sessionId, turn_seq: turnSeq });

    let result;
    try {
      result = await this.runGuidance(payload);
    } catch (error) {
      this.emitError(error?.message || "Live turn failed.", error?.code || "turn_failed");
      return null;
    }

    if (this.closed || turnSeq !== this.turnSeq) {
      return result;
    }

    const guidance = normalizeGuidanceResult(result);
    if (guidance.state) {
      this.wakePhrasePrior = hasWakePhrasePrior(guidance.state);
    }
    if (isRecentCorrectionGuidance(guidance)) {
      this.lastCorrectionAt = Date.now();
    }
    const finalText = guidance.transcript || payload.text || "";
    this.emitJson({
      type: "final",
      session_id: this.sessionId,
      turn_seq: turnSeq,
      text: finalText,
      intent: guidance.intent,
    });

    if (guidance.guidanceAction) {
      this.emitJson({
        type: "guidance",
        session_id: this.sessionId,
        turn_seq: turnSeq,
        action: guidance.guidanceAction,
        source: guidance.guidanceSource,
        response_type: guidance.responseType,
      });
    }

    if (guidance.state) {
      this.noteGuidanceStage(guidance.state.current_stage);
      this.emitJson({
        type: "state",
        session_id: this.sessionId,
        turn_seq: turnSeq,
        current_stage: guidance.state.current_stage,
        state: guidance.state,
      });
    }

    await this.speakGuidance(guidance, turnSeq);
    return result;
  }

  // Bounded proactive follow-up (Live only). Reuses the same turnSeq so a fresh
  // user turn (barge-in) supersedes the chain. Stops at S6 (waiting for user),
  // when no further transition applies, or after MAX_AUTO_ADVANCE_STEPS.
  async runAutoAdvance(initialResult, turnSeq) {
    let result = initialResult;

    for (let step = 0; step < MAX_AUTO_ADVANCE_STEPS; step += 1) {
      if (this.closed || turnSeq !== this.turnSeq) {
        break;
      }
      const stage = normalizeGuidanceResult(result).state?.current_stage || null;
      if (!AUTO_ADVANCE_STAGES.has(stage)) {
        break;
      }
      const followUp = this.buildAutoAdvanceEvent(stage);
      if (!followUp) {
        break;
      }

      const next = await this.runGuidanceTurn(
        { ...this.context, ...followUp, sessionId: this.sessionId },
        turnSeq
      );
      if (next === null) {
        break;
      }

      const nextStage = normalizeGuidanceResult(next).state?.current_stage || null;
      result = next;
      if (nextStage === stage) {
        break;
      }
    }

    return result;
  }

  // Synthesize the system event that nudges a transition stage forward. No user
  // text is attached. The S5 follow-up carries device_state.emergency_call_started
  // (required for S5 -> S6) and reuses any context device state (e.g. mock GPS) so
  // the 120 briefing keeps its location.
  buildAutoAdvanceEvent(stage) {
    if (stage === AgentStage.S4_SUSPECTED_ARREST) {
      return {
        eventSource: "system",
        eventType: "auto_followup",
        metadata: { auto_advance: true, auto_advance_from: stage },
      };
    }

    if (stage === AgentStage.S5_CALL_EMERGENCY) {
      const contextDevice = this.context.deviceState || this.context.device_state || {};
      return {
        eventSource: "device",
        eventType: "device_state_update",
        deviceState: {
          ...contextDevice,
          emergency_call_started: true,
          emergency_call_status: "started",
        },
        metadata: { auto_advance: true, auto_advance_from: stage },
      };
    }

    return null;
  }

  // Record the stage the session is currently sitting in so the tick can measure
  // how long an observation window (S2/S3) has been open. A stage change resets
  // the window and the per-stage one-shot protective-advance guard.
  noteGuidanceStage(stage) {
    if (!stage) {
      return;
    }
    if (stage !== this.currentStage) {
      this.currentStage = stage;
      this.stageEnteredAt = Date.now();
      this.tickProtectedStage = null;
    }
  }

  // Arm (or re-arm) the single self-rescheduling tick timer. No-op unless the
  // autonomous loop is enabled, so the default turn-driven path is unchanged.
  // unref() keeps the timer from holding the process / test runner open.
  scheduleTick() {
    if (!this.tickEnabled || this.closed) {
      return;
    }
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.onTick();
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  async onTick() {
    this.tickTimer = null;
    if (this.closed || !this.tickEnabled) {
      return;
    }
    try {
      // Never speak over ourselves or an in-flight turn; the next tick re-checks.
      if (!this.speaking) {
        await this.maybeAutonomousAdvance();
      }
    } catch {
      // The autonomous loop must never crash the session.
    } finally {
      this.scheduleTick();
    }
  }

  // The autonomous loop body. Decides, based on the current stage and how long it
  // has been open, whether to inject a synthetic system turn through processTurn
  // (which reuses the same emission + turnSeq-preemption contract as a real turn).
  async maybeAutonomousAdvance() {
    const stage = this.currentStage;
    if (!stage) {
      return;
    }
    const now = Date.now();
    const inStageMs = now - (this.stageEnteredAt || now);
    const observationWindowMs = this.wakePhrasePrior
      ? this.wakeWindowMs
      : this.observationWindowMs;

    // (a) Stage A observation windows. S2/S3 stay HARD gates: an explicit "有反应"
    // / "正常呼吸" has already routed to MONITOR, so a session still parked here is
    // silence/ambiguity, whose protective default is to keep funnelling toward the
    // S6 confirm gate (never auto-starting CPR). One protective push per entry.
    if (
      (stage === AgentStage.S2_CHECK_RESPONSE || stage === AgentStage.S3_CHECK_BREATHING) &&
      inStageMs >= observationWindowMs &&
      this.tickProtectedStage !== stage
    ) {
      const followUp = this.buildProtectiveAdvanceEvent(stage);
      if (followUp) {
        this.tickProtectedStage = stage;
        await this.processTurn(followUp);
      }
      return;
    }

    // (b) Stage B silence-default + low-frequency encouragement. Silence remains
    // default; encouragement is injected only after a quiet, correction-free gap.
    if (stage === AgentStage.S7_CPR_LOOP) {
      if (
        this.tickEncourageEnabled &&
        now - this.lastEncouragementAt >= this.encouragementIntervalMs &&
        now - this.lastCorrectionAt >= this.encourageQuietMs
      ) {
        this.lastEncouragementAt = now;
        await this.processTurn(this.buildEncouragementTickEvent());
      }
      return;
    }
  }

  buildEncouragementTickEvent() {
    return {
      eventSource: "system",
      eventType: "encourage_tick",
      metadata: {
        encourage_tick: true,
        autonomous_tick: true,
      },
    };
  }

  // Synthetic "observation window expired" event. Carries no user text and a
  // moderate-confidence protective reading that nudges the funnel one gate
  // forward: S2 -> unresponsive (=> S3), S3 -> no normal breathing (=> S4, after
  // which the existing S4/S5 auto-advance chain runs to the S6 gate and stops).
  buildProtectiveAdvanceEvent(stage) {
    const metadata = {
      autonomous_tick: true,
      protective_advance: true,
      observation_timeout_from: stage,
    };
    if (stage === AgentStage.S2_CHECK_RESPONSE) {
      return {
        eventSource: "system",
        eventType: "patient_state_update",
        patientState: {
          responsive: false,
          responsive_source: "protective_timeout",
          responsive_confidence: 0.55,
        },
        metadata,
      };
    }
    if (stage === AgentStage.S3_CHECK_BREATHING) {
      return {
        eventSource: "system",
        eventType: "breathing_update",
        patientState: {
          normal_breathing: false,
          normal_breathing_source: "protective_timeout",
          normal_breathing_confidence: 0.55,
        },
        metadata,
      };
    }
    return null;
  }

  // Prefer the TTS-free guidance core so the hot path never pays for a throwaway
  // full synthesis; fall back to handleTurn for services that only expose it.
  runGuidance(payload) {
    if (typeof this.service.createGuidance === "function") {
      return this.service.createGuidance(payload);
    }
    return this.service.handleTurn(payload);
  }

  handleBargeIn(reason = "barge_in") {
    this.cancelSpeech(reason);
    this.emitJson({
      type: "audio_cancel",
      session_id: this.sessionId,
      reason,
    });
  }

  cancelSpeech(reason = "cancelled") {
    this.currentSpeechSeq += 1;
    this.speaking = false;
    this.tts.cancel(reason);
  }

  async reset(message = {}) {
    this.cancelSpeech("reset");
    this.clearBufferedAudio();
    this.resetBargeInEnergy();
    this.reconnect.reset();
    this.context = {};
    // Reset the autonomous tick bookkeeping so a fresh session starts a fresh
    // observation window; re-arm only if the loop is enabled.
    clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.currentStage = null;
    this.stageEnteredAt = 0;
    this.tickProtectedStage = null;
    this.lastEncouragementAt = 0;
    this.lastCorrectionAt = 0;
    this.wakePhrasePrior = false;
    this.sttSession?.reset?.({ sampleRate: this.pcmSampleRate });
    const sessionId = message.sessionId || message.session_id || this.sessionId;
    await this.service.reset?.(sessionId);
    this.emitJson({
      type: "state",
      session_id: sessionId,
      status: "reset",
      current_stage: null,
    });
    this.scheduleTick();
  }

  close() {
    this.closed = true;
    clearTimeout(this.sttRestartTimer);
    this.sttRestartTimer = null;
    clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.cancelSpeech("closed");
    this.clearBufferedAudio();
    this.sttSession?.stop?.();
    this.sttSession = null;
    this.removeAllListeners();
  }

  async speakGuidance(guidance, turnSeq) {
    const text = guidance.guidanceAction?.tts?.text || guidance.stateAction?.tts?.text || "";
    if (!text) {
      return;
    }

    const actionId = guidance.guidanceAction?.action_id || guidance.stateAction?.action_id || createId("act_live");
    const speechSeq = ++this.currentSpeechSeq;
    this.speaking = true;
    let begun = false;

    try {
      for await (const item of this.tts.speak(text)) {
        if (this.closed || speechSeq !== this.currentSpeechSeq || turnSeq !== this.turnSeq) {
          break;
        }
        if (!begun) {
          begun = true;
          this.emitJson({
            type: "audio_begin",
            session_id: this.sessionId,
            turn_seq: turnSeq,
            action_id: actionId,
            format: "pcm16",
            sample_rate: item.sampleRate,
            channels: item.channels,
            bits_per_sample: item.bitsPerSample,
          });
        }
        this.emitAudio(item.chunk, {
          sample_rate: item.sampleRate,
          channels: item.channels,
          bits_per_sample: item.bitsPerSample,
          action_id: actionId,
        });
      }

      if (begun && !this.closed && speechSeq === this.currentSpeechSeq && turnSeq === this.turnSeq) {
        this.emitJson({
          type: "audio_end",
          session_id: this.sessionId,
          turn_seq: turnSeq,
          action_id: actionId,
        });
      }
    } catch (error) {
      if (error?.code !== "ERR_TTS_STREAM_CANCELLED") {
        this.emitError(error?.message || "Streaming TTS failed.", error?.code || "tts_stream_failed");
      }
    } finally {
      if (!begun && !this.closed && speechSeq === this.currentSpeechSeq && turnSeq === this.turnSeq) {
        this.emitJson({
          type: "audio_unavailable",
          session_id: this.sessionId,
          turn_seq: turnSeq,
          action_id: actionId,
          reason: "tts_stream_empty",
        });
      }
      if (speechSeq === this.currentSpeechSeq) {
        this.speaking = false;
      }
    }
  }

  // Stream the asynchronously-generated open-question answer as a follow-up segment
  // once the immediate ack has finished. The answer promise always resolves to a
  // safe action (or a silent fallback); on timeout/illegal/barge-in we simply speak
  // nothing further.
  async speakOpenQuestionAnswer(result, turnSeq) {
    const channel = result?.openQuestionAnswer || result?.open_question_answer;
    if (!channel || typeof channel.promise?.then !== "function") {
      return;
    }
    if (this.closed || turnSeq !== this.turnSeq) {
      return;
    }

    // Snapshot the speech sequence so a bare barge-in (which cancels playback and
    // bumps currentSpeechSeq without starting a new turn) also suppresses a still
    // pending answer.
    const speechSeqAtStart = this.currentSpeechSeq;
    let answer;
    try {
      answer = await channel.promise;
    } catch {
      return;
    }

    if (this.closed || turnSeq !== this.turnSeq || this.currentSpeechSeq !== speechSeqAtStart) {
      return; // a newer turn / barge-in superseded this open question
    }

    const action = answer?.action || null;
    const text = action?.tts?.text || "";
    if (!action || !text) {
      return; // timeout/illegal safety fallback may be silent
    }

    this.emitJson({
      type: "guidance",
      session_id: this.sessionId,
      turn_seq: turnSeq,
      action,
      source: answer.source || "gemma_open_question",
      response_type: answer.responseType || null,
      open_question_answer: true,
    });
    await this.speakGuidance({ guidanceAction: action }, turnSeq);
  }

  clearBufferedAudio() {
    this.pcmChunks = [];
    this.bufferedPcmBytes = 0;
  }

  emitJson(message) {
    this.emit("json", message);
  }

  emitAudio(chunk, metadata = {}) {
    this.emit("audio", Buffer.from(chunk), metadata);
  }

  emitError(message, code = "live_session_error") {
    this.emitJson({
      type: "error",
      session_id: this.sessionId,
      error: { message, code },
    });
  }
}

export function encodePcm16Wav(pcm, options = {}) {
  const data = Buffer.from(pcm || Buffer.alloc(0));
  const channels = options.channels || DEFAULT_PCM_CHANNELS;
  const sampleRate = options.sampleRate || DEFAULT_PCM_SAMPLE_RATE;
  const bitsPerSample = options.bitsPerSample || DEFAULT_PCM_BITS_PER_SAMPLE;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

function normalizeGuidanceResult(result = {}) {
  // Tolerate both shapes: handleTurn (snake_case `guidance_action`, top-level
  // `state`) and createGuidance/runVoiceGuidanceCore (camelCase `guidanceAction`,
  // `pipeline.state`, `guidanceDecision`).
  const guidanceAction = result.guidance_action || result.guidanceAction || null;
  const stateAction = result.state_action || result.stateAction || null;
  const state = result.state || result.pipeline?.state || null;
  const transcript = result.transcript || result.stt?.transcript || "";
  const intent = result.stt?.intent || result.event?.user_input?.intent || null;
  const guidanceSource = result.guidance_source || result.guidanceDecision?.source || null;
  const responseType = result.response_type || result.guidanceDecision?.responseType || null;
  return { guidanceAction, stateAction, state, transcript, intent, guidanceSource, responseType };
}

function hasWakePhrasePrior(state = {}) {
  const scope = state.scope ?? {};
  return scope.entry_source === "wake_phrase" || Boolean(scope.wake_phrase);
}

function isRecentCorrectionGuidance(guidance = {}) {
  return (
    guidance.guidanceSource === "rule_feedback" ||
    guidance.guidanceSource === "rule_feedback_critical" ||
    guidance.responseType === "critical_correction"
  );
}

function normalizeType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function sanitizeContext(input = {}) {
  return withoutControlFields(input);
}

function withoutControlFields(input = {}) {
  const {
    type,
    payload,
    event,
    sampleRate,
    sample_rate,
    channels,
    bitsPerSample,
    bits_per_sample,
    ...rest
  } = input;
  return rest;
}

// Safety-critical breathing / negation cues. A streaming `final` that mentions
// these is worth a (rare) offline re-check before it can steer the protocol
// (e.g. "有呼吸" vs "没有呼吸").
const CRITICAL_BREATHING_PATTERN =
  /(没有?呼吸|无呼吸|没气|没喘气|不正常呼吸|呼吸(?:不正常|微弱|很弱|停止)|正常呼吸|有呼吸|喘息|濒死|gasping|agonal|(?:no|not|normal|abnormal)\s+breathing|breathing)/i;

function isCriticalBreathingFinal(text) {
  return CRITICAL_BREATHING_PATTERN.test(typeof text === "string" ? text : "");
}

function resolveFinalReviewer(options = {}) {
  if (typeof options.reviewFinal === "function") {
    return options.reviewFinal;
  }
  if (options.finalReview === true || options.reviewFinal === true) {
    return defaultFinalReviewer;
  }
  return null;
}

// Default offline re-check: run the canonical sherpa-onnx SenseVoice batch STT
// (stt.js) on the captured utterance. Opt-in only (finalReview / reviewFinal)
// because it spawns Python and must never gate the streaming hot path.
async function defaultFinalReviewer({ audioBase64, mimeType }) {
  const result = await transcribeInput({ audioBase64, mimeType });
  return result?.transcript || "";
}

// RMS of 16-bit little-endian mono PCM, normalized to ~0..1 (full-scale = 1).
function computeRms16(buffer) {
  if (!buffer || buffer.length < 2) {
    return 0;
  }
  const sampleCount = buffer.length >> 1;
  let sumSquares = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

function firstPositive(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return undefined;
}

function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}
