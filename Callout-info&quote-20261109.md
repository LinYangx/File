```css
/* =============== info =============== */

/* 深色模式配色 */
.theme-dark {
  --info-title-color: #666666;
  --info-bg-color: #000000;
}

body {
  --info-bar-color: var(--h2-block-bg);
}

/* 底块颜色 */
.callout[data-callout="info"] {
  background-color: var(--info-bg-color);
}

/* 标题、图标和折叠箭头颜色 */
.callout[data-callout="info"] :is(
  .callout-title-inner,
  .callout-icon,
  .callout-fold
) {
  color: var(--info-title-color);
}

/* 隐藏图标 */
.callout[data-callout="info"] .callout-icon {
  display: none;
}

/* 标题左侧色条
.callout[data-callout="info"] .callout-title::before {
  content: "";
  display: inline-block;
  flex: 0 0 auto;
  width: 6px;
  height: 1.6em;
  margin-right: 0em;
  background: var(--info-bar-color);
  box-shadow: 0 -4px 0 0 var(--info-bar-color);
} */

/* =============== Quote =============== */
body {
  /* quote / cite 样式变量 */
  --quote-icon-color: hsl(360, 70%, 60%);
  --quote-title-color: hsl(360, 70%, 62%);
  --quote-title-font-weight: 600;
  --quote-title-font-size: 1em;
  --quote-title-letter-spacing: 0;   /* 默认: 0.02em */
}

/* quote图标 */
/* 去描边并填充颜色 */
.callout[data-callout="quote"] .callout-icon svg,
.callout[data-callout="cite"] .callout-icon svg {
  stroke: none;
  fill: var(--quote-icon-color);
}

/* quote标题文字样式 */
.callout[data-callout="quote"] .callout-title-inner,
.callout[data-callout="cite"] .callout-title-inner {
  color: var(--quote-title-color);
  font-weight: var(--quote-title-font-weight);
  font-size: var(--quote-title-font-size);
  letter-spacing: var(--quote-title-letter-spacing);
}
```