import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanionTask, BindingSubmission } from '../src/sourceBindingTypes';
import { createBrowserLauncher } from '../server/browser';
import { capturePortableSession, PORTAL_ORIGINS } from '../server/portableSession';
import type { BrowserSession } from '../server/provider';
import { SyncError } from '../server/provider';
import { rinProvider } from '../server/providers/rin';
import { munetProvider } from '../server/providers/munet';
import { otogameProvider } from '../server/providers/otogame';

export function remoteServer(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('请提供有效的 HTTPS 服务地址。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('助手仅支持 HTTPS 根地址；本机测试可使用 loopback HTTP。');
  return url.origin;
}
async function hiddenCode(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('请在电脑终端运行助手，并在提示后输入绑定码。');
  process.stdout.write('请输入网页绑定码（输入不会显示）：');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (data: string) => {
        for (const character of data) {
          if (character === '\u0003' || character === '\u0004') { process.stdin.off('data', onData); reject(new Error('登录已取消。')); return; }
          if (character === '\r' || character === '\n') { process.stdin.off('data', onData); resolve(value.trim()); return; }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (/[A-Za-z0-9_-]/.test(character) && value.length < 128) value += character;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
}
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length !== 4 || args[0] !== '--server' || args[2] !== '--task' || !/^[a-f0-9-]{36}$/.test(args[3])) throw new Error('用法：pnpm login:remote --server https://你的域名 --task 任务ID');
  const server = remoteServer(args[1]); const id = args[3]; const code = await hiddenCode();
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('绑定码格式无效，请重新复制网页中的绑定码。');
  async function request(method = 'GET', body?: BindingSubmission): Promise<CompanionTask> {
    let response;
    try {
      response = await fetch(`${server}/api/companion/binding-tasks/${id}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${code}`, 'X-Machun-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('无法连接服务，请检查 HTTPS 地址和网络；可重新运行同一命令查询绑定结果。'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('服务响应无效，请确认助手与服务器版本一致。'); }
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '服务拒绝了绑定请求。');
    return result;
  }
  let task = await request();
  if (task.status === 'complete') { console.log('该任务已绑定成功，可回到网页同步成绩。'); return; }
  if (!['pending', 'validating'].includes(task.status)) throw new Error(task.error ?? '任务已失效，请在网页重新生成。');
  if (task.status === 'pending') {
    const providers = { rin: rinProvider, munet: munetProvider, otogame: otogameProvider };
    const provider = providers[task.source];
    if (!provider || new URL(task.loginUrl).origin !== PORTAL_ORIGINS[task.source]) throw new Error('服务返回的门户地址无效。');
    const directory = await mkdtemp(join(tmpdir(), 'machun-login-'));
    let session: BrowserSession | undefined;
    const stop = () => { void session?.context.close().catch(() => undefined); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      console.log('请在独立窗口内手动登录官方门户并完成验证码。不要关闭网页绑定任务。');
      session = await createBrowserLauncher().open(directory, task.loginUrl, true);
      let submission: BindingSubmission | undefined; let failures = 0;
      while (Date.now() < Date.parse(task.expiresAt)) {
        const pages = session.context.pages().filter(page => !page.isClosed());
        if (!pages.length) throw new Error('登录窗口已关闭；可在网页重新生成任务。');
        const portal = pages.findLast(page => { try { return new URL(page.url()).origin === PORTAL_ORIGINS[task.source]; } catch { return false; } });
        if (portal) {
          session.page = portal;
          try {
            const identity = await provider.identify(session);
            submission = { identity, session: await capturePortableSession(session.context, task.source) }; break;
          } catch (error) {
            if (error instanceof SyncError && error.code === 'AUTH_REQUIRED') failures = 0;
            else if (error instanceof SyncError && !['NETWORK_ERROR', 'UPSTREAM_UNAVAILABLE'].includes(error.code)) throw new Error(error.message);
            else if (++failures > 3) throw new Error('门户验证失败，请检查网络后重试。');
          }
        }
        await delay(1500);
      }
      if (!submission) throw new Error('绑定任务已过期，请在网页重新生成。');
      await session.context.close(); session = undefined;
      console.log('已获取必要登录状态，正在由服务器核对账号与卡片。');
      try { task = await request('POST', submission); }
      catch {
        // Never resend credentials after an unknown outcome; use the read endpoint.
        task = await request();
        if (task.status === 'pending') throw new Error('服务尚未收到会话，请重新运行助手。');
      }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      await session?.context.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }
  while (task.status === 'validating' && Date.now() < Date.parse(task.expiresAt)) { await delay(1500); task = await request(); }
  if (task.status !== 'complete') throw new Error(task.error ?? '服务器未完成验证，请回到网页查看状态。');
  console.log('绑定成功，可回到网页同步成绩。电脑随后可以离线。');
}
if (process.argv[1]?.endsWith('login-remote.ts')) main().catch(error => { console.error(error instanceof Error ? error.message : '登录助手失败。'); process.exitCode = 1; });
