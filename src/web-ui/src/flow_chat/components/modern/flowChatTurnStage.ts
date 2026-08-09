export interface FlowChatTurnStageState {
  turnId: string;
  initialPx: number;
  remainingPx: number;
  baselineNaturalExtentPx: number;
  maxNaturalExtentPx: number;
  /**
   * A provisional stage has no measured baseline yet, so its natural extent is
   * meaningless. Consumption stays inert until alignment calibrates it.
   */
  isCalibrated: boolean;
}

export interface CreateProvisionalFlowChatTurnStageInput {
  turnId: string;
  viewportHeightPx: number;
}

export interface CalibrateFlowChatTurnStageInput {
  stage: FlowChatTurnStageState;
  remainingPx: number;
  scrollHeightPx: number;
  bottomLayoutInsetPx: number;
}

export type FlowChatTurnStageRemainingBucket = 0 | 1 | 2 | 3 | 4;

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

export function createProvisionalFlowChatTurnStage({
  turnId,
  viewportHeightPx,
}: CreateProvisionalFlowChatTurnStageInput): FlowChatTurnStageState {
  const initialPx = finiteNonNegative(viewportHeightPx);
  return {
    turnId,
    initialPx,
    remainingPx: initialPx,
    baselineNaturalExtentPx: 0,
    maxNaturalExtentPx: 0,
    isCalibrated: false,
  };
}

export function calibrateFlowChatTurnStage({
  stage,
  remainingPx,
  scrollHeightPx,
  bottomLayoutInsetPx,
}: CalibrateFlowChatTurnStageInput): FlowChatTurnStageState {
  const calibratedRemainingPx = Math.min(
    stage.initialPx,
    finiteNonNegative(remainingPx),
  );
  // Measure the natural extent while the provisional stage is still fully
  // represented in the DOM. At that point it exceeds Virtuoso's viewport-fill
  // slack, so subtracting it exposes real transcript growth.
  const naturalExtentPx = finiteNonNegative(
    scrollHeightPx - bottomLayoutInsetPx - stage.remainingPx,
  );
  return {
    turnId: stage.turnId,
    initialPx: calibratedRemainingPx,
    remainingPx: calibratedRemainingPx,
    baselineNaturalExtentPx: naturalExtentPx,
    maxNaturalExtentPx: naturalExtentPx,
    isCalibrated: true,
  };
}

export function consumeFlowChatTurnStage(
  stage: FlowChatTurnStageState,
  scrollHeightPx: number,
  bottomLayoutInsetPx: number,
): FlowChatTurnStageState {
  // Before calibration the baseline is still zero, so the whole pre-existing
  // transcript would be mistaken for this Turn's growth and swallow the stage
  // in a single call.
  if (!stage.isCalibrated) return stage;
  const naturalExtent = finiteNonNegative(
    scrollHeightPx - bottomLayoutInsetPx - stage.remainingPx,
  );
  const maxNaturalExtentPx = Math.max(stage.maxNaturalExtentPx, naturalExtent);
  const consumedPx = maxNaturalExtentPx - stage.baselineNaturalExtentPx;
  const remainingPx = Math.max(0, stage.initialPx - consumedPx);

  if (
    remainingPx === stage.remainingPx &&
    maxNaturalExtentPx === stage.maxNaturalExtentPx
  ) {
    return stage;
  }

  return {
    ...stage,
    remainingPx,
    maxNaturalExtentPx,
  };
}

export function getFlowChatTurnStageRemainingBucket(
  stage: FlowChatTurnStageState,
): FlowChatTurnStageRemainingBucket {
  if (stage.initialPx <= 0 || stage.remainingPx <= 0) return 0;
  const ratio = stage.remainingPx / stage.initialPx;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
