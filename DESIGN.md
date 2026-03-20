# Design System — SynonClaw Console

> 源自 Stitch 项目 **Cloud Cluster Login** (`projects/4567437340921825976`)

## 设计主题

| 属性 | 值 |
|------|------|
| 色彩模式 | **Dark** |
| 字体 | **Inter** |
| 圆角 | **8px** (`ROUND_EIGHT`) |
| 主色 | `#135bec` |
| 饱和度 | 3 (高) |
| 设备 | Desktop (1376×768) |

## 调色板

### 主色系 (Primary)

| 名称 | 色值 | 用途 |
|------|------|------|
| Primary | `#135bec` | 按钮、链接、活跃状态 |
| Primary Light | `#3b7bf0` | 悬停态、高亮 |
| Primary Dark | `#0e47bd` | 按下态、深层背景 |
| Primary Subtle | `rgba(19, 91, 236, 0.12)` | 淡色背景、Badge 底色 |

### 背景色 (Background)

| 名称 | 色值 | 用途 |
|------|------|------|
| Base | `#0a0a0f` | 页面底层背景 |
| Surface | `#111118` | 卡片、面板 |
| Elevated | `#1a1a24` | 悬浮元素、下拉菜单 |
| Overlay | `rgba(0, 0, 0, 0.6)` | 遮罩层 |

### 文字色 (Text)

| 名称 | 色值 | 用途 |
|------|------|------|
| Primary | `#f0f0f5` | 标题、正文 |
| Secondary | `#9898a8` | 辅助文字、描述 |
| Muted | `#5c5c6e` | 占位符、禁用态 |
| Inverse | `#0a0a0f` | 深色文字（亮色背景上） |

### 边框色 (Border)

| 名称 | 色值 | 用途 |
|------|------|------|
| Default | `#2a2a3a` | 卡片/表格边框 |
| Subtle | `#1e1e2e` | 分割线 |
| Focus | `#135bec` | 输入框聚焦 |

### 语义色 (Semantic)

| 名称 | 色值 | 用途 |
|------|------|------|
| Success | `#3fb950` | 在线、成功 |
| Warning | `#d29922` | 告警、待审批 |
| Danger | `#f85149` | 离线、错误、删除 |
| Info | `#58a6ff` | 信息提示 |

## 排版 (Typography)

### 字体栈

```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
```

### 字号层级

| Token | 大小 | 行高 | 字重 | 用途 |
|-------|------|------|------|------|
| `--text-xs` | 11px | 1.4 | 400 | 标签、Badge |
| `--text-sm` | 13px | 1.5 | 400 | 辅助文字、表格 |
| `--text-base` | 14px | 1.6 | 400 | 正文 |
| `--text-lg` | 16px | 1.5 | 500 | 卡片标题 |
| `--text-xl` | 20px | 1.3 | 600 | 页面标题 |
| `--text-2xl` | 28px | 1.2 | 700 | 仪表盘数值 |
| `--text-3xl` | 36px | 1.1 | 700 | 大标题/Hero |

### 字重

| Token | 值 | 用途 |
|-------|-----|------|
| `--fw-normal` | 400 | 正文 |
| `--fw-medium` | 500 | 标签、导航 |
| `--fw-semibold` | 600 | 小标题 |
| `--fw-bold` | 700 | 大标题、数值 |

## 间距 (Spacing)

```
--sp-1: 4px    --sp-2: 8px    --sp-3: 12px   --sp-4: 16px
--sp-5: 20px   --sp-6: 24px   --sp-8: 32px   --sp-10: 40px
```

## 圆角 (Radius)

```
--radius-sm: 4px     --radius-md: 8px     --radius-lg: 12px
--radius-xl: 16px    --radius-full: 9999px
```

## 阴影 (Shadow)

```css
--shadow-sm:  0 1px 3px rgba(0, 0, 0, 0.3);
--shadow-md:  0 4px 12px rgba(0, 0, 0, 0.4);
--shadow-lg:  0 8px 24px rgba(0, 0, 0, 0.5);
--shadow-glow: 0 0 20px rgba(19, 91, 236, 0.3);  /* 主色辉光 */
```

## 屏幕清单

| 屏幕 | 描述 |
|------|------|
| Cloud Cluster Login | 登录页（两版变体） |
| Cloud Management Dashboard | 管理仪表盘（两版变体） |
| Global Cluster Overview | 全局集群概览 |
| Advanced Node Monitoring | 高级节点监控面板 |
| Backend Node Operations | 后端节点操作（两版变体） |
| Network & Security Control | 网络与安全控制（两版变体） |
