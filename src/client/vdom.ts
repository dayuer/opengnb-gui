/**
 * vdom.ts - 极简的 DOM 形态渐变引擎 (Minimal DOM Morphing)
 * 采用原生 DOM API 就地更新节点树，保持焦点及状态（防脑裂/滚动闪烁）。
 */

/**
 * 遍历同步两个节点的 Attributes
 */
function syncAttributes(oldEl: Element, newEl: Element) {
  const oldAttrs = oldEl.attributes;
  const newAttrs = newEl.attributes;

  // 1. 删除旧节点有但新节点没有的属性
  for (let i = oldAttrs.length - 1; i >= 0; i--) {
    const name = oldAttrs[i].name;
    if (!newEl.hasAttribute(name)) {
      oldEl.removeAttribute(name);
    }
  }

  // 2. 更新或添加新节点带有的属性
  for (let i = 0; i < newAttrs.length; i++) {
    const name = newAttrs[i].name;
    const value = newAttrs[i].value;
    if (oldEl.getAttribute(name) !== value) {
      oldEl.setAttribute(name, value);
    }
  }

  // 表单元素的 value 属性有些不是标准的 HTML attribute
  // 如果该元素当前拥有焦点，跳过 value 同步以避免光标跳位
  if (oldEl instanceof HTMLInputElement || oldEl instanceof HTMLTextAreaElement || oldEl instanceof HTMLSelectElement) {
    if (document.activeElement === oldEl) return;
    const newElInput = newEl as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (oldEl.value !== newElInput.value) {
      oldEl.value = newElInput.value;
    }
  }
}

/**
 * 核心 morph 算法：递归同步 Node 树
 */
function morph(oldNode: Node, newNode: Node) {
  // 如果节点类型不同，直接整块替换
  if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
    oldNode.parentNode?.replaceChild(newNode.cloneNode(true), oldNode);
    return;
  }

  // 文本节点的内容比对
  if (oldNode.nodeType === Node.TEXT_NODE) {
    if (oldNode.textContent !== newNode.textContent) {
      oldNode.textContent = newNode.textContent;
    }
    return;
  }

  // 元素节点 (Element) 处理
  if (oldNode.nodeType === Node.ELEMENT_NODE) {
    const oldEl = oldNode as Element;
    const newEl = newNode as Element;

    // 按需同步属性
    syncAttributes(oldEl, newEl);

    // 递归对齐子节点
    const oldChildren = Array.from(oldNode.childNodes);
    const newChildren = Array.from(newNode.childNodes);

    // 首先保证旧节点不要长于新节点，从后往前删
    while (oldNode.childNodes.length > newChildren.length) {
      oldNode.removeChild(oldNode.lastChild!);
    }

    // 然后逐一比对或追加
    for (let i = 0; i < newChildren.length; i++) {
      if (i >= oldChildren.length) {
        oldNode.appendChild(newChildren[i].cloneNode(true));
      } else {
        morph(oldNode.childNodes[i], newChildren[i]);
      }
    }
  }
}

/**
 * 将模板渲染入目标容器。
 * 会生成 DocumentFragment 形式虚拟根，将新旧 HTML 进行对比和智能替换更新。
 * @param container 挂载目标容器
 * @param templateString 新 HTML 模板片段
 */
export function renderNode(container: HTMLElement, templateString: string) {
  // 使用 template 防止 img/script 等资源在 fragment 构建时意外执行或加载
  const tpl = document.createElement('template');
  tpl.innerHTML = templateString;
  const newRoot = tpl.content;

  const oldChildren = Array.from(container.childNodes);
  const newChildren = Array.from(newRoot.childNodes);

  while (container.childNodes.length > newChildren.length) {
    container.removeChild(container.lastChild!);
  }

  for (let i = 0; i < newChildren.length; i++) {
    if (i >= oldChildren.length) {
      container.appendChild(newChildren[i].cloneNode(true));
    } else {
      morph(container.childNodes[i], newChildren[i]);
    }
  }
}
