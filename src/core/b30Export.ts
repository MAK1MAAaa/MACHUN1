import type { CatalogChart, ClearStatus, ComboStatus, Difficulty, FullChainStatus, ScoreAchievements, ScoreSource, SingleRating } from "../types";
import { B30_SIZE, chartKey, compareRatings, getB30 } from "./b30";
import { SCORE_SOURCE_LABELS } from "./sources";
import { scoreGrade } from "./rating";
import { CHAIN_LABELS, CLEAR_LABELS, COMBO_DESCRIPTIONS, mergeScoreAchievements } from "./scoreAchievements";
import { downloadBlob } from "./fileDelivery";

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

export interface AjB30Export extends Omit<B30ExportV3, "type"> {
  type: "machun1-aj-b30";
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

export function createAjB30Export(
  scores: Iterable<SingleRating>,
  charts: Map<string, CatalogChart>,
  catalogVersion: string,
  exportedAt = new Date().toISOString(),
): AjB30Export {
  const ajScores = Array.from(scores).filter((record) => record.combo === "aj" || record.combo === "ajc");
  return { ...createB30Export(ajScores, charts, catalogVersion, exportedAt), type: "machun1-aj-b30" };
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
  clear?: ClearStatus;
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
    ...(record.clear ? { clear: record.clear } : {}),
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
  downloadBlob(blob, withCandidates ? "b30-candidates20.json" : "b30.json");
}

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  EXP: "#dd2636",
  MAS: "#8b4bb7",
  ULT: "#26212e",
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

function drawCardBadge(
  context: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  border: string,
  background: string,
  rainbow = false,
): void {
  roundedRect(context, x, y, width, height, 2);
  if (rainbow) {
    const shimmer = context.createLinearGradient(x, y, x + width, y + height);
    for (const [offset, fill] of [[0, "#e5f9ee"], [0.3, "#fff1ba"], [0.6, "#eee1ff"], [1, "#dcf2ff"]] as const) {
      shimmer.addColorStop(offset, fill);
    }
    context.fillStyle = shimmer;
  } else context.fillStyle = background;
  context.fill();
  context.lineWidth = 1.5;
  context.strokeStyle = border;
  context.stroke();
  let size = 14;
  do {
    context.font = `900 ${size}px Inter, "Noto Sans SC", "PingFang SC", sans-serif`;
    if (context.measureText(label).width <= width - 12) break;
    size--;
  } while (size > 8);
  context.fillStyle = color;
  context.textAlign = "center";
  context.fillText(label, x + width / 2, y + (height + size * 0.72) / 2);
}

const CLEAR_BADGE_COLORS: Record<ClearStatus, { text: string; border: string; background: string }> = {
  failed: { text: "#666b75", border: "#b8bec8", background: "#f2f3f5" },
  clear: { text: "#336846", border: "#85b796", background: "#e7f5eb" },
  hard: { text: "#a33639", border: "#d98b8d", background: "#ffeaeb" },
  brave: { text: "#75509d", border: "#b89cd3", background: "#f3eaff" },
  absolute: { text: "#256885", border: "#81b7ce", background: "#e4f5fc" },
  catastrophy: { text: "#8b6415", border: "#c5a253", background: "#fff1c7" },
};

function drawFilledCard(
  context: CanvasRenderingContext2D,
  slot: B30ExportSlot,
  image: HTMLImageElement | null | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  context.save();
  roundedRect(context, x, y, width, height, 4);
  context.clip();
  context.fillStyle = DIFFICULTY_COLORS[slot.difficulty];
  context.fillRect(x, y, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(x, y + height - 39, width, 39);

  const sourceLabel = SCORE_SOURCE_LABELS[slot.source];
  context.font = '800 10px Inter, "PingFang SC", sans-serif';
  const sourceWidth = context.measureText(sourceLabel).width + 16;
  roundedRect(context, x + 8, y + 6, sourceWidth, 18, 3);
  context.fillStyle = "rgba(0, 0, 0, 0.28)";
  context.fill();
  context.textAlign = "left";
  context.fillStyle = "#ffffff";
  context.fillText(sourceLabel, x + 16, y + 19);
  if (slot.fullChain) {
    context.font = '800 10px Inter, "PingFang SC", sans-serif';
    context.fillText(CHAIN_LABELS[slot.fullChain], x + sourceWidth + 24, y + 19);
  }
  context.font = '900 15px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "right";
  context.fillText(`#${String(slot.rank).padStart(2, "0")}`, x + width - 10, y + 20);

  const coverSize = height - 42;
  context.fillStyle = "#ffffff";
  context.fillRect(x + 8, y + 30, coverSize + 4, coverSize + 4);
  drawCover(context, image, x + 10, y + 32, coverSize);
  const contentX = x + coverSize + 24;
  const contentWidth = width - coverSize - 36;
  context.textAlign = "left";
  context.fillStyle = "#ffffff";
  context.font = '800 20px Inter, "Noto Sans SC", "PingFang SC", sans-serif';
  context.fillText(titleLines(context, slot.title, contentWidth, 1)[0] ?? "", contentX, y + 54);
  const score = slot.score.toLocaleString("en-US");
  let scoreSize = 40;
  do {
    context.font = `900 ${scoreSize}px ui-monospace, "SFMono-Regular", monospace`;
    if (context.measureText(score).width <= contentWidth) break;
    scoreSize--;
  } while (scoreSize > 28);
  context.fillText(score, contentX, y + 104);
  context.font = '800 13px Inter, "PingFang SC", sans-serif';
  context.fillText(`${DIFFICULTY_LABELS[slot.difficulty]} ${slot.constant.toFixed(1)}`, contentX, y + 133);
  context.font = '800 12px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "right";
  context.fillText(`Rating: ${slot.rating.toFixed(4)}`, x + width - 12, y + 133);

  const leftWidth = Math.floor((contentWidth - 8) * 0.62);
  const badgeY = y + height - 31;
  const lampLabel = slot.combo ? COMBO_DESCRIPTIONS[slot.combo] : slot.clear ? CLEAR_LABELS[slot.clear] : "—";
  const lampColor = slot.combo
    ? slot.combo === "fc"
      ? { text: "#246842", border: "#81bd99", background: "#e2f5e6" }
      : { text: "#80571a", border: "#c4aa68", background: "#fff2c9" }
    : slot.clear ? CLEAR_BADGE_COLORS[slot.clear] : { text: "#6f7780", border: "#c9cfd4", background: "#f3f5f7" };
  drawCardBadge(context, lampLabel, contentX, badgeY, leftWidth, 23,
    lampColor.text, lampColor.border, lampColor.background, slot.combo === "aj" || slot.combo === "ajc");
  drawCardBadge(context, scoreGrade(slot.score), contentX + leftWidth + 8, badgeY, contentWidth - leftWidth - 8, 23,
    "#334f67", "#88a3b5", "#eef5f8", slot.score >= 1_000_000);
  context.restore();
  roundedRect(context, x, y, width, height, 4);
  context.strokeStyle = "rgba(32, 42, 60, 0.18)";
  context.lineWidth = 1;
  context.stroke();
}

function drawEmptyCard(
  context: CanvasRenderingContext2D,
  rank: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  roundedRect(context, x, y, width, height, 4);
  context.fillStyle = "rgba(255, 255, 255, 0.65)";
  context.fill();
  context.strokeStyle = "#d7dde5";
  context.setLineDash([7, 7]);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#6f90a5";
  context.font = '800 13px ui-monospace, "SFMono-Regular", monospace';
  context.textAlign = "right";
  context.fillText(`#${String(rank).padStart(2, "0")}`, x + width - 10, y + 20);
  context.fillStyle = "#9099a8";
  context.font = '800 13px Inter, "PingFang SC", sans-serif';
  context.textAlign = "center";
  context.fillText("EMPTY SLOT", x + width / 2, y + height / 2 + 5);
}

export interface GeneratedB30Png {
  blob: Blob;
  filename: string;
  missingCovers: number;
}

export interface B30PngOptions {
  nickname?: string;
}

function exportNickname(context: CanvasRenderingContext2D, value: string | undefined, maxWidth: number): string {
  const nickname = value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || "神秘游客";
  if (context.measureText(nickname).width <= maxWidth) return nickname;
  const characters = Array.from(nickname);
  while (characters.length && context.measureText(`${characters.join("")}…`).width > maxWidth) characters.pop();
  return `${characters.join("")}…`;
}

async function waitForExportFonts(): Promise<void> {
  if (!document.fonts) return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 3_000);
    const finish = () => { window.clearTimeout(timeout); resolve(); };
    document.fonts.ready.then(finish, finish);
  });
}

export async function generateB30Png(data: B30ExportV3 | B30CandidatesExport | AjB30Export, options: B30PngOptions = {}): Promise<GeneratedB30Png> {
  await waitForExportFonts();
  const canvas = document.createElement("canvas");
  const withCandidates = "candidates" in data;
  const isAj = data.type === "machun1-aj-b30";
  const slots = withCandidates ? [...data.b30, ...data.candidates] : data.b30;
  const columns = 5;
  const rows = Math.ceil(slots.length / columns);
  const width = 2360;
  const margin = 40;
  const columnGap = 14;
  const rowGap = 12;
  const headerHeight = 132;
  const cardHeight = 188;
  const cardWidth = (width - margin * 2 - columnGap * (columns - 1)) / columns;
  const candidateGap = withCandidates ? 64 : 0;
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
  const titleX = Math.round(width * 0.34);
  context.font = '800 44px Inter, "Noto Sans SC", "PingFang SC", sans-serif';
  context.fillText(exportNickname(context, options.nickname, titleX - margin - 64), margin, 85);
  context.font = '900 48px Inter, "PingFang SC", sans-serif';
  const title = isAj ? "AJ B30" : withCandidates ? "B30 + C20" : "B30";
  context.fillText(title, titleX, 85);
  const ratingX = titleX + context.measureText(`${title}  `).width;
  context.font = '900 52px ui-monospace, "SFMono-Regular", monospace';
  context.fillText(`Rating: ${data.summary.average.toFixed(4)}`, ratingX, 85);
  context.font = '500 15px Inter, "PingFang SC", sans-serif';
  context.fillStyle = "#758378";
  context.fillText(`MACHUN1 · ${data.exportedAt.slice(0, 10)}`, margin, 112);

  if (withCandidates) {
    const separatorY = headerHeight + (B30_SIZE / columns) * (cardHeight + rowGap) - rowGap + (rowGap + candidateGap) / 2;
    const label = "C20 · B31–B50";
    context.font = '800 16px Inter, "PingFang SC", sans-serif';
    const labelGap = context.measureText(label).width / 2 + 24;
    context.strokeStyle = "#bdcbbf";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(margin, separatorY);
    context.lineTo(width / 2 - labelGap, separatorY);
    context.moveTo(width / 2 + labelGap, separatorY);
    context.lineTo(width - margin, separatorY);
    context.stroke();
    context.fillStyle = "#59715f";
    context.textAlign = "center";
    context.fillText(label, width / 2, separatorY + 6);
  }

  slots.forEach((slot, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cardWidth + columnGap);
    const y = headerHeight + row * (cardHeight + rowGap) + (index >= B30_SIZE ? candidateGap : 0);
    if (slot) drawFilledCard(context, slot, covers.get(slot.coverUrl), x, y, cardWidth, cardHeight);
    else drawEmptyCard(context, index + 1, x, y, cardWidth, cardHeight);
  });

  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("B30 图片生成超时，请重试。")), 30_000);
      try {
        canvas.toBlob((result) => {
          window.clearTimeout(timeout);
          if (result) resolve(result);
          else reject(new Error("B30 图片生成失败"));
        }, "image/png");
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
      }
    });

    return {
      blob,
      filename: `machun1-${isAj ? "aj-" : ""}b30${withCandidates ? "-candidates20" : ""}-${data.exportedAt.slice(0, 10)}.png`,
      missingCovers: [...covers.values()].filter((image) => image === null).length,
    };
  } finally {
    // Release the large backing buffer after encoding, including failed exports.
    canvas.width = 0;
    canvas.height = 0;
  }
}
