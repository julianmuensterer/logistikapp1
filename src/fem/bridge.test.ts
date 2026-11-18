import { describe, expect, it } from 'vitest';
import { BRIDGE_LENGTH, BridgeModel, DECK_DEAD_LOAD, TRAFFIC_WIDTH } from './bridge';

const model = new BridgeModel();

describe('BridgeModel', () => {
  it('has the real span layout', () => {
    expect(BRIDGE_LENGTH).toBe(2460);
    expect(model.elements.filter((e) => e.part === 'stay')).toHaveLength(154);
  });

  it('vertical reactions balance the unit traffic load', () => {
    let sum = 0;
    for (let d = 1; d < model.solQ.reactions.length; d += 3) sum += model.solQ.reactions[d];
    expect(sum).toBeCloseTo(TRAFFIC_WIDTH * BRIDGE_LENGTH, 0);
  });

  it('deck self-weight is carried (reactions ≥ deck weight)', () => {
    let sum = 0;
    for (let d = 1; d < model.solG.reactions.length; d += 3) sum += model.solG.reactions[d];
    expect(sum).toBeGreaterThan(DECK_DEAD_LOAD * BRIDGE_LENGTH);
  });

  it('tolerable load is positive, and smaller with safety factors and with wind', () => {
    const plain = model.evaluate(0, 0, false).qMax;
    const safe = model.evaluate(0, 0, true).qMax;
    const windy = model.evaluate(0, 250, false).qMax;
    expect(plain).toBeGreaterThan(0);
    expect(safe).toBeLessThan(plain);
    expect(windy).toBeLessThan(plain);
  });

  it('utilisation reaches 100 % exactly at the tolerable load', () => {
    const { qMax } = model.evaluate(0, 120, true);
    expect(model.evaluate(qMax, 120, true).maxEta).toBeCloseTo(1, 6);
  });
});
