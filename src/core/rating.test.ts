import { describe, expect, it } from "vitest";
import { calculateRating, truncateTo4 } from "./rating";

describe("calculateRating", () => {
  const chartConstant = 14;

  it.each([
    [0, 0],
    [499_999, 0],
    [500_000, 0],
    [800_000, 4.5],
    [900_000, 9],
    [925_000, 10.6666],
    [950_000, 12.3333],
    [975_000, 14],
    [990_000, 14.6],
    [1_000_000, 15],
    [1_005_000, 15.5],
    [1_007_500, 16],
    [1_009_000, 16.15],
    [1_010_000, 16.15],
  ])("score %i returns %f", (score, expected) => {
    expect(calculateRating(score, chartConstant)).toBe(expected);
  });

  it("retains four decimal precision inside an interval", () => {
    expect(calculateRating(1_007_501, chartConstant)).toBe(16.0001);
    expect(calculateRating(975_001, chartConstant)).toBe(14);
  });

  it("rejects invalid scores and constants", () => {
    expect(() => calculateRating(-1, chartConstant)).toThrow(RangeError);
    expect(() => calculateRating(1_010_001, chartConstant)).toThrow(RangeError);
    expect(() => calculateRating(900_000.5, chartConstant)).toThrow(RangeError);
    expect(() => calculateRating(900_000, 0)).toThrow(RangeError);
  });
});

describe("truncateTo4", () => {
  it("truncates instead of rounding", () => {
    expect(truncateTo4(1.23459)).toBe(1.2345);
  });
});
