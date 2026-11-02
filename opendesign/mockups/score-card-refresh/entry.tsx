import { createRoot } from "react-dom/client";
import { B30ScoreCard } from "../../../src/components/B30ScoreCard";
import { catalog } from "../../../src/core/catalog";
import type { Difficulty, ScoreAchievements, ScoreSource, SingleRating } from "../../../src/types";
import "../../../src/styles.css";
import "../../../src/mobile.css";
import "../../../src/workspace.css";
import "./preview.css";

// Only public catalog metadata and explicitly fictional scores enter this gallery.
const samples: Array<{ difficulty: Difficulty; source: ScoreSource; score: number } & ScoreAchievements> = [
  { difficulty: "EXP", source: "rin", score: 1_009_761, combo: "aj" },
  { difficulty: "MAS", source: "otogame", score: 1_008_512, combo: "fc" },
  { difficulty: "ULT", source: "munet", score: 1_005_989, clear: "absolute" },
  { difficulty: "EXP", source: "lxns", score: 1_003_456, clear: "hard" },
  { difficulty: "MAS", source: "rin", score: 999_831, clear: "brave" },
  { difficulty: "ULT", source: "otogame", score: 1_007_510, clear: "catastrophy" },
  { difficulty: "EXP", source: "manual", score: 1_009_000 },
  { difficulty: "MAS", source: "lxns", score: 1_010_000, combo: "ajc", fullChain: "platinum" },
];

createRoot(document.getElementById("score-card-demo")!).render(
  <main className="score-card-demo">
    <header className="score-card-demo-heading">
      <span>示例数据</span>
      <h1>分表卡片</h1>
      <p>公开曲库搭配虚构成绩，仅展示界面；没有连接账号、数据库或同步接口。</p>
    </header>
    <section className="b30-table-scroll" aria-label="B30 卡片示例">
      <div className="b30-grid">
        {samples.map((sample, index) => {
          const matching = catalog.filter(chart => chart.difficulty === sample.difficulty);
          const chart = index === 0
            ? matching.find(row => row.title === "The Devil Incarnate") ?? matching[0]
            : matching[index];
          const record: SingleRating = {
            id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
            source: sample.source, score: sample.score, rating: 16.25 + index / 100,
            updatedAt: "2026-11-01T00:00:00Z", combo: sample.combo, clear: sample.clear, fullChain: sample.fullChain,
          };
          return <B30ScoreCard key={index} rank={index + 1} record={record} coverUrl={chart.coverUrl} />;
        })}
        <B30ScoreCard rank={9} />
      </div>
    </section>
  </main>,
);
