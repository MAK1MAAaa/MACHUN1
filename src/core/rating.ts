const SCORE_MAX = 1_010_000;
const RATING_CAP_SCORE = 1_009_000;

interface RatingAnchor {
  score: number;
  value: number;
}

export function truncateTo4(value: number): number {
  return Math.trunc(value * 10_000 + Math.sign(value) * 1e-9) / 10_000;
}

export function calculateRating(score: number, chartConstant: number): number {
  if (!Number.isInteger(score) || score < 0 || score > SCORE_MAX) {
    throw new RangeError(`分数必须是 0 到 ${SCORE_MAX} 之间的整数`);
  }
  if (!Number.isFinite(chartConstant) || chartConstant <= 0) {
    throw new RangeError("谱面定数必须是正数");
  }
  if (score < 500_000) {
    return 0;
  }

  const anchors: RatingAnchor[] = [
    { score: 500_000, value: 0 },
    { score: 800_000, value: (chartConstant - 5) / 2 },
    { score: 900_000, value: chartConstant - 5 },
    { score: 975_000, value: chartConstant },
    { score: 990_000, value: chartConstant + 0.6 },
    { score: 1_000_000, value: chartConstant + 1 },
    { score: 1_005_000, value: chartConstant + 1.5 },
    { score: 1_007_500, value: chartConstant + 2 },
    { score: RATING_CAP_SCORE, value: chartConstant + 2.15 },
  ];

  const cappedScore = Math.min(score, RATING_CAP_SCORE);
  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (cappedScore <= upper.score) {
      const progress = (cappedScore - lower.score) / (upper.score - lower.score);
      return truncateTo4(Math.max(0, lower.value + (upper.value - lower.value) * progress));
    }
  }

  return truncateTo4(chartConstant + 2.15);
}

export function formatScore(score: number): string {
  return new Intl.NumberFormat("zh-CN").format(score);
}

export function scoreGrade(score: number): string {
  if (score >= 1_009_000) return "SSS+";
  if (score >= 1_007_500) return "SSS";
  if (score >= 1_005_000) return "SS+";
  if (score >= 1_000_000) return "SS";
  if (score >= 990_000) return "S+";
  if (score >= 975_000) return "S";
  if (score >= 950_000) return "AAA";
  if (score >= 925_000) return "AA";
  if (score >= 900_000) return "A";
  if (score >= 800_000) return "BBB";
  if (score >= 700_000) return "BB";
  if (score >= 600_000) return "B";
  if (score >= 500_000) return "C";
  return "D";
}
