import type { SingleRating } from "../types";

export const B30_SIZE = 30;

export function chartKey(record: Pick<SingleRating, "id" | "difficulty">): string {
  return `${record.id}:${record.difficulty}`;
}

export function compareRatings(left: SingleRating, right: SingleRating): number {
  return (
    right.rating - left.rating ||
    right.score - left.score ||
    right.constant - left.constant ||
    left.title.localeCompare(right.title, "zh-CN") ||
    chartKey(left).localeCompare(chartKey(right))
  );
}

export function getB30(scores: Iterable<SingleRating>): SingleRating[] {
  return Array.from(scores).sort(compareRatings).slice(0, B30_SIZE);
}

export function getB30Axis(scores: Iterable<SingleRating>): { min: number; max: number; middle: number; span: number } {
  const b30 = getB30(scores);
  if (!b30.length) return { min: 0, max: 18, middle: 9, span: 18 };
  // Ratings use four decimals; the epsilon keeps exact tenths stable in binary arithmetic.
  const max = Math.floor((b30[0].rating + 0.2) * 10 + 1e-8) / 10;
  const min = Math.ceil((b30[b30.length - 1].rating - 0.2) * 10 - 1e-8) / 10;
  return { min, max, middle: (min + max) / 2, span: max - min };
}

export function getB30Summary(scores: Iterable<SingleRating>): {
  count: number;
  average: number;
} {
  const b30 = getB30(scores);
  const ratingSum = b30.reduce((sum, record) => sum + record.rating, 0);
  return {
    count: b30.length,
    average: ratingSum / B30_SIZE,
  };
}
