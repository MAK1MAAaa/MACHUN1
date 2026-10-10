import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => vi.unstubAllGlobals());
function fallback(success = true) {
  class Element { focus = vi.fn(); }
  const active = new Element();
  const field = { value: '', readOnly: false, style: {}, select: vi.fn(), remove: vi.fn() };
  const execCommand = vi.fn(() => success);
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', { activeElement: active, createElement: vi.fn(() => field), body: { append: vi.fn() }, execCommand });
  return { field, active, execCommand };
}
describe('binding command copy on HTTP pages', () => {
  it('uses the Clipboard API on supported pages', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('command')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('command');
  });
  it.each([undefined, { writeText: vi.fn().mockRejectedValue(new Error('not allowed')) }])('copies using the selection fallback when Clipboard is unavailable', async clipboard => {
    vi.stubGlobal('navigator', { clipboard });
    const { field, active, execCommand } = fallback();
    expect(await copyText('binding-code')).toBe(true);
    expect(field.value).toBe('binding-code');
    expect(field.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(field.remove).toHaveBeenCalledOnce();
    expect(active.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it('reports copy failure and cleans up instead of claiming success', async () => {
    vi.stubGlobal('navigator', {});
    const { field } = fallback(false);
    expect(await copyText('code')).toBe(false);
    expect(field.remove).toHaveBeenCalledOnce();
  });
});
