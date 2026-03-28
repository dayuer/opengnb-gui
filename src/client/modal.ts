// @alpha: 模态框模块
import { $, escHtml, refreshIcons } from './utils';

interface ModalModule {
  show(html: string): void;
  close(): void;
  confirm(title: string, message: string): Promise<boolean>;
  alert(title: string, messageHtml: string): void;
  pickedColor: string;
  COLORS: string[];
  renderColorPicker(selected?: string): string;
  pickColor(el: HTMLElement, color: string): void;
  _resolve: ((value: boolean) => void) | null;
}

export const Modal: ModalModule = {
  _resolve: null,

  show(html: string) {
    const overlay = $('#modal-overlay');
    const content = $('#modal-content');
    if (overlay) { overlay.classList.remove('hidden'); overlay.classList.add('flex'); }
    if (content) content.innerHTML = html;
    refreshIcons();
  },

  close() {
    const overlay = $('#modal-overlay');
    if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('flex'); }
  },

  confirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.show(`
        <h3 class="text-base font-semibold mb-3">${escHtml(title)}</h3>
        <p class="text-sm text-text-secondary mb-5">${escHtml(message)}</p>
        <div class="flex justify-end gap-2">
          <button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="Modal.close();Modal._resolve(false)">取消</button>
          <button class="px-4 py-2 text-sm rounded-lg bg-danger hover:bg-danger/80 text-white transition cursor-pointer" onclick="Modal.close();Modal._resolve(true)">确认</button>
        </div>
      `);
      this._resolve = resolve;
    });
  },

  alert(title: string, messageHtml: string): void {
    this.show(`
      <h3 class="text-base font-semibold mb-3 text-danger flex gap-2 items-center">
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        ${escHtml(title)}
      </h3>
      <p class="text-sm text-text-secondary mb-5 leading-relaxed">${messageHtml}</p>
      <div class="flex justify-end gap-2">
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary/80 text-white transition cursor-pointer" onclick="Modal.close()">知道了</button>
      </div>
    `);
  },

  pickedColor: '#135bec',
  COLORS: ['#135bec', '#006c4a', '#ba1a1a', '#4b41e1', '#bb0112', '#a371f7', '#f778ba', '#56d4dd'],

  renderColorPicker(selected?: string): string {
    this.pickedColor = selected || this.COLORS[0];
    return `<div class="flex gap-2 mt-1">${this.COLORS.map((c) => `
      <span class="w-6 h-6 rounded-full cursor-pointer ring-2 ring-offset-2 ring-offset-surface transition ${c === this.pickedColor ? 'ring-primary' : 'ring-transparent hover:ring-border-default'}"
        style="background:${c}" onclick="Modal.pickColor(this,'${c}')"></span>
    `).join('')}</div>`;
  },

  pickColor(el: HTMLElement, color: string) {
    this.pickedColor = color;
    el.parentElement?.querySelectorAll('span').forEach((s) => {
      s.classList.remove('ring-primary');
      s.classList.add('ring-transparent');
    });
    el.classList.remove('ring-transparent');
    el.classList.add('ring-primary');
  },
};
