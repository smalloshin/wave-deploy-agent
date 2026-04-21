# DESIGN.md — wave-deploy-agent Design System 4.0

**Anchor screen**: `projects/[id]`
**Approved on**: 2026-04-20
**Anchor artifact**: `~/.gstack/projects/smalloshin-smalloshin.github.io/designs/deploy-agent-redesign-20260420/finalized.html`

---

## Typography

**Base font size: 18px**（以前 ~14px，太小）

**Fonts**
- Body: `Inter` (Google Fonts, weights 400/500/600/700)
- Mono: `JetBrains Mono` (Google Fonts, weights 400/500)
- Fallbacks: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`

**Type scale**
```css
--fs-xs:  14px;   /* timestamps, tiny meta */
--fs-sm:  16px;   /* secondary meta, card subtle */
--fs-md:  18px;   /* body, inputs, list items */
--fs-lg:  22px;   /* section headers (版本/安全報告/部署時間軸) */
--fs-xl:  28px;   /* reserved (big section title) */
--fs-2xl: 36px;   /* hero (專案名稱 gam-publisher) */
--fs-3xl: 48px;   /* reserved (big numbers / dashboard counters) */
```

**Line height**
```css
--lh-tight:  1.2;   /* hero titles */
--lh-snug:   1.35;  /* section headers */
--lh-normal: 1.6;   /* body */
```

**Rules**
- Hero title (projects/[id] 專案名): `--fs-2xl` bold, `--lh-tight`, letter-spacing -0.02em
- Section header (card-title): `--fs-lg` 600, letter-spacing -0.01em
- Body: `--fs-md` 400, `--lh-normal`
- Meta / timestamps: `--fs-sm` 或 `--fs-xs`, color `--ink-500`
- Mono code: 0.92em relative (so it doesn't dominate in mixed flows)

---

## Color

**Brand — Sea（保留，就是品牌）**
```css
--sea-50:  #eff3fb;
--sea-100: #dbe4f5;
--sea-200: #a4bce7;
--sea-400: #436fc5;
--sea-500: #003aad;  /* primary */
--sea-600: #002a85;  /* hover */
--sea-700: #001c58;  /* deep ink on sea bg */
```

**Ink — 比舊 gray- scale 高對比**
```css
--ink-900: #0b0e14;  /* primary text (比純黑溫和) */
--ink-700: #30343f;  /* strong body */
--ink-500: #636873;  /* secondary / meta */
--ink-400: #8a8f9a;  /* disabled / subtle */
--ink-300: #c7ccd6;  /* strong border */
--ink-200: #dfe3ea;  /* card border */
--ink-100: #eef1f6;  /* separator */
--ink-50:  #f6f7f9;  /* app bg */
```

**Surface**
```css
--bg:        var(--ink-50);   /* app background */
--surface-1: #ffffff;          /* cards, sidebar */
--surface-2: #fbfbfd;          /* nested cards (version rows in card) */
--border:    var(--ink-200);
--border-strong: var(--ink-300);
```

**Status — 獨立命名，不再 alias status-live**
```css
--ok:        #0f8f45;  --ok-bg:     #e3f6ea;  /* 已部署 / 已上線 / 已通過 */
--warn:      #a76a00;  --warn-bg:   #fff0cf;  /* 審查中 / 待審 */
--danger:    #c53030;  --danger-bg: #fde4e1;  /* 失敗 / 停止 */
--info:      var(--sea-500);  --info-bg: var(--sea-50);  /* 部署中 / scanning */
```

**Legacy aliases**（舊 token 名稱救活用，逐步汰除）
```css
--status-live: var(--ok);
--status-live-bg: var(--ok-bg);
--status-success: var(--ok);
--status-success-bg: var(--ok-bg);
--status-critical: var(--danger);
--status-critical-bg: var(--danger-bg);
--status-warning: var(--warn);
--status-warning-bg: var(--warn-bg);
--status-info: var(--info);
--status-info-bg: var(--info-bg);
```

---

## Space scale

8px base，從 4 到 64 共 8 檔。
```css
--sp-1: 4px;   /* hairline gaps */
--sp-2: 8px;   /* tight */
--sp-3: 12px;  /* default small */
--sp-4: 16px;  /* card inner gap */
--sp-5: 24px;  /* card padding, section gap */
--sp-6: 32px;  /* page section spacing */
--sp-7: 48px;  /* page horizontal padding */
--sp-8: 64px;  /* page bottom padding */
```

---

## Radius

```css
--r-sm:   6px;   /* inline code, tiny chips */
--r-md:  10px;   /* buttons, inputs, nested cards */
--r-lg:  14px;   /* top-level cards */
--r-pill: 999px; /* status pills */
```

---

## Shadow

低調用法 — 只在 raised-in-raised 才用。
```css
--shadow-sm: 0 1px 2px rgba(11,14,20,0.04);
--shadow-md: 0 4px 12px rgba(11,14,20,0.06);
```

---

## Components

### Pill / Status badge

```html
<span class="pill pill-ok">已上線</span>
```

- 圓點前置（`::before` 8px dot background currentColor）
- `font-size: var(--fs-sm)`, `font-weight: 600`
- `padding: 6px 14px`, `border-radius: var(--r-pill)`

### Button

```html
<button class="btn">查看日誌</button>        <!-- secondary -->
<button class="btn btn-primary">+ 新版本</button>  <!-- primary -->
<button class="btn btn-sm">查看</button>      <!-- small -->
```

- 預設：`--surface-1` bg, `--border` 1px, `--fs-md` 600
- Primary：`--sea-500` bg, white text
- Hover：填色 darken / bg `--ink-100`
- Small：padding 6/12, `--fs-sm`

### Card

```html
<section class="card">
  <header class="card-header">
    <div class="card-title">版本</div>
    <span class="card-subtle">2 個版本</span>
  </header>
  ...
</section>
```

- `background: --surface-1`, `border: 1px solid --border`, `border-radius: --r-lg`, `padding: --sp-5`
- Header: flex space-between, title `--fs-lg` 600
- Subtle meta: `--fs-sm` `--ink-500`

### Timeline

```html
<div class="timeline">
  <div class="tl-item ok">
    <div class="tl-dot">✓</div>
    <div class="tl-body">
      <div class="tl-title">已部署</div>
      <div class="tl-sub">服務上線並通過健康檢查</div>
      <div class="tl-ts">2026-04-20 16:53:08</div>
    </div>
  </div>
  ...
</div>
```

- 24px 圓點，2px vertical line 連接
- 狀態色：ok（綠）/ warn（橘）/ info（藍）/ danger（紅）
- 標題 `--fs-md` 600、描述 `--fs-sm --ink-500`、時間戳 `--fs-xs` mono

---

## Layout

### App shell

```
┌──────────┬─────────────────────────────┐
│ Sidebar  │                             │
│ 240px    │   Main (max-width 1400px)   │
│          │   padding: sp-6 sp-7 sp-8   │
│ sticky   │                             │
└──────────┴─────────────────────────────┘
```

- Sidebar 240px，sticky，白底，右 1px border
- Main max 1400px，padding `32 48 64`

### Primary grid (projects/[id])

```
┌─────────────────────┬────────────┐
│ 2fr (版本/安全/時間軸)│ 1fr (快速動作/詳細/env) │
└─────────────────────┴────────────┘
gap: sp-5 (24px)
```

### Responsive breakpoints

- `< 960px`: sidebar 橫移 top，grid 單欄
- `< 640px`: hero meta 換行，version row 堆疊，env row 垂直

---

## Sidebar nav

```html
<nav class="nav">
  <a class="active" aria-current="page">
    <span class="icon">▣</span> 專案
  </a>
  <a>
    <span class="icon">◉</span> 審查
    <span class="badge">3</span>  <!-- 未審數字 -->
  </a>
</nav>
```

- Item：`padding: sp-3`, `border-radius: --r-md`, gap sp-3
- Active：bg `--sea-50`, color `--sea-600`, weight 600
- Hover：bg `--ink-100`
- 圖示先用 Unicode glyph 佔位（之後換 Lucide / Phosphor SVG）

---

## AI-slop 黑名單

以下這些東西**不要**出現在 wave-deploy-agent：

- ❌ 紫/藍漸層做背景裝飾
- ❌ 三欄 feature grid with rounded shadow cards
- ❌ 浮雕 blob / wave / 幾何圖形做版面裝飾
- ❌ 置中一切的 landing hero
- ❌ 表情符號當圖示
- ❌ 「Get Started」「Learn More」這種沒說明的 CTA
- ❌ 泛用 testimonial section
- ❌ cookie banner 占大範圍

---

## 實作指引

### 新元件第一優先
1. 用 token，不要 hardcode color / spacing
2. 先查 `--ok/--warn/--danger/--info` 再決定狀態色
3. body 字級預設 18px，若要更小用 `--fs-sm` (16)，不要 14 以下（除非 timestamp 之類）

### 舊檔案移轉
1. `--status-live` / `--status-success` alias 還會通，逐步改用 `--ok`
2. `background: white` → `background: var(--surface-1)`
3. `color: #000` → `color: var(--ink-900)`
4. 所有 `font-size: 14px` → 審視是否該升到 16 或 18

### Font weight 規則
- 400：body text
- 500：button label, meta strong, nav item default
- 600：card title, section title, pill, nav active, primary button
- 700：hero title only

---

## 驗證清單

新頁面上線前檢查：
- [ ] 字級至少 16px（body 18px 更佳）
- [ ] 色彩只用 token，沒有 hardcoded hex
- [ ] 3 個 viewport（375 / 768 / 1440）都能順暢讀
- [ ] status pill 用 `--ok/--warn/--danger/--info`，不是硬寫 green/red
- [ ] 沒有 AI-slop 黑名單的元素
- [ ] `prefers-reduced-motion` 尊重
