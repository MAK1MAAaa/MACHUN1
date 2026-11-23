import {
  CONSTANT_TABLE_AJ_COLORS,
  CONSTANT_TABLE_AJC_COLORS,
  CONSTANT_TABLE_DIFFICULTY_COLORS,
  CONSTANT_TABLE_FC_COLOR,
  CONSTANT_TABLE_LAMP_LABELS,
  CONSTANT_TABLE_SCORE_STYLES,
  constantTableLamp,
  constantTableScoreTier,
  validateConstantSelection,
  type ConstantTableEntry,
  type ConstantTableFilters,
  type ConstantTableGroup,
} from "./constantTable";
import { scoreGrade } from "./rating";
import { catalog } from "./catalog";
import { getAvailableChartConstants } from "./recordsView";
import { drawMateLogo, loadMateLogo } from "./exportBrand";

export interface ConstantTablePngOptions {
  showScores: boolean;
  filters: ConstantTableFilters;
}

export interface GeneratedConstantTablePng {
  blob: Blob;
  filename: string;
  missingCovers: number;
}

const WIDTH = 2000;
const MARGIN = 40;
const GAP = 12;
const HEADER_HEIGHT = 164;
const GROUP_HEADING = 58;
const GROUP_GAP = 28;
// Stay within the Canvas pixel budget used by mobile browsers, preserving every entry.
const MAX_CANVAS_SIDE = 16_000;
const MAX_CANVAS_PIXELS = 16_000_000;
const COVER_DEADLINE_MS = 20_000;
const scoreFormatter = new Intl.NumberFormat("en-US");

function fitText(context: CanvasRenderingContext2D, text: string, width: number): string {
  const characters = Array.from(text);
  if (context.measureText(text).width <= width) return text;
  while (characters.length && context.measureText(`${characters.join("")}…`).width > width) characters.pop();
  return `${characters.join("")}…`;
}

async function waitForFonts(): Promise<void> {
  if (!document.fonts) return;
  await new Promise<void>(resolve => {
    const timeout = window.setTimeout(resolve, 3000);
    const finish = () => { window.clearTimeout(timeout); resolve(); };
    document.fonts.ready.then(finish, finish);
  });
}

function loadCover(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = (loaded: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      image.onload = image.onerror = null;
      if (!loaded) image.src = "";
      resolve(loaded);
    };
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) { finish(null); return; }
      if (typeof image.decode === "function") image.decode().then(() => finish(image), () => finish(null));
      else finish(image);
    };
    image.onerror = () => finish(null);
    image.src = url;
  });
}

async function loadCovers(groups: readonly ConstantTableGroup[]): Promise<Map<string, HTMLImageElement | null>> {
  const urls = [...new Set(groups.flatMap(group => group.entries.map(entry => entry.chart.coverUrl)).filter(Boolean))];
  const images = new Map<string, HTMLImageElement | null>();
  const deadline = Date.now() + COVER_DEADLINE_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const remaining = deadline - Date.now();
      images.set(url, remaining > 0 ? await loadCover(url, Math.min(8000, remaining)) : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  return images;
}

function cover(context: CanvasRenderingContext2D, entry: ConstantTableEntry, image: HTMLImageElement | null | undefined, x: number, y: number, size: number): void {
  context.fillStyle = CONSTANT_TABLE_DIFFICULTY_COLORS[entry.chart.difficulty];
  context.fillRect(x, y, size, size);
  const inset = 5;
  const innerSize = size - inset * 2;
  if (image) {
    const scale = Math.max(innerSize / image.naturalWidth, innerSize / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.save();
    context.beginPath(); context.rect(x + inset, y + inset, innerSize, innerSize); context.clip();
    context.drawImage(image, x + (size - width) / 2, y + (size - height) / 2, width, height);
    context.restore();
  } else {
    context.fillStyle = "#e8ede7";
    context.fillRect(x + inset, y + inset, innerSize, innerSize);
    context.fillStyle = "#718574";
    context.font = '700 15px "Noto Sans SC", "PingFang SC", sans-serif';
    context.textAlign = "center";
    context.fillText("NO COVER", x + size / 2, y + size / 2 + 5);
  }
}

function gradientFill(
  context: CanvasRenderingContext2D,
  colors: readonly string[],
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasGradient {
  const gradient = context.createLinearGradient(x, y, x + width, y + height);
  colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
  return gradient;
}

function scoreLayerBackground(context: CanvasRenderingContext2D, entry: ConstantTableEntry, x: number, y: number, width: number, height: number): string | CanvasGradient {
  const style = CONSTANT_TABLE_SCORE_STYLES[constantTableScoreTier(entry.record)];
  return style.gradient ? gradientFill(context, style.gradient, x, y, width, height) : style.background;
}

function lampLayerBackground(context: CanvasRenderingContext2D, entry: ConstantTableEntry, x: number, y: number, width: number, height: number): string | CanvasGradient {
  const lamp = constantTableLamp(entry.record);
  if (lamp === "fc") return CONSTANT_TABLE_FC_COLOR;
  if (lamp === "aj") return gradientFill(context, CONSTANT_TABLE_AJ_COLORS, x, y, width, height);
  if (lamp === "ajc") return gradientFill(context, CONSTANT_TABLE_AJC_COLORS, x, y, width, height);
  if (lamp === "unplayed") return "#f1f5f9";
  return "#ffffff";
}

function lampLayerTextColor(entry: ConstantTableEntry): string {
  const lamp = constantTableLamp(entry.record);
  if (lamp === "fc") return "#047857";
  if (lamp === "ajc") return "#0f172a";
  if (lamp === "aj") return "#1e293b";
  if (lamp === "unplayed") return "#94a3b8";
  return "#334155";
}

function scorePanel(context: CanvasRenderingContext2D, entry: ConstantTableEntry, x: number, y: number, size: number): void {
  const topHeight = Math.round(size * 0.62);
  const bottomHeight = size - topHeight;
  const tier = constantTableScoreTier(entry.record);

  // Top layer: score + grade tier background
  context.fillStyle = scoreLayerBackground(context, entry, x, y, size, topHeight);
  context.fillRect(x, y, size, topHeight);

  // Bottom layer: AJ / AJC / FC / CLEAR lamp background
  context.fillStyle = lampLayerBackground(context, entry, x, y + topHeight, size, bottomHeight);
  context.fillRect(x, y + topHeight, size, bottomHeight);

  // Subtle horizontal divider between score tier and lamp tier
  context.fillStyle = "rgba(15, 23, 42, 0.1)";
  context.fillRect(x, y + topHeight, size, 1);

  context.strokeStyle = "#cbd5e1";
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  // Score & Grade in top layer
  context.textAlign = "center";
  context.fillStyle = CONSTANT_TABLE_SCORE_STYLES[tier].text;
  const score = entry.record ? scoreFormatter.format(entry.record.score) : "—";
  let scoreSize = 32;
  do { context.font = `900 ${scoreSize--}px "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace`; }
  while (context.measureText(score).width > size - 20 && scoreSize > 16);
  context.fillText(score, x + size / 2, y + topHeight * 0.44);
  context.font = '900 28px "Plus Jakarta Sans", "PingFang SC", sans-serif';
  context.fillText(entry.record ? scoreGrade(entry.record.score) : "—", x + size / 2, y + topHeight * 0.84);

  // Lamp label in bottom layer
  const lamp = constantTableLamp(entry.record);
  const label = CONSTANT_TABLE_LAMP_LABELS[lamp];
  context.fillStyle = lampLayerTextColor(entry);
  let lampSize = 21;
  do { context.font = `800 ${lampSize--}px "Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", sans-serif`; }
  while (context.measureText(label).width > size - 16 && lampSize > 12);
  context.fillText(label, x + size / 2, y + topHeight + bottomHeight * 0.64);
}

function subtitle(options: ConstantTablePngOptions, constants: string[]): string {
  const hasGaps = constants.some((value, index) => index > 0 && Math.round(Number(value) * 10) - Math.round(Number(constants[index - 1]) * 10) !== 1);
  const constant = constants.length === 1 || hasGaps ? constants.join("、") : `${constants[0]}–${constants.at(-1)}`;
  return [options.filters.difficulty || "全部难度", options.filters.level ? `等级 ${options.filters.level}` : "全部等级",
    `定数 ${constant}`, options.filters.genre || "全部分类", options.filters.version || "全部版本", options.showScores ? "显示成绩" : "封面模式"].join(" · ");
}

/** Render every supplied entry in its existing group order; never trim rows to fit. */
export async function generateConstantTablePng(groups: readonly ConstantTableGroup[], options: ConstantTablePngOptions): Promise<GeneratedConstantTablePng> {
  const constants = validateConstantSelection(options.filters.constants, getAvailableChartConstants(catalog, options.filters));
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0);
  if (!count) throw new Error("没有可导出的谱面，请调整筛选条件。");
  if (groups.length > 5 || count > 5000 || groups.some(group => !constants.includes(group.constant))) throw new Error("定数表内容超出范围，请重新生成。");
  const columns = options.showScores ? 5 : 10;
  const cardWidth = (WIDTH - MARGIN * 2 - GAP * (columns - 1)) / columns;
  const cardHeight = options.showScores ? cardWidth / 2 : cardWidth;
  const bodyHeight = groups.reduce((sum, group) => {
    const rows = Math.ceil(group.entries.length / columns);
    return sum + GROUP_HEADING + (rows ? rows * cardHeight + (rows - 1) * GAP : 42) + GROUP_GAP;
  }, 0);
  const logicalHeight = Math.ceil(HEADER_HEIGHT + bodyHeight + MARGIN);
  const scale = Math.min(1, MAX_CANVAS_SIDE / logicalHeight, Math.sqrt(MAX_CANVAS_PIXELS / (WIDTH * logicalHeight)));
  const canvas = document.createElement("canvas");
  let images = new Map<string, HTMLImageElement | null>();
  try {
    const [, covers, logo] = await Promise.all([waitForFonts(), loadCovers(groups), loadMateLogo()]);
    images = covers;
    canvas.width = Math.floor(WIDTH * scale);
    canvas.height = Math.floor(logicalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持 Canvas 图片导出。");
    context.scale(scale, scale);
    context.fillStyle = "#f5f7fc"; context.fillRect(0, 0, WIDTH, logicalHeight);
    const accentBar = context.createLinearGradient(0, 0, WIDTH, 0);
    accentBar.addColorStop(0, "#4f46e5");
    accentBar.addColorStop(0.5, "#0ea5e9");
    accentBar.addColorStop(1, "#7c3aed");
    context.fillStyle = accentBar; context.fillRect(0, 0, WIDTH, 6);
    const logoWidth = drawMateLogo(context, logo, MARGIN, 28, 60);
    const titleX = MARGIN + logoWidth + 22;
    context.textAlign = "left"; context.fillStyle = "#0f172a";
    context.font = '900 42px "Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", sans-serif';
    context.fillText("定数表", titleX, 76);
    context.font = '600 23px "Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", sans-serif'; context.fillStyle = "#475569";
    context.fillText(fitText(context, subtitle(options, constants), WIDTH - MARGIN * 2), MARGIN, 120);
    context.font = '500 17px "Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", sans-serif'; context.fillStyle = "#64748b";
    context.fillText(`共 ${count} 张谱面 · ULT → MAS → EXP · 上线时间从早到晚${scale < 0.999 ? ` · 已缩放至 ${Math.round(scale * 100)}%，全部谱面均保留` : ""}`, MARGIN, 149);
    let groupY = HEADER_HEIGHT;
    groups.forEach((group, index) => {
      if (index) {
        context.strokeStyle = "#cbd5e1"; context.lineWidth = 2; context.beginPath();
        context.moveTo(MARGIN, groupY + 2); context.lineTo(WIDTH - MARGIN, groupY + 2); context.stroke();
      }
      context.textAlign = "left"; context.fillStyle = "#4f46e5";
      context.font = '900 32px "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace'; context.fillText(group.constant, MARGIN, groupY + 39);
      context.font = '600 20px "Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", sans-serif'; context.fillStyle = "#64748b";
      context.fillText(`${group.entries.length} 张`, MARGIN + 112, groupY + 37);
      const cardY = groupY + GROUP_HEADING;
      group.entries.forEach((entry, entryIndex) => {
        const x = MARGIN + (entryIndex % columns) * (cardWidth + GAP);
        const y = cardY + Math.floor(entryIndex / columns) * (cardHeight + GAP);
        cover(context, entry, images.get(entry.chart.coverUrl), x, y, cardHeight);
        if (options.showScores) scorePanel(context, entry, x + cardHeight, y, cardHeight);
      });
      const rows = Math.ceil(group.entries.length / columns);
      if (!rows) { context.textAlign = "left"; context.fillText("该定数暂无匹配谱面", MARGIN, cardY + 27); }
      groupY += GROUP_HEADING + (rows ? rows * cardHeight + (rows - 1) * GAP : 42) + GROUP_GAP;
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("定数表图片生成超时，请缩小筛选范围后重试。")), 30_000);
      try {
        canvas.toBlob(value => { window.clearTimeout(timeout); value ? resolve(value) : reject(new Error("定数表图片生成失败，请缩小筛选范围后重试。")); }, "image/png");
      } catch { window.clearTimeout(timeout); reject(new Error("定数表图片无法编码，请检查封面访问或缩小筛选范围。")); }
    });
    return { blob, filename: `machun1-constant-table${options.showScores ? "-scores" : ""}-${new Date().toISOString().slice(0, 10)}.png`,
      missingCovers: [...images.values()].filter(image => !image).length };
  } finally { canvas.width = 0; canvas.height = 0; images.clear(); }
}
