import type { BrowserSource } from './syncTypes';

/** Deliberately excludes cookies, passwords and full browser profiles. */
export interface PortableSession {
  version: 1;
  source: BrowserSource;
  localStorage: Record<string, string>;
}
