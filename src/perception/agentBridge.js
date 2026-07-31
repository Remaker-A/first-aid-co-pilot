import { stepAgentTurn } from "../agent/runPipeline.js";
import { createCprActionRecognitionEvent } from "./actionRecognition.js";

export function stepAgentWithActionRecognition(state, frame, options = {}) {
  const event = createCprActionRecognitionEvent(frame, options);
  const turn = stepAgentTurn(state, event, options);

  if (turn && typeof turn.then === "function") {
    return turn.then((result) => ({ ...result, event }));
  }

  return { ...turn, event };
}

export const stepAgentTurnWithActionRecognition = stepAgentWithActionRecognition;

