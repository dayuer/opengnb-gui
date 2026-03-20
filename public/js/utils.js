'use strict';
// @alpha: 工具函数模块

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const L = (name) => `<i data-lucide="${name}"></i>`;

function refreshIcons() { if (window.lucide) lucide.createIcons(); }

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function safeAttr(str) {
  return String(str).replace(/[&'"<>]/g, c => ({'&':'&amp;',"'":'&#39;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
}

function formatBytes(b) {
  if (!b) return '0B';
  if (b >= 1073741824) return `${(b/1073741824).toFixed(1)}G`;
  if (b >= 1048576) return `${(b/1048576).toFixed(1)}M`;
  if (b >= 1024) return `${(b/1024).toFixed(1)}K`;
  return `${b}B`;
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

function pctColor(pct) {
  return pct > 90 ? 'text-danger' : pct > 70 ? 'text-warning' : 'text-success';
}

function pctBg(pct) {
  return pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-success';
}

function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `fixed top-4 right-4 z-[9999] px-5 py-2.5 rounded-lg text-sm font-medium text-white shadow-lg transition-opacity duration-300 ${type === 'error' ? 'bg-danger' : 'bg-success'}`;
  el.textContent = msg;
  el.style.opacity = '0';
  document.body.appendChild(el);
  requestAnimationFrame(() => el.style.opacity = '1');
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

// CIDR 工具
function cidrMatch(ip, cidr) {
  const [range, bits] = cidr.split('/');
  if (!range || !bits) return false;
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isValidCidr(cidr) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr);
}
