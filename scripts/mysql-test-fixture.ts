import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { createDatabase } from '../server/db/connection';
import { hashPassword } from '../server/auth';
import { seedCatalog } from '../server/db/catalog';

export async function prepareTestDatabase() {
  const adminUrl = process.env.MACHUN_TEST_ADMIN_URL;
  if (!adminUrl || !/^machun1-test-[a-f0-9]{12}$/.test(process.env.MACHUN_TEST_CONTAINER ?? '')) throw new Error('必须通过 pnpm test:mysql 启动独立容器。');
  const parsed = new URL(adminUrl);
  if (parsed.protocol !== 'mysql:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username !== 'root' || parsed.pathname.length > 1) throw new Error('只允许测试容器的本机 MySQL URL。');
  const admin = await createConnection({ uri: adminUrl, multipleStatements: true, timezone: 'Z' });
  const directory = new URL('../db/migrations/', import.meta.url);
  const migration = (await Promise.all((await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => readFile(new URL(name, directory), 'utf8')))).join('\n');
  try {
    await admin.query(migration);
    const password = randomBytes(32).toString('hex');
    const username = `test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE USER '${username}'@'%' IDENTIFIED BY '${password}'`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON machun1.* TO '${username}'@'%'`);
    await admin.execute('INSERT IGNORE INTO machun1.users (username,pwd) VALUES (?,?)', ['root', hashPassword('pwd')]);
    const url = `mysql://${username}:${password}@127.0.0.1:${parsed.port}/machun1`;
    const { db, pool } = createDatabase(url);
    try { await seedCatalog(db); } catch (error) { await pool.end(); throw error; }
    return { admin, db, pool, url, migration };
  } catch (error) { await admin.end(); throw error; }
}
