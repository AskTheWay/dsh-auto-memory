/** 页面与面板底色沿用 DSH，记忆类型、状态和图表使用独立强调色。 */
export const PANEL_CSS = `
.dam-root {
  --dam-bg: var(--dsw-alias-bg-base, #f8f9fb);
  --dam-surface: var(--dsw-alias-bg-layer-1, #fff);
  --dam-soft: var(--dsw-alias-bg-layer-2, #eff2f6);
  --dam-ink: var(--dsw-alias-label-primary, #17222f);
  --dam-muted: var(--dsw-alias-label-secondary, #536174);
  --dam-line: var(--dsw-alias-border-l1, #dce2ea);
  --dam-line-strong: var(--dsw-alias-border-l2, #bfc9d6);
  --dam-accent: var(--dsw-alias-brand-primary, #315fb3);
  --dam-warn: var(--dsw-alias-state-warn-primary, #b17227);
  --dam-danger: var(--dsw-alias-state-error-primary, #bc4044);
  --dam-hover: var(--dsw-alias-interactive-bg-hover, #edf1f7);
  --dam-selected: color-mix(in srgb, var(--dam-surface) 88%, var(--dam-accent));
  --dam-green: #21654e;
  --dam-on-green: #fff;
  --dam-blue: #2e5a83;
  --dam-plum: #6e4887;
  --dam-on-plum: #fff;
  --dam-clay: #963f31;
  --dam-gold: #815016;
  --dam-chart-fill: #4b7b96;
  --dam-chart-cut: #b4583e;
  color: var(--dam-ink);
  width: 100%;
  height: 100%;
  overflow: auto;
  container-type: inline-size;
  scrollbar-width: thin;
}
:where(body[data-ds-dark-theme]) .dam-root {
  --dam-green: #8cd7b4;
  --dam-on-green: #17352a;
  --dam-blue: #a3c7eb;
  --dam-plum: #d0b1e7;
  --dam-on-plum: #271631;
  --dam-clay: #f4a391;
  --dam-gold: #efc385;
  --dam-chart-fill: #6d9db9;
  --dam-chart-cut: #df8a70;
}
.dam-root *, .dam-root *::before, .dam-root *::after { box-sizing: border-box; }
.dam-shell {
  width: 100%;
  max-width: 1300px;
  padding: 28px clamp(14px, 3.1cqi, 42px) 36px;
  margin-inline: auto;
  font-size: 13px;
  line-height: 1.55;
}
.dam-shell h1, .dam-shell h2, .dam-shell h3, .dam-shell h4, .dam-shell p { margin: 0; }
.dam-shell h1 { font-size: 27px; line-height: 1.24; font-weight: 650; letter-spacing: -0.02em; }
.dam-shell h2 { font-size: 16px; line-height: 1.4; font-weight: 620; }
.dam-shell h3 { font-size: 13px; line-height: 1.45; font-weight: 620; }
.dam-shell h4 { font-size: 12px; line-height: 1.45; font-weight: 620; }
.dam-shell :is(button, input, textarea, select) { font: inherit; }
.dam-shell :is(button, a, input, textarea, select, summary):focus-visible {
  outline: 2px solid var(--dam-accent);
  outline-offset: 2px;
}
.dam-shell button { cursor: pointer; touch-action: manipulation; }
.dam-shell button:disabled { cursor: default; opacity: .5; }
.dam-shell [hidden] { display: none !important; }
.dam-shell svg { flex: none; }
.dam-note { color: var(--dam-muted); font-size: 12px; overflow-wrap: anywhere; }
.dam-ellipsize { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dam-danger-text { color: var(--dam-danger) !important; }
.dam-pane { min-width: 0; padding-top: 18px; }
.dam-header, .dam-section-head, .dam-event-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dam-header { min-height: 42px; flex-wrap: wrap; }
.dam-header-actions, .dam-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dam-btn, .dam-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 5px 10px;
  border: 1px solid var(--dam-line-strong);
  border-radius: 6px;
  background: var(--dam-surface);
  color: var(--dam-ink);
  white-space: nowrap;
}
.dam-icon-btn { width: 34px; padding: 0; background: transparent; border-color: transparent; color: var(--dam-muted); }
.dam-btn:not(:disabled):hover, .dam-icon-btn:not(:disabled):hover { background: var(--dam-hover); }
.dam-btn-quiet { background: transparent; border-color: transparent; }
.dam-btn-primary {
  background: var(--dam-accent);
  border-color: var(--dam-accent);
  color: var(--dsw-alias-label-inverse, #fff);
  font-weight: 600;
}
.dam-btn-primary:not(:disabled):hover { background: color-mix(in srgb, var(--dam-accent) 89%, var(--dam-ink)); }
.dam-btn-danger { color: var(--dam-danger); border-color: color-mix(in srgb, var(--dam-danger) 55%, var(--dam-line)); }
.dam-btn-danger:not(:disabled):hover { background: color-mix(in srgb, var(--dam-danger) 10%, var(--dam-surface)); }
.dam-text-action {
  border: 0;
  padding: 1px 0;
  background: transparent;
  color: var(--dam-accent);
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 3px;
  overflow-wrap: anywhere;
}
.dam-action-count, .dam-tab-count, .dam-list-count {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  min-width: 18px;
  text-align: center;
  padding-inline: 4px;
  border-radius: 4px;
  color: var(--dam-muted);
  background: var(--dam-soft);
}
.dam-tabs {
  display: flex;
  gap: 20px;
  border-bottom: 1px solid var(--dam-line-strong);
  margin-top: 13px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.dam-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 41px;
  padding: 0 4px;
  white-space: nowrap;
  color: var(--dam-muted);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
}
#dam-tab-library { --dam-tab-ink: var(--dam-green); }
#dam-tab-activity { --dam-tab-ink: var(--dam-blue); }
#dam-tab-maintenance { --dam-tab-ink: var(--dam-clay); }
#dam-tab-settings { --dam-tab-ink: var(--dam-plum); }
.dam-tab:is(:hover, [aria-selected="true"]) { color: var(--dam-tab-ink, var(--dam-ink)); }
.dam-tab[aria-selected="true"] { border-bottom-color: var(--dam-tab-ink, var(--dam-accent)); font-weight: 620; }
.dam-tab-count { color: var(--dam-clay); }
.dam-tab:focus-visible { outline-offset: -3px; }
.dam-notice {
  margin-top: 12px;
  padding: 3px 6px 3px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--dam-line);
  border-radius: 6px;
  overflow-wrap: anywhere;
  background: var(--dam-surface);
}
.dam-notice[data-error] { border-inline-start: 3px solid var(--dam-danger); }
.dam-library-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.dam-shell .dam-search-status { margin-bottom: 10px; }
.dam-search {
  flex: 1 1 250px;
  min-width: 0;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding-inline: 11px 4px;
  border: 1px solid var(--dam-line-strong);
  border-radius: 6px;
  color: var(--dam-muted);
  background: var(--dam-surface);
}
.dam-search:focus-within { border-color: var(--dam-accent); }
.dam-search input {
  min-width: 0;
  flex: 1;
  height: 34px;
  background: transparent;
  color: var(--dam-ink);
  border: 0;
  padding: 0;
}
.dam-search input::placeholder { color: var(--dam-muted); }
.dam-search input::-webkit-search-cancel-button { appearance: none; }
.dam-search .dam-icon-btn { min-height: 28px; width: 28px; }
.dam-filters { display: flex; flex-wrap: wrap; gap: 7px; min-width: 0; }
.dam-select {
  min-height: 36px;
  max-width: min(100%, 190px);
  padding: 4px 8px;
  background: var(--dam-surface);
  border: 1px solid var(--dam-line-strong);
  border-radius: 6px;
  color: var(--dam-ink);
  text-overflow: ellipsis;
}
.dam-library-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.19fr) minmax(300px, 1fr);
  align-items: start;
  min-height: 405px;
  background: var(--dam-surface);
  border: 1px solid var(--dam-line-strong);
  border-radius: 8px;
}
.dam-record-list { align-self: stretch; min-width: 0; border-inline-end: 1px solid var(--dam-line); }
.dam-record-columns, .dam-record {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px 42px;
  align-items: center;
  gap: 12px;
  padding-inline: 14px;
  text-align: left;
}
.dam-record-columns {
  min-height: 40px;
  color: var(--dam-muted);
  font-size: 12px;
  border-block-end: 1px solid var(--dam-line);
}
.dam-record-columns div { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 9px; }
.dam-record-columns > :last-child { text-align: right; }
.dam-record-group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 5px 14px;
  background: var(--dam-soft);
  color: var(--dam-ink);
  border-block-end: 1px solid var(--dam-line);
}
.dam-record-group-head svg { color: var(--dam-blue); }
.dam-record-group-head[data-scope="current"] svg { color: var(--dam-green); }
.dam-record-group-head[data-scope="user"] svg { color: var(--dam-plum); }
.dam-group-caption { color: var(--dam-muted); }
.dam-group-caption { white-space: nowrap; font-size: 11px; font-weight: 400; }
.dam-records, .dam-review-list { list-style: none; padding: 0; margin: 0; }
.dam-records li { content-visibility: auto; contain-intrinsic-block-size: auto 57px; }
.dam-record {
  position: relative;
  width: 100%;
  min-height: 57px;
  padding-block: 7px;
  color: var(--dam-ink);
  background: transparent;
  border: 0;
  border-block-end: 1px solid var(--dam-line);
  border-radius: 0;
}
:is(.dam-record, .dam-inspector-kind)[data-kind="project"] { --dam-kind-ink: var(--dam-green); }
:is(.dam-record, .dam-inspector-kind)[data-kind="user"] { --dam-kind-ink: var(--dam-plum); }
:is(.dam-record, .dam-inspector-kind)[data-kind="feedback"] { --dam-kind-ink: var(--dam-clay); }
:is(.dam-record, .dam-inspector-kind)[data-kind="reference"] { --dam-kind-ink: var(--dam-blue); }
.dam-record:not(:disabled):hover { background: var(--dam-hover); }
.dam-record[aria-current="true"] { background: var(--dam-selected); box-shadow: inset 2px 0 var(--dam-kind-ink, var(--dam-accent)); }
.dam-record:focus-visible { outline-offset: -3px; }
.dam-record-main { min-width: 0; }
.dam-record-title, .dam-record-summary { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dam-record-title { font-size: 13px; font-weight: 610; }
.dam-record-title svg { color: var(--dam-muted); }
.dam-record-summary { margin-top: 1px; color: var(--dam-muted); font-size: 11.5px; }
.dam-record-kind, .dam-inspector-kind {
  flex: none;
  padding-inline: 4px;
  border-radius: 3px;
  color: var(--dam-kind-ink, var(--dam-muted));
  background: color-mix(in srgb, currentColor 9%, transparent);
  font-weight: 600;
}
.dam-record-reads, .dam-index-size { color: var(--dam-muted); font-variant-numeric: tabular-nums; }
.dam-record-reads { text-align: right; }
:is(.dam-state, .dam-evidence-box)[data-state="candidate"], .dam-state[data-state="expired"] { --dam-state-ink: var(--dam-gold); }
:is(.dam-state, .dam-evidence-box)[data-state="disputed"] { --dam-state-ink: var(--dam-clay); }
:is(.dam-state, .dam-evidence-box)[data-state="verified"] { --dam-state-ink: var(--dam-green); }
.dam-state[data-state="superseded"] { --dam-state-ink: var(--dam-plum); }
.dam-state { display: inline-flex; align-items: baseline; gap: 6px; color: var(--dam-state-ink, var(--dam-muted)); font-size: 12px; white-space: nowrap; }
.dam-state::before { content: ''; width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--dam-state-ink, var(--dam-line-strong)); align-self: center; }
.dam-inspector {
  position: sticky;
  top: 8px;
  max-height: calc(100dvh - 28px);
  overflow: auto;
  min-width: 0;
  padding: 17px 19px 19px;
  scrollbar-width: thin;
}
.dam-back { display: none; margin: -5px 0 9px -6px; }
.dam-inspector-head { overflow-wrap: anywhere; }
.dam-inspector-location { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; color: var(--dam-muted); font-size: 12px; }
.dam-inspector-head h2 { font-size: 20px; line-height: 1.35; letter-spacing: -.01em; }
.dam-inspector-head p { margin-top: 5px; color: var(--dam-muted); }
.dam-record-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; margin: 15px 0; padding: 11px 0; border-block: 1px solid var(--dam-line); }
.dam-record-facts dt, .dam-event-metrics dt { color: var(--dam-muted); font-size: 11px; }
.dam-record-facts dd, .dam-event-metrics dd { margin: 1px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dam-detail-states { display: flex; flex-wrap: wrap; gap: 3px 9px; }
.dam-evidence-box {
  padding: 11px 13px;
  border-inline-start: 2px solid var(--dam-state-ink, var(--dam-line-strong));
  background: var(--dam-soft);
  margin-bottom: 15px;
}
.dam-evidence-box h3 { color: var(--dam-state-ink, var(--dam-ink)); }
.dam-evidence-box .dam-btn-primary {
  background: var(--dam-green);
  border-color: var(--dam-green);
  color: var(--dam-on-green);
}
.dam-evidence-box .dam-btn-primary:not(:disabled):hover { background: color-mix(in srgb, var(--dam-green) 89%, var(--dam-ink)); }
.dam-evidence-box blockquote { margin: 7px 0; overflow-wrap: anywhere; }
.dam-evidence-box p + p { margin-top: 6px; }
.dam-evidence-box .dam-actions, .dam-evidence-box > button { margin-top: 10px; }
.dam-evidence-source { display: flex; align-items: baseline; gap: 8px; color: var(--dam-muted); font-size: 11px; }
.dam-evidence-source code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dam-body-section h3 { margin-bottom: 7px; }
.dam-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 13px;
  line-height: 1.62;
  margin: 5px 0 0;
}
.dam-inspector-actions { margin-top: 16px; border-block-start: 1px solid var(--dam-line); padding-top: 12px; }
.dam-delete-confirm { margin-top: 11px; padding: 10px 12px; border: 1px solid var(--dam-line); border-inline-start: 2px solid var(--dam-danger); }
.dam-delete-confirm p { margin-bottom: 7px; }
.dam-editor { display: grid; gap: 11px; margin-top: 15px; }
.dam-editor label { display: grid; gap: 5px; }
.dam-editor :is(input, textarea) {
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  color: var(--dam-ink);
  border: 1px solid var(--dam-line-strong);
  border-radius: 6px;
  background: var(--dam-surface);
}
.dam-editor textarea { resize: vertical; }
.dam-empty { display: grid; justify-items: start; gap: 7px; min-height: 158px; padding: 27px 19px; border: 1px solid var(--dam-line); border-radius: 8px; }
.dam-empty p { color: var(--dam-muted); }
.dam-index-usage { margin-bottom: 12px; padding: 0 2px; }
.dam-index-usage > summary, .dam-checklist > summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  min-height: 36px;
  cursor: pointer;
  list-style: none;
}
.dam-shell summary::-webkit-details-marker { display: none; }
.dam-shell details[open] > summary > svg:last-child { transform: rotate(90deg); }
.dam-index-label { flex: none; font-size: 12px; }
.dam-index-size { font-size: 12px; white-space: nowrap; }
.dam-index-meter {
  flex: 1;
  height: 5px;
  overflow: hidden;
  background: var(--dam-line);
  border-radius: 2px;
  display: flex;
}
.dam-index-meter i { height: 100%; background: var(--dam-accent); }
.dam-index-meter i + i { background: var(--dam-line-strong); }
.dam-index-meter[data-over] i:first-child { background: var(--dam-warn); }
.dam-index-body { padding: 3px 4px 12px; display: grid; gap: 7px; }
.dam-index-group { border-block-start: 1px solid var(--dam-line); padding: 7px 0; }
.dam-index-group summary { color: var(--dam-ink); cursor: pointer; }
.dam-index-group .dam-body { padding: 9px; background: var(--dam-soft); max-height: 220px; overflow: auto; }
.dam-maintenance, .dam-activity, .dam-settings-form { display: grid; gap: 15px; }
.dam-audit-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.dam-audit-toolbar .dam-select { max-width: min(100%, 560px); }
.dam-audit-run { padding: 0 16px 12px; }
.dam-surface, .dam-activity-overview { min-width: 0; border: 1px solid var(--dam-line); border-radius: 8px; background: var(--dam-surface); }
.dam-section-head { align-items: baseline; padding: 13px 16px; }
#dam-pane-activity .dam-section-head h2 { color: var(--dam-blue); }
#dam-pane-maintenance .dam-section-head h2 { color: var(--dam-clay); }
#dam-pane-settings .dam-section-head h2 { color: var(--dam-plum); }
.dam-section-head .dam-note { margin-top: 3px; }
.dam-section-empty { padding: 1px 16px 15px; }
.dam-review-list > li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  border-block-start: 1px solid var(--dam-line);
}
.dam-review-main { display: grid; gap: 1px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dam-review-name { font-weight: 560; }
.dam-review-main code { color: var(--dam-muted); font-size: 11px; }
.dam-maintenance-checks { border: 1px solid var(--dam-line); border-radius: 8px; background: var(--dam-surface); }
.dam-checklist + .dam-checklist { border-block-start: 1px solid var(--dam-line); }
.dam-checklist > summary { padding-inline: 16px; }
.dam-checklist > summary span:first-child { flex: 1; font-weight: 550; }
.dam-checklist > summary:hover { background: var(--dam-hover); }
.dam-chart-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.dam-legend-limit, .dam-legend-excluded { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--dam-muted); font-size: 11px; }
.dam-legend-limit::before { content: ''; width: 16px; border-block-start: 1px dashed var(--dam-plum); }
.dam-legend-excluded::before { content: ''; width: 10px; height: 8px; background: var(--dam-chart-cut); border-radius: 2px; }
.dam-chart-scroll { min-width: 0; overflow-x: auto; scrollbar-width: thin; padding-block: 3px 4px; }
.dam-chart { margin: 3px 16px 10px; display: grid; grid-template-columns: 49px minmax(0, 1fr); column-gap: 8px; }
.dam-chart-axes { display: flex; flex-direction: column; align-items: end; justify-content: space-between; block-size: 142px; padding-block: 3px 1px; color: var(--dam-muted); font-size: 10px; }
.dam-chart-plot { position: relative; height: 139px; border-block-end: 1px solid var(--dam-line-strong); }
.dam-chart-mid, .dam-chart-limit { position: absolute; inset-inline: 0; border-block-start: 1px solid var(--dam-line); pointer-events: none; }
.dam-chart-mid { bottom: 50%; }
.dam-chart-limit { border-block-start: 1px dashed var(--dam-plum); z-index: 1; }
.dam-chart-bars { position: absolute; inset: 0 0 0; display: flex; align-items: stretch; gap: min(1.05cqi, 9px); padding-inline: 3px; }
.dam-chart-bar {
  --dam-bar-fill: var(--dam-chart-fill);
  min-width: 12px;
  flex: 1;
  padding: 0;
  border: 0;
  background: transparent;
  display: flex;
  align-items: end;
  justify-content: center;
}
.dam-chart-bar span { width: 100%; max-width: 50px; background: var(--dam-bar-fill); border-radius: 3px 3px 0 0; }
.dam-chart-bar[data-excluded] { --dam-bar-fill: var(--dam-chart-cut); }
.dam-chart-bar[data-excluded] span { border-block-start: 3px solid var(--dam-clay); }
.dam-chart-bar:is(:hover, [aria-pressed="true"]) span { background: color-mix(in srgb, var(--dam-bar-fill) 75%, var(--dam-ink)); }
.dam-chart-bar[aria-pressed="true"] span { box-shadow: inset 0 0 0 1px var(--dam-ink); }
.dam-chart-bar:focus-visible { outline-offset: -2px; }
.dam-chart figcaption {
  grid-column: 2;
  margin-top: 7px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 5px;
  color: var(--dam-muted);
  font-size: 10.5px;
}
.dam-event { min-width: 0; padding: 12px 16px 15px; border-block-start: 1px solid var(--dam-line); }
.dam-event-head { align-items: start; flex-wrap: wrap; }
.dam-event-head > div { min-width: 0; }
.dam-event-head time { font-size: 11px; color: var(--dam-muted); }
.dam-shell .dam-event-session { font-size: 11px; }
.dam-event-metrics { display: flex; gap: 20px; flex-wrap: wrap; margin: 0; }
.dam-event-metrics dd { font-weight: 610; }
.dam-event-content { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
.dam-event-legacy { grid-column: 1 / -1; }
.dam-event-content h4 { color: var(--dam-muted); }
.dam-event [data-result="included"] :is(h4, dd) { color: var(--dam-green); }
.dam-event [data-result="excluded"] :is(h4, dd) { color: var(--dam-clay); }
.dam-event-content ul { margin: 4px 0 0; padding-inline-start: 17px; font-size: 11.5px; overflow-wrap: anywhere; }
.dam-audit-tables { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.dam-table-scroll { overflow-x: auto; }
.dam-data-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.dam-data-table tr > * { padding: 7px 9px; text-align: right; border-block-start: 1px solid var(--dam-line); }
.dam-data-table thead { color: var(--dam-muted); background: var(--dam-soft); font-size: 11.5px; }
.dam-data-table tr > :first-child { width: 49%; padding-inline-start: 16px; text-align: left; }
.dam-data-table tr > :last-child { padding-inline-end: 16px; }
.dam-data-table tbody th { font-weight: 500; }
.dam-data-table tbody th span { display: block; }
.dam-column-sort { color: inherit; border: 0; padding: 0; background: transparent; white-space: nowrap; }
.dam-column-sort span { margin-inline-start: 3px; }
.dam-more { margin: 5px 8px; }
.dam-empty-inline { border: 0; min-height: auto; padding: 8px 16px 17px; }
.dam-settings-form { max-width: 840px; }
.dam-setting-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(175px, .78fr);
  align-items: start;
  gap: 18px;
  padding: 13px 16px;
  border-block-start: 1px solid var(--dam-line);
}
.dam-setting-copy label { font-weight: 610; }
.dam-setting-copy p { margin-top: 3px; }
.dam-setting-field { display: grid; gap: 4px; }
.dam-range { display: flex; align-items: center; gap: 10px; }
.dam-range input { flex: 1; min-width: 70px; accent-color: var(--dam-plum); }
.dam-range output { min-width: 60px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dam-setting-source { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; color: var(--dam-muted); font-size: 11px; }
.dam-preset-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; padding: 0 16px 12px; }
.dam-preset { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--dam-line); border-radius: 5px; color: var(--dam-ink); background: transparent; text-align: left; }
.dam-preset span + span { color: var(--dam-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.dam-preset[aria-pressed="true"] { border-color: var(--dam-plum); background: var(--dam-selected); }
.dam-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.dam-settings-actions .dam-btn-primary {
  background: var(--dam-plum);
  border-color: var(--dam-plum);
  color: var(--dam-on-plum);
}
.dam-settings-actions .dam-btn-primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--dam-plum) 90%, var(--dam-on-plum));
}
.dam-settings-actions .dam-btn-primary:disabled {
  background: transparent;
  border-color: var(--dam-line);
  color: var(--dam-muted);
  opacity: 1;
}
.dam-settings-draft { color: var(--dam-plum); font-weight: 550; }
.dam-check { margin: 0; width: 15px; height: 15px; accent-color: var(--dam-accent); }
.dam-settings-form .dam-check { accent-color: var(--dam-plum); }
.dam-dialog {
  margin: auto;
  padding: 0;
  background: var(--dam-surface);
  color: var(--dam-ink);
  border: 1px solid var(--dam-line-strong);
  border-radius: 9px;
  width: min(640px, calc(100vw - 30px));
  max-height: calc(100dvh - 30px);
  overscroll-behavior: contain;
}
.dam-dialog::backdrop { background: rgb(16 25 38 / 49%); }
.dam-dialog-head, .dam-dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 15px; }
.dam-dialog-head { border-block-end: 1px solid var(--dam-line); }
.dam-dialog-actions { justify-content: flex-end; border-block-start: 1px solid var(--dam-line); }
.dam-dialog-body { padding: 14px 15px; min-width: 0; overflow-wrap: anywhere; }
.dam-import-list { max-height: min(46vh, 480px); overflow: auto; scrollbar-width: thin; }
.dam-import-group + .dam-import-group { margin-top: 12px; }
.dam-import-group-head, .dam-import-entry, .dam-import-option { display: flex; align-items: center; gap: 9px; cursor: pointer; padding: 8px 7px; }
.dam-import-group-head { background: var(--dam-soft); }
.dam-import-entry { border-block-end: 1px solid var(--dam-line); }
.dam-import-entry > span:nth-child(2), .dam-import-group-head > span { min-width: 0; flex: 1; display: grid; gap: 2px; }
.dam-import-entry small, .dam-import-group-head small { font-size: 11px; color: var(--dam-muted); }
.dam-import-option { margin-top: 7px; }

@container (max-width: 790px) {
  .dam-library-grid { display: block; min-height: 0; }
  .dam-record-list { border: 0; }
  .dam-inspector { position: static; max-height: none; }
  .dam-library-grid[data-detail="closed"] .dam-inspector, .dam-library-grid[data-detail="open"] .dam-record-list { display: none; }
  .dam-back { display: inline-flex; }
  .dam-audit-tables { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 500px) {
  .dam-shell { padding-block-start: 16px; }
  .dam-header h1 { font-size: 22px; }
  .dam-tabs { gap: 10px; }
  .dam-filters { width: 100%; }
  .dam-filters .dam-select { flex: 1 1 90px; max-width: none; min-width: 0; }
  .dam-record-columns, .dam-record { grid-template-columns: minmax(0, 1fr) 67px 30px; column-gap: 7px; padding-inline: 10px; }
  .dam-record-group-head { padding-inline: 10px; }
  .dam-group-caption { font-size: 10px; }
  .dam-inspector { padding: 13px; }
  .dam-index-usage > summary { flex-wrap: wrap; gap: 5px 10px; }
  .dam-index-meter { flex-basis: 100%; order: 2; }
  .dam-index-label { flex: 1; }
  .dam-section-head, .dam-review-list > li { padding-inline: 11px; }
  .dam-review-list > li { gap: 7px; flex-wrap: wrap; }
  .dam-section-head { flex-wrap: wrap; }
  .dam-chart figcaption > :nth-child(2) { flex-basis: 100%; order: 1; }
  .dam-setting-row { grid-template-columns: minmax(0, 1fr); gap: 7px; }
  .dam-event-content { grid-template-columns: minmax(0, 1fr); }
}
`
