import { fileURLToPath } from 'node:url';
import { createDatabase, databaseUrl } from '../server/db/connection';
import { seedCatalog, loadCatalog } from '../server/db/catalog';

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { db, pool } = createDatabase(await databaseUrl(root));
  try {
    await seedCatalog(db);
    const snapshot = await loadCatalog(db);
    console.log(JSON.stringify({ version: snapshot.version, songs: new Set(snapshot.charts.map(chart => chart.id)).size,
      scoringCharts: snapshot.charts.length, detailCharts: snapshot.details.length }));
  } catch {
    console.error('曲库入库失败，事务未提交；请检查数据库和 SSH 隧道后重试。');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
main().catch(() => { console.error('MySQL 配置无效或无法连接，请检查 .env 和 SSH 隧道。'); process.exitCode = 1; });
