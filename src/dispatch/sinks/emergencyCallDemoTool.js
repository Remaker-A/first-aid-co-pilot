const DEFAULT_MODE = "dial_only_fallback";

const DEMO_MODES = new Set([
  "test_auto_call",
  "accessibility_click_120",
  "dial_only_fallback",
]);

export function buildEmergencyCallDemoDetail(tool = {}, action = {}, context = {}) {
  const env = getEnv();
  const config = normalizeConfig(context.emergencyCallDemo);
  const warnings = [];
  const requestedTarget = normalizePhoneTarget(tool.target ?? config.target ?? "120");
  const requestedMode = resolveRequestedMode(config, env);

  let mode = requestedMode.value;
  if (!DEMO_MODES.has(mode)) {
    warnings.push(`emergency_call_demo_unsupported_mode:${mode}:dial_only_fallback`);
    mode = DEFAULT_MODE;
  }

  let target = requestedTarget;
  let wouldAutoClick = false;
  let wouldPlaceCall = false;
  let degraded = mode !== requestedMode.value;

  if (mode === "test_auto_call") {
    const testNumber = normalizeOptionalPhoneTarget(
      config.testNumber ?? config.test_number ?? env.FIRSTAID_EMERGENCY_CALL_TEST_NUMBER
    );

    if (!testNumber) {
      warnings.push("emergency_call_demo_missing_test_number:dial_only_fallback");
      mode = DEFAULT_MODE;
      degraded = true;
    } else if (isEmergency120(testNumber)) {
      warnings.push("emergency_call_demo_test_number_must_not_be_120:dial_only_fallback");
      mode = DEFAULT_MODE;
      degraded = true;
    } else {
      target = testNumber;
      wouldPlaceCall = true;
      if (isEmergency120(requestedTarget)) {
        warnings.push("emergency_call_demo_replaced_120_with_test_number");
      } else if (requestedTarget !== testNumber) {
        warnings.push("emergency_call_demo_replaced_requested_target_with_test_number");
      }
    }
  }

  if (mode === "accessibility_click_120") {
    const accessibilityAuthorized = config.accessibilityAuthorized === true;
    const allowRealEmergencyTest = config.allowRealEmergencyTest === true;

    if (!accessibilityAuthorized || !allowRealEmergencyTest) {
      warnings.push(
        "emergency_call_demo_accessibility_click_requires_authorization_and_real_test_flag:dial_only_fallback"
      );
      mode = DEFAULT_MODE;
      degraded = true;
    } else {
      wouldAutoClick = true;
    }
  }

  const androidIntent = buildAndroidIntent({ mode, target, wouldAutoClick });

  return {
    mode,
    requested_mode: requestedMode.value,
    mode_source: requestedMode.source,
    target,
    requested_target: requestedTarget,
    android_intent: androidIntent,
    speakerphone: {
      requested: true,
      demo_only: true,
      android_hint: "Enable speakerphone after the call screen is active or the call is connected.",
    },
    tts_briefing: buildTtsBriefing({ action, mode, target }),
    visible_script: buildVisibleScript({ mode, target, wouldAutoClick, wouldPlaceCall }),
    audit_flags: {
      critical_tool: true,
      demo_only: true,
      no_real_dial_from_node: true,
      critical_not_blocked: true,
      degraded_to_fallback: degraded,
      would_place_call: wouldPlaceCall,
      would_auto_click: wouldAutoClick,
      accessibility_authorized: config.accessibilityAuthorized === true,
      allow_real_emergency_test: config.allowRealEmergencyTest === true,
      uses_test_number: mode === "test_auto_call",
    },
    warnings,
  };
}

function resolveRequestedMode(config, env) {
  const contextMode = firstNonEmpty(config.mode, config.demoMode, config.demo_mode);
  if (contextMode) {
    return { value: contextMode, source: "context.emergencyCallDemo" };
  }

  const envMode = normalizeOptionalText(env.FIRSTAID_EMERGENCY_CALL_DEMO_MODE);
  if (envMode) {
    return { value: envMode, source: "env.FIRSTAID_EMERGENCY_CALL_DEMO_MODE" };
  }

  return { value: DEFAULT_MODE, source: "default" };
}

function buildAndroidIntent({ mode, target, wouldAutoClick }) {
  const uri = `tel:${target}`;

  if (mode === "test_auto_call") {
    return {
      action: "Intent.ACTION_CALL",
      uri,
      action_call:
        "Android integration would place a call to the configured demo test number after CALL_PHONE permission checks.",
    };
  }

  if (mode === "accessibility_click_120") {
    return {
      action: "Intent.ACTION_DIAL",
      uri,
      action_dial:
        "Android integration would open the dialer on 120, then an authorized AccessibilityService would click the call control.",
      accessibility_click: {
        would_auto_click: wouldAutoClick,
        target_button: "call",
      },
    };
  }

  return {
    action: "Intent.ACTION_DIAL",
    uri,
    action_dial: "Android integration would open the dialer only; the user must press the call button.",
  };
}

function buildTtsBriefing({ action, mode, target }) {
  const actionText = normalizeOptionalText(action?.tts?.text);
  const fallbackText =
    mode === "test_auto_call"
      ? `Demo call mode: calling test number ${target}. Keep the phone on speaker.`
      : `Opening the dialer for ${target}. Put the phone on speaker and continue CPR guidance.`;

  return {
    source: actionText ? "action.tts.text" : "emergencyCallDemoTool.default",
    text: actionText || fallbackText,
  };
}

function buildVisibleScript({ mode, target, wouldAutoClick, wouldPlaceCall }) {
  const lines = [];

  if (mode === "test_auto_call") {
    lines.push(`Demo test call target: ${target}`);
    lines.push(wouldPlaceCall ? "Android ACTION_CALL path is described for demo testing." : "No call will be placed.");
  } else if (mode === "accessibility_click_120") {
    lines.push(`Open dialer target: ${target}`);
    lines.push(
      wouldAutoClick
        ? "Authorized accessibility test would click the call control."
        : "Accessibility auto-click is not authorized."
    );
  } else {
    lines.push(`Open dialer target: ${target}`);
    lines.push("User must manually press the call button.");
  }

  lines.push("Keep emergency guidance visible and request speakerphone.");

  return {
    title: "Emergency call demo",
    lines,
  };
}

function normalizeConfig(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    return { mode: normalizeOptionalText(value) };
  }
  if (typeof value === "object") {
    return value;
  }
  return {};
}

function normalizePhoneTarget(value) {
  return normalizeOptionalPhoneTarget(value) || "120";
}

function normalizeOptionalPhoneTarget(value) {
  const text = normalizeOptionalText(value);
  return text ? text.replace(/\s+/g, "") : "";
}

function normalizeOptionalText(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeOptionalText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function isEmergency120(value) {
  return normalizeOptionalPhoneTarget(value).replace(/\D/g, "") === "120";
}

function getEnv() {
  return typeof process === "undefined" ? {} : process.env ?? {};
}
