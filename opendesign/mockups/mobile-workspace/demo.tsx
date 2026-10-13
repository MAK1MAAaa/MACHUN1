import { createRoot } from 'react-dom/client';
import App from '/src/App';
import { catalog, catalogByKey } from '/src/core/catalog';
import { calculateRating } from '/src/core/rating';
import { SYNC_SOURCES } from '/src/syncTypes';
import '/src/styles.css';
import '/src/mobile.css';
import '/src/workspace.css';

// This design-only entry never reads localStorage or an account. All /api calls
// stay in memory; production entry points and authentication are unchanged.
const exampleCharts = [...catalog].sort((a, b) => b.constant - a.constant).slice(0, 50);
let workspace = {
  revision: 1, legacyMigrated: true,
  state: {
    schemaVersion: 2,
    scores: Object.fromEntries(exampleCharts.map((chart, index) => {
      const score = 1_007_000 - index * 79;
      return [`${chart.id}:${chart.difficulty}`, {
        id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
        score, rating: calculateRating(score, chart.constant), source: index % 2 ? 'rin' : 'lxns',
        updatedAt: '2026-10-13T00:00:00.000Z', ...(index % 3 === 0 ? { combo: 'aj' } : { combo: 'fc' }),
      }];
    })), nicknameOverrides: {},
  },
};
const sources = SYNC_SOURCES.map(source => ({ source, status: 'unbound', bound: false, identity: null,
  lastAttemptAt: null, lastSuccessAt: null, error: null, ...(source !== 'lxns' ? { bindingMode: 'companion' } : {}) }));
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
  const response = (payload, status = 200) => Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
  if (url.pathname === '/api/sources') return response({ sources });
  if (url.pathname === '/api/workspace') return response(workspace);
  if (url.pathname === '/api/workspace/actions') {
    const action = JSON.parse(String(init?.body ?? '{}'));
    const state = structuredClone(workspace.state);
    if (action.type === 'delete') delete state.scores[action.key];
    else if (action.type === 'clear') { state.scores = {}; state.nicknameOverrides = {}; }
    else if (action.type === 'aliases') state.nicknameOverrides[action.id] = action.aliases;
    else if (action.type === 'manual') {
      const chart = catalogByKey.get(action.key); const score = Number(action.score);
      if (!chart || !Number.isInteger(score) || score < 0 || score > 1_010_000) return response({ error: '请输入 0–1,010,000 的整数分数。' }, 400);
      state.scores[action.key] = { ...state.scores[action.key], id: chart.id, title: chart.title,
        difficulty: chart.difficulty, constant: chart.constant, score, rating: calculateRating(score, chart.constant),
        source: 'manual', updatedAt: new Date().toISOString() };
    } else return response({ error: '设计预览不连接门户或导入账号数据。' }, 409);
    workspace = { ...workspace, state, revision: workspace.revision + 1 };
    return response({ ...workspace, notice: '示例成绩已更新。' });
  }
  return response({ error: '此页面仅用于设计预览，请在正式网页绑定来源。' }, 409);
};
createRoot(document.getElementById('demo-root')!).render(<>
  <aside style={{ padding: '12px 20px', background: '#e3eddd', color: '#30483b', fontSize: '13px', textAlign: 'center' }}>
    设计预览 · 示例成绩 · 不读取或修改个人账号
  </aside>
  <App account={{ username: '示例用户' }} initial={workspace} />
</>);
