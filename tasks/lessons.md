## [2026-03-27] JS 对象数组全量筛选时的隐式副作用
- 触发场景: 渲染技能列表时，按来源划分为 isBuiltin 和 != isBuiltin 后，缺少了对其内部真实逻辑状态 (`status === 'ready'`) 的过滤。
- 根因: 认为后端或者 Agent 下发的 `skills` 列表等同于“已生效”，忽略了中间状态（error/installing）。
- 防范规则: 在处理含有明确 `status` 枚举的状态机联调数据时，过滤条件必须是正向断言（`s.status === 'ready'`），而不是假设整体数组的纯净性。

## [2026-03-27] Rust WebSocket NAT 穿透超时表驱逐问题
- 触发场景: synon-daemon 驻留节点时，若几十分钟无外发流量，连接伪存活，无法收到 Console 下发的命令。
- 根因: `tokio-tungstenite` 的 `connect_async` 默认不开启底层 TCP `SO_KEEPALIVE`。云防火墙 / SLB 的 TCP session 保活时间（如 900s）到期后直接丢弃追踪表，引发对端 `Connection reset by peer`。
- 防范规则: 开发长连接 Agent 时，**必须使用 `socket2` 手动接管建连阶段**：先创建非阻塞 tcp 句柄，设置操作系统的 `TCP_KEEPALIVE` 属性（idle/interval/retries），转换成 `tokio::net::TcpStream` 后再交由 TLS 和 WebSocket 层去握手。同时配以应用层 Watchdog（如 45s 无任何帧包则硬切断重连）。
