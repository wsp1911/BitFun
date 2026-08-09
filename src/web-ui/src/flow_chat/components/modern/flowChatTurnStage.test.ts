import { describe, expect, it } from 'vitest';
import {
  calibrateFlowChatTurnStage,
  consumeFlowChatTurnStage,
  createProvisionalFlowChatTurnStage,
  getFlowChatTurnStageRemainingBucket,
} from './flowChatTurnStage';

describe('flowChatTurnStage', () => {
  it('creates a bounded stage and consumes it monotonically', () => {
    const provisional = createProvisionalFlowChatTurnStage({
      turnId: 'turn-1',
      viewportHeightPx: 800,
    });
    const stage = calibrateFlowChatTurnStage({
      stage: provisional,
      remainingPx: 400,
      scrollHeightPx: 1800,
      bottomLayoutInsetPx: 200,
    });
    expect(stage.initialPx).toBe(400);
    expect(getFlowChatTurnStageRemainingBucket(stage)).toBe(4);
    const consumed = consumeFlowChatTurnStage(stage, 1500, 200);
    expect(consumed.remainingPx).toBe(300);
    expect(getFlowChatTurnStageRemainingBucket(consumed)).toBe(3);
    expect(consumeFlowChatTurnStage(consumed, 1400, 200)).toBe(consumed);
  });

  it('keeps the stage exhausted and never restores shrinkage', () => {
    const provisional = createProvisionalFlowChatTurnStage({
      turnId: 'turn-1',
      viewportHeightPx: 600,
    });
    const stage = calibrateFlowChatTurnStage({
      stage: provisional,
      remainingPx: 300,
      scrollHeightPx: 1400,
      bottomLayoutInsetPx: 100,
    });
    const exhausted = consumeFlowChatTurnStage(stage, 1800, 100);
    expect(exhausted.remainingPx).toBe(0);
    expect(getFlowChatTurnStageRemainingBucket(exhausted)).toBe(0);
    expect(consumeFlowChatTurnStage(exhausted, 1200, 100).remainingPx).toBe(0);
  });

  it('keeps a provisional stage outside the consumable type', () => {
    const provisional = createProvisionalFlowChatTurnStage({
      turnId: 'turn-3',
      viewportHeightPx: 983,
    });

    expect(provisional.isCalibrated).toBe(false);
    expect(provisional.remainingPx).toBe(983);
    // Consuming it would count the 326px of pre-existing transcript as this
    // Turn's growth and swallow a third of the stage before alignment runs.
    // @ts-expect-error a provisional stage carries no baseline to consume from
    consumeFlowChatTurnStage(provisional, 1_413, 104);
  });

  it('calibrates a provisional viewport stage against its full geometry', () => {
    const provisional = createProvisionalFlowChatTurnStage({
      turnId: 'turn-2',
      viewportHeightPx: 800,
    });
    const calibrated = calibrateFlowChatTurnStage({
      stage: provisional,
      remainingPx: 250,
      scrollHeightPx: 1_450,
      bottomLayoutInsetPx: 200,
    });

    expect(calibrated.initialPx).toBe(250);
    expect(calibrated.remainingPx).toBe(250);
    expect(calibrated.baselineNaturalExtentPx).toBe(450);
    expect(calibrated.maxNaturalExtentPx).toBe(450);
    // Once the Footer is trimmed to 250px, the same natural content measures
    // 900px total. Another 200px of transcript growth consumes 200px.
    expect(consumeFlowChatTurnStage(calibrated, 1_100, 200).remainingPx).toBe(50);
  });
});
