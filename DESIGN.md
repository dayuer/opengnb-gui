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

> 源自 Stitch 项目最新数据 (2026-03-20T19:55:46Z)

| 屏幕 ID | 标题 | 尺寸 |
|---------|------|------|
| `f1c51f5f` | Cloud Cluster Login | 1376×768 |
| `b425091b` | Cloud Cluster Login (变体) | 1376×768 |
| `dc95e6ee` | CloudSuite Login Portal | 2560×2048 |
| `cf6de39a` | Cloud Management Dashboard | 1376×768 |
| `94734647` | Global Management Dashboard | 3072×2726 |
| `36627364` | Advanced Node Monitoring | 1376×768 |
| `171abfa7` | Node Operations Center | 3072×2048 |
| `c4a90d27` | Backend Node Operations | 1376×768 |
| `e9990d39` | Network & Security Control | 3072×2146 |
| `514d0a70` | Network & Security Control (变体) | 1376×768 |
| `bb307ac1` | Identity & Access Management | 2560×2118 |
| `35431cbc` | Cluster Management | 2560×2380 |
| `acc9703a` | System Settings | 2560×2594 |

## Tailwind v4 映射

上述设计 token 在 `index.html` 中通过 `@theme` 块直接映射：

```css
@theme {
  --color-primary: #135bec;
  --color-surface: #111118;
  --color-elevated: #1a1a24;
  --color-base: #0a0a0f;
  --color-border-default: #2a2a3a;
  --color-text-primary: #f0f0f5;
  --color-text-secondary: #9898a8;
  --color-text-muted: #5c5c6e;
  --color-success: #3fb950;
  --color-warning: #d29922;
  --color-danger: #f85149;
  --font-sans: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

## 高级设计模式 (Advanced Patterns)

> 从 Stitch 屏幕源码提取的组件级模式

### Glassmorphism

```css
.glass-card {
  background: rgba(17, 17, 24, 0.75);
  backdrop-filter: blur(16px);
}
```

### 网格点阵背景

```css
.bg-grid-pattern {
  background-image: radial-gradient(circle, rgba(19, 91, 236, 0.06) 1px, transparent 1px);
  background-size: 32px 32px;
}
```

### 品牌渐变

```css
.signature-gradient { background: linear-gradient(135deg, #135bec 0%, #3b7bf0 100%); }
```

### 环境阴影 (Dark Mode)

```css
.shadow-ambient { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 1px rgba(19, 91, 236, 0.1); }
```

### 微动画

```css
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
```

### 排版模式

| 模式 | 类名 | 说明 |
|------|------|------|
| 标签 | `uppercase tracking-wider font-semibold text-xs` | 表单标签、卡片标题 |
| 徽章 | `uppercase tracking-widest text-xs font-bold` | 状态/变化指示器 |
| 值 | `text-2xl font-bold` | 仪表盘数值 |
| 品牌 | `font-bold tracking-tight` | 侧边栏品牌名 |

### 组件模式

| 组件 | 描述 |
|------|------|
| **Metric Card** | icon circle(40×40, rounded-lg, bg-color/10) → label(uppercase) → value(2xl bold) → progress bar |
| **Login Card** | glass-card + border border-default + rounded-lg + shadow-ambient |
| **Sidebar Logo** | signature-gradient icon(36×36) + tracking-tight name + uppercase subtitle |
| **Status Footer** | pulse dot + uppercase tracking-widest label + divider + icon label |
| **Decorative Corners** | fixed corners with uppercase label + primary/20 line |

