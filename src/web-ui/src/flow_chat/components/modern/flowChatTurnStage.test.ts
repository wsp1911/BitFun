import { describe, expect, it } from 'vitest';
import {
  calibrateFlowChatTurnStage,
  consumeFlowChatTurnStage,
  createProvisionalFlowChatTurnStage,
  getFlowChatTurnStageRemainingBucket,
  measureVisibleFlowChatTurnStagePx,
  trimFlowChatTurnStage,
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

  describe('trimming the part of the stage nobody can see', () => {
    // 1200px of transcript under a 600px stage, in an 800px viewport. The reader
    // sits at 700, so 300px of the stage is on screen and 300px is past the
    // viewport bottom.
    const stageWithBlankTail = () => calibrateFlowChatTurnStage({
      stage: createProvisionalFlowChatTurnStage({ turnId: 'turn-1', viewportHeightPx: 600 }),
      remainingPx: 600,
      scrollHeightPx: 1800,
      bottomLayoutInsetPx: 0,
    });

    it('keeps only the stage the viewport still reaches', () => {
      expect(measureVisibleFlowChatTurnStagePx(stageWithBlankTail(), {
        scrollTopPx: 700,
        scrollHeightPx: 1800,
        clientHeightPx: 800,
      })).toBe(300);
    });

    it('offers nothing while the reader sits at the physical bottom', () => {
      const stage = stageWithBlankTail();
      // scrollTop is already at the maximum, so every pixel of the stage is
      // holding the viewport up. Removing any of it would clamp.
      expect(measureVisibleFlowChatTurnStagePx(stage, {
        scrollTopPx: 1000,
        scrollHeightPx: 1800,
        clientHeightPx: 800,
      })).toBe(600);
      expect(trimFlowChatTurnStage(stage, 600)).toBe(stage);
    });

    // The shape of a fresh session: 500px of transcript under a 600px stage in
    // an 800px viewport. Only the stage makes the page scrollable at all, so
    // "the scroll range without the stage" is negative and cannot be used to
    // work out what is free — the slack between scrollTop and the bottom can.
    it('offers only the real slack when the transcript is shorter than the viewport', () => {
      const stage = calibrateFlowChatTurnStage({
        stage: createProvisionalFlowChatTurnStage({ turnId: 'turn-1', viewportHeightPx: 800 }),
        remainingPx: 600,
        scrollHeightPx: 1300,
        bottomLayoutInsetPx: 0,
      });
      expect(stage.baselineNaturalExtentPx).toBe(500);

      // scrollHeight 1100, so the bottom of the range is 300 and the reader at
      // 250 has 50px of slack. Reclaiming the 350px that a stage-free range of
      // "zero" would imply would drop the transcript by 300px.
      expect(measureVisibleFlowChatTurnStagePx(stage, {
        scrollTopPx: 250,
        scrollHeightPx: 1100,
        clientHeightPx: 800,
      })).toBe(550);
    });

    it('offers the whole stage to a reader who scrolled away from it', () => {
      expect(measureVisibleFlowChatTurnStagePx(stageWithBlankTail(), {
        scrollTopPx: 120,
        scrollHeightPx: 1800,
        clientHeightPx: 800,
      })).toBe(0);
    });

    it('lets later growth keep consuming pixel for pixel after a trim', () => {
      const trimmed = trimFlowChatTurnStage(stageWithBlankTail(), 300);
      expect(trimmed.remainingPx).toBe(300);
      expect(trimmed.initialPx).toBe(300);

      // The Footer lost exactly the 300px the stage gave up, so the settled DOM
      // measures the same natural extent and nothing further is consumed.
      expect(consumeFlowChatTurnStage(trimmed, 1500, 0)).toBe(trimmed);
      // 200px of real growth still consumes 200px.
      expect(consumeFlowChatTurnStage(trimmed, 1700, 0).remainingPx).toBe(100);
    });

    it('never recomputes trimmed space back into existence', () => {
      const trimmed = trimFlowChatTurnStage(stageWithBlankTail(), 300);
      // Content shrank below the calibration baseline; the watermark ignores it.
      expect(consumeFlowChatTurnStage(trimmed, 900, 0).remainingPx).toBe(300);
      expect(trimFlowChatTurnStage(trimmed, 500).remainingPx).toBe(300);
    });
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
