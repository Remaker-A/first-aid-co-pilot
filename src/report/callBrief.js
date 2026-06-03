const DEFAULT_LOW_ACCURACY_THRESHOLD_M = 100;

const TEXT = Object.freeze({
  here: "\u8fd9\u91cc\u662f",
  coordinates: "\u5750\u6807",
  accuracyAbout: "\u5b9a\u4f4d\u7cbe\u5ea6\u7ea6",
  accuracyUnknown: "\u5b9a\u4f4d\u7cbe\u5ea6\u672a\u77e5",
  meter: "\u7c73",
  locationMissing: "位置未获取",
  coordinateMissing: "\u672a\u83b7\u53d6",
  lowAccuracy: "\u5b9a\u4f4d\u53ef\u80fd\u4e0d\u7cbe\u786e",
  siteAdult: "\u73b0\u573a\u6210\u4eba",
  sitePerson: "\u73b0\u573a\u4eba\u5458",
  unresponsive: "\u65e0\u53cd\u5e94",
  responsive: "\u6709\u53cd\u5e94",
  responseUnknown: "\u53cd\u5e94\u672a\u786e\u8ba4",
  noNormalBreathing: "\u65e0\u6b63\u5e38\u547c\u5438",
  normalBreathing: "\u6709\u6b63\u5e38\u547c\u5438",
  breathingUnknown: "\u547c\u5438\u672a\u786e\u8ba4",
  agonalBreathing: "\u53ef\u80fd\u5598\u606f\u6837\u547c\u5438",
  suspectedHandling: "\u6309\u7591\u4f3c\u5fc3\u810f\u9aa4\u505c\u5904\u7406",
  compressing: "\u6b63\u5728\u80f8\u5916\u6309\u538b",
  preparingCompressions: "\u51c6\u5907\u80f8\u5916\u6309\u538b",
  noCompressions: "\u6682\u672a\u8fdb\u884c\u80f8\u5916\u6309\u538b",
  callbackNumber: "\u56de\u62e8\u53f7\u7801",
  callbackMissing: "\u56de\u62e8\u53f7\u7801\u672a\u63d0\u4f9b",
  dispatchAmbulance: "\u8bf7\u6d3e\u6551\u62a4\u8f66",
  landmark: "\u5730\u6807",
  floor: "\u697c\u5c42",
  manualNote: "\u73b0\u573a\u5907\u6ce8",
});

const COMMA = "\uff0c";
const LIST_COMMA = "\u3001";
const PERIOD = "\u3002";

export function generateCallBrief(state = {}, options = {}) {
  const facts = state.confirmed_facts ?? {};
  const cprState = state.cpr_state ?? {};
  const scope = state.scope ?? {};
  const toolState = state.tool_state ?? {};
  const thresholdM = numberOrNull(options.lowAccuracyThresholdM) ?? DEFAULT_LOW_ACCURACY_THRESHOLD_M;
  const location = normalizeLocation(
    firstPlainObject(state.location, toolState.location, options.location),
  );
  const missingLocation = !hasLocationDetail(location);
  const lowAccuracy = !missingLocation && isLowAccuracy(location, thresholdM);
  const normalizedLocation = location
    ? {
        ...location,
        low_accuracy: lowAccuracy,
      }
    : null;
  const adultLikely = booleanOrNull(
    scope.adult_likely ??
      facts.adult_likely ??
      options.adult_likely ??
      options.adultLikely,
  );
  const responsive = booleanOrNull(facts.responsive);
  const normalBreathing = booleanOrNull(facts.normal_breathing);
  const agonalBreathing = booleanOrNull(facts.agonal_breathing);
  const cprInProgress = isCprInProgress(cprState);
  const suspectedHandling = inferSuspectedHandling(facts, cprState, {
    responsive,
    normalBreathing,
    agonalBreathing,
    cprInProgress,
  });
  const callbackNumber = firstString(
    options.callback_number,
    options.callbackNumber,
    options.phone_number,
    options.phoneNumber,
    state.callback_number,
    state.callbackNumber,
    toolState.callback_number,
    toolState.callbackNumber,
    toolState.emergency_callback_number,
    toolState.phone_number,
    state.rescuer_state?.callback_number,
    state.rescuer_state?.phone_number,
  );
  const flags = [];

  if (missingLocation) {
    flags.push("missing_location");
  }
  if (lowAccuracy) {
    flags.push("low_accuracy_location");
  }
  if (!callbackNumber) {
    flags.push("missing_callback_number");
  }

  const brief = {
    schema: "firstaid_call_brief_v1",
    destination: options.destination ?? "120",
    generated_at: options.generatedAt ?? options.generated_at ?? new Date().toISOString(),
    location: normalizedLocation,
    callback_number: callbackNumber,
    patient: {
      adult_likely: adultLikely,
      responsive,
      normal_breathing: normalBreathing,
      agonal_breathing: agonalBreathing,
    },
    assessment: {
      adult_suspected_cardiac_arrest:
        adultLikely !== false && suspectedHandling === true,
      unresponsive: responsive === false,
      no_normal_breathing:
        normalBreathing === false || agonalBreathing === true,
      suspected_cardiac_arrest_handling: suspectedHandling,
      cpr_in_progress: cprInProgress,
    },
    flags,
  };

  return {
    ...brief,
    script: generateCallBriefScript(brief),
  };
}

export function generateCallBriefScript(brief = {}) {
  const parts = [
    buildLocationSentence(brief),
  ];
  const locationFlags = new Set(brief.flags ?? []);

  if (locationFlags.has("low_accuracy_location")) {
    parts.push(`${TEXT.lowAccuracy}${PERIOD}`);
  }

  parts.push(buildAssessmentSentence(brief));
  parts.push(buildCallbackSentence(brief));
  parts.push(`${TEXT.dispatchAmbulance}${PERIOD}`);

  return parts.filter(Boolean).join("");
}

function buildLocationSentence(brief) {
  const location = brief.location ?? null;
  const address = formatAddress(location);
  const coordinates = formatCoordinates(location);
  const accuracy = formatAccuracy(location);

  return `${TEXT.here}${address}${COMMA}${TEXT.coordinates}${coordinates}${COMMA}${accuracy}${PERIOD}`;
}

function buildAssessmentSentence(brief) {
  const patient = brief.patient ?? {};
  const assessment = brief.assessment ?? {};
  const subject = patient.adult_likely === false ? TEXT.sitePerson : TEXT.siteAdult;
  const facts = [
    formatResponse(patient.responsive),
    formatBreathing(patient.normal_breathing, patient.agonal_breathing),
  ];
  const cprText = assessment.cpr_in_progress
    ? TEXT.compressing
    : assessment.suspected_cardiac_arrest_handling
      ? TEXT.preparingCompressions
      : TEXT.noCompressions;

  if (assessment.suspected_cardiac_arrest_handling) {
    return `${subject}${facts.join(LIST_COMMA)}${COMMA}${TEXT.suspectedHandling}${COMMA}${cprText}${PERIOD}`;
  }

  return `${subject}${facts.join(LIST_COMMA)}${COMMA}${cprText}${PERIOD}`;
}

function buildCallbackSentence(brief) {
  if (brief.callback_number) {
    return `${TEXT.callbackNumber}${brief.callback_number}${PERIOD}`;
  }

  return `${TEXT.callbackMissing}${PERIOD}`;
}

function formatAddress(location) {
  if (!location) {
    return TEXT.locationMissing;
  }

  const parts = [
    location.address_line,
    location.landmark ? `${TEXT.landmark}${location.landmark}` : null,
    location.floor ? `${TEXT.floor}${location.floor}` : null,
    location.manual_note ? `${TEXT.manualNote}${location.manual_note}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(COMMA) : TEXT.locationMissing;
}

function formatCoordinates(location) {
  if (!isFiniteNumber(location?.latitude) || !isFiniteNumber(location?.longitude)) {
    return TEXT.coordinateMissing;
  }

  return `${formatCoordinate(location.latitude)},${formatCoordinate(location.longitude)}`;
}

function formatAccuracy(location) {
  if (!isFiniteNumber(location?.accuracy_m)) {
    return TEXT.accuracyUnknown;
  }

  return `${TEXT.accuracyAbout}${formatMeters(location.accuracy_m)}${TEXT.meter}`;
}

function formatResponse(value) {
  if (value === false) {
    return TEXT.unresponsive;
  }
  if (value === true) {
    return TEXT.responsive;
  }

  return TEXT.responseUnknown;
}

function formatBreathing(normalBreathing, agonalBreathing) {
  if (normalBreathing === false) {
    return agonalBreathing === true
      ? `${TEXT.noNormalBreathing}${COMMA}${TEXT.agonalBreathing}`
      : TEXT.noNormalBreathing;
  }
  if (normalBreathing === true) {
    return TEXT.normalBreathing;
  }
  if (agonalBreathing === true) {
    return TEXT.agonalBreathing;
  }

  return TEXT.breathingUnknown;
}

function inferSuspectedHandling(facts, cprState, normalizedFacts) {
  if (facts.suspected_cardiac_arrest === true) {
    return true;
  }
  if (normalizedFacts.cprInProgress) {
    return true;
  }

  return (
    normalizedFacts.responsive === false &&
    (
      normalizedFacts.normalBreathing === false ||
      normalizedFacts.agonalBreathing === true
    )
  );
}

function isCprInProgress(cprState = {}) {
  return (
    cprState.started === true ||
    Boolean(cprState.started_at) ||
    positiveNumber(cprState.total_compressions) ||
    positiveNumber(cprState.current_rate)
  );
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }

  return definedValues({
    address_line: firstString(
      location.address_line,
      location.address,
      location.formatted_address,
    ),
    landmark: firstString(location.landmark),
    latitude: numberOrNull(location.latitude ?? location.lat),
    longitude: numberOrNull(location.longitude ?? location.lng ?? location.lon),
    accuracy_m: numberOrNull(
      location.accuracy_m ??
        location.accuracyMeters ??
        location.accuracy,
    ),
    floor: firstString(location.floor),
    manual_note: firstString(location.manual_note, location.note),
    provider: firstString(location.provider),
    captured_at: firstString(location.captured_at, location.timestamp),
    low_accuracy: booleanOrNull(location.low_accuracy),
  });
}

function hasLocationDetail(location) {
  return Boolean(
    location &&
      (
        location.address_line ||
        location.landmark ||
        location.manual_note ||
        (isFiniteNumber(location.latitude) && isFiniteNumber(location.longitude))
      ),
  );
}

function isLowAccuracy(location, thresholdM) {
  if (location?.low_accuracy === true) {
    return true;
  }

  return isFiniteNumber(location?.accuracy_m) && location.accuracy_m > thresholdM;
}

function firstPlainObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) ?? null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function numberOrNull(value) {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return isFiniteNumber(parsed) ? parsed : null;
  }

  return null;
}

function booleanOrNull(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return null;
}

function positiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCoordinate(value) {
  return value.toFixed(6);
}

function formatMeters(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function definedValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
  );
}
