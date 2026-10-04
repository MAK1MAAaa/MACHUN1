import { describe, expect, it } from "vitest";
import type { SingleRating } from "../types";
import { B30_SIZE, getB30, getB30Summary, getB30Axis } from "./b30";

function record(index: number, rating = index): SingleRating {
  return {
    id: String(index),
    title: `Song ${index}`,
    difficulty: "MAS",
    constant: 14,
    score: 1_000_000 + index,
    rating,
    updatedAt: "2026-08-03T00:00:00.000Z",
    source: "manual",
  };
}

describe("B30", () => {
  it("sorts descending and keeps exactly the best 30", () => {
    const scores = Array.from({ length: 35 }, (_, index) => record(index));
    const b30 = getB30(scores);
    expect(b30).toHaveLength(B30_SIZE);
    expect(b30[0].rating).toBe(34);
    expect(b30.at(-1)?.rating).toBe(5);
  });

  it("uses a fixed denominator of 30 for incomplete data", () => {
    const summary = getB30Summary([record(1, 15), record(2, 16)]);
    expect(summary.count).toBe(2);
    expect(summary.average).toBeCloseTo(31 / 30);
    expect(summary).not.toHaveProperty("total");
  });

  it("rounds the B1 + 0.2 upper bound down and the B30 - 0.2 lower bound up to tenths", () => {
    expect(getB30Axis([record(1, 17.15), record(2, 16.82)])).toEqual({ max: 17.3, min: 16.7, middle: 17, span: 17.3 - 16.7 });
    const scores = Array.from({ length: 31 }, (_, index) => record(index, 17.9 - index * 0.01));
    expect(getB30Axis(scores).min).toBe(17.5);
    expect(getB30Axis(scores).max).toBe(18.1);
  });

  it("keeps a usable axis for exact tenths, equal Ratings, zero scores and empty data", () => {
    expect(getB30Axis([record(1, 17.1)])).toMatchObject({ min: 16.9, max: 17.3, middle: 17.1 });
    expect(getB30Axis([record(1, 0), record(2, 0)])).toEqual({ min: -0.2, max: 0.2, middle: 0, span: 0.4 });
    expect(getB30Axis([])).toEqual({ min: 0, max: 18, middle: 9, span: 18 });
  });
});
