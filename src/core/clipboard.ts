/** HTTP IP pages do not have the secure-context Clipboard API. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* Try the browser's user-initiated copy command. */ }
  const active = document.activeElement;
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
