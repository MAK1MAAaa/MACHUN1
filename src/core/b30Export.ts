import type { CatalogChart, ComboStatus, Difficulty, FullChainStatus, ScoreAchievements, ScoreSource, SingleRating } from "../types";
import { B30_SIZE, chartKey, compareRatings, getB30 } from "./b30";
import { SCORE_SOURCE_LABELS } from "./sources";
import { scoreGrade } from "./rating";
import { CHAIN_LABELS, COMBO_LABELS, mergeScoreAchievements } from "./scoreAchievements";

export interface B30ExportSlot extends ScoreAchievements {
  rank: number;
  id: string;
  title: string;
  difficulty: Difficulty;
  constant: number;
  score: number;
  rating: number;
  coverUrl: string;
  source: ScoreSource;
}

export interface B30ExportV3 {
  schemaVersion: 3;
  type: "machun1-b30";
  catalogVersion: string;
  exportedAt: string;
  summary: {
    filled: number;
    average: number;
  };
  b30: Array<B30ExportSlot | null>;
}

export function createB30Export(
  scores: Iterable<SingleRating>,
  charts: Map<string, CatalogChart>,
  catalogVersion: string,
  exportedAt = new Date().toISOString(),
): B30ExportV3 {
  const ranked = getB30(scores);
  const total = ranked.reduce((sum, record) => sum + record.rating, 0);
  const b30 = Array.from({ length: B30_SIZE }, (_, index): B30ExportSlot | null => {
    const record = ranked[index];
    if (!record) return null;
    return {
      rank: index + 1,
      id: record.id,
      title: record.title,
      difficulty: record.difficulty,
      constant: record.constant,
      score: record.score,
      rating: record.rating,
      coverUrl: charts.get(chartKey(record))?.coverUrl ?? "",
      source: record.source,
      ...mergeScoreAchievements(record, {}),
    };
  });

  return {
    schemaVersion: 3,
    type: "machun1-b30",
    catalogVersion,
    exportedAt,
    summary: {
      filled: ranked.length,
      average: total / B30_SIZE,
    },
    b30,
  };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export interface B30CandidatesExport extends B30ExportV3 {
  candidates: Array<B30ExportSlot | null>;
}

export function createB30CandidatesExport(
  scores: Iterable<SingleRating>,
  charts: Map<string, CatalogChart>,
  catalogVersion: string,
): B30CandidatesExport {
  const ranked = Array.from(scores).sort(compareRatings);
  const data = createB30Export(ranked, charts, catalogVersion);
  const candidates = Array.from({ length: 20 }, (_, index): B30ExportSlot | null => {
    const record = ranked[B30_SIZE + index];
    if (!record) return null;
    return {
      rank: B30_SIZE + index + 1,
      id: record.id,
      title: record.title,
      difficulty: record.difficulty,
      constant: record.constant,
      score: record.score,
      rating: record.rating,
      coverUrl: charts.get(chartKey(record))?.coverUrl ?? "",
      source: record.source,
      ...mergeScoreAchievements(record, {}),
    };
  });
  return { ...data, candidates };
}

interface OtoB30Record {
  song_id: string;
  difficulty: number;
  music: { name: string };
  score: number;
  full_combo?: "fullcombo" | "alljustice" | "alljusticecritical";
  full_chain?: "fchain" | "fullchain2" | "fullchain";
}

const EXPORTED_COMBO: Record<ComboStatus, NonNullable<OtoB30Record["full_combo"]>> = {
  fc: "fullcombo", aj: "alljustice", ajc: "alljusticecritical",
};
const EXPORTED_CHAIN: Record<FullChainStatus, NonNullable<OtoB30Record["full_chain"]>> = {
  fchain: "fchain", gold: "fullchain2", platinum: "fullchain",
};

export interface OtoB30Export {
  code: 0;
  data: {
    base_rating_list: OtoB30Record[];
    new_rating_list: OtoB30Record[];
    next_rating_list: OtoB30Record[];
    new_next_rating_list: OtoB30Record[];
  };
}

export function createOtoB30Export(scores: Iterable<SingleRating>, withCandidates = false): OtoB30Export {
  const levels: Record<Difficulty, number> = { EXP: 2, MAS: 3, ULT: 4 };
  const ranked = Array.from(scores).sort(compareRatings);
  const toOtoRecord = (record: SingleRating): OtoB30Record => ({
    song_id: record.id,
    difficulty: levels[record.difficulty],
    music: { name: record.title },
    score: record.score,
    ...(record.combo ? { full_combo: EXPORTED_COMBO[record.combo] } : {}),
    ...(record.fullChain ? { full_chain: EXPORTED_CHAIN[record.fullChain] } : {}),
  });
  return {
    code: 0,
    data: {
      base_rating_list: ranked.slice(0, B30_SIZE).map(toOtoRecord),
      new_rating_list: [],
      next_rating_list: withCandidates ? ranked.slice(B30_SIZE, B30_SIZE + 20).map(toOtoRecord) : [],
      new_next_rating_list: [],
    },
  };
}

export function downloadB30Json(scores: Iterable<SingleRating>, withCandidates = false): void {
  const blob = new Blob([JSON.stringify(createOtoB30Export(scores, withCandidates), null, 2)], { type: "application/json" });
  triggerDownload(blob, withCandidates ? "b30-candidates20.json" : "b30.json");
}

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  EXP: "#ef4454",
  MAS: "#a989ed",
  ULT: "#050506",
};

const DIFFICULTY_TINTS: Record<Difficulty, string> = {
  EXP: "rgba(239, 68, 84, 0.24)",
  MAS: "rgba(169, 137, 237, 0.32)",
  ULT: "rgba(5, 5, 6, 0.16)",
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EXP: "EXPERT",
  MAS: "MASTER",
  ULT: "ULTIMA",
};

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function titleLines(
  context: CanvasRenderingContext2D,
  title: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const characters = Array.from(title);
  const lines: string[] = [];
  let current = "";

  for (let index = 0; index < characters.length; index += 1) {
    const candidate = `${current}${characters[index]}`;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      let finalLine = `${current}${characters.slice(index).join("")}`;
      while (finalLine && context.measureText(`${finalLine}…`).width > maxWidth) {
        finalLine = finalLine.slice(0, -1);
      }
      lines.push(`${finalLine}…`);
      return lines;
    }
    if (current) lines.push(current);
    current = characters[index];
  }

  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.src = "";
      resolve(null);
    }, 15_000);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
    image.src = url;
  });
}

async function loadCoverImages(urls: string[]): Promise<Map<string, HTMLImageElement | null>> {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  const images = new Map<string, HTMLImageElement | null>();
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueUrls.length) {
      const url = uniqueUrls[cursor];
      cursor += 1;
      images.set(url, await loadImage(url));
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, uniqueUrls.length) }, worker));
  return images;
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null | undefined,
  x: number,
  y: number,
  size: number,
): void {
  roundedRect(context, x, y, size, size, 8);
  context.save();
  context.clip();
  if (image) {
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, x + (size - width) / 2, y + (size - height) / 2, width, height);
  } else {
    const fallback = context.createLinearGradient(x, y, x + size, y + size);
    fallback.addColorStop(0, "#e9edf3");
    fallback.addColorStop(1, "#d7dfe9");
    context.fillStyle = fallback;
    context.fillRect(x, y, size, size);
    context.fillStyle = "#7d9db2";
    context.font = '700 12px Inter, "PingFang SC", sans-serif';
    context.textAlign = "center";
    context.fillText("NO COVER", x + size / 2, y + size / 2 + 4);
  }
  context.restore();
}

function drawFilledCard(
  context: CanvasRenderingContext2D,
  slot: B30ExportSlot,
  image: HTMLImageElement | null | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const accent = DIFFICULTY_COLORS[slot.difficulty];
  roundedRect(context, x, y, width, height, 10);
  context.fillStyle = "#ffffff";
  context.fill();
  context.fillStyle = DIFFICULTY_TINTS[slot.difficulty];
  context.fill();
  context.strokeStyle = "rgba(32, 42, 60, 0.10)";
  context.lineWidth = 1;
  context.stroke();

  context.fillStyle = accent;
  roundedRect(context, x, y, 5, height, 3);
  context.fill();
  if (slot.difficulty === "ULT") {
    context.fillStyle = "#737b87";
    context.fillRect(x + 5, y, 1, height);
  }

  const coverSize = height - 24;
  drawCover(context, image, x + 14, y + 12, coverSize);

  context.fillStyle = "rgba(5, 8, 13, 0.88)";
  roundedRect(context, x + 20, y + 18, 42, 24, 6);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = '800 13px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "center";
  context.fillText(`#${String(slot.rank).padStart(2, "0")}`, x + 41, y + 35);

  const contentX = x + coverSize + 30;
  const contentWidth = width - coverSize - 44;
  context.textAlign = "left";
  context.font = '800 12px Inter, "PingFang SC", sans-serif';
  const difficultyLabel = DIFFICULTY_LABELS[slot.difficulty];
  const labelWidth = context.measureText(difficultyLabel).width + 16;
  roundedRect(context, contentX, y + 9, labelWidth, 22, 5);
  context.fillStyle = accent;
  context.fill();
  if (slot.difficulty === "ULT") {
    context.strokeStyle = "#737b87";
    context.stroke();
  }
  context.fillStyle = slot.difficulty === "ULT" ? "#f5f6f8" : "#080b12";
  context.fillText(difficultyLabel, contentX + 8, y + 24);
  context.fillStyle = "#5c6575";
  context.fillText(
    `定数 ${slot.constant.toFixed(1)} · ${SCORE_SOURCE_LABELS[slot.source]}`,
    contentX + labelWidth + 9,
    y + 24,
  );

  context.fillStyle = "#202a3c";
  context.font = '800 19px Inter, "Noto Sans SC", "PingFang SC", sans-serif';
  const lines = titleLines(context, slot.title, contentWidth, 2);
  lines.forEach((line, index) => context.fillText(line, contentX, y + 54 + index * 23));

  const badges = [
    { label: scoreGrade(slot.score), background: "#fff2c9", color: "#80571a" },
    ...(slot.combo ? [{ label: COMBO_LABELS[slot.combo], background: slot.combo === "fc" ? "#e2f5e6" : slot.combo === "aj" ? "#ffedcc" : "#ede3ff", color: slot.combo === "fc" ? "#246842" : slot.combo === "aj" ? "#9b5718" : "#6442a0" }] : []),
    ...(slot.fullChain ? [{ label: CHAIN_LABELS[slot.fullChain], background: slot.fullChain === "gold" ? "#fff1bf" : "#e4f2fa", color: slot.fullChain === "gold" ? "#87611c" : "#43677c" }] : []),
  ];
  let badgeX = contentX;
  context.font = '800 11px Inter, "PingFang SC", sans-serif';
  for (const badge of badges) {
    const badgeWidth = context.measureText(badge.label).width + 12;
    roundedRect(context, badgeX, y + height - 52, badgeWidth, 18, 4);
    context.fillStyle = badge.background;
    context.fill();
    context.fillStyle = badge.color;
    context.fillText(badge.label, badgeX + 6, y + height - 39);
    badgeX += badgeWidth + 5;
  }
  context.fillStyle = "#667085";
  context.font = '700 10px Inter, "PingFang SC", sans-serif';
  context.textAlign = "right";
  context.fillText("RATING", x + width - 15, y + height - 35);

  context.fillStyle = "#202a3c";
  context.font = '800 18px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "left";
  context.fillText(slot.score.toLocaleString("en-US"), contentX, y + height - 13);
  context.fillStyle = "#202a3c";
  context.font = '900 20px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "right";
  context.fillText(slot.rating.toFixed(4), x + width - 15, y + height - 13);
}

function drawEmptyCard(
  context: CanvasRenderingContext2D,
  rank: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  roundedRect(context, x, y, width, height, 10);
  context.fillStyle = "rgba(255, 255, 255, 0.65)";
  context.fill();
  context.strokeStyle = "#d7dde5";
  context.setLineDash([7, 7]);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#6f90a5";
  context.font = '800 13px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "left";
  context.fillText(`#${String(rank).padStart(2, "0")}`, x + 16, y + 25);
  context.fillStyle = "#9099a8";
  context.font = '800 13px Inter, "PingFang SC", sans-serif';
  context.textAlign = "center";
  context.fillText("EMPTY SLOT", x + width / 2, y + height / 2 + 5);
}

export async function downloadB30Png(data: B30ExportV3 | B30CandidatesExport): Promise<{ missingCovers: number }> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  const withCandidates = "candidates" in data;
  const slots = withCandidates ? [...data.b30, ...data.candidates] : data.b30;
  const columns = 5;
  const rows = Math.ceil(slots.length / columns);
  const width = 2360;
  const margin = 40;
  const columnGap = 14;
  const rowGap = 12;
  const headerHeight = 132;
  const cardHeight = 148;
  const cardWidth = (width - margin * 2 - columnGap * (columns - 1)) / columns;
  const candidateGap = withCandidates ? 32 : 0;
  const height = headerHeight + cardHeight * rows + rowGap * (rows - 1) + margin + candidateGap;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持 Canvas 图片导出");
  const covers = await loadCoverImages(
    slots.flatMap((slot) => (slot?.coverUrl ? [slot.coverUrl] : [])),
  );

  context.fillStyle = "#f5f6f8";
  context.fillRect(0, 0, width, height);
  context.textAlign = "left";
  context.fillStyle = "#202a3c";
  context.font = '900 48px Inter, "PingFang SC", sans-serif';
  context.fillText("B30", margin, 85);
  context.textAlign = "right";
  context.font = '900 52px ui-monospace, "SFMono-Regular", monospace';
  context.fillText(data.summary.average.toFixed(4), width - margin, 85);

  slots.forEach((slot, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cardWidth + columnGap);
    const y = headerHeight + row * (cardHeight + rowGap) + (index >= B30_SIZE ? candidateGap : 0);
    if (slot) drawFilledCard(context, slot, covers.get(slot.coverUrl), x, y, cardWidth, cardHeight);
    else drawEmptyCard(context, index + 1, x, y, cardWidth, cardHeight);
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("B30 图片生成失败"));
    }, "image/png");
  });
  triggerDownload(blob, `machun1-b30${withCandidates ? "-candidates20" : ""}-${data.exportedAt.slice(0, 10)}.png`);

  return {
    missingCovers: [...covers.values()].filter((image) => image === null).length,
  };
}
