# SynonClaw Console — Design System

> 源自 Stitch 项目 `Cloud Cluster Login` (ID: `4567437340921825976`)
> 主题：**亮色 (LIGHT)** | 字体：**Inter** | 圆角：**8px (ROUND_EIGHT)** | 主色：**#4b41e1**

---

## 调色板

### 表面层级 (Surface Hierarchy)

| Token | 色值 | 用途 |
|-------|------|------|
| `base` | `#f7f9fb` | 页面画布、body 背景 |
| `surface` | `#ffffff` | 卡片、侧边栏 |
| `elevated` | `#f2f4f6` | 输入框、hover 态 |
| `surface-container` | `#eceef0` | 进度条轨道、分割区 |
| `surface-container-high` | `#e6e8ea` | 活跃态、深层容器 |

### 主色系 (Primary)

| Token | 色值 | 用途 |
|-------|------|------|
| `primary` | `#4b41e1` | 按钮、链接、active 态 |
| `primary-light` | `#645efb` | hover 态、渐变终点 |
| `primary-dark` | `#3323cc` | pressed 态 |
| `primary-subtle` | `rgba(75,65,225,0.08)` | 背景高亮 |

### 文字色 (Text)

| Token | 色值 | 用途 |
|-------|------|------|
| `text-primary` | `#191c1e` | 标题、关键数据 |
| `text-secondary` | `#464554` | 副标题、标签 |
| `text-muted` | `#767586` | 占位符、辅助信息 |
| `text-inverse` | `#ffffff` | 深色背景上的白色文字 |

### 边框色 (Border)

| Token | 色值 | 用途 |
|-------|------|------|
| `border-default` | `#e0e3e5` | 卡片边框、分割线 |
| `border-subtle` | `#eceef0` | 更柔和的分割 |
| `border-focus` | `#4b41e1` | focus 状态高亮 |

### 语义色 (Semantic)

| Token | 色值 | 用途 |
|-------|------|------|
| `success` | `#006c4a` | 在线、成功 |
| `warning` | `#c76e00` | 告警、待审批 |
| `danger` | `#ba1a1a` | 错误、离线 |
| `info` | `#4b41e1` | 信息提示 |

### 阴影 (Shadows — 亮色柔和)

| Token | 值 | 用途 |
|-------|-----|------|
| `shadow-sm` | `0 1px 3px rgba(25,28,30,0.06)` | 微小浮起 |
| `shadow-md` | `0 4px 12px rgba(25,28,30,0.08)` | 卡片 |
| `shadow-lg` | `0 10px 30px rgba(25,28,30,0.06)` | 弹窗 / overlay |
| `shadow-glow` | `0 0 20px rgba(75,65,225,0.15)` | 品牌聚焦 |

---

## 排版 (Typography)

| Token | 大小 | 权重 | 用途 |
|-------|------|------|------|
| `headline-md` | 1.75rem (28px) | 600 | 页面标题 |
| `title-sm` | 1rem (16px) | 500 | 卡片标题 |
| `body-md` | 0.875rem (14px) | 400 | 正文 |
| `label-sm` | 0.6875rem (11px) | 600 | 大写微标签 |
| `display-lg` | 3.5rem (56px) | 700 | 大指标 |

**排版规则**:
- 使用 `letter-spacing: -0.02em` 于标题以获得高端编辑感
- body 文字用 `text-secondary` 减少视觉疲劳
- 标签使用 `uppercase tracking-wider font-semibold text-xs`
- 数值显示使用 `font-variant-numeric: tabular-nums` 保证等宽对齐

---

## 高级设计模式 (Advanced Patterns)

### Glassmorphism (亮色)

```css
.glass-card {
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(12px);
}
```

### 网格点阵背景

```css
.bg-grid-pattern {
  background-image: radial-gradient(circle, rgba(75, 65, 225, 0.08) 1px, transparent 1px);
  background-size: 32px 32px;
}
```

### 品牌渐变

```css
.signature-gradient { background: linear-gradient(135deg, #4b41e1 0%, #645efb 100%); }
```

### 环境阴影

```css
.shadow-ambient { box-shadow: 0 10px 30px rgba(25, 28, 30, 0.06); }
```

### 组件模式

| 组件 | 描述 |
|------|------|
| **Metric Card** | icon circle(40×40, bg-primary/10) → uppercase label → 2xl bold value → gradient progress bar |
| **Login Card** | glass-card + border-default + rounded-lg + shadow-ambient |
| **Sidebar Logo** | signature-gradient icon(36×36) + tracking-tight brand + uppercase subtitle |
| **Status Footer** | pulse dot + uppercase tracking-widest label + divider + icon label |
| **Primary Button** | signature-gradient + white text + shadow-primary/20 + hover:scale[1.01] |
| **Input Field** | bg-base (etched) + no border + focus:ring-primary/20 + pl-12 icon |

---

## Tailwind v4 @theme 映射

```css
@theme {
  --color-primary: #4b41e1;
  --color-primary-light: #645efb;
  --color-primary-dark: #3323cc;
  --color-primary-subtle: rgba(75, 65, 225, 0.08);
  --color-surface: #ffffff;
  --color-elevated: #f2f4f6;
  --color-base: #f7f9fb;
  --color-border-default: #e0e3e5;
  --color-border-subtle: #eceef0;
  --color-text-primary: #191c1e;
  --color-text-secondary: #464554;
  --color-text-muted: #767586;
  --color-text-inverse: #ffffff;
  --color-success: #006c4a;
  --color-warning: #c76e00;
  --color-danger: #ba1a1a;
  --color-info: #4b41e1;
  --font-sans: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```
