interface FlowChatTurnStageBase {
  turnId: string;
  initialPx: number;
  remainingPx: number;
}

/**
 * A stage committed before alignment has run. Its natural-content baseline is
 * still unknown, so it carries no extent fields and cannot be consumed.
 */
export interface ProvisionalFlowChatTurnStage extends FlowChatTurnStageBase {
  isCalibrated: false;
}

/**
 * A stage whose baseline was measured while the provisional space was still
 * fully represented in the DOM. Only this shape can be consumed.
 */
export interface CalibratedFlowChatTurnStage extends FlowChatTurnStageBase {
  isCalibrated: true;
  baselineNaturalExtentPx: number;
  maxNaturalExtentPx: number;
}

export type FlowChatTurnStageState =
  | ProvisionalFlowChatTurnStage
  | CalibratedFlowChatTurnStage;

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

export interface FlowChatTurnStageViewportGeometry {
  scrollTopPx: number;
  scrollHeightPx: number;
  clientHeightPx: number;
}

export type FlowChatTurnStageRemainingBucket = 0 | 1 | 2 | 3 | 4;

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

export function createProvisionalFlowChatTurnStage({
  turnId,
  viewportHeightPx,
}: CreateProvisionalFlowChatTurnStageInput): ProvisionalFlowChatTurnStage {
  const initialPx = finiteNonNegative(viewportHeightPx);
  return {
    turnId,
    initialPx,
    remainingPx: initialPx,
    isCalibrated: false,
  };
}

export function calibrateFlowChatTurnStage({
  stage,
  remainingPx,
  scrollHeightPx,
  bottomLayoutInsetPx,
}: CalibrateFlowChatTurnStageInput): CalibratedFlowChatTurnStage {
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

/**
 * Only a calibrated stage is accepted: consuming a provisional one would count
 * the entire pre-existing transcript as this Turn's growth. Callers holding a
 * `FlowChatTurnStageState` must narrow on `isCalibrated` first.
 */
export function consumeFlowChatTurnStage(
  stage: CalibratedFlowChatTurnStage,
  scrollHeightPx: number,
  bottomLayoutInsetPx: number,
): CalibratedFlowChatTurnStage {
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

/**
 * How much of the stage has to stay so removing the rest cannot move content.
 * Free space is measured directly as the slack between `scrollTop` and the
 * bottom of the scroll range — the browser clamps only once the content can no
 * longer reach the reader's position.
 *
 * Do not reconstruct "the scroll range this transcript would have with no
 * stage" by subtracting `remainingPx` from `scrollHeightPx`. A transcript
 * shorter than its viewport makes that intermediate negative, and clamping it
 * to zero reports the whole of `scrollTop` as stage-supported — which reclaims
 * far past the slack and drops the transcript by the difference.
 *
 * The geometry must be read while `stage.remainingPx` is the amount actually
 * laid out, so the slack describes the same Footer the caller is trimming.
 */
export function measureVisibleFlowChatTurnStagePx(
  stage: FlowChatTurnStageState,
  geometry: FlowChatTurnStageViewportGeometry,
): number {
  const removableWithoutClampPx = (geometry.scrollHeightPx - geometry.clientHeightPx)
    - finiteNonNegative(geometry.scrollTopPx);
  return Math.min(
    stage.remainingPx,
    Math.max(0, stage.remainingPx - Math.max(0, removableWithoutClampPx)),
  );
}

/**
 * Reduces the stage to `remainingPx`. `initialPx` drops by the same amount so
 * the next consumption cannot recompute the trimmed space back into existence —
 * the stage may only ever shrink.
 *
 * `baselineNaturalExtentPx` deliberately stays put: the Footer loses exactly the
 * pixels the stage gave up, so the natural extent this stage was calibrated
 * against is unchanged and later growth still consumes pixel for pixel.
 */
export function trimFlowChatTurnStage(
  stage: CalibratedFlowChatTurnStage,
  remainingPx: number,
): CalibratedFlowChatTurnStage {
  const nextRemainingPx = Math.min(stage.remainingPx, finiteNonNegative(remainingPx));
  const trimmedPx = stage.remainingPx - nextRemainingPx;
  if (trimmedPx <= 0) return stage;
  return {
    ...stage,
    initialPx: Math.max(0, stage.initialPx - trimmedPx),
    remainingPx: nextRemainingPx,
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
