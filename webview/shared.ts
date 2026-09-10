import type { HostMessage, ViewMessage } from '../src/protocol';
declare function acquireVsCodeApi(): { postMessage(m: ViewMessage): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();
export const post = (message: ViewMessage) => api.postMessage(message);
export const saved = () => api.getState();
export function save(patch: Record<string, unknown>): void {
  const previous = api.getState();
  api.setState({ ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), ...patch });
}
export function listen(fn: (message: HostMessage) => void): void { window.addEventListener('message', e => fn(e.data)); }
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text: string, action: () => void, title = text): HTMLButtonElement {
  const b = el('button', '', text); b.type = 'button'; b.title = title; b.onclick = action; return b;
}
export const seconds = (n: number) => `${Number(n.toFixed(4))} s`;
