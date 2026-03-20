'use strict';
// @alpha: 模态框模块

const Modal = {
  show(html) {
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

  // @alpha: 通用确认弹窗
  confirm(title, message) {
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

  // @alpha: 颜色选择器
  pickedColor: '#135bec',
  COLORS: ['#135bec','#006c4a','#ba1a1a','#4b41e1','#bb0112','#a371f7','#f778ba','#56d4dd'],

  renderColorPicker(selected) {
    this.pickedColor = selected || this.COLORS[0];
    return `<div class="flex gap-2 mt-1">${this.COLORS.map(c => `
      <span class="w-6 h-6 rounded-full cursor-pointer ring-2 ring-offset-2 ring-offset-surface transition ${c === this.pickedColor ? 'ring-primary' : 'ring-transparent hover:ring-border-default'}"
        style="background:${c}" onclick="Modal.pickColor(this,'${c}')"></span>
    `).join('')}</div>`;
  },

  pickColor(el, color) {
    this.pickedColor = color;
    el.parentElement.querySelectorAll('span').forEach(s => {
      s.classList.remove('ring-primary');
      s.classList.add('ring-transparent');
    });
    el.classList.remove('ring-transparent');
    el.classList.add('ring-primary');
  },
};
