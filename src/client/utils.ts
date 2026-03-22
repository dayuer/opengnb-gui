// @alpha: 工具函数模块
import { createIcons, icons } from 'lucide';

export const $ = (sel: string): HTMLElement | null => document.querySelector(sel);
export const $$ = (sel: string): NodeListOf<HTMLElement> => document.querySelectorAll(sel);
export const L = (name: string): string => `<i data-lucide="${name}"></i>`;

export function refreshIcons(): void {
  createIcons({ icons });
}

export function escHtml(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

export function safeAttr(str: string): string {
  return String(str).replace(/[&'"<>]/g, (c) =>
    ({ '&': '&amp;', "'": '&#39;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}

export function formatBytes(b: number): string {
  if (!b) return '0B';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)}G`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}M`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${b}B`;
}

export function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

export function pctColor(pct: number): string {
  return pct > 90 ? 'text-danger' : pct > 70 ? 'text-warning' : 'text-success';
}

export function pctBg(pct: number): string {
  return pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-success';
}

// Toast 无障碍容器 — 确保屏幕阅读器能朗读通知
let _toastContainer: HTMLElement | null = null;
function getToastContainer(): HTMLElement {
  if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.setAttribute('aria-live', 'polite');
  _toastContainer.setAttribute('aria-atomic', 'false');
  _toastContainer.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none';
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

export function showToast(msg: string, type: 'success' | 'error' | 'info' = 'success'): void {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = `px-5 py-2.5 rounded-lg text-sm font-medium text-white shadow-lg transition-opacity duration-300 pointer-events-auto ${type === 'error' ? 'bg-danger' : 'bg-success'}`;
  el.textContent = msg;
  el.style.opacity = '0';
  container.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// CIDR 工具
export function cidrMatch(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  if (!range || !bits) return false;
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

export function isValidCidr(cidr: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr);
}
