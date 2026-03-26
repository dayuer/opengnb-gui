// @alpha: 拓扑可视化页面 — D3.js Force-Directed Graph
import { $, L, refreshIcons, escHtml, formatUptime } from '../utils';
import { App } from '../core';

// D3 通过 CDN 加载，声明全局类型
declare const d3: any;

interface TopoNode {
  id: string;
  name: string;
  tunAddr: string;
  online: boolean;
  peerCount: number;
  sysOs?: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface TopoLink {
  source: string | TopoNode;
  target: string | TopoNode;
  type: 'direct' | 'relay';
  latencyUs: number;
}

// D3 加载状态
let d3Loaded = false;
let d3Loading = false;

// 渲染状态
let simulation: any = null;
let svg: any = null;
let currentWidth = 0;
let currentHeight = 0;

/**
 * CDN 加载 D3.js v7（按需，仅首次）
 */
function ensureD3(): Promise<void> {
  if (d3Loaded) return Promise.resolve();
  if (d3Loading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (d3Loaded) { clearInterval(check); resolve(); }
      }, 100);
    });
  }
  d3Loading = true;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
    script.onload = () => { d3Loaded = true; d3Loading = false; resolve(); };
    script.onerror = () => { d3Loading = false; reject(new Error('D3.js 加载失败')); };
    document.head.appendChild(script);
  });
}

/**
 * 从 App.nodesData 构建拓扑数据
 */
function buildTopology(): { nodes: TopoNode[]; links: TopoLink[] } {
  const nodesMap = new Map<string, TopoNode>();
  const links: TopoLink[] = [];
  const edgeSet = new Set<string>();

  for (const n of App.nodesData) {
    nodesMap.set(n.id, {
      id: n.id,
      name: n.name || n.id.substring(0, 8),
      tunAddr: n.tunAddr4 || '',
      online: !!n.online,
      peerCount: n.nodes?.length || 0,
      sysOs: n.sysInfo?.os || '',
    });

    // 构建边（去重双向）
    if (n.nodes) {
      for (const peer of n.nodes) {
        const peerId = peer.uuid64 || peer.id;
        if (!peerId) continue;
        const edgeKey = [n.id, peerId].sort().join('::');
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        // 确保对端节点也存在
        if (!nodesMap.has(peerId)) {
          nodesMap.set(peerId, {
            id: peerId,
            name: peerId.substring(0, 8),
            tunAddr: peer.tunAddr4 || '',
            online: false, // 对端可能不在管理范围内
            peerCount: 0,
          });
        }

        links.push({
          source: n.id,
          target: peerId,
          type: peer.status === 'Direct' ? 'direct' : 'relay',
          latencyUs: peer.latency4Usec || 0,
        });
      }
    }
  }

  return { nodes: Array.from(nodesMap.values()), links };
}

/**
 * 渲染 D3 力导向图
 */
function renderForceGraph(container: HTMLElement) {
  const { nodes, links } = buildTopology();

  // 清理旧 simulation
  if (simulation) { simulation.stop(); simulation = null; }

  const wrapper = container.querySelector('#topo-svg-wrapper') as HTMLElement;
  if (!wrapper) return;
  wrapper.innerHTML = '';

  currentWidth = wrapper.clientWidth || 800;
  currentHeight = wrapper.clientHeight || 600;

  // 空状态
  if (nodes.length === 0) {
    wrapper.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-text-muted">
      <span class="text-4xl mb-4">${L('network')}</span>
      <span class="text-sm">暂无节点数据</span>
      <span class="text-xs mt-1">等待节点上线后自动显示拓扑</span>
    </div>`;
    refreshIcons();
    return;
  }

  // 配色
  const colors = {
    nodeOnline: '#22c55e',      // green-500
    nodeOffline: '#6b7280',     // gray-500
    linkDirect: '#3b82f6',      // blue-500
    linkRelay: '#f59e0b',       // amber-500
    text: '#94a3b8',            // slate-400
    hoverRing: '#8b5cf6',       // violet-500
  };

  svg = d3.select(wrapper)
    .append('svg')
    .attr('width', currentWidth)
    .attr('height', currentHeight)
    .attr('viewBox', `0 0 ${currentWidth} ${currentHeight}`)
    .style('user-select', 'none');

  // 缩放/平移组
  const g = svg.append('g');
  const zoom = d3.zoom()
    .scaleExtent([0.2, 5])
    .on('zoom', (event: any) => g.attr('transform', event.transform));
  svg.call(zoom);

  // defs: 箭头标记
  svg.append('defs').selectAll('marker')
    .data(['direct', 'relay'])
    .join('marker')
    .attr('id', (d: string) => `arrow-${d}`)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', (d: string) => d === 'direct' ? colors.linkDirect : colors.linkRelay);

  // 边
  const link = g.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', (d: TopoLink) => d.type === 'direct' ? colors.linkDirect : colors.linkRelay)
    .attr('stroke-width', (d: TopoLink) => d.type === 'direct' ? 2 : 1.5)
    .attr('stroke-dasharray', (d: TopoLink) => d.type === 'relay' ? '6 3' : null)
    .attr('stroke-opacity', 0.6)
    .attr('marker-end', (d: TopoLink) => `url(#arrow-${d.type})`);

  // 节点组
  const node = g.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragged)
      .on('end', dragEnd));

  // 节点圆圈
  node.append('circle')
    .attr('r', (d: TopoNode) => 6 + Math.min(d.peerCount * 2, 10))
    .attr('fill', (d: TopoNode) => d.online ? colors.nodeOnline : colors.nodeOffline)
    .attr('stroke', '#1e293b')
    .attr('stroke-width', 2)
    .attr('opacity', 0.9)
    .style('cursor', 'pointer');

  // 节点标签
  node.append('text')
    .attr('dy', (d: TopoNode) => -(10 + Math.min(d.peerCount * 2, 10)))
    .attr('text-anchor', 'middle')
    .attr('font-size', '11px')
    .attr('fill', colors.text)
    .attr('font-family', 'Inter, sans-serif')
    .text((d: TopoNode) => d.name);

  // 悬停卡片
  const tooltip = d3.select(wrapper)
    .append('div')
    .attr('class', 'absolute hidden bg-surface border border-border-default rounded-lg shadow-lg p-3 text-xs z-10 pointer-events-none')
    .style('max-width', '220px');

  node.on('mouseenter', (event: MouseEvent, d: TopoNode) => {
    const latencies = links
      .filter(l => (typeof l.source === 'object' ? l.source.id : l.source) === d.id ||
                    (typeof l.target === 'object' ? l.target.id : l.target) === d.id)
      .map(l => l.latencyUs);
    const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000) : 0;

    tooltip.html(`
      <div class="font-semibold text-text-primary mb-1">${escHtml(d.name)}</div>
      <div class="text-text-muted space-y-0.5">
        <div>IP: ${escHtml(d.tunAddr || '—')}</div>
        <div>状态: <span class="${d.online ? 'text-success' : 'text-danger'}">${d.online ? '在线' : '离线'}</span></div>
        <div>对等体: ${d.peerCount}</div>
        ${avgLatency > 0 ? `<div>平均延迟: ${avgLatency}ms</div>` : ''}
        ${d.sysOs ? `<div>系统: ${escHtml(d.sysOs)}</div>` : ''}
      </div>
    `).classed('hidden', false)
      .style('left', `${event.offsetX + 12}px`)
      .style('top', `${event.offsetY - 10}px`);
  })
  .on('mouseleave', () => tooltip.classed('hidden', true));

  // 力模拟
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d: TopoNode) => d.id).distance(120))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(currentWidth / 2, currentHeight / 2))
    .force('collision', d3.forceCollide().radius(30))
    .on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

  // 拖拽行为
  function dragStart(event: any) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }
  function dragged(event: any) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }
  function dragEnd(event: any) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  // 居中视图
  setTimeout(() => {
    svg.call(zoom.transform, d3.zoomIdentity
      .translate(currentWidth / 2, currentHeight / 2)
      .scale(0.8)
      .translate(-currentWidth / 2, -currentHeight / 2));
  }, 500);
}

export const Topology = {
  async render(container: HTMLElement) {
    container.innerHTML = `<div class="space-y-6">
      <!-- 标题 -->
      <div class="flex items-end justify-between">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">网络拓扑</h1>
          <p class="text-text-muted max-w-xl leading-relaxed">P2P 网状网络可视化 — 实线为直连通道，虚线为中继通道。</p>
        </div>
        <div class="flex items-center gap-3">
          <button class="px-3 py-1.5 rounded-lg text-xs font-medium bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer border border-border-default" onclick="Topology.refresh()">
            ${L('refresh-cw')}<span class="ml-1">刷新</span>
          </button>
        </div>
      </div>

      <!-- 图例 -->
      <div class="flex items-center gap-6 text-xs text-text-muted">
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-[#22c55e] inline-block"></span>
          <span>在线节点</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-[#6b7280] inline-block"></span>
          <span>离线节点</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-6 h-0 border-t-2 border-[#3b82f6] inline-block"></span>
          <span>直连</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-6 h-0 border-t-2 border-dashed border-[#f59e0b] inline-block"></span>
          <span>中继</span>
        </div>
      </div>

      <!-- SVG 容器 -->
      <div class="glass-card border border-border-default rounded-lg overflow-hidden relative" style="min-height: 500px">
        <div id="topo-svg-wrapper" class="w-full" style="height: calc(100vh - 280px); min-height: 500px">
          <div class="flex items-center justify-center h-full text-text-muted">
            <span class="text-sm">加载中...</span>
          </div>
        </div>
      </div>

      <!-- 统计 -->
      <div id="topo-stats" class="grid grid-cols-2 md:grid-cols-4 gap-4"></div>
    </div>`;

    refreshIcons();

    try {
      await ensureD3();
      renderForceGraph(container);
      this._renderStats(container);
    } catch (e) {
      const wrapper = container.querySelector('#topo-svg-wrapper');
      if (wrapper) {
        wrapper.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-danger">
          <span class="text-4xl mb-4">${L('alert-triangle')}</span>
          <span class="text-sm">拓扑渲染失败</span>
          <span class="text-xs mt-1 text-text-muted">${escHtml(String(e))}</span>
        </div>`;
        refreshIcons();
      }
    }
  },

  refresh() {
    const container = $('#main-content');
    if (container) this.render(container);
  },

  _renderStats(container: HTMLElement) {
    const statsEl = container.querySelector('#topo-stats');
    if (!statsEl) return;
    const { nodes: topoNodes, links } = buildTopology();
    const directLinks = links.filter(l => l.type === 'direct').length;
    const relayLinks = links.filter(l => l.type === 'relay').length;
    const onlineNodes = topoNodes.filter(n => n.online).length;
    
    statsEl.innerHTML = [
      { label: '节点总数', value: topoNodes.length, icon: 'globe' },
      { label: '在线节点', value: onlineNodes, icon: 'check-circle' },
      { label: '直连通道', value: directLinks, icon: 'zap' },
      { label: '中继通道', value: relayLinks, icon: 'repeat' },
    ].map(s => `
      <div class="glass-card border border-border-default rounded-lg p-4 flex items-center gap-3">
        <span class="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">${L(s.icon)}</span>
        <div>
          <div class="text-xl font-bold text-text-primary">${s.value}</div>
          <div class="text-xs text-text-muted">${s.label}</div>
        </div>
      </div>
    `).join('');
    refreshIcons();
  },

  /**
   * WS 数据更新时增量刷新拓扑（避免全量重渲染）
   */
  onDataUpdate() {
    if (App.currentPage !== 'topology') return;
    // 简化策略: 当前页面活跃时直接重渲染
    // 未来可优化为 D3 enter/exit/update pattern
    const container = $('#main-content');
    if (container && d3Loaded) {
      renderForceGraph(container);
      this._renderStats(container);
    }
  },
};
