# GNB 中控台实施方案

> 基于 `opengnb` 核心源码和 `gnb_vt` 终端控制台代码的全量审计。

## 1. 设计原则

**复用 gnb_vt 的实现方式，不构建本地 GUI。**

gnb_vt 的价值不在 PDCursesMod TUI，而在于它已验证的 **mmap 读取 → 数据解析 → 格式化输出** 完整链路。中控台的做法是：

- **保留**：gnb_vt 的 `gnb_ctl_block.c/h` mmap 读取、`gnb_node_type.h` 结构体解析、`gnb_address.c/h` 地址格式化
- **替换**：PDCursesMod TUI → HTTP/WebSocket API 服务
- **新增**：Web 前端中控台

---

## 2. gnb_vt 现有能力清单（审计确认）

| 已实现 | 代码位置 | 复用方式 |
|--------|---------|---------|
| mmap 5-Zone 读取 | `gnb_ctl_block.c/h` | 直接编译链接 |
| 节点数据解析 (30+ 字段) | `console_node_window.c` | 提取数据访问逻辑 |
| 在线/全量节点过滤 | `console_screen.c:load_nodes()` | 复用过滤逻辑 |
| 配置目录扫描 | `nodes_menu_screen.c` | 复用目录扫描 |
| 进程启动/停止 | `gnb_vt.c:gnb_node_start/stop` | 复用进程管理 |
| UDP 日志接收 | `gnb_udp_logs_worker.c` | 复用日志收集 |
| 地址格式化 | `gnb_address.c/h`, `gnb_binary.c/h` | 直接编译链接 |
| 进程健康检测 | `status_zone->keep_alive_ts_sec` | 直接读取 |

---

## 3. 架构

```
                    ┌──────────────────────────────┐
                    │  Central Console (Web 前端)    │
                    │  Dashboard / Topology / Logs  │
                    └──────────────┬───────────────┘
                                   │ WebSocket
                    ┌──────────────▼───────────────┐
                    │  Console Backend (聚合服务)    │
                    │  Go/Node.js + 时序 DB          │
                    └──────────────┬───────────────┘
                                   │ WebSocket / GNB TUN 网络
              ┌────────────────────┼────────────────────┐
              │                    │                     │
      ┌───────▼──────┐    ┌───────▼──────┐    ┌────────▼─────┐
      │  gnb_console │    │  gnb_console │    │  gnb_console  │  ← 每节点部署
      │  (C 守护进程) │    │  (C 守护进程) │    │  (C 守护进程) │
      ├──────────────┤    ├──────────────┤    ├──────────────┤
      │gnb_ctl_block │    │gnb_ctl_block │    │gnb_ctl_block │  ← 复用 gnb_vt 的 C 代码
      │  ↕ mmap      │    │  ↕ mmap      │    │  ↕ mmap      │
      ├──────────────┤    ├──────────────┤    ├──────────────┤
      │  GNB Core    │    │  GNB Core    │    │  GNB Core    │
      └──────────────┘    └──────────────┘    └──────────────┘
        Host A              Host B              Host C
```

### 3.1 gnb_console（节点端 C 守护进程）

**不是 GUI 程序。** 它是 gnb_vt 去掉 PDCursesMod 后的精简版，以守护进程方式运行。

**复用的 gnb_vt 源文件**：
```
gnb_ctl_block.c/h     ← mmap 读取
gnb_node_type.h       ← 节点结构体
gnb_conf_type.h       ← 配置结构体
gnb_address.c/h       ← 地址解析格式化
gnb_binary.c/h        ← 二进制工具
gnb_mmap.c/h          ← mmap 封装
gnb_time.c/h          ← 时间工具
gnb_udp_logs_worker.c ← UDP 日志接收
```

**去掉的 gnb_vt 依赖**：
```
PDCursesMod           ← 整个 TUI 库
gnb_curses.c/h        ← curses 封装
gnb_vt_colors.c/h     ← 颜色主题
console_screen/       ← 全部窗口组件
nodes_menu_screen/    ← 全部菜单组件
```

**新增的模块**：
```
gnb_console_api.c     ← HTTP/WebSocket JSON API 服务 (嵌入 libwebsockets 或 civetweb)
gnb_console_json.c    ← 将 gnb_node_t 序列化为 JSON (参考 console_node_window.c 的字段遍历)
gnb_console_daemon.c  ← 守护进程框架 (参考 gnb_es 的事件循环模式)
```

**核心逻辑伪代码**（参考 `gnb_vt.c` + `console_screen.c`）：
```c
// 复用 gnb_vt 的 mmap 打开方式
gnb_ctl_block = gnb_get_ctl_block(gnb_map_path, 1);

// 守护进程事件循环（参考 gnb_es 的模式，替换 gnb_vt 的 TUI 循环）
while (running) {
    // 复用 console_screen.c 的 load_nodes() 逻辑
    load_nodes(gnb_ctl_block);
    
    // 替换 TUI draw_func → JSON 序列化
    json = serialize_nodes_to_json(gnb_ctl_block);
    
    // 替换 TUI wrefresh → WebSocket 推送
    ws_broadcast(json);
    
    sleep_ms(5000);  // 5 秒采集周期
}
```

### 3.2 Console Backend（中央聚合服务）

| 职责 | 说明 |
|------|------|
| WebSocket Hub | 接收所有 gnb_console 的数据上报 |
| 数据汇聚 | 存储到 SQLite/InfluxDB |
| 拓扑计算 | 根据各节点 `udp_addr_status` + `route_node` 还原全网拓扑 |
| API Gateway | 为 Web 前端提供 REST/WebSocket 接口 |
| 控制下行 | 转发终端指令到目标 gnb_console |

### 3.3 Web 前端

| 页面 | 对应 gnb_vt 窗口 | 功能提升 |
|------|-----------------|---------|
| Node List | `nodelist_window` | 多节点汇聚 + 搜索排序 |
| Node Detail | `node_window` | 同样的 20+ 字段 + 历史趋势图 |
| Topology | _(新增)_ | D3.js 全网可视化 |
| Logs | `logs_window` | 多节点日志聚合 + 过滤 |
| Dashboard | `local_window` | 全平台统计 |

---

## 4. 实施里程碑

| 阶段 | 目标 | 周期 |
|------|------|------|
| **M1** | gnb_console 守护进程：mmap 读取 + JSON 序列化 + WebSocket 推送 | 1-2 周 |
| **M2** | Console Backend + 前端节点列表/详情 | 2-3 周 |
| **M3** | 拓扑可视化 + 远程控制 | 2-3 周 |
| **M4** | 历史趋势 + 告警 | 2-3 周 |

## 5. 风险与对策

| 风险 | 对策 |
|------|------|
| `gnb_node_t` 版本漂移 | gnb_console 与 GNB Core 共享同一份头文件，保持同步编译 |
| 嵌入式 HTTP 库选择 | 推荐 civetweb（单文件 ~5000 行，MIT 协议，支持 WebSocket） |
| 安全通信 | gnb_console 的 WebSocket 端口仅监听 TUN 地址，不暴露 WAN |
