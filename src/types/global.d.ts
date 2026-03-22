// 全局类型声明 — Alpha pass 宽松类型
// Beta 阶段将逐步替换为精确接口定义

// DOM 工具函数增强 — 允许 $ 返回带 value/checked 属性的元素
declare function $<T extends HTMLElement = HTMLElement>(sel: string): T | null;
declare function $$(sel: string): NodeListOf<HTMLElement>;
declare function L(name: string): string;
declare function refreshIcons(): void;
declare function escHtml(str: string): string;
declare function safeAttr(str: string): string;
declare function showToast(msg: string, type?: 'success' | 'error' | 'info'): void;
declare function formatBytes(b: number): string;
declare function formatUptime(seconds: number): string;
declare function pctColor(pct: number): string;
declare function pctBg(pct: number): string;
declare function cidrMatch(ip: string, cidr: string): boolean;
declare function ipToInt(ip: string): number;
declare function isValidCidr(cidr: string): boolean;

// Lucide 图标库 (CDN)
declare namespace lucide {
  function createIcons(): void;
}
