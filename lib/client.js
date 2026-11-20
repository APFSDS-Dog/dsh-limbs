/**
 * dsh-limbs — Client half: the composer model seat (`conversation.input.model`).
 *
 * REPLACEMENT, NOT STACKING. The shipped seat
 * (`@deepseek-ai/dsh-client-ui-model-selection`) stays mounted and keeps its
 * `ctx.modelDirectories` service and its `/model` popup command alive. This
 * module registers the SAME named seat at `priority: -1`; the slot core keeps
 * entries sorted by priority and the lowest priority renders, so the stock
 * occupant (0) is shadowed instead of duplicated. Disabling this plugin's row
 * removes the entry and the stock control is back — no CSS or DOM residue,
 * because every style and effect below is registered under `ctx.effect`.
 *
 * DATA: one directory per session, the stock `ctx.modelDirectories`
 * (`directoryFor(sessionId)` → `.store/.load()/.select()`), i.e. the very same
 * instance `/model` reads and writes. This module never keeps a catalogue of
 * its own and never calls the Host directly, so a switch made here is what
 * `/model` shows next, and vice versa.
 *
 * DISPLAY-ONLY METADATA: price multipliers, discount labels and load dots have
 * no field in the Host model catalogue (`ModelCatalogModel` = id/name/
 * description/reasoning/badge). They are driven by LIMBS_META below: an empty
 * entry renders nothing (no invented numbers). Fill it with values you can
 * source, or leave it empty.
 */
window.__ModuleLoader__.load({
  id: 'dsh-limbs',
  factory: (require) => {
    const React = require('react')
    const {
      Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React
    const h = React.createElement

    // ── Display-only metadata ───────────────────────────────────────────────
    // Empty by design (2026-11-14 decision): the Host catalogue carries no
    // price, multiplier or load data, so this picker shows none until a sourced
    // feed exists. Nothing here is fetched and no value is invented — fill a
    // key only when you have a value you can point at.
    //
    // Keys: `providerId/modelId` for models, `providerId` for providers.
    //
    // provider: { title?: string, mark?: string }
    // model:    { multiplier?: string, discount?: string | { zh, en },
    //             status?: 'idle' | 'warn' | 'busy' | 'unknown' }
    //
    // `mark` is the short label in the logo tile; unset uses the provider's
    // first letter (the deliberate placeholder — no brand artwork is bundled).
    const LIMBS_META = {
      providers: {
        // 'scnet': { mark: 'S' },
      },
      models: {
        // 'scnet/GLM-5.3-Flash': { multiplier: '0.69x', discount: '夜间折扣', status: 'idle' },
      },
    }

    // ── Copy ────────────────────────────────────────────────────────────────
    const STR = {
      zh: {
        triggerEmpty: '选择模型',
        search: '搜索模型或提供商…',
        clear: '清除搜索',
        providers: '提供商',
        allProviders: '全部提供商',
        models: '模型',
        loading: '正在读取模型目录…',
        noModels: '暂无可用模型',
        noMatch: '没有匹配的模型',
        providerEmpty: '该提供商暂无模型',
        retry: '重试',
        refresh: '重新读取',
        config: '配置',
        configHint: '打开设置 · 模型',
        failed: '选择失败',
        loadFailed: '目录读取失败',
        groupFailed: '加载失败',
        footerProviders: '提供商',
        footerModels: '模型',
        footerFailures: '失败',
        effort: '推理档位',
        providerDefault: '提供方默认',
        accountProvider: 'DeepSeek 账号',
        statusIdle: '空闲',
        statusWarn: '轻微拥堵',
        statusBusy: '极度拥堵',
        statusUnknown: '未知',
        keyHint: '↑↓ 选择 · Enter 确认 · Esc 关闭',
        // Settings tab + review panel. UI shell only: every value here is a
        // placeholder until module 3 lands.
        settingsNav: 'Limbs 配置',
        settingsContext: '默认上下文长度',
        settingsContextHint: '新会话默认带多长的上下文窗口',
        settingsEffort: '默认推理强度',
        settingsEffortHint: '新会话默认使用的推理档位',
        settingsWarn: '费用超限时提示',
        settingsWarnHint: '估算花费超过预算时在对话里提醒',
        settingsMock: '当前为界面占位，设置只存在本机浏览器里，暂未写入 DSH 配置。',
        reviewNav: 'Limbs 复盘',
        reviewEntry: '复盘',
        reviewQuickModel: '快捷切换模型',
        reviewQuickModelHint: '本次会话使用的模型（占位）',
        reviewRun: '一键复盘',
        reviewRunning: '正在复盘…',
        reviewTriggered: '占位触发：已记录一次复盘请求，尚未接入真实逻辑。',
        reviewReport: '复盘报告',
        reviewMock: '假数据',
        effortLow: '低',
        effortMedium: '中',
        effortHigh: '高',
        reviewGuideDesc: '在当前会话里跑一次复盘并查看报告',
      },
      en: {
        triggerEmpty: 'Select model',
        search: 'Search models or providers…',
        clear: 'Clear search',
        providers: 'Providers',
        allProviders: 'All providers',
        models: 'Models',
        loading: 'Loading model directory…',
        noModels: 'No models available',
        noMatch: 'No matching models',
        providerEmpty: 'No models for this provider',
        retry: 'Retry',
        refresh: 'Reload',
        config: 'Settings',
        configHint: 'Open Settings → Models',
        failed: 'Selection failed',
        loadFailed: 'Directory load failed',
        groupFailed: 'Failed to load',
        footerProviders: 'providers',
        footerModels: 'models',
        footerFailures: 'failed',
        effort: 'Reasoning',
        providerDefault: 'Provider default',
        accountProvider: 'DeepSeek account',
        statusIdle: 'Idle',
        statusWarn: 'Light load',
        statusBusy: 'Heavy load',
        statusUnknown: 'Unknown',
        keyHint: '↑↓ to move · Enter to accept · Esc to close',
        // Settings tab + review panel. UI shell only: every value here is a
        // placeholder until module 3 lands.
        settingsNav: 'Limbs settings',
        settingsContext: 'Default context length',
        settingsContextHint: 'Context window a new Session starts from',
        settingsEffort: 'Default reasoning effort',
        settingsEffortHint: 'Reasoning level a new Session starts from',
        settingsWarn: 'Warn when cost exceeds the limit',
        settingsWarnHint: 'Call out an estimated spend over budget in the chat',
        settingsMock: 'UI placeholder: these values stay in this browser, not in DSH config.',
        reviewNav: 'Limbs review',
        reviewEntry: 'Review',
        reviewQuickModel: 'Quick model switch',
        reviewQuickModelHint: 'Model used by this Session (placeholder)',
        reviewRun: 'Run review',
        reviewRunning: 'Reviewing…',
        reviewTriggered: 'Placeholder: one review request recorded, no real logic yet.',
        reviewReport: 'Review report',
        reviewMock: 'mock data',
        effortLow: 'Low',
        effortMedium: 'Medium',
        effortHigh: 'High',
        reviewGuideDesc: 'Run one review in this Session and read the report',
      },
    }

    let LOCALE = 'en'
    try {
      const nl = String(navigator.language || navigator.userLanguage || '')
      if (nl.toLowerCase().startsWith('zh')) LOCALE = 'zh'
    } catch { /* keep en */ }

    const t = (key) => (STR[LOCALE] && STR[LOCALE][key]) || STR.en[key] || key

    /** Localize a LIMBS_META text value that may be a plain string or {zh,en}. */
    function metaText(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'string') return value
      return value[LOCALE] || value.en
    }

    // ── Styles ──────────────────────────────────────────────────────────────
    // Every color is a theme token (light/dark follow the app); the fallbacks
    // only matter if a token ever disappears.
    const CSS = `
.limbs-root{position:relative;display:inline-flex;min-width:0;max-width:100%}
.limbs-trigger{display:flex;align-items:center;gap:6px;min-width:0;max-width:240px;height:28px;padding:0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.limbs-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2,#c8ccd1)}
.limbs-trigger:disabled{color:var(--dsw-alias-label-dimmed,#9aa0a6);cursor:default}
.limbs-triggerMark{display:var(--dsh-composer-model-icon-display,none);flex:0 0 auto}
.limbs-triggerLabel{display:var(--dsh-composer-model-text-display,inline);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.limbs-triggerEffort{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.limbs-chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;transition:transform 120ms ease}
.limbs-chevronOpen{transform:rotate(180deg)}
.limbs-resize{position:absolute;top:0;left:0;right:0;height:7px;z-index:1;cursor:row-resize;touch-action:none}
.limbs-resize::after{content:'';position:absolute;left:50%;top:2px;transform:translateX(-50%);width:28px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2,#c8ccd1);opacity:0;transition:opacity 120ms ease}
.limbs-resize:hover::after{opacity:.7}
.limbs-busy{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4f8cff);animation:limbs-pulse 900ms ease-in-out infinite}
@keyframes limbs-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.limbs-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:60;display:flex;flex-direction:column;width:min(480px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 120px));overflow:hidden;padding:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:14px;background-color:var(--dsw-alias-bg-base,#fff);background-image:linear-gradient(var(--dsw-menu-surface-fill,transparent),var(--dsw-menu-surface-fill,transparent));box-shadow:var(--dsw-elevation-panel,var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18)));color:var(--dsw-alias-label-primary,#1f2328)}
.limbs-searchRow{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin:6px 2px 2px}
.limbs-search{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:9px;outline:none;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:inherit;font:inherit;font-size:13px;line-height:20px}
.limbs-search::placeholder{color:var(--dsw-alias-label-tertiary,#8b949e)}
.limbs-search:hover:not(:focus-visible){border-color:var(--dsw-alias-border-l2,#c8ccd1)}
.limbs-search:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.limbs-clear{flex:0 0 auto;width:22px;height:22px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:14px;line-height:22px;cursor:pointer}
.limbs-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-body{display:flex;flex:1;min-height:0;gap:6px}
.limbs-providers{flex:0 0 152px;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:2px}
.limbs-provider{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.limbs-provider:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-providerActive{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 14%,transparent);color:var(--dsw-alias-brand-primary,#4f8cff);font-weight:600}
.limbs-providerName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.limbs-providerCount{flex:0 0 auto;padding:0 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px}
.limbs-list{flex:1;min-width:0;min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));padding:2px 2px 2px 6px}
.limbs-groupLabel{position:sticky;top:0;z-index:1;padding:6px 6px 4px;background-color:var(--dsw-alias-bg-base,#fff);background-image:linear-gradient(var(--dsw-alias-menu-group-header-fill,transparent),var(--dsw-alias-menu-group-header-fill,transparent));color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px;letter-spacing:.02em;text-transform:none}
.limbs-row{display:grid;grid-template-columns:10px 18px minmax(0,1fr) auto 16px;align-items:center;gap:8px;width:100%;min-height:36px;padding:5px 8px;border:none;border-radius:9px;outline:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.limbs-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-rowActive{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 10%,transparent)}
.limbs-rowSelected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 16%,transparent)}
.limbs-rowSelected:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 22%,transparent)}
.limbs-row:disabled{color:var(--dsw-alias-label-dimmed,#9aa0a6);cursor:default}
.limbs-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9aa0a6);opacity:.45}
.limbs-dot-idle{background:var(--dsw-alias-state-success-primary,#1a7f37);opacity:1}
.limbs-dot-warn{background:var(--dsw-alias-state-warn-primary,#bf8700);opacity:1}
.limbs-dot-busy{background:var(--dsw-alias-state-error-primary,#cf222e);opacity:1}
.limbs-mark{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#57606a);font-size:10px;font-weight:700;line-height:1;overflow:hidden;text-transform:uppercase}
.limbs-nameCell{display:flex;align-items:center;gap:6px;min-width:0}
.limbs-name{min-width:0;overflow:hidden;color:inherit;font-size:13px;line-height:20px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.limbs-subName{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.limbs-discount{flex:0 0 auto;padding:0 6px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 16%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37);font-size:10px;line-height:16px;font-weight:600}
.limbs-multiplier{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.limbs-check{color:var(--dsw-alias-brand-primary,#4f8cff);font-size:13px;line-height:1;text-align:center}
.limbs-state{padding:10px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:13px;line-height:20px}
.limbs-error,.limbs-warning{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:4px 2px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(207,34,46,.1));color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12px;line-height:18px}
.limbs-warning{background:var(--dsw-alias-bg-module-platform,rgba(191,135,0,.1));color:var(--dsw-alias-state-warn-label,#8a6100)}
.limbs-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.limbs-effort{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:0 0 auto;padding:8px 6px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.limbs-effortLabel{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:18px}
.limbs-effortBtn{flex:0 0 auto;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:11px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:11px;line-height:20px;cursor:pointer}
.limbs-effortBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-effortOn{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 10%,transparent);color:var(--dsw-alias-brand-primary,#4f8cff)}
.limbs-footer{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin-top:6px;padding:6px 6px 2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.limbs-counts{flex:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.limbs-footerBtn{flex:0 0 auto;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:11px;line-height:22px;cursor:pointer}
.limbs-footerBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-footerBtn:disabled{color:var(--dsw-alias-label-dimmed,#9aa0a6);cursor:default}
.limbs-hint{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px}

/* ── Settings section + review panel (UI shell, mock data) ──────────────
   Layout copies a stock settings page: a title, one group panel with 0.5px
   dividers, and label/control rows. Controls are hand-written instead of
   imported from ui-primitives, which is not a loadable Client package. */
.limbs-page{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.limbs-pageTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.limbs-pageNote{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.limbs-group{border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.limbs-row2{display:flex;align-items:center;gap:16px;padding:12px 14px}
.limbs-row2 + .limbs-row2{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.limbs-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.limbs-rowLabel{color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px;font-weight:500}
.limbs-rowHint{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}
.limbs-select{flex:0 0 auto;min-width:132px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:8px;outline:none;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;cursor:pointer}
.limbs-select:hover{border-color:var(--dsw-alias-border-l2,#c8ccd1)}
.limbs-select:focus-visible{border-color:var(--dsw-alias-label-secondary,#57606a);box-shadow:0 0 0 2px var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
/* Contrast is derived, never assumed. From the shipped palette
   (ui-theme lib/client.js), the two tokens this control needs are exact
   opposites in BOTH themes:
     light: label-primary #0f1115 · bg-base #ffffff
     dark : label-primary #f9fafb · bg-base #151517
   So the knob is always the opposite of its track: label-primary while off
   (over a 34% track), bg-base while on (over a full-strength track). Pairing a
   fixed bg-base knob with a dark track is what made the off state vanish.
   NOTE: this whole block is inside a template literal — never write a
   backtick in these comments or the CSS string ends early. */
.limbs-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:none;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 34%,transparent);cursor:pointer;transition:background 120ms ease}
.limbs-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary,#1f2328)}
.limbs-switch:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#57606a);outline-offset:2px}
.limbs-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform 120ms ease,background 120ms ease}
.limbs-switch[aria-checked="true"] .limbs-switchKnob{background:var(--dsw-alias-bg-base,#fff);transform:translateX(16px)}
.limbs-panel{display:flex;flex-direction:column;gap:12px;min-width:0;height:100%;padding:12px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.limbs-panelHead{display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
.limbs-panelLabel{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.limbs-panelSelectRow{display:flex;align-items:center;gap:8px;min-width:0}
.limbs-panelSelectRow .limbs-select{flex:1;min-width:0}
/* The primary action INVERTS the surface instead of using brand-primary:
   in this theme brand-primary resolves to near-white, so white-on-brand was
   invisible. Pairing label-primary with bg-base keeps full contrast in both
   light and dark, which is what a filled action needs here. */
.limbs-run{flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:38px;padding:0 16px;border:none;border-radius:9px;background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-base,#fff);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.limbs-run:hover:not(:disabled){filter:brightness(1.08)}
.limbs-run:active:not(:disabled){filter:brightness(.92)}
.limbs-run:focus-visible{outline:2px solid var(--dsw-alias-border-l2,#c8ccd1);outline-offset:2px}
.limbs-run:disabled{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.24));color:var(--dsw-alias-label-secondary,#57606a);cursor:default;filter:none}
.limbs-runNotice{flex:0 0 auto;margin:0;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 12%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37);font-size:12px;line-height:18px}
.limbs-report{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
.limbs-reportHead{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.limbs-reportTitle{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px;font-weight:600}
.limbs-badge{flex:0 0 auto;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;line-height:16px}
.limbs-md{flex:1;min-height:120px;margin:0;padding:10px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-family:inherit;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;overflow:auto;tab-size:2}
.limbs-headerBtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.limbs-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-headerBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2,#c8ccd1)}

/* ── 模块二 · 档位化模型管理 ────────────────────────────────────────────
   A single centered column (400–640px) so the two sliders are visible
   without hunting through nested menus. Colors stay on theme tokens; text
   and marks carry every state so color is never the only signal. */
.mm-page{display:flex;flex-direction:column;gap:18px;width:100%;min-width:400px;max-width:640px;margin:0 auto;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.mm-head{display:flex;flex-direction:column;gap:4px}
.mm-title{margin:0;font-size:17px;font-weight:600;line-height:24px}
.mm-intro{margin:0;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.mm-hero{display:flex;flex-direction:column;gap:10px;padding:16px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.mm-heroTop{display:flex;align-items:center;justify-content:space-between;gap:10px}
.mm-eyebrow{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px;letter-spacing:.02em}
.mm-sync{flex:0 0 auto;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}
.mm-heroModel{margin:0;font-size:20px;font-weight:600;line-height:28px;overflow-wrap:anywhere}
.mm-chips{display:flex;flex-wrap:wrap;gap:8px}
.mm-chip{display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px;transition:background-color 180ms ease,color 180ms ease,border-color 180ms ease}
.mm-chipOff{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#bf8700) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#bf8700) 12%,transparent);color:var(--dsw-alias-state-warn-label,#8a6100)}
.mm-section{display:flex;flex-direction:column;gap:10px;padding:16px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff)}
.mm-sectionHead{display:flex;align-items:flex-start;gap:10px}
.mm-icon{flex:0 0 auto;display:block;color:var(--dsw-alias-label-secondary,#57606a)}
.mm-sectionText{display:flex;flex-direction:column;gap:2px;min-width:0}
.mm-sectionTitle{margin:0;font-size:14px;font-weight:600;line-height:20px}
.mm-sectionHint{margin:0;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}
.mm-slider{position:relative;padding:8px 36px 0;border-radius:12px;outline:none;touch-action:none;user-select:none}
.mm-slider:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#4f8cff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 5%,transparent)}
.mm-field{position:relative;height:72px}
.mm-rail{position:absolute;left:0;right:0;top:13px;height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 16%,transparent)}
.mm-railFill{position:absolute;left:0;top:0;height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width 180ms ease,background 180ms ease}
.mm-thumb{position:absolute;top:13px;width:20px;height:20px;margin-top:-6px;margin-left:-10px;border:2px solid var(--dsw-alias-bg-base,#fff);border-radius:50%;background:var(--dsw-alias-brand-primary,#4f8cff);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left 180ms ease,background 180ms ease;z-index:2}
.mm-tick{position:absolute;top:0;display:flex;flex-direction:column;align-items:center;gap:0;width:76px;margin-left:-38px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font:inherit;cursor:pointer;z-index:3}
.mm-tick:focus{outline:none}
.mm-tickDot{display:block;width:16px;height:16px;margin-top:9px;border:2px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:border-color 180ms ease,background 180ms ease}
.mm-tickLabel{margin-top:10px;color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px;white-space:nowrap}
.mm-tickActive .mm-tickDot{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-brand-primary,#4f8cff)}
.mm-tickActive .mm-tickLabel{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
.mm-tickDefault{margin-top:1px;padding:0 5px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f8cff);font-size:10px;line-height:14px;white-space:nowrap}
.mm-tickDisabled{cursor:not-allowed}
.mm-tickDisabled .mm-tickDot{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,#f4f6f8);opacity:.5}
.mm-tickCheck{position:absolute;top:0;left:calc(50% + 9px);color:var(--dsw-alias-brand-primary,#4f8cff);font-size:11px;line-height:16px;font-weight:700}
.mm-note{display:flex;align-items:flex-start;gap:6px;margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.mm-noteWarn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#bf8700) 12%,transparent);color:var(--dsw-alias-state-warn-label,#8a6100)}
.mm-row{display:flex;align-items:center;gap:10px;min-height:40px}
.mm-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.mm-rowLabel{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px}
.mm-rowValue{color:var(--dsw-alias-label-primary,#1f2328);font-size:14px;line-height:20px;font-weight:600;overflow-wrap:anywhere}
.mm-rowHint{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;line-height:16px}
.mm-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:2px}
.mm-status{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.mm-statusDot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#1a7f37)}
.mm-statusSaving .mm-statusDot{background:var(--dsw-alias-state-warn-primary,#bf8700)}
.mm-statusError .mm-statusDot{background:var(--dsw-alias-state-error-primary,#cf222e)}
.mm-reset{flex:0 0 auto;height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:16px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.mm-reset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mm-reset:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2,#c8ccd1)}
.mm-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.38)}
.mm-dialog{display:flex;flex-direction:column;gap:10px;width:min(400px,100%);padding:18px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 18px 48px rgba(0,0,0,.28)}
.mm-dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.mm-dialogBody{margin:0;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.mm-dialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.mm-dialogCancel,.mm-dialogConfirm{height:32px;padding:0 14px;border-radius:9px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.mm-dialogCancel{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:transparent;color:var(--dsw-alias-label-secondary,#57606a)}
.mm-dialogConfirm{border:none;background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-base,#fff);font-weight:600}
.mm-dialogCancel:focus-visible,.mm-dialogConfirm:focus-visible{outline:2px solid var(--dsw-alias-border-l2,#c8ccd1);outline-offset:2px}
.mm-toast{position:fixed;left:50%;bottom:28px;z-index:130;display:flex;align-items:center;gap:8px;max-width:min(520px,calc(100vw - 40px));padding:9px 10px 9px 12px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 10px 30px rgba(0,0,0,.2);font-size:12px;line-height:18px;transform:translateX(-50%)}
.mm-toastSuccess .mm-icon{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.mm-toastError .mm-icon{color:var(--dsw-alias-state-error-primary,#cf222e)}
.mm-toastInfo .mm-icon{color:var(--dsw-alias-brand-primary,#4f8cff)}
.mm-toastText{flex:1;min-width:0}
.mm-toastClose{flex:0 0 auto;width:22px;height:22px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:14px;line-height:22px;cursor:pointer}
.mm-toastClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mm-loading{display:flex;align-items:center;justify-content:center;min-height:180px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
@media (prefers-reduced-motion: reduce){
  .mm-railFill,.mm-thumb,.mm-tickDot,.mm-tickLabel,.mm-chip{transition:none}
}
`

    // ── Helpers ─────────────────────────────────────────────────────────────
    const EMPTY_STATE = {
      current: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
    }

    const providerMeta = (id) => (LIMBS_META.providers && LIMBS_META.providers[id]) || {}
    const modelMeta = (providerId, modelId) =>
      (LIMBS_META.models && LIMBS_META.models[providerId + '/' + modelId]) || {}

    /** Localized provider caption; the account route has its own dictionary entry. */
    function providerName(group) {
      return group.id === 'deepseek-account' ? t('accountProvider') : group.name
    }

    function markLabel(providerId, group) {
      const meta = providerMeta(providerId)
      const mark = meta.mark
      if (typeof mark === 'string' && mark !== '') return mark.slice(0, 2)
      const source = (group && group.name) || providerId || '?'
      return source.slice(0, 1)
    }

    function statusOf(providerId, modelId) {
      const raw = modelMeta(providerId, modelId).status
      return raw === 'idle' || raw === 'warn' || raw === 'busy' ? raw : 'unknown'
    }

    function statusTitle(status) {
      return status === 'idle' ? t('statusIdle')
        : status === 'warn' ? t('statusWarn')
          : status === 'busy' ? t('statusBusy')
            : t('statusUnknown')
    }

    // ── Open Settings → Models ──────────────────────────────────────────────
    // No public client service opens the settings panel at a section: the shell
    // hands `openSettings(sectionId)` only to its `settings.launcher` occupant
    // (replacing it would shadow the account row), and the `settings.open`
    // keyboard command is dispatched from native input only on Windows/macOS
    // desktop. This drives the shell's own published markers instead and
    // silently does nothing if they disappear upstream.
    //
    // Two launcher layouts exist, so both are handled:
    //   A. the settings trigger is its own button — `aria-haspopup="dialog"`
    //      with a localized 设置 / Settings label (the fallback launcher);
    //   B. 设置 is a row inside the account menu — `aria-haspopup="menu"`
    //      labelled 账号菜单 / Account menu (the launcher this build ships,
    //      because the account row occupies `settings.launcher`).
    const SETTINGS_NAV_TEXT = LOCALE === 'zh' ? ['模型'] : ['Models']
    const SETTINGS_ITEM_TEXT = LOCALE === 'zh' ? ['设置'] : ['Settings']
    const ACCOUNT_MENU_LABEL = LOCALE === 'zh' ? '账号菜单' : 'Account menu'

    function clickModelsNavCell(panel) {
      const cells = panel.querySelectorAll('nav button')
      for (const cell of cells) {
        const label = String(cell.textContent || '').replace(/\s+/g, '')
        if (SETTINGS_NAV_TEXT.some((want) => label === want || label.startsWith(want))) {
          cell.click()
          return true
        }
      }
      return false
    }

    function settingsTrigger() {
      const labelled = (button) => button.getAttribute('aria-label') || ''
      const dialogButton = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'))
        .find((button) => {
          const label = labelled(button)
          return label.indexOf('设置') >= 0 || /settings/i.test(label)
        })
      if (dialogButton !== undefined) return dialogButton
      return Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
        .find((button) => labelled(button).indexOf(ACCOUNT_MENU_LABEL) >= 0)
    }

    /** True when `label` is the wanted row text, allowing a trailing shortcut hint. */
    function labelIsRow(label, want) {
      if (label === want) return true
      if (!label.startsWith(want)) return false
      // Only a shortcut hint may follow ("设置Ctrl+,", "Settings ⌘,"). Anything
      // longer means we matched a container, not the row.
      const rest = label.slice(want.length)
      return rest.length <= 2 || /^[A-Za-z0-9+⌘,，、\s]{1,10}$/.test(rest)
    }

    /** The 设置 row of an open account menu; the menu renders in a portal. */
    function clickSettingsMenuItem() {
      // Interactive elements only: a container <div> whose text starts with the
      // row text would otherwise be clicked instead of the row itself.
      const picker = document.querySelector('.limbs-menu')
      const candidates = Array.from(document.querySelectorAll(
        'button, [role="menuitem"], [role="button"], a',
      ))
      for (const row of candidates) {
        const label = String(row.textContent || '').replace(/\s+/g, '')
        if (!SETTINGS_ITEM_TEXT.some((want) => labelIsRow(label, want))) continue
        if (picker !== null && picker.contains(row)) continue
        if (row.getClientRects().length === 0 && row.offsetParent === null) continue
        row.click()
        return true
      }
      return false
    }

    function openModelsSettings() {
      try {
        const panel = document.querySelector('[data-shortcut-modal="settings"]')
        if (panel !== null && clickModelsNavCell(panel)) return
        const trigger = settingsTrigger()
        if (trigger === undefined) return
        trigger.click()

        // Poll instead of assuming one tick: layout B needs a second click for
        // the menu row, then the panel mounts asynchronously.
        let tries = 0
        let openedMenu = false
        const timer = window.setInterval(() => {
          tries += 1
          if (tries > 40) {
            window.clearInterval(timer)
            return
          }
          const next = document.querySelector('[data-shortcut-modal="settings"]')
          if (next !== null) {
            if (clickModelsNavCell(next)) window.clearInterval(timer)
            return
          }
          if (!openedMenu && clickSettingsMenuItem()) openedMenu = true
        }, 50)
      } catch { /* never break the picker over this */ }
    }

    /** Case-insensitive substring match over model name, provider name and description. */
    function matches(group, model, query) {
      if (query === '') return true
      const haystack = [
        model.name, model.id, model.description || '', group.name, group.id,
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    }

    function selectionOf(group, model, current) {
      const sameRoute = current !== null
        && current.provider === group.id
        && current.model === model.id
      const effort = sameRoute
        ? current.reasoningEffort
        : model.reasoning && model.reasoning.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
    }

    // ── Component ───────────────────────────────────────────────────────────
    function LimbsModelSeat(props) {
      const { locked, available, directory, load, select } = props

      const state = useSyncExternalStore(
        useCallback((fn) => (directory === null ? () => {} : directory.subscribe(fn)), [directory]),
        useCallback(() => (directory === null ? EMPTY_STATE : directory.getSnapshot()), [directory]),
        useCallback(() => EMPTY_STATE, []),
      )

      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [activeProvider, setActiveProvider] = useState(null)
      const [highlight, setHighlight] = useState(0)
      const [notice, setNotice] = useState(null)
      // User-resized menu height, remembered in localStorage (null = natural height).
      const [menuHeight, setMenuHeight] = useState(() => {
        try {
          const saved = Number(localStorage.getItem('dsh-limbs.menuHeight'))
          return Number.isFinite(saved) && saved >= 260 && saved <= 1600 ? Math.round(saved) : null
        } catch { return null }
      })

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const searchRef = useRef(null)
      const menuRef = useRef(null)
      const rowRefs = useRef({})
      // Set on open so the current model is highlighted as soon as its row exists,
      // and cleared as soon as the user narrows or re-tabs the list.
      const pickCurrentRef = useRef(false)

      const groups = state.groups || EMPTY_STATE.groups
      const failures = state.failures || EMPTY_STATE.failures
      const busy = state.status === 'selecting' || state.pending !== null

      const currentChoice = useMemo(() => {
        const current = state.current
        if (current === null) return null
        for (const group of groups) {
          if (group.id !== current.provider) continue
          for (const model of group.models) {
            if (model.id === current.model) return { group, model }
          }
        }
        return null
      }, [groups, state.current])

      // 模块二只读这一条能力记录：当前模型是否声明了最高推理档。
      // 独立键、失败静默，不改变座位本身的选择流程。
      useEffect(() => {
        if (currentChoice === null) return
        try {
          const efforts = currentChoice.model.reasoning && Array.isArray(currentChoice.model.reasoning.efforts)
            ? currentChoice.model.reasoning.efforts
            : []
          localStorage.setItem(MM_LAST_MODEL_KEY, JSON.stringify({
            name: currentChoice.model.name,
            provider: currentChoice.group.id,
            model: currentChoice.model.id,
            maxSupported: efforts.some((level) => level.id === 'max'),
            updatedAt: Date.now(),
          }))
        } catch { /* 隐私模式或存储已满：不影响选择器 */ }
      }, [currentChoice])

      const reasoning = currentChoice === null ? undefined : currentChoice.model.reasoning
      const effectiveEffort = state.current === null
        ? undefined
        : state.current.reasoningEffort ?? (reasoning && reasoning.defaultEffort)
      const effortLabel = reasoning === undefined
        ? (state.retainedEffort || undefined)
        : effectiveEffort === undefined
          ? t('providerDefault')
          : (reasoning.efforts.find((level) => level.id === effectiveEffort) || {}).name || String(effectiveEffort)

      const effortChoices = useMemo(() => {
        if (reasoning === undefined) return []
        const rows = []
        if (reasoning.defaultEffort === undefined) {
          rows.push({ key: 'provider-default', effort: undefined, label: t('providerDefault') })
        }
        for (const level of reasoning.efforts) {
          rows.push({ key: level.id, effort: level.id, label: level.name })
        }
        return rows
      }, [reasoning])

      const normalizedQuery = query.trim().toLowerCase()
      const searching = normalizedQuery !== ''

      /** Right-pane rows: flat when searching, grouped under the active provider otherwise. */
      const rows = useMemo(() => {
        const out = []
        if (searching) {
          for (const group of groups) {
            for (const model of group.models) {
              if (matches(group, model, normalizedQuery)) out.push({ group, model })
            }
          }
          return out
        }
        const tabId = activeProvider !== null && groups.some((group) => group.id === activeProvider)
          ? activeProvider
          : null
        for (const group of groups) {
          if (tabId !== null && group.id !== tabId) continue
          for (const model of group.models) out.push({ group, model })
        }
        return out
      }, [groups, searching, normalizedQuery, activeProvider])

      const tabs = useMemo(() => {
        const total = groups.reduce((sum, group) => sum + group.models.length, 0)
        return [{ id: null, name: t('allProviders'), count: total }].concat(
          groups.map((group) => ({ id: group.id, name: providerName(group), count: group.models.length })),
        )
      }, [groups])

      const activeTabId = activeProvider !== null && groups.some((group) => group.id === activeProvider)
        ? activeProvider
        : null

      // Keep the highlight inside the visible rows.
      useEffect(() => {
        if (rows.length === 0) {
          if (highlight !== 0) setHighlight(0)
          return
        }
        if (highlight > rows.length - 1) setHighlight(rows.length - 1)
      }, [rows.length, highlight])

      // When the menu opens, land the highlight on the current model once its
      // row is part of the list (the directory may still be loading).
      useEffect(() => {
        if (!open || !pickCurrentRef.current || rows.length === 0) return
        const current = state.current
        pickCurrentRef.current = false
        if (current === null) return
        const index = rows.findIndex((row) => row.group.id === current.provider && row.model.id === current.model)
        if (index >= 0) setHighlight(index)
      }, [open, rows, state.current])

      // Close on an outside pointer press.
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => { document.removeEventListener('mousedown', onDown) }
      }, [open])

      const close = useCallback((restoreFocus) => {
        setOpen(false)
        setNotice(null)
        setQuery('')
        setActiveProvider(null)
        if (restoreFocus && triggerRef.current !== null) triggerRef.current.focus()
      }, [])

      // Drag the top edge to grow/shrink the menu; the final height is remembered.
      const onResizeStart = useCallback((event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const startY = event.clientY
        const startHeight = menuRef.current !== null ? menuRef.current.offsetHeight : 360
        const clampHeight = (value) => Math.max(260, Math.min(Math.round(value), window.innerHeight - 120))
        const onMove = (moveEvent) => { setMenuHeight(clampHeight(startHeight + (startY - moveEvent.clientY))) }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setMenuHeight((final) => {
            try { localStorage.setItem('dsh-limbs.menuHeight', String(final)) } catch { /* private mode */ }
            return final
          })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [])

      const reload = useCallback(() => {
        setNotice(null)
        if (typeof load === 'function') load()
      }, [load])

      const show = useCallback(() => {
        setNotice(null)
        setQuery('')
        setHighlight(0)
        pickCurrentRef.current = true
        setOpen(true)
        reload()
      }, [reload])

      /** Submit one selection; resolves with whether the Host accepted it. */
      const choose = useCallback((group, model) => {
        if (typeof select !== 'function') return
        const sameRoute = state.current !== null
          && state.current.provider === group.id
          && state.current.model === model.id
        if (sameRoute) {
          close(true)
          return
        }
        setNotice(null)
        const selection = selectionOf(group, model, state.current)
        Promise.resolve(select(selection)).then((result) => {
          const accepted = result === true
            || result === undefined
            || (result !== null && typeof result === 'object' && result.ok === true)
          if (accepted) { close(true); return }
          const message = directory === null ? null : directory.getSnapshot().error
          setNotice(message ? t('failed') + '：' + message : t('failed'))
        }, () => { setNotice(t('failed')) })
      }, [select, state.current, directory, close])

      const chooseEffort = useCallback((effort) => {
        if (typeof select !== 'function' || state.current === null) return
        if ((state.current.reasoningEffort ?? (reasoning && reasoning.defaultEffort)) === effort) {
          close(true)
          return
        }
        setNotice(null)
        const selection = {
          provider: state.current.provider,
          model: state.current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        }
        Promise.resolve(select(selection)).then((result) => {
          const accepted = result === true
            || result === undefined
            || (result !== null && typeof result === 'object' && result.ok === true)
          if (accepted) { close(true); return }
          const message = directory === null ? null : directory.getSnapshot().error
          setNotice(message ? t('failed') + '：' + message : t('failed'))
        }, () => { setNotice(t('failed')) })
      }, [select, state.current, reasoning, directory, close])

      // Keep the highlighted row in view while navigating with the keyboard.
      useEffect(() => {
        if (!open) return
        const node = rowRefs.current[highlight]
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' })
        }
      }, [highlight, open])

      const move = useCallback((delta) => {
        setHighlight((index) => {
          if (rows.length === 0) return 0
          const next = (index + delta + rows.length) % rows.length
          return next
        })
      }, [rows.length])

      const acceptHighlighted = useCallback(() => {
        const row = rows[highlight]
        if (row === undefined) return
        choose(row.group, row.model)
      }, [rows, highlight, choose])

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close(true)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (rows.length === 0) return
          event.preventDefault()
          acceptHighlighted()
        }
      }, [close, move, rows.length, acceptHighlighted])

      if (!available || directory === null || directory === undefined) return null

      const modelLabel = currentChoice === null ? t('triggerEmpty') : currentChoice.model.name
      const triggerLabel = effortLabel === undefined ? modelLabel : modelLabel + ' · ' + effortLabel
      const failuresCount = failures.length
      const modelCount = groups.reduce((sum, group) => sum + group.models.length, 0)

      const renderRow = (group, model) => {
        const index = rows.findIndex((row) => row.group.id === group.id && row.model.id === model.id)
        const selected = state.current !== null
          && state.current.provider === group.id
          && state.current.model === model.id
        const status = statusOf(group.id, model.id)
        const meta = modelMeta(group.id, model.id)
        const discount = metaText(meta.discount)
        const multiplier = metaText(meta.multiplier)
        const showProvider = searching
        return h('button', {
          key: group.id + '/' + model.id,
          ref: (node) => { rowRefs.current[index] = node },
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': selected,
          className: 'limbs-row'
            + (selected ? ' limbs-rowSelected' : '')
            + (index === highlight ? ' limbs-rowActive' : ''),
          'data-provider-id': group.id,
          'data-model-id': model.id,
          title: model.name + (multiplier ? ' · ' + multiplier : ''),
          disabled: busy,
          tabIndex: -1,
          onMouseEnter: () => { if (index >= 0) setHighlight(index) },
          onClick: () => { choose(group, model) },
        },
          h('span', {
            className: 'limbs-dot limbs-dot-' + status,
            title: statusTitle(status),
            'aria-label': statusTitle(status),
          }),
          h('span', { className: 'limbs-mark', 'aria-hidden': true }, markLabel(group.id, group)),
          h('span', { className: 'limbs-nameCell' },
            h('span', { className: 'limbs-name' }, model.name),
            discount !== undefined ? h('span', { className: 'limbs-discount' }, discount) : null,
            showProvider ? h('span', { className: 'limbs-subName' }, providerName(group)) : null,
          ),
          multiplier !== undefined ? h('span', { className: 'limbs-multiplier' }, multiplier) : null,
          h('span', { className: 'limbs-check', 'aria-hidden': true }, selected ? '✓' : ''),
        )
      }

      const groupedRows = searching
        ? []
        : groups
          .filter((group) => activeTabId === null || group.id === activeTabId)
          .map((group) => ({
            group,
            models: group.models,
          }))

      return h('div', {
        ref: rootRef,
        className: 'limbs-root',
        onKeyDown: open ? onKeyDown : undefined,
      },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'limbs-trigger',
          title: triggerLabel,
          'aria-label': modelLabel,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: locked,
          onClick: () => { if (open) close(true); else show() },
        },
          h('span', { className: 'limbs-triggerMark', 'aria-hidden': true },
            h('span', { className: 'limbs-mark' }, markLabel(
              currentChoice === null ? '' : currentChoice.group.id,
              currentChoice === null ? null : currentChoice.group,
            ))),
          h('span', { className: 'limbs-triggerLabel' }, modelLabel),
          effortLabel !== undefined ? h('span', { className: 'limbs-triggerEffort' }, effortLabel) : null,
          busy
            ? h('span', { className: 'limbs-busy', 'aria-hidden': true })
            : h('span', { className: 'limbs-chevron' + (open ? ' limbs-chevronOpen' : ''), 'aria-hidden': true }, '▾'),
        ),

        open && h('div', {
          ref: menuRef,
          className: 'limbs-menu',
          role: 'menu',
          'aria-label': t('models'),
          'aria-busy': state.status === 'loading' || busy,
          onMouseDown: (event) => { event.preventDefault() },
          style: menuHeight !== null ? { height: menuHeight + 'px' } : undefined,
        },
          h('div', { className: 'limbs-resize', 'aria-hidden': true, onPointerDown: onResizeStart }),

          state.status === 'loading'
            ? h('div', { className: 'limbs-state' }, t('loading'))
            : null,
          state.error !== null && notice === null
            ? h('div', { className: 'limbs-error' },
              h('span', null, t('loadFailed') + '：' + String(state.error)),
              h('button', { type: 'button', className: 'limbs-retry', onClick: reload }, t('retry')),
            )
            : null,
          notice !== null
            ? h('div', { className: 'limbs-error' }, h('span', null, notice))
            : null,
          failures.map((failure) => h('div', { className: 'limbs-warning', key: failure.id },
            h('span', null, (failure.id === 'deepseek-account' ? t('accountProvider') : failure.name)
              + ' ' + t('groupFailed') + '：' + failure.message),
            h('button', { type: 'button', className: 'limbs-retry', onClick: reload }, t('retry')),
          )),

          h('div', { className: 'limbs-body' },
            h('div', { className: 'limbs-providers', role: 'tablist', 'aria-label': t('providers') },
              tabs.map((tab) => h('button', {
                key: tab.id === null ? '__all__' : tab.id,
                type: 'button',
                role: 'tab',
                'aria-selected': !searching && activeTabId === tab.id,
                className: 'limbs-provider' + (!searching && activeTabId === tab.id ? ' limbs-providerActive' : ''),
                onClick: () => {
                  pickCurrentRef.current = false
                  setQuery('')
                  setActiveProvider(tab.id)
                  setHighlight(0)
                },
              },
                h('span', { className: 'limbs-providerName' }, tab.name),
                h('span', { className: 'limbs-providerCount' }, String(tab.count)),
              )),
            ),

            h('div', {
              className: 'limbs-list',
              role: 'group',
              'aria-label': t('models'),
            },
              searching
                ? (rows.length === 0
                  ? h('div', { className: 'limbs-state' }, t('noMatch'))
                  : rows.map((row) => renderRow(row.group, row.model)))
                : (groupedRows.length === 0
                  ? h('div', { className: 'limbs-state' }, state.status === 'ready' ? t('noModels') : '')
                  : groupedRows.map((entry) => h(Fragment, { key: entry.group.id },
                    activeTabId === null
                      ? h('div', { className: 'limbs-groupLabel' }, providerName(entry.group))
                      : null,
                    entry.models.length === 0
                      ? h('div', { className: 'limbs-state' }, t('providerEmpty'))
                      : entry.models.map((model) => renderRow(entry.group, model)),
                  ))),
            ),
          ),

          reasoning !== undefined && effortChoices.length > 0 && !searching
            ? h('div', { className: 'limbs-effort' },
              h('span', { className: 'limbs-effortLabel' }, t('effort')),
              effortChoices.map((level) => h('button', {
                key: level.key,
                type: 'button',
                className: 'limbs-effortBtn' + (effectiveEffort === level.effort ? ' limbs-effortOn' : ''),
                onClick: () => { chooseEffort(level.effort) },
              }, level.label)),
            )
            : null,

          h('div', { className: 'limbs-footer' },
            h('span', { className: 'limbs-counts' },
              groups.length + ' ' + t('footerProviders') + ' · '
              + modelCount + ' ' + t('footerModels')
              + (failuresCount > 0 ? ' · ' + failuresCount + ' ' + t('footerFailures') : '')),
            h('button', {
              type: 'button',
              className: 'limbs-footerBtn',
              title: t('configHint'),
              onClick: () => { close(false); openModelsSettings() },
            }, t('config')),
            h('button', {
              type: 'button',
              className: 'limbs-footerBtn',
              onClick: reload,
            }, t('refresh')),
            h('span', { className: 'limbs-hint' }, t('keyHint')),
          ),

          h('div', { className: 'limbs-searchRow' },
            h('input', {
              ref: searchRef,
              type: 'text',
              role: 'searchbox',
              className: 'limbs-search',
              placeholder: t('search'),
              'aria-label': t('search'),
              value: query,
              onMouseDown: (event) => { event.stopPropagation() },
              onChange: (event) => {
                pickCurrentRef.current = false
                setQuery(event.target.value)
                setHighlight(0)
              },
            }),
            query !== ''
              ? h('button', {
                type: 'button',
                className: 'limbs-clear',
                'aria-label': t('clear'),
                onClick: () => {
                  pickCurrentRef.current = false
                  setQuery('')
                  setHighlight(0)
                  if (searchRef.current) searchRef.current.focus()
                },
              }, '✕')
              : null,
          ),
        ),
      )
    }

    // ── Settings store (UI shell only) ──────────────────────────────────────
    // Module 3 owns the real preference plumbing. Until then these three values
    // live in this browser only: writing them into the Host Config would claim
    // a contract that does not exist yet, and a user setting that silently does
    // nothing is worse than one visibly marked as a placeholder.
    const SETTINGS_KEY = 'dsh-limbs:settings'
    const CONTEXT_CHOICES = ['128K', '256K', '512K', '1M']
    const EFFORT_CHOICES = ['low', 'medium', 'high']

    function readSettings() {
      const fallback = { context: '128K', effort: 'medium', warn: true }
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw === null) return fallback
        const parsed = JSON.parse(raw)
        return {
          context: CONTEXT_CHOICES.includes(parsed.context) ? parsed.context : fallback.context,
          effort: EFFORT_CHOICES.includes(parsed.effort) ? parsed.effort : fallback.effort,
          warn: parsed.warn !== false,
        }
      } catch { return fallback }
    }

    let settingsState = readSettings()
    const settingsListeners = new Set()

    /** Merge a patch, persist it, and republish; a throwing storage keeps the value in memory. */
    function updateSettings(patch) {
      settingsState = Object.assign({}, settingsState, patch)
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsState)) } catch { /* private mode */ }
      for (const listener of Array.from(settingsListeners)) {
        try { listener() } catch (error) { console.error('[dsh-limbs] settings listener failed', error) }
      }
    }

    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    }

    function useSettings() {
      return useSyncExternalStore(subscribeSettings, () => settingsState, () => settingsState)
    }

    function effortLabel(id) {
      return id === 'low' ? t('effortLow') : id === 'high' ? t('effortHigh') : t('effortMedium')
    }

    // ── Settings section (`settings.section`) ───────────────────────────────
    function SettingsRow(props) {
      return h('div', { className: 'limbs-row2' },
        h('div', { className: 'limbs-rowText' },
          h('span', { className: 'limbs-rowLabel' }, props.label),
          props.hint === undefined ? null : h('span', { className: 'limbs-rowHint' }, props.hint),
        ),
        props.children,
      )
    }

    /** Hand-written switch: `role="switch"` with `aria-checked`, per the host's own control. */
    function LimbsSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'limbs-switch',
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'limbs-switchKnob' }))
    }

    function LimbsSettingsSection() {
      const settings = useSettings()
      return h('div', { className: 'limbs-page' },
        h('h2', { className: 'limbs-pageTitle' }, t('settingsNav')),
        h('p', { className: 'limbs-pageNote' }, t('settingsMock')),
        h('div', { className: 'limbs-group' },
          h(SettingsRow, { label: t('settingsContext'), hint: t('settingsContextHint') },
            h('select', {
              className: 'limbs-select',
              'aria-label': t('settingsContext'),
              value: settings.context,
              onChange: (event) => updateSettings({ context: event.target.value }),
            }, CONTEXT_CHOICES.map((choice) =>
              h('option', { key: choice, value: choice }, choice)))),
          h(SettingsRow, { label: t('settingsEffort'), hint: t('settingsEffortHint') },
            h('select', {
              className: 'limbs-select',
              'aria-label': t('settingsEffort'),
              value: settings.effort,
              onChange: (event) => updateSettings({ effort: event.target.value }),
            }, EFFORT_CHOICES.map((choice) =>
              h('option', { key: choice, value: choice }, effortLabel(choice))))),
          h(SettingsRow, { label: t('settingsWarn'), hint: t('settingsWarnHint') },
            h(LimbsSwitch, {
              checked: settings.warn,
              label: t('settingsWarn'),
              onChange: (next) => updateSettings({ warn: next }),
            })),
        ),
      )
    }

    // ════════════════════════════════════════════════════════════════════
    // 模块二 · 档位化交互与模型管理
    // ════════════════════════════════════════════════════════════════════
    //
    // 模块边界：
    //   - 这里只新增一个 settings.section（id limbs-model）与一条 Host 保存接口；
    //     模块一的模型座位、模块三的设置页/复盘面板都不改行为；
    //   - 模块一对本模块的唯一贡献是打开选择器时记住最近模型的 reasoning 能力，
    //     用于判断“最高档”是否可用；写的是独立 localStorage 键，失败静默。

    /** 模块二文案：全中文，品牌名与 K/M 单位除外。 */
    const MM = {
      nav: '模型管理',
      title: '模型管理',
      intro: '把推理挡位和上下文长度滑到顺手的位置，改动会立即保存。',
      currentModel: '当前模型',
      modelUnknown: '尚未选择模型',
      modelHint: '模型仍在输入框的模型选择器里切换；恢复默认不会改变当前模型。',
      reasoning: '推理挡位',
      reasoningHint: '从左到右，推理力度依次增强。键盘左右方向键可切换。',
      context: '上下文长度',
      contextHint: '从左到右，可容纳的上下文依次增加。',
      default: '默认',
      disabled: '不可用',
      offStatus: '推理已关闭',
      providerDefaultDetail: '服务商默认：使用服务商提供的默认强度',
      saving: '正在保存…',
      saved: '已保存',
      savedRemote: '已保存 · 服务端已同步',
      savedLocal: '已保存到本机',
      saveError: '保存失败，已恢复原设置',
      conflict: '设置已在其他设备更新，已同步最新设置',
      fallback: '当前档位不可用，已回退到默认档',
      migrated: '已迁移旧设置',
      reset: '恢复默认',
      resetTitle: '恢复默认设置？',
      resetBody: '只会恢复“推理挡位”和“上下文长度”，当前模型不会改变。',
      cancel: '取消',
      confirmReset: '确认恢复',
      resetDone: '已恢复默认设置',
      synced: '服务端已同步',
      localOnly: '仅本机保存',
      toastClose: '关闭提示',
      keyboardHint: '提示：聚焦轨道后，左右方向键切换档位；点击刻度也可以直接跳转。',
      modelReadonly: '只读',
      syncFailed: '服务端读取失败，已使用本机设置',
    }

    /** Host 不可用时的内置档位；与 lib/model-management/levels.js 保持一致。 */
    const MM_FALLBACK_LEVELS = {
      version: 2,
      showMax: true,
      defaults: { reasoning: 'provider-default', context: '600k' },
      reasoning: [
        { id: 'off', label: '关闭', shortLabel: '关闭', description: '不启用推理，回答更快、更省。', fullDescription: '关闭：完全关闭推理，只做快速回答。' },
        { id: 'provider-default', label: '服务商默认', shortLabel: '默认', description: '跟随服务商给出的默认强度。', fullDescription: '服务商默认：使用服务商提供的默认强度。', isDefault: true },
        { id: 'low', label: '低', shortLabel: '低', description: '轻量思考，适合日常问答。' },
        { id: 'medium', label: '中', shortLabel: '中', description: '平衡速度与质量，适合多数任务。' },
        { id: 'high', label: '高', shortLabel: '高', description: '更充分的推理，适合复杂问题。' },
        { id: 'max', label: '最高', shortLabel: '最高', description: '最强推理，耗时与花费更高。' },
      ],
      context: [
        { id: '300k', label: '300K', shortLabel: '300K', statusLabel: '精简', description: '精简，满足基础对话。' },
        { id: '600k', label: '600K', shortLabel: '600K', statusLabel: '适中', description: '适中，满足长文阅读。', isDefault: true },
        { id: '1m', label: '1M', shortLabel: '1M', statusLabel: '充足', description: '充足，满足超长文档处理。' },
      ],
    }

    const MM_CACHE_KEY = 'dsh-limbs:model-settings:v2'
    const MM_LEGACY_KEY = 'dsh-limbs:settings'
    const MM_MIGRATION_LOG_KEY = 'dsh-limbs:model-migration-log'
    const MM_LAST_MODEL_KEY = 'dsh-limbs:last-model'
    const MM_LEVEL_CONFIG_KEY = 'dsh-limbs:level-config'

    function mmReadJson(key) {
      try {
        const raw = localStorage.getItem(key)
        return raw === null ? null : JSON.parse(raw)
      } catch { return null }
    }

    function mmWriteJson(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 隐私模式 */ }
    }

    /** 最高档展示开关：默认展示；关闭后轨道上不再出现“最高”。 */
    function mmShowMax() {
      const raw = mmReadJson(MM_LEVEL_CONFIG_KEY)
      return raw === null || raw === undefined || raw.showMax !== false
    }

    /** 模块一写入的最近模型能力；没有就按“不支持最高档”处理，宁可置灰不撒谎。 */
    function mmLastModel() {
      const raw = mmReadJson(MM_LAST_MODEL_KEY)
      if (raw === null || typeof raw !== 'object') return null
      return {
        name: typeof raw.name === 'string' ? raw.name : '',
        maxSupported: raw.maxSupported === true,
      }
    }

    function mmLevelEnabled(level) {
      return level !== undefined && level !== null && typeof level.disabledReason !== 'string'
    }

    function mmDefaultLevel(levels) {
      if (!Array.isArray(levels) || levels.length === 0) return undefined
      return levels.find((level) => level.isDefault === true) || levels[0]
    }

    /** 校验 Host/内置档位表；结构不对就回退内置表，避免一个坏响应拖垮页面。 */
    function mmNormalizeLevels(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const reasoning = Array.isArray(raw.reasoning) ? raw.reasoning : null
      const context = Array.isArray(raw.context) ? raw.context : null
      if (reasoning === null || context === null || reasoning.length === 0 || context.length === 0) return null
      const valid = (level) => level !== null && typeof level === 'object'
        && typeof level.id === 'string' && typeof level.label === 'string' && typeof level.shortLabel === 'string'
      if (!reasoning.every(valid) || !context.every(valid)) return null
      return {
        version: Number(raw.version) || 2,
        showMax: raw.showMax !== false,
        defaults: raw.defaults !== null && typeof raw.defaults === 'object'
          ? raw.defaults
          : MM_FALLBACK_LEVELS.defaults,
        reasoning,
        context,
      }
    }

    /** 组装当前可用的档位：隐藏最高档 / 置灰最高档 / 上下文可用性。 */
    function mmBuildLevels(rawLevels, options = {}) {
      const base = mmNormalizeLevels(rawLevels) || MM_FALLBACK_LEVELS
      const showMax = options.showMax === undefined ? mmShowMax() : options.showMax !== false
      const lastModel = options.lastModel === undefined ? mmLastModel() : options.lastModel
      const maxSupported = options.maxSupported === undefined
        ? Boolean(lastModel && lastModel.maxSupported)
        : options.maxSupported === true
      const contextAvailable = options.contextAvailable || {}
      const reasoning = base.reasoning
        .filter((level) => level.id !== 'max' || showMax)
        .map((level) => (level.id === 'max' && !maxSupported
          ? { ...level, disabledReason: '当前服务商不支持最高档' }
          : { ...level }))
      const context = base.context.map((level) => (contextAvailable[level.id] === false
        ? { ...level, disabledReason: '当前配置不支持该上下文长度' }
        : { ...level }))
      return { ...base, reasoning, context, showMax }
    }

    // ── 旧配置映射（与 levels.js 同表；测试会逐条比对）────────────────────
    function mmMapLegacyReasoning(value) {
      if (value === undefined || value === null) return 'provider-default'
      const key = String(value).trim().toLowerCase()
      if (key === '') return 'provider-default'
      if (['off', 'none', 'no', 'false', '0', '关闭', '不启用'].includes(key)) return 'off'
      if (['default', 'provider-default', 'providerdefault', 'provider_default', 'auto', 'inherit', 'inherited', '服务商默认', '默认'].includes(key)) return 'provider-default'
      if (['low', 'min', 'minimal', '低'].includes(key)) return 'low'
      if (['medium', 'mid', 'normal', 'balanced', '中'].includes(key)) return 'medium'
      if (['high', '高'].includes(key)) return 'high'
      if (['max', 'maximum', 'highest', 'xhigh', '最高'].includes(key)) return 'max'
      return null
    }

    function mmMapLegacyContext(value) {
      if (value === undefined || value === null) return '600k'
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (value <= 0) return '600k'
        if (value <= 384000) return '300k'
        if (value <= 800000) return '600k'
        return '1m'
      }
      const key = String(value).trim().toLowerCase()
      if (key === '') return '600k'
      if (['300k', '300000', '300', '精简'].includes(key)) return '300k'
      if (['600k', '600000', '600', '适中', '默认', 'default'].includes(key)) return '600k'
      if (['1m', '1000k', '1000000', '1000000k', '充足', '超长'].includes(key)) return '1m'
      if (['128k', '128000', '131072', '256k', '256000', '262144'].includes(key)) return '300k'
      if (['512k', '512000', '524288'].includes(key)) return '600k'
      const numeric = Number(key.replace(/[^0-9.]/g, ''))
      if (!Number.isFinite(numeric) || numeric <= 0) return null
      const unit = /m$/.test(key) ? 1_000_000 : /k$/.test(key) ? 1_000 : 1
      return mmMapLegacyContext(numeric * unit)
    }

    function mmMigrateSettings(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const changes = []
      let fellBack = false
      const rawReasoning = source.reasoning ?? source.effort ?? source.reasoningEffort ?? source.reasoningLevel
      let reasoning = mmMapLegacyReasoning(rawReasoning)
      if (reasoning === null) {
        reasoning = MM_FALLBACK_LEVELS.defaults.reasoning
        fellBack = true
        changes.push({ field: 'reasoning', from: rawReasoning, to: reasoning, reason: '无法识别旧推理档位，已回退服务商默认' })
      } else if (rawReasoning !== undefined && rawReasoning !== null) {
        const legacyField = source.reasoning === undefined
        if (legacyField || String(rawReasoning) !== reasoning) {
          changes.push({ field: 'reasoning', from: rawReasoning, to: reasoning, reason: legacyField ? '旧推理字段已迁移' : '旧推理档位已迁移' })
        }
      }
      const rawContext = source.context ?? source.contextLength ?? source.contextWindow ?? source.contextSize
      let context = mmMapLegacyContext(rawContext)
      if (context === null) {
        context = MM_FALLBACK_LEVELS.defaults.context
        fellBack = true
        changes.push({ field: 'context', from: rawContext, to: context, reason: '无法识别旧上下文长度，已回退 600K' })
      } else if (rawContext !== undefined && rawContext !== null) {
        const legacyField = source.context === undefined
        if (legacyField || String(rawContext) !== context) {
          changes.push({ field: 'context', from: rawContext, to: context, reason: legacyField ? '旧上下文字段已迁移' : '旧上下文长度已迁移' })
        }
      }
      return {
        settings: {
          reasoning,
          context,
          ...(Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
            ? { updatedAt: Number(source.updatedAt) }
            : {}),
        },
        changes,
        fellBack,
      }
    }

    /** 当前设置收敛到可用档位；返回回退说明，调用方负责 Toast。 */
    function mmNormalizeSettings(settings, levels) {
      const source = settings !== null && typeof settings === 'object' ? settings : {}
      const enabled = (list) => (Array.isArray(list) ? list.filter(mmLevelEnabled) : [])
      const reasoningLevels = enabled(levels.reasoning)
      const contextLevels = enabled(levels.context)
      const reasoningIds = new Set(reasoningLevels.map((level) => level.id))
      const contextIds = new Set(contextLevels.map((level) => level.id))
      const changes = []
      let reasoning = source.reasoning
      let context = source.context
      if (!reasoningIds.has(reasoning)) {
        const next = mmDefaultLevel(reasoningLevels)
        reasoning = next === undefined ? MM_FALLBACK_LEVELS.defaults.reasoning : next.id
        changes.push({ field: 'reasoning', from: source.reasoning, to: reasoning, reason: '当前推理档位不可用，已回退可用默认档' })
      }
      if (!contextIds.has(context)) {
        const next = mmDefaultLevel(contextLevels)
        context = next === undefined ? MM_FALLBACK_LEVELS.defaults.context : next.id
        changes.push({ field: 'context', from: source.context, to: context, reason: '当前上下文长度不可用，已回退可用默认档' })
      }
      return { settings: { ...source, reasoning, context }, changes }
    }

    function mmNearestEnabled(levels, ratio) {
      if (!Array.isArray(levels) || levels.length === 0) return -1
      const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
      const raw = Math.round(clamped * (levels.length - 1))
      for (let distance = 0; distance < levels.length; distance += 1) {
        for (const index of [raw - distance, raw + distance]) {
          if (index >= 0 && index < levels.length && mmLevelEnabled(levels[index])) return index
        }
      }
      return -1
    }

    function mmMoveEnabled(levels, from, delta) {
      if (!Array.isArray(levels) || levels.length === 0) return -1
      let index = Number.isInteger(from) ? from : 0
      for (let step = 0; step < levels.length; step += 1) {
        index += delta
        if (index < 0 || index >= levels.length) return Math.max(0, Math.min(levels.length - 1, index - delta))
        if (mmLevelEnabled(levels[index])) return index
      }
      return from
    }

    function mmEdgeEnabled(levels, edge) {
      if (!Array.isArray(levels)) return -1
      const indices = edge === 'last'
        ? levels.map((_level, index) => index).reverse()
        : levels.map((_level, index) => index)
      return indices.find((index) => mmLevelEnabled(levels[index])) ?? -1
    }

    function mmAriaText(groupLabel, levels, index) {
      if (!Array.isArray(levels) || levels.length === 0 || index < 0 || index >= levels.length) {
        return groupLabel + '：不可用'
      }
      const level = levels[index]
      const reason = level.disabledReason === undefined ? '' : '，' + level.disabledReason
      return groupLabel + '：' + level.label + '，第 ' + (index + 1) + ' 档，共 ' + levels.length + ' 档' + reason
    }

    function mmReasoningSummary(settings, levels) {
      const level = (levels.reasoning || []).find((item) => item.id === settings.reasoning)
      if (settings.reasoning === 'off') return { text: '已关闭', detail: '推理已关闭', kind: 'off' }
      if (settings.reasoning === 'provider-default') {
        return { text: '服务商默认', detail: MM.providerDefaultDetail, kind: 'default' }
      }
      return {
        text: level === undefined ? '未知' : level.label,
        detail: level === undefined ? '当前推理档位未知' : level.description,
        kind: 'level',
      }
    }

    function mmContextSummary(settings, levels) {
      const level = (levels.context || []).find((item) => item.id === settings.context)
      if (level === undefined) return { text: '上下文长度未知', detail: '当前上下文长度未知', kind: 'unknown' }
      return {
        text: level.label + ' 上下文 · ' + level.statusLabel,
        detail: level.description,
        kind: 'level',
      }
    }

    function mmSettingsEqual(left, right) {
      return left !== null && right !== null && left !== undefined && right !== undefined
        && left.reasoning === right.reasoning && left.context === right.context
    }

    // ── 本地缓存 / 迁移日志 ──────────────────────────────────────────────
    function mmReadLocal() {
      const cached = mmReadJson(MM_CACHE_KEY)
      if (cached !== null && typeof cached === 'object' && typeof cached.reasoning === 'string' && typeof cached.context === 'string') {
        return { settings: cached, changes: [] }
      }
      const legacy = mmReadJson(MM_LEGACY_KEY)
      if (legacy === null || typeof legacy !== 'object') return { settings: null, changes: [] }
      const migrated = mmMigrateSettings(legacy)
      mmWriteJson(MM_CACHE_KEY, migrated.settings)
      if (migrated.changes.length > 0) {
        const previous = mmReadJson(MM_MIGRATION_LOG_KEY)
        const rows = Array.isArray(previous) ? previous.slice(-19) : []
        rows.push({ at: new Date().toISOString(), changes: migrated.changes })
        mmWriteJson(MM_MIGRATION_LOG_KEY, rows)
        try { console.info('[dsh-limbs] 旧档位配置已迁移', migrated.changes) } catch { /* ignore */ }
      }
      return { settings: migrated.settings, changes: migrated.changes }
    }

    // ── Host 保存接口客户端 ──────────────────────────────────────────────
    function mmBridge() {
      try {
        const bridge = globalThis.__DSH_LIMBS_BRIDGE__
        if (bridge !== null && typeof bridge === 'object'
          && typeof bridge.token === 'string' && typeof bridge.path === 'string') return bridge
      } catch { /* 无 bridge */ }
      return null
    }

    async function mmBridgeRequest(bridge, fetchImpl, method, body) {
      const response = await fetchImpl(bridge.path, {
        method,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-limbs-token': bridge.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let data = {}
      try { data = await response.json() } catch { data = {} }
      if (response.status === 409) return { conflict: true, ...data }
      if (!response.ok) {
        const message = typeof data.message === 'string' ? data.message : '服务端保存失败'
        const error = new Error(message)
        error.code = typeof data.code === 'string' ? data.code : 'save'
        throw error
      }
      return data
    }

    /**
     * 档位设置仓库：本地缓存 + 乐观更新 + 失败回滚 + 最新时间优先。
     * 单独导出（__test）以便离线测试注入假 bridge。
     */
    function createModelSettingsStore(ctx, options = {}) {
      const now = typeof options.now === 'function' ? options.now : () => Date.now()
      const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
      const bridge = options.bridge === undefined ? mmBridge() : options.bridge
      let canBridge = bridge !== null && bridge !== undefined && typeof fetchImpl === 'function'
      const initialLocal = options.localSettings === undefined ? mmReadLocal() : { settings: options.localSettings, changes: [] }
      const baseLevels = mmBuildLevels(options.levels, {
        showMax: options.showMax,
        maxSupported: options.maxSupported,
        lastModel: options.lastModel,
        contextAvailable: options.contextAvailable,
      })
      const initialRaw = initialLocal.settings === null
        ? { ...MM_FALLBACK_LEVELS.defaults, updatedAt: 0 }
        : { ...initialLocal.settings }
      const initialNormalized = mmNormalizeSettings(initialRaw, baseLevels)

      let levels = baseLevels
      let state = {
        settings: initialNormalized.settings,
        lastSaved: initialNormalized.settings,
        levels,
        status: 'ready',
        syncing: false,
        bridge: canBridge,
        account: canBridge ? 'current' : 'local',
        revision: 0,
        modelName: options.modelName === undefined ? ((mmLastModel() || {}).name || '') : options.modelName,
        toast: initialNormalized.changes.length > 0
          ? { kind: 'info', text: MM.fallback }
          : (initialLocal.changes.length > 0 ? { kind: 'info', text: MM.migrated } : null),
      }
      const listeners = new Set()
      let disposed = false
      let started = false
      let timer = null
      let chain = Promise.resolve()

      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { console.error('[dsh-limbs] 档位监听器失败', error) }
        }
      }
      const setState = (patch) => {
        state = { ...state, ...patch }
        emit()
      }
      const cache = (settings) => { mmWriteJson(MM_CACHE_KEY, settings) }

      const normalize = (settings) => mmNormalizeSettings(settings, levels)

      const adopt = (remote, toastText) => {
        if (remote !== null && remote !== undefined && remote.levels !== undefined) {
          const next = mmNormalizeLevels(remote.levels)
          if (next !== null) {
            levels = mmBuildLevels(next, {
              showMax: options.showMax,
              maxSupported: options.maxSupported,
              lastModel: options.lastModel,
              contextAvailable: options.contextAvailable,
            })
          }
        }
        const normalized = normalize(remote !== null && typeof remote === 'object' && remote.settings !== undefined ? remote.settings : remote)
        const nextSettings = normalized.settings
        cache(nextSettings)
        const toast = toastText !== undefined && toastText !== null
          ? { kind: 'info', text: toastText }
          : (normalized.changes.length > 0 ? { kind: 'info', text: MM.fallback } : state.toast)
        state = {
          ...state,
          settings: nextSettings,
          lastSaved: nextSettings,
          levels,
          status: 'ready',
          syncing: false,
          revision: remote !== null && typeof remote === 'object' && Number.isFinite(Number(remote.revision))
            ? Number(remote.revision)
            : state.revision,
          toast,
        }
        emit()
      }

      const save = (next, saveOptions = {}) => {
        const previousSaved = state.lastSaved
        const optimistic = { ...next, updatedAt: now() }
        setState({ settings: optimistic, status: 'saving' })
        if (!canBridge) {
          cache(optimistic)
          state = {
            ...state,
            settings: optimistic,
            lastSaved: optimistic,
            status: 'ready',
            toast: saveOptions.silent === true ? state.toast : null,
          }
          emit()
          return Promise.resolve({ ok: true })
        }
        return mmBridgeRequest(bridge, fetchImpl, 'PUT', {
          settings: optimistic,
          baseRevision: state.revision,
        }).then((result) => {
          if (result.conflict === true) {
            const remote = result
            const remoteUpdatedAt = Number(remote.settings && remote.settings.updatedAt) || 0
            if (remoteUpdatedAt > optimistic.updatedAt) {
              adopt(remote, MM.conflict)
              return { ok: true, conflict: true }
            }
            return mmBridgeRequest(bridge, fetchImpl, 'PUT', {
              settings: { ...optimistic, updatedAt: Math.max(optimistic.updatedAt, now()) },
              baseRevision: remote.revision,
            }).then((retried) => {
              if (retried.conflict === true) {
                adopt(retried, MM.conflict)
                return { ok: true, conflict: true }
              }
              adopt(retried)
              return { ok: true }
            })
          }
          adopt(result)
          return { ok: true }
        }, () => {
          state = {
            ...state,
            settings: previousSaved,
            status: 'error',
            toast: { kind: 'error', text: MM.saveError },
          }
          emit()
          return { ok: false }
        })
      }

      const change = (patch) => {
        const next = { ...state.settings, ...patch }
        if (mmSettingsEqual(next, state.settings)) return Promise.resolve({ ok: true, unchanged: true })
        // 乐观更新必须在调用栈内完成：组件下一帧就能看到新档位，
        // 保存失败再由 save() 回滚到 lastSaved。
        setState({ settings: { ...next, updatedAt: now() }, status: 'saving' })
        const run = () => save(next)
        chain = chain.then(run, run)
        return chain
      }

      const start = () => {
        if (disposed || started) return Promise.resolve()
        started = true
        if (!canBridge) return Promise.resolve()
        setState({ syncing: true })
        return mmBridgeRequest(bridge, fetchImpl, 'GET').then((remote) => {
          if (remote === null || typeof remote !== 'object' || remote.settings === undefined) {
            setState({ syncing: false })
            return
          }
          const remoteSettings = remote.settings
          const remoteUpdatedAt = Number(remoteSettings.updatedAt) || 0
          const localUpdatedAt = Number(state.settings.updatedAt) || 0
          // 首次升级：Host 还没有这条账号记录（updatedAt 0），而本机已有迁移
          // 出来的非默认设置。此时本机才是用户的选择，先推上去，不能被服务端
          // 的默认值覆盖。
          if (remoteUpdatedAt === 0
            && !mmSettingsEqual(state.settings, MM_FALLBACK_LEVELS.defaults)) {
            return save(state.settings, { silent: true })
          }
          if (remoteUpdatedAt > localUpdatedAt) {
            const hadLocal = state.settings !== null && localUpdatedAt > 0
            adopt(remote, hadLocal && !mmSettingsEqual(state.settings, remoteSettings) ? MM.conflict : null)
            return
          }
          if (localUpdatedAt > remoteUpdatedAt) {
            // 本机缓存更新：推上去；失败时按普通保存回滚。
            return save(state.settings, { silent: true })
          }
          adopt(remote)
        }, () => {
          // 读取失败就本机模式，避免每次改档位都撞同一个不可用接口。
          canBridge = false
          state = {
            ...state,
            syncing: false,
            bridge: false,
            account: 'local',
            toast: { kind: 'error', text: MM.syncFailed },
          }
          emit()
        })
      }

      const refresh = () => {
        if (disposed || !canBridge || state.status === 'saving') return Promise.resolve()
        return mmBridgeRequest(bridge, fetchImpl, 'GET').then((remote) => {
          if (remote === null || typeof remote !== 'object' || remote.settings === undefined) return
          const remoteUpdatedAt = Number(remote.settings.updatedAt) || 0
          const savedUpdatedAt = Number(state.lastSaved && state.lastSaved.updatedAt) || 0
          if (remoteUpdatedAt > savedUpdatedAt) {
            adopt(remote, !mmSettingsEqual(state.lastSaved, remote.settings) ? MM.conflict : null)
          }
        }, () => { /* 轮询失败不打扰用户 */ })
      }

      const restoreDefaults = () => change({
        ...MM_FALLBACK_LEVELS.defaults,
      }).then((result) => {
        if (result !== null && result !== undefined && result.ok === true) {
          setState({ toast: { kind: 'success', text: MM.resetDone } })
        }
        return result
      })

      const notify = (text, kind = 'info') => {
        setState({ toast: { kind, text } })
      }
      const dismissToast = () => { setState({ toast: null }) }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const getSnapshot = () => state
      const dispose = () => {
        disposed = true
        if (timer !== null) clearInterval(timer)
        timer = null
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          try { window.removeEventListener('focus', refresh) } catch { /* ignore */ }
        }
        listeners.clear()
      }

      if (canBridge) {
        timer = setInterval(refresh, 30_000)
        if (timer !== null && typeof timer.unref === 'function') timer.unref()
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          try { window.addEventListener('focus', refresh) } catch { /* ignore */ }
        }
      }

      return {
        getSnapshot,
        subscribe,
        start,
        refresh,
        change,
        restoreDefaults,
        notify,
        dismissToast,
        dispose,
      }
    }

    // ── 图标（16×16、1.6 线宽、currentColor；模块二统一使用）────────────
    const MM_ICON_PATHS = {
      model: ['M5 3.5h6v9H5z', 'M8 1.5V3.5', 'M8 12.5v2', 'M3.5 5.5h1.5', 'M11 5.5h1.5', 'M3.5 10.5h1.5', 'M11 10.5h1.5'],
      reasoning: ['M3 12.5V7', 'M8 12.5V4', 'M13 12.5V9'],
      context: ['M2.5 4.5h11', 'M2.5 8h11', 'M2.5 11.5h7'],
      check: ['M3.5 8.5l3 3 6-7'],
      warn: ['M8 2.2l6 11H2z', 'M8 6.2v4', 'M8 12h.01'],
      reset: ['M3 8a5 5 0 1 0 1.5-3.5', 'M3 3.5v3h3'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
    }

    function MmIcon(props) {
      const paths = MM_ICON_PATHS[props.name] || MM_ICON_PATHS.model
      return h('svg', {
        className: 'mm-icon' + (props.className === undefined ? '' : ' ' + props.className),
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    function MmSection(props) {
      return h('section', { className: 'mm-section' },
        h('div', { className: 'mm-sectionHead' },
          h(MmIcon, { name: props.icon }),
          h('div', { className: 'mm-sectionText' },
            h('h3', { className: 'mm-sectionTitle' }, props.title),
            props.hint === undefined ? null : h('p', { className: 'mm-sectionHint' }, props.hint),
          ),
        ),
        props.children,
      )
    }

    /**
     * 通用横向档位滑动组件：推理挡位与上下文长度共用。
     * 拖动吸附、点击刻度、Tab + 方向键、Focus Ring、禁用档跳过、
     * 默认标识、aria slider 语义与中文 aria-valuetext 都在这里。
     */
    function LevelSlider(props) {
      const levels = Array.isArray(props.levels) ? props.levels : []
      const value = props.value
      const selectedIndex = Math.max(0, levels.findIndex((level) => level.id === value))
      const [preview, setPreview] = useState(null)
      const dragRef = useRef(null)
      const rootRef = useRef(null)
      const fieldRef = useRef(null)
      const activeIndex = preview === null ? selectedIndex : preview
      const safeIndex = activeIndex < 0 || activeIndex >= levels.length ? selectedIndex : activeIndex
      const percent = levels.length <= 1 ? 0 : (safeIndex / (levels.length - 1)) * 100

      const commit = (index) => {
        const level = levels[index]
        if (level === undefined) return
        if (!mmLevelEnabled(level)) {
          if (typeof props.onDisabled === 'function') props.onDisabled(level.disabledReason || '该档位不可用')
          return
        }
        if (level.id !== value && typeof props.onChange === 'function') props.onChange(level.id)
      }

      const indexFromClientX = (clientX) => {
        const node = fieldRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function' || levels.length === 0) return -1
        const rect = node.getBoundingClientRect()
        if (!(rect.width > 0)) return -1
        return mmNearestEnabled(levels, (clientX - rect.left) / rect.width)
      }

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const index = indexFromClientX(event.clientX)
        if (index < 0) return
        dragRef.current = index
        setPreview(index)
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
        }
      }
      const onPointerMove = (event) => {
        if (dragRef.current === null) return
        const index = indexFromClientX(event.clientX)
        if (index >= 0 && index !== dragRef.current) {
          dragRef.current = index
          setPreview(index)
        }
      }
      const onPointerUp = () => {
        const index = dragRef.current
        dragRef.current = null
        setPreview(null)
        if (index !== null && index >= 0) commit(index)
      }
      const onPointerCancel = () => {
        dragRef.current = null
        setPreview(null)
      }

      const onKeyDown = (event) => {
        let index = -1
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = mmMoveEnabled(levels, selectedIndex, 1)
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = mmMoveEnabled(levels, selectedIndex, -1)
        else if (event.key === 'Home') index = mmEdgeEnabled(levels, 'first')
        else if (event.key === 'End') index = mmEdgeEnabled(levels, 'last')
        else return
        if (index < 0) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        commit(index)
      }

      const sliderAria = mmAriaText(props.groupLabel, levels, safeIndex)

      return h('div', {
        className: 'mm-slider',
        ref: rootRef,
        tabIndex: 0,
        role: 'slider',
        'aria-label': props.groupLabel,
        'aria-valuemin': 0,
        'aria-valuemax': Math.max(0, levels.length - 1),
        'aria-valuenow': safeIndex,
        'aria-valuetext': sliderAria,
        'aria-orientation': 'horizontal',
        'data-level-id': levels[safeIndex] === undefined ? '' : levels[safeIndex].id,
        onKeyDown,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
      },
        h('div', { className: 'mm-field', ref: fieldRef },
          h('div', { className: 'mm-rail' },
            h('div', { className: 'mm-railFill', style: { width: percent + '%' } }),
            h('div', { className: 'mm-thumb', style: { left: percent + '%' } }),
          ),
          levels.map((level, index) => {
            const left = levels.length <= 1 ? 0 : (index / (levels.length - 1)) * 100
            const disabled = !mmLevelEnabled(level)
            return h('button', {
              key: level.id,
              type: 'button',
              tabIndex: -1,
              className: 'mm-tick'
                + (index === safeIndex ? ' mm-tickActive' : '')
                + (disabled ? ' mm-tickDisabled' : ''),
              style: { left: left + '%' },
              title: disabled ? level.disabledReason : (level.fullDescription || level.description),
              'aria-label': mmAriaText(props.groupLabel, levels, index),
              'aria-disabled': disabled ? 'true' : 'false',
              onPointerDown: (event) => { event.stopPropagation() },
              onClick: (event) => {
                event.stopPropagation()
                if (disabled) {
                  if (typeof props.onDisabled === 'function') props.onDisabled(level.disabledReason || '该档位不可用')
                  return
                }
                commit(index)
              },
            },
              h('span', { className: 'mm-tickDot', 'aria-hidden': true }),
              h('span', { className: 'mm-tickLabel' }, level.shortLabel),
              level.isDefault === true && level.shortLabel !== MM.default
                ? h('span', { className: 'mm-tickDefault' }, MM.default)
                : null,
              index === safeIndex ? h('span', { className: 'mm-tickCheck', 'aria-hidden': true }, '✓') : null,
            )
          }),
        ),
      )
    }

    /** 二次确认：恢复默认只影响两个档位模块。 */
    function MmConfirm(props) {
      const confirmRef = useRef(null)
      useEffect(() => {
        if (typeof confirmRef.current?.focus === 'function') confirmRef.current.focus()
        const onKey = (event) => {
          if (event.key === 'Escape' && typeof props.onCancel === 'function') props.onCancel()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        }
        return undefined
      }, [props.onCancel])
      return h('div', {
        className: 'mm-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onCancel() },
      },
        h('div', {
          className: 'mm-dialog',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': 'mm-dialog-title',
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('h3', { id: 'mm-dialog-title', className: 'mm-dialogTitle' }, MM.resetTitle),
          h('p', { className: 'mm-dialogBody' }, MM.resetBody),
          h('div', { className: 'mm-dialogActions' },
            h('button', { type: 'button', className: 'mm-dialogCancel', onClick: props.onCancel }, MM.cancel),
            h('button', { ref: confirmRef, type: 'button', className: 'mm-dialogConfirm', onClick: props.onConfirm }, MM.confirmReset),
          ),
        ),
      )
    }

    function MmToast(props) {
      const toast = props.toast
      const icon = toast.kind === 'error' ? 'warn' : toast.kind === 'success' ? 'check' : 'check'
      return h('div', {
        className: 'mm-toast mm-toast' + (toast.kind === 'error' ? 'Error' : toast.kind === 'success' ? 'Success' : 'Info'),
        role: 'status',
        'aria-live': 'polite',
      },
        h(MmIcon, { name: icon }),
        h('span', { className: 'mm-toastText' }, toast.text),
        h('button', {
          type: 'button',
          className: 'mm-toastClose',
          'aria-label': MM.toastClose,
          onClick: props.onClose,
        }, '×'),
      )
    }

    /** 模块二页面组件；由 apply 注入 ctx（用于读最近模型与保存接口）。 */
    function makeModelManagementSection(ctx) {
      return function LimbsModelManagement() {
        const storeRef = useRef(null)
        if (storeRef.current === null) storeRef.current = createModelSettingsStore(ctx)
        const store = storeRef.current
        const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        const [confirming, setConfirming] = useState(false)

        useEffect(() => {
          store.start()
          return () => store.dispose()
        }, [store])

        useEffect(() => {
          if (state.toast === null) return undefined
          const timer = setTimeout(() => store.dismissToast(), 4200)
          return () => clearTimeout(timer)
        }, [state.toast, store])

        const settings = state.settings
        const levels = state.levels
        const reasoning = mmReasoningSummary(settings, levels)
        const context = mmContextSummary(settings, levels)
        const statusClass = state.status === 'saving' ? ' mm-statusSaving' : state.status === 'error' ? ' mm-statusError' : ''
        const statusText = state.status === 'saving'
          ? MM.saving
          : state.status === 'error'
            ? MM.saveError
            : state.bridge
              ? MM.savedRemote
              : MM.savedLocal

        return h('div', { className: 'mm-page' },
          h('header', { className: 'mm-head' },
            h('h2', { className: 'mm-title' }, MM.title),
            h('p', { className: 'mm-intro' }, MM.intro),
          ),

          h('section', { className: 'mm-hero', 'aria-label': MM.currentModel },
            h('div', { className: 'mm-heroTop' },
              h('span', { className: 'mm-eyebrow' }, MM.currentModel),
              h('span', { className: 'mm-sync' }, state.bridge ? MM.synced : MM.localOnly),
            ),
            h('p', { className: 'mm-heroModel' }, state.modelName === '' ? MM.modelUnknown : state.modelName),
            h('div', { className: 'mm-chips' },
              h('span', { className: 'mm-chip' + (reasoning.kind === 'off' ? ' mm-chipOff' : '') },
                reasoning.kind === 'off' ? MM.offStatus : '推理 · ' + reasoning.text),
              h('span', { className: 'mm-chip' }, context.text),
            ),
          ),

          h(MmSection, { icon: 'model', title: MM.currentModel, hint: MM.modelHint },
            h('div', { className: 'mm-row' },
              h(MmIcon, { name: 'model' }),
              h('div', { className: 'mm-rowText' },
                h('span', { className: 'mm-rowLabel' }, MM.currentModel),
                h('span', { className: 'mm-rowValue' }, state.modelName === '' ? MM.modelUnknown : state.modelName),
              ),
              h('span', { className: 'mm-sync' }, MM.modelReadonly),
            ),
          ),

          h(MmSection, { icon: 'reasoning', title: MM.reasoning, hint: MM.reasoningHint },
            h(LevelSlider, {
              groupLabel: MM.reasoning,
              levels: levels.reasoning,
              value: settings.reasoning,
              onChange: (id) => { void store.change({ reasoning: id }) },
              onDisabled: (reason) => store.notify(reason, 'error'),
            }),
            reasoning.kind === 'default'
              ? h('p', { className: 'mm-note' }, MM.providerDefaultDetail)
              : null,
            reasoning.kind === 'off'
              ? h('p', { className: 'mm-note mm-noteWarn' }, '推理已关闭：不会进行额外思考，回答更快、更省。')
              : null,
          ),

          h(MmSection, { icon: 'context', title: MM.context, hint: MM.contextHint },
            h(LevelSlider, {
              groupLabel: MM.context,
              levels: levels.context,
              value: settings.context,
              onChange: (id) => { void store.change({ context: id }) },
              onDisabled: (reason) => store.notify(reason, 'error'),
            }),
            h('p', { className: 'mm-note' }, context.text + '：' + context.detail),
          ),

          h('p', { className: 'mm-intro' }, MM.keyboardHint),

          h('footer', { className: 'mm-footer' },
            h('div', {
              className: 'mm-status' + statusClass,
              role: 'status',
              'aria-live': 'polite',
            },
              h('span', { className: 'mm-statusDot', 'aria-hidden': true }),
              h('span', null, statusText),
            ),
            h('button', {
              type: 'button',
              className: 'mm-reset',
              onClick: () => setConfirming(true),
            }, MM.reset),
          ),

          confirming
            ? h(MmConfirm, {
              onCancel: () => setConfirming(false),
              onConfirm: () => { setConfirming(false); void store.restoreDefaults() },
            })
            : null,
          state.toast === null
            ? null
            : h(MmToast, { toast: state.toast, onClose: () => store.dismissToast() }),
        )
      }
    }

    // ── Review panel (`sidebar.right.pane.tab`) ─────────────────────────────
    // The tab type's identity; the keyed body and title register under it.
    const LIMBS_REVIEW_ID = 'dsh-limbs'
    const LIMBS_REVIEW_KIND = 'limbs-review'

    // Placeholder catalogue: the real models come from `ctx.modelDirectories`
    // once module 3 wires the panel to the Session. Nothing here is read from
    // the Host, so no invented capability is shown.
    const MOCK_PANEL_MODELS = [
      { id: 'mock-a', name: 'DeepSeek V4 · 标准' },
      { id: 'mock-b', name: 'DeepSeek V4 · 长上下文' },
      { id: 'mock-c', name: 'DeepSeek V4 · 轻量' },
    ]

    const MOCK_REPORT = [
      '> 正在等待复盘数据…',
      '',
      '## 会话概览',
      '',
      '| 项目 | 数值 |',
      '| --- | --- |',
      '| 回合数 | 12 |',
      '| 工具调用 | 34 |',
      '| 估算花费 | ¥0.42 |',
      '| 上下文峰值 | 61% |',
      '',
      '### 值得留意的三点',
      '',
      '1. 第 3 轮重复读取了同一个文件。',
      '2. 第 7 轮两次工具调用可以合并。',
      '3. 收尾缺少一次完整验证。',
      '',
      '_以上为占位假数据，模块三接入后替换。_',
    ].join('\n')

    function LimbsReviewPanel() {
      const [model, setModel] = useState(MOCK_PANEL_MODELS[0].id)
      const [notice, setNotice] = useState(null)
      const [running, setRunning] = useState(false)
      // The placeholder settles on the next tick so the running state is
      // observable; the timer is cleared if the tab unmounts first.
      const timerRef = useRef(null)

      useEffect(() => () => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      }, [])

      const runReview = () => {
        // Placeholder trigger, per the agreed contract.
        console.log('触发复盘')
        setRunning(true)
        setNotice(null)
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          setRunning(false)
          setNotice(t('reviewTriggered'))
        }, 240)
      }

      return h('div', { className: 'limbs-panel' },
        h('div', { className: 'limbs-panelHead' },
          h('span', { className: 'limbs-panelLabel' }, t('reviewQuickModel')),
          h('div', { className: 'limbs-panelSelectRow' },
            h('select', {
              className: 'limbs-select',
              'aria-label': t('reviewQuickModel'),
              title: t('reviewQuickModelHint'),
              value: model,
              onChange: (event) => setModel(event.target.value),
            }, MOCK_PANEL_MODELS.map((entry) =>
              h('option', { key: entry.id, value: entry.id }, entry.name))),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'limbs-run',
          disabled: running,
          onClick: runReview,
        }, running ? t('reviewRunning') : t('reviewRun')),
        notice === null ? null : h('p', { className: 'limbs-runNotice' }, notice),
        h('div', { className: 'limbs-report' },
          h('div', { className: 'limbs-reportHead' },
            h('span', { className: 'limbs-reportTitle' }, t('reviewReport')),
            h('span', { className: 'limbs-badge' }, t('reviewMock')),
          ),
          h('pre', { className: 'limbs-md' }, MOCK_REPORT),
        ),
      )
    }

    function LimbsReviewTitle() {
      return h('span', null, t('reviewNav'))
    }

    /** Session-header entry that opens the panel; the panel itself is a tab type. */
    function LimbsReviewHeaderButton(props) {
      const openReview = props.openReview
      return h('button', {
        type: 'button',
        className: 'limbs-headerBtn',
        title: t('reviewGuideDesc'),
        onClick: () => {
          if (typeof openReview === 'function') openReview()
        },
      }, h('span', null, t('reviewEntry')))
    }

    // ── Plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return

      // Style is installed and removed with this plugin's run: disabling the
      // row leaves no <style> behind.
      //
      // The stale-element sweep is load-bearing: a hot reload replaces the
      // module but NOT the <style> a previous run appended. Guarding on
      // "already present, skip" therefore pinned the page to the OLD stylesheet
      // for the whole session, which is exactly how three CSS fixes in a row
      // appeared not to work. Always remove first, always install the current
      // text.
      ctx.effect(() => {
        const CSS_ID = 'dsh-limbs-styles'
        const previous = document.getElementById(CSS_ID)
        if (previous !== null) previous.remove()
        const element = document.createElement('style')
        element.id = CSS_ID
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          const installed = document.getElementById(CSS_ID)
          if (installed !== null) installed.remove()
        }
      }, 'dsh-limbs: styles')

      slots.inject('conversation.input.model', () => slots.register({
        name: 'conversation.input.model',
        // The stock occupant registers at 0; the slot core renders the LOWEST
        // priority, so -1 shadows it while its service and /model stay alive.
        priority: -1,
        registrant: 'dsh-limbs',
        // Children stay declared by the stock occupant; this seat only needs
        // the label/options slots to keep working for other plugins, and they
        // remain declared there while the stock plugin is mounted.
        inject: (sessionId) => {
          try {
            const models = ctx.get('modelDirectories')
            const sessions = ctx.get('sessions')
            if (models === undefined || models === null || typeof models.directoryFor !== 'function') {
              return { available: false, directory: null, load: () => {}, select: () => Promise.resolve(false) }
            }
            const directory = models.directoryFor(sessionId)
            const available = sessions !== undefined && sessions !== null
              && typeof sessions.subagentAddress === 'function'
              ? sessions.subagentAddress(sessionId) === undefined
              : true
            return {
              available,
              directory: directory.store,
              load: () => {
                if (!available) return
                Promise.resolve(directory.load()).catch(() => { /* surfaced on the store */ })
              },
              select: (selection) => available
                ? Promise.resolve(directory.select(selection)).then(
                  (result) => (result === undefined ? true : (result && result.ok !== false)),
                  () => false,
                )
                : Promise.resolve(false),
            }
          } catch (error) {
            console.error('[dsh-limbs] seat inject failed', error)
            return { available: false, directory: null, load: () => {}, select: () => Promise.resolve(false) }
          }
        },
      }, LimbsModelSeat))

      // ── Settings tab (`settings.section`) ─────────────────────────────────
      // A fresh id adds a page beside the shipped ones; reusing a shipped id
      // would replace that page instead. `limbs` collides with nothing.
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'limbs',
        // Between plugins (15) and agent-presets (20): configuration pages stay
        // together, ahead of the roster-style ones.
        order: 18,
        // A thunk is re-read on every projection, so the nav follows the locale
        // of the next render without re-registering on every language change.
        label: () => t('settingsNav'),
      }, LimbsSettingsSection)), 'dsh-limbs: settings section')

      // ── 模块二 · 模型管理（设置分区）────────────────────────────────────
      // 新 id = 新格子：不顶掉官方的「模型」页，也不改模块三的「Limbs 配置」。
      // order 11 紧挨官方模型页（10），新手在设置里第一眼就能看到。
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'limbs-model',
        order: 11,
        label: () => MM.nav,
      }, makeModelManagementSection(ctx))), 'dsh-limbs: model management section')

      // ── Review panel (right Sidebar tab type) ────────────────────────────
      // Stage one declares what the page type IS; stage two supplies the body
      // under the same `id`. The Sidebar persists a tab record, not the props
      // its opener passed, so both stages are static on purpose.
      const sidebarTabs = ctx.get('sidebarRightTabs')
      const sidebarRight = ctx.get('sidebarRight')
      if (sidebarTabs !== undefined && sidebarTabs !== null
        && typeof sidebarTabs.register === 'function') {
        ctx.effect(() => sidebarTabs.register({
          id: LIMBS_REVIEW_ID,
          kind: LIMBS_REVIEW_KIND,
          priority: 'extension',
          title: () => t('reviewNav'),
          // A page type: opened by kind, so it recognizes no resource address
          // and `patterns` stays unset.
          guide: [{
            id: LIMBS_REVIEW_KIND,
            order: 45,
            title: () => t('reviewNav'),
            description: () => t('reviewGuideDesc'),
          }],
        }), 'dsh-limbs: right-sidebar tab type')

        ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: LIMBS_REVIEW_ID,
        }, LimbsReviewPanel)), 'dsh-limbs: right-sidebar tab body')

        ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: LIMBS_REVIEW_ID,
        }, LimbsReviewTitle)), 'dsh-limbs: right-sidebar tab title')

        // Open through the public navigation face; `openTab` throws for a kind
        // nothing registered, which the guard above already ruled out.
        const openReview = () => {
          try {
            if (sidebarRight !== undefined && sidebarRight !== null
              && typeof sidebarRight.openTab === 'function') {
              sidebarRight.openTab(LIMBS_REVIEW_KIND)
            }
          } catch (error) {
            console.error('[dsh-limbs] openTab failed', error)
          }
        }

        ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register({
          name: 'conversation.session.header.utilities',
          id: 'limbs-review',
          // Between the schedule catalog (-5) and dsh-unlag (29).
          order: 28,
          inject: () => ({ openReview }),
        }, LimbsReviewHeaderButton)), 'dsh-limbs: header entry')
      }
    }

    return {
      inject,
      apply,
      // 离线测试入口：不暴露给运行时 UI，只挂一个纯对象供 .dev 测试读取。
      __test: {
        MM,
        MM_FALLBACK_LEVELS,
        mmBuildLevels,
        mmMigrateSettings,
        mmNormalizeSettings,
        mmNearestEnabled,
        mmMoveEnabled,
        mmEdgeEnabled,
        mmAriaText,
        mmReasoningSummary,
        mmContextSummary,
        createModelSettingsStore,
        LevelSlider,
        makeModelManagementSection,
      },
    }
  },
})
