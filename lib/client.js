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
        // Settings tab + review panel. The values live in the Host Config of
        // the `dsh-limbs` entry; the panel runs the real analyzer through
        // `/limbs-review`.
        settingsNav: 'Limbs 配置',
        settingsEffort: '默认推理强度',
        settingsEffortHint: '新会话默认使用的推理档位',
        settingsWarn: '费用超限时提示',
        settingsWarnHint: '估算花费超过预算时在对话里提醒',
        settingsLoading: '正在读取 DSH 配置…',
        settingsHostMissing: 'DSH 还没提供这条插件的配置（Host 侧首次加载 Config schema 需要重启一次 DSH），这几项暂时改不了。',
        settingsReadOnly: '当前 profile 不接受写入，这几项暂时改不了。',
        settingsSaved: '已保存到 DSH 配置',
        settingsFailed: '保存失败，已恢复上一次的值',
        reviewNav: 'Limbs 复盘',
        reviewEntry: '复盘',
        reviewQuickModel: '快捷切换模型',
        reviewQuickModelHint: '本次会话使用的模型',
        reviewNoModels: '读不到模型目录',
        reviewRun: '一键复盘',
        reviewRunning: '正在复盘…',
        reviewFailed: '复盘失败：',
        reviewEmpty: '还没有报告。点「一键复盘」跑一次本会话的复盘。',
        reviewReport: '复盘报告',
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
        // Settings tab + review panel. The values live in the Host Config of
        // the `dsh-limbs` entry; the panel runs the real analyzer through
        // `/limbs-review`.
        settingsNav: 'Limbs settings',
        settingsEffort: 'Default reasoning effort',
        settingsEffortHint: 'Reasoning level a new Session starts from',
        settingsWarn: 'Warn when cost exceeds the limit',
        settingsWarnHint: 'Call out an estimated spend over budget in the chat',
        settingsLoading: 'Reading DSH configuration…',
        settingsHostMissing: 'DSH does not serve this plugin entry\'s configuration yet (the Host must reload its Config schema once), so these fields cannot change for now.',
        settingsReadOnly: 'This profile does not accept writes, so these fields cannot change yet.',
        settingsSaved: 'Saved to DSH configuration',
        settingsFailed: 'Save failed; the previous value is back',
        reviewNav: 'Limbs review',
        reviewEntry: 'Review',
        reviewQuickModel: 'Quick model switch',
        reviewQuickModelHint: 'Model used by this Session',
        reviewNoModels: 'No model directory',
        reviewRun: 'Run review',
        reviewRunning: 'Reviewing…',
        reviewFailed: 'Review failed: ',
        reviewEmpty: 'No report yet. Press "Run review" to analyze this Session.',
        reviewReport: 'Review report',
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
.limbs-md{flex:1;min-height:120px;padding:10px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-family:inherit;font-size:12px;line-height:18px;overflow:auto;word-break:break-word}
/* Rendered-report element styles: only what the smallest reasonable Markdown
   subset needs to be legible — spacing and weight, all on theme tokens. The
   renderer escapes the whole document first, so everything below sees only
   tags it emitted itself. */
.limbs-md h1,.limbs-md h2,.limbs-md h3,.limbs-md h4,.limbs-md h5{margin:10px 0 4px;font-size:13px;line-height:20px;font-weight:600}
.limbs-md h1,.limbs-md h2{font-size:14px;line-height:22px}
.limbs-md p{margin:4px 0}
.limbs-md ul,.limbs-md ol{margin:4px 0;padding-left:20px}
.limbs-md li{margin:2px 0}
.limbs-md code{padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);font-family:inherit;font-size:11px;line-height:16px}
.limbs-md pre{margin:6px 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f4f6f8);overflow:auto;white-space:pre-wrap}
.limbs-md pre code{padding:0;background:none;font-size:11px;line-height:16px}
.limbs-md table{margin:6px 0;border-collapse:collapse;font-size:11px;line-height:16px}
.limbs-md th,.limbs-md td{padding:3px 6px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));text-align:left}
.limbs-md blockquote{margin:6px 0;padding:2px 8px;border-left:2px solid var(--dsw-alias-border-l2,#c8ccd1);color:var(--dsw-alias-label-secondary,#57606a)}
.limbs-md hr{margin:8px 0;border:none;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.limbs-reportEmpty{flex:1;min-height:120px;margin:0;padding:10px;border:0.5px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}
.limbs-headerBtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.limbs-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.limbs-headerBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2,#c8ccd1)}

/* ── 模块二 · 档位化模型管理 ────────────────────────────────────────────
   A single centered column (400–640px) that stays readable without
   hunting through nested menus. Colors stay on theme tokens; text
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
  .mm-chip{transition:none}
}
`

    // ── 模块八 · 独立 style 块 ──────────────────────────────────────────────
    //
    // 独立 id + 独立文本：模块一的样式表一个字都不动（改它能改坏选择器座位）。
    // ⚠️ 这是模板字符串：注释里不许出现反引号（踩坑录 #8；.dev 测试会断言）。
    const M8_STYLE_ID = 'dsh-limbs-m8-styles'
    const M8_CSS = `.m8-page{display:flex;flex-direction:column;gap:14px;min-width:0;height:100%;max-height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;padding:16px 18px 24px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.m8-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.m8-title{margin:0;font-size:17px;line-height:24px;font-weight:600}
.m8-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px;max-width:60ch}
.m8-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}
.m8-cardTitle{margin:0;font-size:13px;line-height:20px;font-weight:600}
.m8-note{margin:0;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:18px}
.m8-error{margin:0;color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12px;line-height:18px}
.m8-empty{margin:0;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}
.m8-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;min-width:0}
.m8-cell{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.m8-cellLabel{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}
.m8-cellValue{font-size:12px;line-height:18px}
.m8-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}
.m8-btn{flex:0 0 auto;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:26px;cursor:pointer}
.m8-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.m8-btn:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#57606a);outline-offset:2px}
.m8-projects{display:flex;flex-direction:column;gap:8px;min-width:0}
.m8-project{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background 120ms ease,border-color 120ms ease}
.m8-project:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));border-color:var(--dsw-alias-border-l4,#9aa0a6)}
.m8-project:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#57606a);outline-offset:2px}
.m8-projectHead{display:flex;align-items:center;gap:8px;min-width:0}
.m8-projectTitle{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:600}
.m8-projectBadge{flex:0 0 auto;padding:0 6px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:999px;color:var(--dsw-alias-label-secondary,#57606a);font-size:10px;line-height:16px}
.m8-projectBadgeError{border-color:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e)}
.m8-projectPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8b949e);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px}
.m8-projectStats{display:flex;flex-wrap:wrap;gap:14px;min-width:0}
.m8-stat{display:flex;align-items:baseline;gap:5px;min-width:0}
.m8-statLabel{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}
.m8-statValue{font-variant-numeric:tabular-nums;font-size:12px;line-height:18px;font-weight:600}
.m8-projectFlags{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.m8-flagLabel{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}
.m8-flag{padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 10%,transparent);color:var(--dsw-alias-label-secondary,#57606a);font-size:10px;line-height:16px}
.m8-flagOn{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 18%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37)}
.m8-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:6px 0}
.m8-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.m8-rowLabel{font-size:12px;line-height:18px}
.m8-rowHint{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}
.m8-rowControl{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.m8-source{padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;line-height:16px}
.m8-sourceProject{color:var(--dsw-alias-brand-primary,#4f8cff)}
.m8-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:none;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 34%,transparent);cursor:pointer;transition:background 120ms ease}
.m8-switch:disabled{cursor:default;opacity:.5}
.m8-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary,#1f2328)}
.m8-switch:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#57606a);outline-offset:2px}
.m8-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform 120ms ease,background 120ms ease}
.m8-switch[aria-checked="true"] .m8-switchKnob{background:var(--dsw-alias-bg-base,#fff);transform:translateX(16px)}
.m8-input{flex:1;min-width:0;height:28px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:26px;box-sizing:border-box}
.m8-input:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#57606a);outline-offset:1px}
.m8-manual{display:flex;align-items:center;gap:10px;min-width:0;padding-top:4px}
.m8-tableWrap{min-width:0;overflow:auto;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1)}
.m8-table{width:100%;border-collapse:collapse;font-size:11px;line-height:16px}
.m8-table th{position:sticky;top:0;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary,#57606a);text-align:left;font-weight:600;white-space:nowrap}
.m8-table td{padding:5px 8px;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));vertical-align:top}
.m8-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:nowrap}
.m8-status{white-space:nowrap}
.m8-status-done{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.m8-status-doing{color:var(--dsw-alias-brand-primary,#4f8cff)}
.m8-status-blocked{color:var(--dsw-alias-state-error-primary,#cf222e)}
.m8-status-dropped{color:var(--dsw-alias-label-tertiary,#8b949e)}
.m8-pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,#1f2328);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.m8-detail{min-width:0}
.m8-detailHead{display:flex;align-items:center;gap:10px;min-width:0}
.m8-detailTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px}
.m8-detailBlock{display:flex;flex-direction:column;gap:6px;min-width:0;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.m8-blockTitle{margin:0;font-size:12px;line-height:18px;font-weight:600}
.m8-select{flex:0 0 auto;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2,#c8ccd1);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:26px}
.m8-inputNarrow{flex:0 1 220px}
.m8-devlogs{display:flex;flex-direction:column;gap:4px;min-width:0;max-height:260px;overflow:auto}
.m8-devlog{display:flex;align-items:baseline;gap:10px;min-width:0;padding:5px 8px;border:0.5px solid transparent;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.m8-devlog:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.m8-devlogOpen{border-color:var(--dsw-alias-border-l4,#9aa0a6);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.m8-devlogId{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px}
.m8-devlogTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.m8-devlogBody{display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:4px}
.m8-devlogBodyHead{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
@media (prefers-reduced-motion: reduce){
  .m8-project,.m8-switch,.m8-switchKnob{transition:none}
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

    // ── Settings store (Host Config of the `dsh-limbs` entry) ───────────────
    // The three values are declared once in `lib/host.js` (LIMBS_CONFIG_SPEC)
    // and persisted in this profile's `cordis.patch.yml` under the `dsh-limbs`
    // entry. The Client reads and writes them through the shipped
    // `ctx.configForms` service — it keeps no copy of its own.
    //
    // The old `localStorage['dsh-limbs:settings']` is DROPPED on purpose: there
    // are no real users yet, so a migration would be work invented for nobody.
    const LIMBS_SETTINGS_ENTRY = 'dsh-limbs'
    const LIMBS_SETTINGS_DEFAULTS = { effort: 'provider-default', costWarn: true }

    /**
     * 取官方 `ConfigForm`（**本插件条目**的那一份），不是 `configForms` 服务本身。
     * 服务缺席、或该条目没被 Host 提供时返回 null。
     */
    function limbsConfigForms(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return null
      try {
        const forms = ctx.get('configForms')
        if (forms === null || forms === undefined || typeof forms.get !== 'function') return null
        const form = forms.get(LIMBS_SETTINGS_ENTRY)
        return form !== null && form !== undefined && typeof form.getSnapshot === 'function'
          && typeof form.subscribe === 'function' && typeof form.set === 'function'
          ? form
          : null
      } catch { return null }
    }

    /**
     * 把 Host 传来的设置节收敛成可信结构：字段缺失或取值不认识都退回默认。
     * 枚举与 `lib/model-management/levels.js` 同表（离线测试逐项比对）。
     *
     * @param {unknown} section
     * @returns {{effort:string, costWarn:boolean}}
     */
    function limbsNormalizeSettings(section) {
      const source = section !== null && typeof section === 'object' ? section : {}
      const effortIds = MM_FALLBACK_LEVELS.reasoning.map((level) => level.id)
      return {
        effort: effortIds.includes(source.effort) ? source.effort : LIMBS_SETTINGS_DEFAULTS.effort,
        costWarn: source.costWarn !== false,
      }
    }

    /** A档位的中文/英文短名（与档位表同一份，别另造一张）。 */
    function levelLabel(table, id) {
      const level = table.find((item) => item.id === id)
      return level === undefined ? String(id) : level.label
    }

    /**
     * 设置页的数据源：官方 `ConfigForm` 的只读快照 + 一次乐观写入。
     * `form` 为 null 时（profile 没挂 configForms）页面只读、并说明原因。
     *
     * @param {object|null} form
     * @returns {{read:() => object, write: (field: string, value: unknown) => Promise<boolean>, subscribe: (fn: () => void) => () => void}}
     */
    function createLimbsSettingsStore(form) {
      let optimistic = null
      // `useSyncExternalStore` 拿 `read` 当 getSnapshot：数据没变时必须返回
      // **同一个引用**，否则 React 判为「一直在变」→ 无限重渲染
      // （`Maximum update depth exceeded`，整个设置分区白屏）。快照按字段
      // 比对后复用，只有真变了才换新对象。
      let cached = null
      const listeners = new Set()
      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { console.error('[dsh-limbs] settings listener failed', error) }
        }
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        const offForm = form === null ? () => {} : form.subscribe(emit)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) offForm()
        }
      }
      const read = () => {
        const snapshot = form === null ? null : form.getSnapshot()
        const value = limbsNormalizeSettings(snapshot === null || snapshot === undefined ? null : snapshot.value)
        const settings = optimistic === null ? value : { ...value, ...optimistic }
        const status = form === null ? 'unavailable' : (snapshot.status || 'loading')
        const writable = form !== null && snapshot.writable === true
        if (cached !== null
          && cached.status === status
          && cached.writable === writable
          && cached.settings.effort === settings.effort
          && cached.settings.costWarn === settings.costWarn) return cached
        cached = { settings, status, writable }
        return cached
      }
      const write = (field, value) => {
        if (form === null || !(form.getSnapshot().writable === true)) return Promise.resolve(false)
        optimistic = { ...(optimistic === null ? {} : optimistic), [field]: value }
        emit()
        return Promise.resolve(form.set(field, value))
          .then((accepted) => {
            optimistic = null
            emit()
            return accepted === true
          })
          .catch(() => {
            optimistic = null
            emit()
            return false
          })
      }
      return { read, write, subscribe }
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

    /**
     * Settings page. Reads the live Host Config through the store above; the
     * note line only appears when the surface cannot read or write it, so a
     * healthy page carries no apology text.
     *
     * @param {{store: object}} props
     */
    function LimbsSettingsSection(props) {
      const store = props.store
      const [notice, setNotice] = useState(null)
      const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read)
      const settings = snapshot.settings
      const blockedNote = snapshot.status === 'unavailable'
        ? t('settingsHostMissing')
        : (snapshot.status === 'ready' && !snapshot.writable ? t('settingsReadOnly') : null)
      const save = (field, value) => {
        setNotice(null)
        void store.write(field, value).then((accepted) => {
          setNotice(accepted ? t('settingsSaved') : t('settingsFailed'))
        })
      }
      return h('div', { className: 'limbs-page' },
        h('h2', { className: 'limbs-pageTitle' }, t('settingsNav')),
        blockedNote === null ? null : h('p', { className: 'limbs-pageNote' }, blockedNote),
        snapshot.status === 'loading' ? h('p', { className: 'limbs-pageNote' }, t('settingsLoading')) : null,
        notice === null ? null : h('p', { className: 'limbs-pageNote' }, notice),
        h('div', { className: 'limbs-group' },
          h(SettingsRow, { label: t('settingsEffort'), hint: t('settingsEffortHint') },
            h('select', {
              className: 'limbs-select',
              'aria-label': t('settingsEffort'),
              value: settings.effort,
              disabled: !snapshot.writable,
              onChange: (event) => save('effort', event.target.value),
            }, MM_FALLBACK_LEVELS.reasoning.map((level) =>
              h('option', { key: level.id, value: level.id }, levelLabel(MM_FALLBACK_LEVELS.reasoning, level.id))))),
          h(SettingsRow, { label: t('settingsWarn'), hint: t('settingsWarnHint') },
            h(LimbsSwitch, {
              checked: settings.costWarn,
              label: t('settingsWarn'),
              onChange: (next) => save('costWarn', next),
            })),
        ),
      )
    }

    /** 组装设置页：把官方 ConfigForm 解析出来，解析不到就交给只读版本。 */
    function makeLimbsSettingsSection(ctx) {
      const store = createLimbsSettingsStore(limbsConfigForms(ctx))
      return (props) => h(LimbsSettingsSection, { ...props, store })
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
      intro: '推理挡位在输入框的模型选择器底部切换；这里只读展示当前模型。',
      currentModel: '当前模型',
      modelUnknown: '尚未选择模型',
      modelHint: '模型仍在输入框的模型选择器里切换；恢复默认不会改变当前模型。',
      reasoning: '推理挡位',
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
      resetBody: '只会恢复“推理挡位”，当前模型不会改变。',
      cancel: '取消',
      confirmReset: '确认恢复',
      resetDone: '已恢复默认设置',
      synced: '服务端已同步',
      localOnly: '仅本机保存',
      toastClose: '关闭提示',
      modelReadonly: '只读',
      syncFailed: '服务端读取失败，已使用本机设置',
    }

    /** Host 不可用时的内置档位；与 lib/model-management/levels.js 保持一致。 */
    const MM_FALLBACK_LEVELS = {
      version: 2,
      showMax: true,
      defaults: { reasoning: 'provider-default' },
      reasoning: [
        { id: 'off', label: '关闭', shortLabel: '关闭', description: '不启用推理，回答更快、更省。', fullDescription: '关闭：完全关闭推理，只做快速回答。' },
        { id: 'provider-default', label: '服务商默认', shortLabel: '默认', description: '跟随服务商给出的默认强度。', fullDescription: '服务商默认：使用服务商提供的默认强度。', isDefault: true },
        { id: 'low', label: '低', shortLabel: '低', description: '轻量思考，适合日常问答。' },
        { id: 'medium', label: '中', shortLabel: '中', description: '平衡速度与质量，适合多数任务。' },
        { id: 'high', label: '高', shortLabel: '高', description: '更充分的推理，适合复杂问题。' },
        { id: 'max', label: '最高', shortLabel: '最高', description: '最强推理，耗时与花费更高。' },
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
      if (reasoning === null || reasoning.length === 0) return null
      const valid = (level) => level !== null && typeof level === 'object'
        && typeof level.id === 'string' && typeof level.label === 'string' && typeof level.shortLabel === 'string'
      if (!reasoning.every(valid)) return null
      return {
        version: Number(raw.version) || 2,
        showMax: raw.showMax !== false,
        defaults: raw.defaults !== null && typeof raw.defaults === 'object'
          ? raw.defaults
          : MM_FALLBACK_LEVELS.defaults,
        reasoning,
      }
    }

    /** 组装当前可用的档位：隐藏最高档 / 置灰最高档。 */
    function mmBuildLevels(rawLevels, options = {}) {
      const base = mmNormalizeLevels(rawLevels) || MM_FALLBACK_LEVELS
      const showMax = options.showMax === undefined ? mmShowMax() : options.showMax !== false
      const lastModel = options.lastModel === undefined ? mmLastModel() : options.lastModel
      const maxSupported = options.maxSupported === undefined
        ? Boolean(lastModel && lastModel.maxSupported)
        : options.maxSupported === true
      const reasoning = base.reasoning
        .filter((level) => level.id !== 'max' || showMax)
        .map((level) => (level.id === 'max' && !maxSupported
          ? { ...level, disabledReason: '当前服务商不支持最高档' }
          : { ...level }))
      return { ...base, reasoning, showMax }
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
      return {
        settings: {
          reasoning,
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
      const reasoningIds = new Set(reasoningLevels.map((level) => level.id))
      const changes = []
      let reasoning = source.reasoning
      if (!reasoningIds.has(reasoning)) {
        const next = mmDefaultLevel(reasoningLevels)
        reasoning = next === undefined ? MM_FALLBACK_LEVELS.defaults.reasoning : next.id
        changes.push({ field: 'reasoning', from: source.reasoning, to: reasoning, reason: '当前推理档位不可用，已回退可用默认档' })
      }
      return { settings: { ...source, reasoning }, changes }
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

    function mmSettingsEqual(left, right) {
      return left !== null && right !== null && left !== undefined && right !== undefined
        && left.reasoning === right.reasoning
    }

    // ── 本地缓存 / 迁移日志 ──────────────────────────────────────────────
    function mmReadLocal() {
      const cached = mmReadJson(MM_CACHE_KEY)
      if (cached !== null && typeof cached === 'object' && typeof cached.reasoning === 'string') {
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

    /** 二次确认：恢复默认只影响推理档位模块。 */
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
    /**
     * 人类入口 = 模块三自己的 `/limbs-review` 命令。命令 handler 里调的就是
     * `lib/host.js` 的 `reviewConversation()`（与工具
     * `analyze_conversation_efficiency` 同一条实现）。面板不自己算报告，只跑
     * 这条命令、画它返回的 Markdown —— 一个操作一处实现，三条入口不会漂移。
     */
    const LIMBS_REVIEW_COMMAND = '/limbs-review'

    // ── Markdown（极小子集：先转义，再套结构）──────────────────────────────
    // 报告是模型侧工具链生成的文本，里面会出现工具参数原文（路径、命令、甚至
    // 用户内容），所以**整篇先转义成 HTML 实体**，再在转义后的文本上识别结构。
    // 任何内容都进不了裸 HTML —— 这是不引第三方库换来的唯一正确做法。
    //
    // 支持的块：标题 / 代码块 / 表格 / 有序无序列表（两级）/ 引用 / 分隔线；
    // 支持的行内：粗体 / 斜体 / 行内代码。刻意不做完整解析器：链接、图片、
    // 嵌套表格都不认，够画这份报告就行。

    /** HTML 实体转义。顺序必须先 `&`，否则后面的 `&lt;` 会被二次转义。 */
    function escapeHtml(text) {
      return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    // 行内代码先摘出来占位，免得里面的 `*` `_` 被当成强调标记。
    const INLINE_OPEN = '\u0000'
    const INLINE_CLOSE = '\u0001'

    /** 行内标记：输入是**已转义**的文本，输出是安全的 HTML 片段。 */
    function renderInline(escaped) {
      const codes = []
      let text = escaped.replace(/\u0000/gu, '').replace(/\u0001/gu, '')
      text = text.replace(/`([^`\n]+)`/g, (_match, inner) => {
        codes.push(inner)
        return INLINE_OPEN + String(codes.length - 1) + INLINE_CLOSE
      })
      text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // 斜体只在词边界上认，避免把 `top_n` 这类标识符吃掉一半。
      text = text.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
      text = text.replace(new RegExp(INLINE_OPEN + '(\\d+)' + INLINE_CLOSE, 'g'), (_match, index) =>
        '<code>' + codes[Number(index)] + '</code>')
      return text
    }

    /** `1.` / `-` / `*` 打头的列表行；返回缩进量、序号与正文。 */
    function parseListLine(line) {
      const match = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line)
      if (match === null) return null
      return {
        indent: match[1].length >= 2 ? 1 : 0,
        ordered: match[3] !== undefined,
        text: match[4],
      }
    }

    /** 表格分隔行，如 `| --- | :--: |`。 */
    function isTableDivider(line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) return false
      const cells = trimmed.replace(/^\||\|$/g, '').split('|')
      return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
    }

    function tableCells(line) {
      return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
    }

    /**
     * Markdown → HTML 字符串（已转义）。块级状态机，逐行往下走。
     *
     * @param {string} markdown
     * @returns {string} 安全 HTML
     */
    function renderMarkdown(markdown) {
      const escaped = escapeHtml(markdown)
      const lines = escaped.split(/\r?\n/)
      const out = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]

        if (line.trim() === '') { index += 1; continue }

        // 代码块
        if (line.trim().startsWith('```')) {
          index += 1
          const body = []
          while (index < lines.length && !lines[index].trim().startsWith('```')) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          out.push('<pre><code>' + body.join('\n') + '</code></pre>')
          continue
        }

        // 分隔线（`---` 或 `***`，单独一行）
        if (/^(\s*)(---|\*\*\*|\*\s\*\s\*)\s*$/.test(line)) {
          out.push('<hr>')
          index += 1
          continue
        }

        // 标题
        const heading = /^(#{1,5})\s+(.*)$/.exec(line.trim())
        if (heading !== null) {
          const level = heading[1].length
          out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>')
          index += 1
          continue
        }

        // 表格：表头行 + 分隔行
        if (line.trim().startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
          const head = tableCells(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].trim().startsWith('|')) {
            rows.push(tableCells(lines[index]))
            index += 1
          }
          out.push('<table><thead><tr>'
            + head.map((cell) => '<th>' + renderInline(cell) + '</th>').join('')
            + '</tr></thead><tbody>'
            + rows.map((row) => '<tr>'
              + row.map((cell) => '<td>' + renderInline(cell) + '</td>').join('')
              + '</tr>').join('')
            + '</tbody></table>')
          continue
        }

        // 引用：连续的 `>` 行
        if (line.trim().startsWith('&gt;')) {
          const body = []
          while (index < lines.length && lines[index].trim().startsWith('&gt;')) {
            body.push(lines[index].trim().replace(/^&gt;\s*/u, ''))
            index += 1
          }
          out.push('<blockquote>' + renderInline(body.join(' ')) + '</blockquote>')
          continue
        }

        // 列表：缩进两级，续行并进上一条
        if (parseListLine(line) !== null) {
          let level = -1
          let tag = ''
          const items = []
          while (index < lines.length) {
            const item = parseListLine(lines[index])
            if (item === null) break
            if (item.indent !== level || !tag.startsWith(item.ordered ? 'ol' : 'ul')) {
              if (level !== -1) items.push('</' + tag + '>')
              level = item.indent
              tag = item.ordered ? 'ol' : 'ul'
              items.push('<' + tag + '>')
            }
            items.push('<li>' + renderInline(item.text) + '</li>')
            index += 1
          }
          if (level !== -1) items.push('</' + tag + '>')
          out.push(items.join(''))
          continue
        }

        // 段落：连续的非空行并成一段
        const paragraph = []
        while (index < lines.length
          && lines[index].trim() !== ''
          && !lines[index].trim().startsWith('```')
          && !lines[index].trim().startsWith('|')
          && !lines[index].trim().startsWith('&gt;')
          && !/^(\s*)(---|\*\*\*)\s*$/.test(lines[index])
          && /^(#{1,5})\s+/.exec(lines[index].trim()) === null
          && parseListLine(lines[index]) === null) {
          paragraph.push(lines[index].trim())
          index += 1
        }
        out.push('<p>' + renderInline(paragraph.join(' ')) + '</p>')
      }
      return out.join('')
    }

    /**
     * 面板的属性面：会话目录与「跑一次复盘」，由 `inject(sessionId)` 提供。
     *
     * ⚠️ `ctx.modelDirectories.directoryFor(sessionId)` 返回的是
     * `{ store, load(), select() }`（模块一的座位就读这一份），订阅与快照在
     * `.store` 上 —— 不是目录对象本身。这里把两半拆开给面板，别让面板猜。
     */
    function limbsReviewFace(ctx) {
      const models = ctx !== undefined && ctx !== null && typeof ctx.get === 'function'
        ? ctx.get('modelDirectories')
        : undefined
      return (sessionId) => {
        let directory = null
        if (models !== undefined && models !== null && typeof models.directoryFor === 'function') {
          try { directory = models.directoryFor(sessionId) } catch { directory = null }
        }
        if (directory !== null && (directory.store === undefined || directory.store === null)) directory = null
        return {
          sessionId,
          store: directory === null ? null : directory.store,
          select: directory === null ? null : (selection) => directory.select(selection),
          load: directory === null ? null : () => directory.load(),
          runReview: () => limbsReviewRequest(ctx, sessionId),
        }
      }
    }

    /** 取客户端 Remote 的 commands 命名空间（官方人类命令通道）。 */
    function limbsRemoteCommands(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return null
      try {
        const direct = ctx.get('remote.commands')
        if (direct !== null && direct !== undefined && typeof direct.execute === 'function') return direct
      } catch { /* 服务不在或未就绪 */ }
      try {
        const remote = ctx.get('remote')
        if (remote !== null && remote !== undefined && remote.commands !== undefined
          && typeof remote.commands.execute === 'function') return remote.commands
      } catch { /* 同上 */ }
      return null
    }

    /**
     * 通过官方命令通道跑一次 `/limbs-review`，返回报告的 Markdown。
     * 失败一律抛带可读原因的 Error（面板只负责显示）。
     *
     * @param {object} ctx
     * @param {string} sessionId
     * @returns {Promise<string>}
     */
    function limbsReviewRequest(ctx, sessionId) {
      const commands = limbsRemoteCommands(ctx)
      if (commands === null) return Promise.reject(new Error('Host 的命令通道未挂载（remote.commands 缺席）'))
      if (typeof sessionId !== 'string' || sessionId === '') {
        return Promise.reject(new Error('没有会话标识，无法复盘'))
      }
      return Promise.resolve(commands.execute(sessionId, LIMBS_REVIEW_COMMAND, []))
        .then((response) => {
          if (response === null || response === undefined || response.ok !== true) {
            const error = response !== null && response !== undefined ? response.error : undefined
            throw new Error(error !== null && error !== undefined && typeof error.message === 'string'
              ? error.message
              : '复盘命令没有被接受')
          }
          const execution = response.value
          if (execution === null || execution === undefined) throw new Error('复盘命令未注册或语法不合法')
          const result = execution.result !== null && execution.result !== undefined ? execution.result : {}
          const text = typeof result.text === 'string' ? result.text : ''
          if (result.kind !== 'success') throw new Error(text !== '' ? text : '复盘失败')
          return text
        })
    }

    /** 模型下拉的选项：真目录，按提供商分组；目录缺席时给一条说明。 */
    function reviewModelOptions(snapshot) {
      const groups = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.groups)
        ? snapshot.groups
        : []
      const current = snapshot !== null && snapshot !== undefined ? snapshot.current : null
      const value = current === null || current === undefined
        ? null
        : current.provider + '/' + current.model
      return { groups, current, value }
    }

    function LimbsReviewPanel(props) {
      // `store` 是 modelDirectories 的快照/订阅面；`select` 是同一目录的写入面。
      const store = props.store === undefined ? null : props.store
      const selectFn = props.select === undefined ? null : props.select
      const runReview = props.runReview
      const state = useSyncExternalStore(
        useCallback((listener) => (store === null ? () => {} : store.subscribe(listener)), [store]),
        useCallback(() => (store === null ? EMPTY_STATE : store.getSnapshot()), [store]),
        useCallback(() => EMPTY_STATE, []),
      )
      const { groups, value } = reviewModelOptions(state)
      const [report, setReport] = useState(null)
      const [notice, setNotice] = useState(null)
      const [running, setRunning] = useState(false)

      const chooseModel = (choice) => {
        if (selectFn === null) return
        for (const group of groups) {
          for (const model of group.models) {
            if (group.id + '/' + model.id !== choice) continue
            setNotice(null)
            void Promise.resolve(selectFn(selectionOf(group, model, state.current)))
              .then((ok) => { if (ok === false) setNotice(t('failed')) })
              .catch(() => { setNotice(t('failed')) })
            return
          }
        }
      }

      const startReview = () => {
        if (running) return
        setRunning(true)
        setNotice(null)
        void Promise.resolve()
          .then(() => (typeof runReview === 'function' ? runReview() : Promise.reject(new Error('面板没拿到复盘入口'))))
          .then((markdown) => {
            setReport(String(markdown ?? ''))
            setRunning(false)
          })
          .catch((error) => {
            setRunning(false)
            setNotice(t('reviewFailed') + (error instanceof Error ? error.message : String(error)))
          })
      }

      const reportHtml = report === null ? null : renderMarkdown(report)

      const modelOptions = []
      if (store === null || groups.length === 0) {
        modelOptions.push(h('option', { key: 'none', value: '' }, t('reviewNoModels')))
      } else {
        if (value === null) modelOptions.push(h('option', { key: 'none', value: '' }, t('triggerEmpty')))
        for (const group of groups) {
          modelOptions.push(h('optgroup', { key: group.id, label: providerName(group) },
            group.models.map((model) => h('option', {
              key: group.id + '/' + model.id,
              value: group.id + '/' + model.id,
            }, model.name))))
        }
      }

      return h('div', { className: 'limbs-panel' },
        h('div', { className: 'limbs-panelHead' },
          h('span', { className: 'limbs-panelLabel' }, t('reviewQuickModel')),
          h('div', { className: 'limbs-panelSelectRow' },
            h('select', {
              className: 'limbs-select',
              'aria-label': t('reviewQuickModel'),
              title: t('reviewQuickModelHint'),
              value: value === null ? '' : value,
              disabled: store === null || groups.length === 0,
              onChange: (event) => chooseModel(event.target.value),
            }, modelOptions),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'limbs-run',
          disabled: running,
          onClick: startReview,
        }, running ? t('reviewRunning') : t('reviewRun')),
        notice === null ? null : h('p', { className: 'limbs-runNotice' }, notice),
        h('div', { className: 'limbs-report' },
          h('div', { className: 'limbs-reportHead' },
            h('span', { className: 'limbs-reportTitle' }, t('reviewReport')),
          ),
          reportHtml === null
            ? h('p', { className: 'limbs-reportEmpty' }, t('reviewEmpty'))
            : h('div', { className: 'limbs-md', dangerouslySetInnerHTML: { __html: reportHtml } }),
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

    // ════════════════════════════════════════════════════════════════════
    // 模块八 · 项目管理（UI 层）
    // ════════════════════════════════════════════════════════════════════
    //
    // 一级页（总管理）：项目列表 + 全局默认（只读）+ 每个项目的摘要。
    // 二级页（单项目）：该项目的账表 / §3.3 待拍板 / STATUS 快照 / devlog 列表
    //                   + 该项目自己的配置（覆盖全局默认，含热注入开关）。
    //
    // 数据全部来自 Host 的两条窄接口（`lib/handoff-config.js`），Client 不直接
    // 读写任何文件；令牌由 Host 启动时随机生成，经 index 注入到
    // `window.__DSH_LIMBS_HANDOFF__`（与模块二的 `__DSH_LIMBS_BRIDGE__` 分开）。
    //
    // 为什么 UI 在本文件而不是另开一个运行时文件：DSH 的客户端模块系统一个
    // 包只认 `exports["./client"]` 一个 bundle（`dsh.client` 没有 entry 字段，
    // 浏览器端的 require 只解析已注册的包名、不支持相对路径）。所以这里**新增
    // 一节 + 一个新 style 块**，而不是继续把东西塞进 Host 的 handoff.js。

    const M8 = {
      nav: '项目',      title: '项目管理',
      subtitle: '这里的每个项目＝DSH 的一个工作区；配置落点是该项目自己的 .dsh/handoff.yaml。',
      globalDefaults: '全局默认（只读 · 来自代码 DEFAULT_HANDOFF_CONFIG）',
      globalDefaultsHint: '全局默认不在 UI 里改；想改哪个项目，就去那个项目页写项目级覆盖。',
      projects: '项目',
      projectsEmpty: '还没有任何工作区。先在侧栏新建一个工作区，或手填一个项目路径。',
      manualPath: '手填路径',
      manualPathHint: '绝对路径；目录里要有 PROJECT_PROGRESS.md 或 .dsh/handoff.yaml',
      open: '打开',
      refresh: '刷新',
      back: '返回项目列表',
      loading: '正在读取…',
      workspaceMissing: 'Host 没提供工作区列表（workspaceRegistry 缺席），已退化为手填路径。',
      noBridge: 'Host 接口没挂上（webServer 缺席或插件未启用），项目管理暂时读不到数据。',
      requestFailed: '请求失败',
      ledgerRows: '账表',
      rows: '行',
      latestCloseout: '最近收尾',
      devlogCount: '冷存档',
      inject: '热注入',
      write: '真写',
      ledgerRecent: '账表滑窗',
      checkCommand: '自检命令',
      configTitle: '该项目自己的配置（覆盖全局默认）',
      configHint: '未显式覆盖的项继承全局默认；保存只写与默认不同的项。',
      sourceProject: '项目覆盖',
      sourceDefault: '继承默认',
      injectHint: '关掉后，这个项目的交接热层不再注入任何会话',
      writeHint: '真写仍要过四道闸：令牌 → 权限档 → 本开关 → 写后自检',
      ledgerHint: '热层注入时账表只取最近这么多行',
      checkHint: '留空 = 自动探测 check-docs.ps1 / check_docs.py',
      sourceProject: '项目覆盖',
      sourceDefault: '继承默认',
      saving: '正在保存…',
      saved: '已保存',
      saveFailed: '保存失败',
      injectOn: '开',
      injectOff: '关',
      ledgerText: '该项目的任务账（最近若干行）',
      ledgerEmpty: '账表为空。',
      pendingTitle: '§3.3 待拍板（全部，不剪）',
      pendingEmpty: '这条没有待拍板条目。',
      snapshotTitle: 'STATUS 实测快照',
      snapshotEmpty: '未取到 PROJECT_STATUS.md §二。',
      devlogs: 'devlog（按 id 倒序）',
      devlogsEmpty: 'Docs/devlog 里还没有冷存档。',
      devlogOpenHint: '点一条看正文',
      devlogBody: 'devlog 正文',
      close: '收起',
      checkedAt: '核对日期',
      notWorkspace: '未登记工作区（按项目形态放行）',
      closeoutPrefix: 't-',
      nothing: '—',
      // 按 **code** 分档说人话：路径问题说路径，令牌问题说令牌。
      // 一条笼统的「请求失败：没有权限…」会让排查的人先怀疑令牌，白跑一天。
      reasonForbidden: '令牌失效（Host 换了新一轮令牌，页面还拿着旧的）。重新点一次或刷新页面即可；这不是路径问题。',
      reasonCrossOrigin: '跨站来源被拒 —— 请求不是从这个 DSH 页面发出的。',
      reasonMissing: '路径问题：这个路径不存在，或不是一个目录。',
      reasonUnregistered: '路径问题：这个目录既不是已登记的 DSH 工作区，也没有 PROJECT_PROGRESS.md / .dsh/handoff.yaml。',
      reasonPath: '路径问题：path 必须是绝对路径，且不能含 ..。',
      reasonMethod: '这个接口只支持读取（GET），别的方法会被拒。',
    }

    /**
     * 把 Host 的 `code` 翻成**指向正确那条闸**的一句话。
     *
     * Host 侧两条接口的失败码（`lib/handoff-config.js`）：
     *   `forbidden`     → 令牌闸（403）
     *   `cross-origin`  → 同源闸（403）
     *   `path` / `missing` / `unregistered` → 路径准入闸（400）
     *   `method`        → 方法闸（405）
     * 未认得的 code 才退回服务端 message；两者拼起来，位数不多但能定位。
     *
     * @param {string} code
     * @param {unknown} [serverMessage]
     * @returns {string}
     */
    function m8FailureText(code, serverMessage) {
      const table = {
        forbidden: M8.reasonForbidden,
        'cross-origin': M8.reasonCrossOrigin,
        missing: M8.reasonMissing,
        unregistered: M8.reasonUnregistered,
        path: M8.reasonPath,
        method: M8.reasonMethod,
      }
      const reason = table[code]
      if (typeof reason === 'string') return `${reason}（${code}）`
      if (typeof serverMessage === 'string' && serverMessage !== '') return `${serverMessage}（${code}）`
      return `${M8.requestFailed}（${code}）`
    }

    /** 一级页的「项目」左栏图标；宿主会把 `{ size, active }` 注入进来。 */
    function LimbsProjectsIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      // 选中态由宿主的 .panelRow.panelActive 负责，这里只画字形。
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { display: 'block', color: 'currentColor' },
      },
      h('path', {
        d: 'M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.4h4.8a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round',
      }))
    }

    /** 模块八的令牌引导路由（页面全局缺席时用它换令牌，见 Host 侧的注释）。 */
    const M8_BRIDGE_ROUTE = '/limbs/handoff-bridge'

    /** 模块八的 Host 接口信息（index 注入给了就有；没给返回 null，由 store 去换）。 */
    function m8Bridge() {
      try {
        const bridge = globalThis.__DSH_LIMBS_HANDOFF__
        if (bridge !== null && typeof bridge === 'object'
          && typeof bridge.token === 'string'
          && typeof bridge.configPath === 'string'
          && typeof bridge.projectPath === 'string') return bridge
      } catch { /* 无 bridge */ }
      return null
    }

    /**
     * 模块八的数据仓库：列表 / 详情 / 保存 / 取 devlog。
     *
     * 单独导出（`__test`）以便离线测试注入假 bridge 与假 fetch；组件只读快照。
     */
    function createProjectsStore(options = {}) {
      const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
      const injected = options.bridge === undefined ? m8Bridge() : options.bridge
      const hasFetch = typeof fetchImpl === 'function'
      let bridge = injected !== null && injected !== undefined ? injected : null

      let state = {
        phase: hasFetch ? 'idle' : 'offline',
        list: [],
        defaults: null,
        fallback: null,
        error: null,
        selected: null,
        detail: null,
        devlog: null,
        saving: false,
        toast: null,
        loaded: false,
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { console.error('[dsh-limbs] 项目监听器失败', error) }
        }
      }
      const setState = (patch) => { state = { ...state, ...patch }; emit() }

      /**
       * 向 Host 换一次桥接信息（令牌 + 两条路由名），并把它记成当前桥接。
       *
       * 为什么需要第二手：桌面端可能不经过 Host 的 index 渲染，页面全局就是空的
       * —— 段 2 第一次真机目视碰到的正是这个（页面显示「Host 接口没挂上」，
       * 而 Host 的接口本身是活的）。换令牌的接口只回令牌与两条路由名。
       */
      async function fetchBridge() {
        if (!hasFetch) throw Object.assign(new Error(M8.noBridge), { code: 'offline' })
        let response
        try {
          response = await fetchImpl(M8_BRIDGE_ROUTE, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
        } catch (cause) {
          // 把浏览器拒绝的原因带出来 —— 只说「接口没挂上」在真机上没法定位。
          throw Object.assign(new Error(
            `${M8.noBridge}（桥接请求失败：${cause instanceof Error ? cause.message : String(cause)}）`),
          { code: 'offline' })
        }
        let data = {}
        try { data = await response.json() } catch { data = {} }
        if (!response.ok || typeof data.token !== 'string'
          || typeof data.configPath !== 'string' || typeof data.projectPath !== 'string') {
          throw Object.assign(new Error(
            `${M8.noBridge}（桥接返回 HTTP ${response.status}${typeof data.code === 'string' ? ' / ' + data.code : ''}）`),
          { code: 'offline' })
        }
        bridge = {
          token: data.token,
          configPath: data.configPath,
          projectPath: data.projectPath,
        }
        return bridge
      }

      async function ensureBridge() {
        if (bridge !== null) return bridge
        return fetchBridge()
      }

      /**
       * 发一次请求；**令牌失配时换一次令牌再重试一次**。
       *
       * 页面里这份令牌有两个来源（index 注入 / 桥接换回），Host 重载一次插件就换一个新的
       * （Host 侧是 `randomBytes` 现生成的），而页面不会因此重开 —— 症状是：
       * 一级页还挂着旧快照（看着挺正常），点进二级页，详情 GET 与配置 PUT **两条一起 403**
       * （2026-11-25 真机实测：旧令牌 → 403 `forbidden`，现行令牌 → 200）。
       *
       * 只对 `403 forbidden` 动手，其余 code 原样上抛：路径问题（`missing` / `unregistered`
       * / `path`）不是换令牌能救的。换回来的令牌**必须真的变了**才重试，不变就说明
       * Host 也认这个令牌，再发一次纯属浪费。
       */
      async function request(pathFor, init) {
        const send = async (target) => {
          const response = await fetchImpl(pathFor(target), {
            credentials: 'same-origin',
            ...init,
            headers: {
              'content-type': 'application/json',
              'x-limbs-token': target.token,
            },
          })
          let data = {}
          try { data = await response.json() } catch { data = {} }
          return { response, data }
        }

        let current = await ensureBridge()
        let attempt = await send(current)
        const failure = typeof attempt.data?.code === 'string' ? attempt.data.code : null
        if (attempt.response.ok === false && failure === 'forbidden') {
          const stale = current.token
          let renewed = null
          try { renewed = await fetchBridge() } catch { renewed = null }
          if (renewed !== null && renewed.token !== stale) {
            current = renewed
            attempt = await send(current)
          }
        }
        if (attempt.response.ok === false) {
          const code = typeof attempt.data?.code === 'string' ? attempt.data.code : 'request'
          const error = new Error(m8FailureText(code, attempt.data?.message))
          error.code = code
          error.status = attempt.response.status
          throw error
        }
        return attempt.data
      }

      const listPath = (target) => target.configPath
      const detailPath = (root) => (target) => target.projectPath + '?path=' + encodeURIComponent(root)
      const devlogPath = (root, id) => (target) => target.projectPath
        + '?path=' + encodeURIComponent(root) + '&id=' + encodeURIComponent(id)

      /** 把一次 PUT/GET 的响应合并进 list 里对应那一项（保持顺序、不重排）。 */
      const mergeListItem = (data) => {
        const root = typeof data?.path === 'string' ? data.path : null
        if (root === null) return state.list
        return state.list.map((item) => (item.root === root
          ? { ...item, config: data.config ?? item.config, configExists: data.configExists ?? item.configExists }
          : item))
      }

      return {
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        getSnapshot() { return state },
        get canBridge() { return bridge !== null },
        async loadList() {
          if (!hasFetch) { setState({ phase: 'offline' }); return state }
          setState({ phase: state.loaded ? 'ready' : 'loading', error: null })
          try {
            const data = await request(listPath, { method: 'GET' })
            setState({
              phase: 'ready',
              list: Array.isArray(data.projects) ? data.projects : [],
              defaults: data.defaults ?? null,
              fallback: data.fallback ?? null,
              error: null,
              loaded: true,
            })
          } catch (error) {
            setState({ phase: 'error', error: error instanceof Error ? error.message : String(error), loaded: true })
          }
          return state
        },
        async openProject(root) {
          setState({ selected: root, detail: null, devlog: null, phase: 'loading', error: null })
          try {
            const data = await request(detailPath(root), { method: 'GET' })
            setState({
              phase: 'ready',
              selected: root,
              detail: data.detail ?? null,
              defaults: data.defaults ?? state.defaults,
              detailConfig: data.config ?? null,
              detailSources: data.configSources ?? {},
              detailWarnings: data.configWarnings ?? [],
              list: mergeListItem(data),
              error: null,
            })
          } catch (error) {
            setState({ phase: 'error', selected: root, error: error instanceof Error ? error.message : String(error) })
          }
          return state
        },
        backToList() { setState({ selected: null, detail: null, devlog: null, phase: 'ready', error: null }) },
        async saveConfig(root, patch) {
          setState({ saving: true, toast: null })
          try {
            const data = await request(listPath, {
              method: 'PUT',
              body: JSON.stringify({ path: root, config: patch }),
            })
            setState({
              saving: false,
              list: mergeListItem(data),
              config: data.config ?? state.config,
              detailConfig: data.config ?? state.detailConfig,
              detailSources: data.sources ?? state.detailSources,
              detailWarnings: data.warnings ?? [],
              toast: { kind: 'ok', text: M8.saved },
            })
            return state
          } catch (error) {
            setState({
              saving: false,
              toast: {
                kind: 'error',
                text: `${M8.saveFailed}：${error instanceof Error ? error.message : String(error)}`,
              },
            })
            return state
          }
        },
        async openDevlog(root, id) {
          try {
            const data = await request(devlogPath(root, id), { method: 'GET' })
            setState({ devlog: data.devlog ?? null })
          } catch (error) {
            setState({ devlog: { found: false, id, reason: error instanceof Error ? error.message : String(error) } })
          }
          return state
        },
        closeDevlog() { setState({ devlog: null }) },
        dismissToast() { setState({ toast: null }) },
      }
    }

    // ── 模块八 · 渲染小件 ──────────────────────────────────────────────────
    //
    // 模块八的文案单独放（`M8`），不走模块三的 STR —— 那边的键是给设置页与
    // 复盘面板用的，混进来会让「模块三文案全中文」那条断言开始漂。

    /** 布尔开关：照踩坑录 #9，圆钮永远取与轨道相反的 token。 */
    function M8Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'm8-switch',
        disabled: props.disabled === true,
        onClick: () => { if (props.disabled !== true) props.onChange(!props.checked) },
      }, h('span', { className: 'm8-switchKnob' }))
    }

    /** 只读的「开 / 关」标签（全局默认用，不可点）。 */
    function M8Flag(props) {
      return h('span', { className: 'm8-flag' + (props.on ? ' m8-flagOn' : '') },
        props.on ? M8.injectOn : M8.injectOff)
    }

    /** 一行「标签 + 控件 + 来源」。 */
    function M8Row(props) {
      return h('div', { className: 'm8-row' },
        h('div', { className: 'm8-rowText' },
          h('span', { className: 'm8-rowLabel' }, props.label),
          props.hint === undefined || props.hint === null
            ? null
            : h('span', { className: 'm8-rowHint' }, props.hint),
        ),
        h('div', { className: 'm8-rowControl' },
          props.source === undefined || props.source === null
            ? null
            : h('span', {
              className: 'm8-source' + (props.source === 'project' ? ' m8-sourceProject' : ''),
            }, props.source === 'project' ? M8.sourceProject : M8.sourceDefault),
          props.children,
        ),
      )
    }

    /** 一小块统计（一级页每个项目摘要用）。 */
    function M8Stat(props) {
      return h('div', { className: 'm8-stat' },
        h('span', { className: 'm8-statLabel' }, props.label),
        h('span', { className: 'm8-statValue' }, String(props.value)),
      )
    }

    /** 把 markdown 表格以外的纯文本按行渲染成等宽文本块（不做富文本，不编造格式）。 */
    function M8Pre(props) {
      return h('pre', { className: 'm8-pre' }, String(props.text ?? ''))
    }

    /** 账行渲染：六列，状态用色点区分。 */
    function M8Ledger(props) {
      const all = Array.isArray(props.rows) ? props.rows : []
      const rows = typeof props.limit === 'number' && props.limit > 0 ? all.slice(-props.limit) : all
      if (rows.length === 0) return h('p', { className: 'm8-empty' }, M8.ledgerEmpty)
      return h('div', { className: 'm8-tableWrap' },
        h('table', { className: 'm8-table' },
          h('thead', null, h('tr', null,
            h('th', null, 'id'), h('th', null, '标题'), h('th', null, '状态'),
            h('th', null, '结论'), h('th', null, '存档'), h('th', null, 'next'))),
          h('tbody', null, rows.map(row => h('tr', { key: row.id },
            h('td', { className: 'm8-id' }, row.id),
            h('td', null, row.title),
            h('td', null, h('span', { className: 'm8-status m8-status-' + String(row.status) }, row.status)),
            h('td', null, row.conclusion),
            h('td', { className: 'm8-id' }, row.archive),
            h('td', null, row.next),
          ))),
        ),
      )
    }

    // ════════════════════════════════════════════════════════════════════
    // 模块八 · 一级页（总管理）
    // ════════════════════════════════════════════════════════════════════

    /** 一级页的一个项目行。 */
    function M8ProjectRow(props) {
      const item = props.item
      const config = item.config ?? {}
      return h('button', {
        type: 'button',
        className: 'm8-project',
        onClick: () => props.onOpen(item),
      },
      h('div', { className: 'm8-projectHead' },
        h('span', { className: 'm8-projectTitle' }, item.title || item.root),
        item.registered === false
          ? h('span', { className: 'm8-projectBadge' }, M8.notWorkspace)
          : null,
        item.error
          ? h('span', { className: 'm8-projectBadge m8-projectBadgeError' }, item.error)
          : null,
      ),
      h('span', { className: 'm8-projectPath' }, item.root),
      h('div', { className: 'm8-projectStats' },
        h(M8Stat, { label: M8.ledgerRows, value: item.ledgerRows ?? 0 }),
        h(M8Stat, { label: M8.latestCloseout, value: item.latestArchiveId || M8.nothing }),
        h(M8Stat, { label: M8.devlogCount, value: item.devlogCount ?? 0 }),
      ),
      h('div', { className: 'm8-projectFlags' },
        h('span', { className: 'm8-flagLabel' }, M8.inject),
        h(M8Flag, { on: config.inject !== false }),
        h('span', { className: 'm8-flagLabel' }, M8.write),
        h(M8Flag, { on: config.write === true }),
      ),
      )
    }

    /**
     * 一级页。**只读展示 + 全局默认**：不改任何项目的配置。
     *
     * 点某个项目 = 进二级页（段 3 之后接真；契约在这里一次定死，
     * 免得两段各定一套「点哪儿、传什么」）。
     */
    function LimbsProjectsPanel(props) {
      const store = props.store
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const [manual, setManual] = useState('')

      useEffect(() => {
        if (state.loaded === false && state.phase === 'idle') void store.loadList()
      }, [state.loaded, state.phase, store])
      const openManual = () => {
        const value = manual.trim()
        if (value === '') return
        void store.openProject(value)
      }

      const defaults = state.defaults ?? {}
      return h('div', { className: 'm8-page' },
        h('div', { className: 'm8-head' },
          h('div', null,
            h('h2', { className: 'm8-title' }, M8.title),
            h('p', { className: 'm8-subtitle' }, M8.subtitle),
          ),
          h('button', {
            type: 'button',
            className: 'm8-btn',
            onClick: () => { void store.loadList() },
          }, M8.refresh),
        ),

        state.phase === 'offline'
          ? h('p', { className: 'm8-error' }, M8.noBridge)
          : null,
        state.error !== null
          ? h('p', { className: 'm8-error' }, state.error)
          : null,
        state.fallback === 'workspace-registry-missing'
          ? h('p', { className: 'm8-note' }, M8.workspaceMissing)
          : null,

        // ── 全局默认（只读）────────────────────────────────────────────
        h('section', { className: 'm8-card' },
          h('h3', { className: 'm8-cardTitle' }, M8.globalDefaults),
          h('p', { className: 'm8-note' }, M8.globalDefaultsHint),
          h('div', { className: 'm8-grid' },
            h('div', { className: 'm8-cell' },
              h('span', { className: 'm8-cellLabel' }, M8.inject),
              h(M8Flag, { on: defaults.inject !== false }),
            ),
            h('div', { className: 'm8-cell' },
              h('span', { className: 'm8-cellLabel' }, M8.write),
              h(M8Flag, { on: defaults.write === true }),
            ),
            h('div', { className: 'm8-cell' },
              h('span', { className: 'm8-cellLabel' }, M8.ledgerRecent),
              h('span', { className: 'm8-cellValue' }, String(defaults.ledgerRecent ?? M8.nothing)),
            ),
            h('div', { className: 'm8-cell' },
              h('span', { className: 'm8-cellLabel' }, M8.checkCommand),
              h('span', { className: 'm8-cellValue m8-mono' },
                typeof defaults.checkCommand === 'string' && defaults.checkCommand !== ''
                  ? defaults.checkCommand
                  : '自动探测 check-docs.ps1'),
            ),
          ),
        ),

        // ── 项目列表 ──────────────────────────────────────────────────
        h('section', { className: 'm8-card' },
          h('h3', { className: 'm8-cardTitle' }, `${M8.projects}（${state.list.length}）`),
          state.list.length === 0
            ? (state.phase === 'loading' || state.phase === 'idle'
              ? h('p', { className: 'm8-empty' }, M8.loading)
              : h('p', { className: 'm8-empty' }, M8.projectsEmpty))
            : h('div', { className: 'm8-projects' },
              state.list.map(item => h(M8ProjectRow, {
                key: item.root, item, onOpen: (target) => { void store.openProject(target.root) },
              }))),

          h('div', { className: 'm8-manual' },
            h('div', { className: 'm8-rowText' },
              h('span', { className: 'm8-rowLabel' }, M8.manualPath),
              h('span', { className: 'm8-rowHint' }, M8.manualPathHint),
            ),
            h('input', {
              className: 'm8-input',
              type: 'text',
              spellCheck: false,
              placeholder: 'D:\\Projects\\some-project',
              value: manual,
              onChange: (event) => setManual(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') openManual() },
            }),
            h('button', { type: 'button', className: 'm8-btn', onClick: openManual }, M8.open),
          ),
        ),

        state.selected !== null ? h(LimbsProjectDetail, { store, state }) : null,
      )
    }

    /**
     * 二级页（单项目管理）。
     *
     * 四块（需求原话）：该项目任务账（最近 N 行）· §3.3 待拍板 · STATUS 实测快照
     * · devlog 列表（按 id 倒序、点开看正文），外加**该项目自己的配置**（覆盖
     * 全局默认，热注入开关就在这里）。
     *
     * 保存语义：PUT 一次提交「当前四个字段」，Host 只落与默认不同的项；
     * 未显式覆盖的继续继承默认（`sources` 逐项标出来源）。
     */
    function LimbsProjectDetail(props) {
      const store = props.store
      const state = props.state
      const detail = state.detail
      const config = state.detailConfig ?? state.config ?? null
      const sources = state.detailSources ?? state.configSources ?? {}
      const defaults = state.defaults ?? {}
      const ledgerRecent = typeof defaults.ledgerRecent === 'number' ? defaults.ledgerRecent : 10
      const MAX_LEDGER_ROWS = 50

      const save = (patch) => {
        if (state.selected === null) return
        void store.saveConfig(state.selected, patch)
      }

      const effective = config ?? { ...defaults }
      const current = {
        inject: effective.inject !== false,
        write: effective.write === true,
        ledgerRecent: typeof effective.ledgerRecent === 'number' ? effective.ledgerRecent : ledgerRecent,
        checkCommand: typeof effective.checkCommand === 'string' ? effective.checkCommand : '',
      }

      // 自检命令**不逐键 PUT**：点一下才落盘（每次按键都写文件既吵又慢）。
      const [checkDraft, setCheckDraft] = useState(current.checkCommand)
      const committedCheckRef = useRef(current.checkCommand)
      if (committedCheckRef.current !== current.checkCommand) {
        // 配置从 Host 刷新回来了（例如刚保存过）：草稿跟到最新值。
        committedCheckRef.current = current.checkCommand
        setCheckDraft(current.checkCommand)
      }
      const commitCheck = () => {
        const next = checkDraft.trim()
        if (next === committedCheckRef.current) return
        save({ checkCommand: next })
      }

      const devlogList = detail?.devlogs ?? []
      const opened = state.devlog

      return h('section', { className: 'm8-card m8-detail' },
        h('div', { className: 'm8-detailHead' },
          h('button', {
            type: 'button',
            className: 'm8-btn',
            onClick: () => props.store.backToList(),
          }, M8.back),
          h('span', { className: 'm8-detailTitle' }, state.selected ?? ''),
          detail?.statusCheckedAt
            ? h('span', { className: 'm8-source' }, `${M8.checkedAt} ${detail.statusCheckedAt}`)
            : null,
        ),

        state.phase === 'loading'
          ? h('p', { className: 'm8-empty' }, M8.loading)
          : null,
        state.error !== null
          ? h('p', { className: 'm8-error' }, state.error)
          : null,

        // ── 该项目自己的配置（覆盖全局默认）──────────────────────────
        h('div', { className: 'm8-detailBlock' },
          h('h4', { className: 'm8-blockTitle' }, M8.configTitle),
          h('p', { className: 'm8-note' }, M8.configHint),
          h(M8Row, {
            label: M8.inject,
            hint: M8.injectHint,
            source: sources.inject,
          }, h(M8Switch, {
            checked: current.inject,
            disabled: state.saving === true,
            label: M8.inject,
            onChange: (next) => save({ inject: next }),
          })),
          h(M8Row, {
            label: M8.write,
            hint: M8.writeHint,
            source: sources.write,
          }, h(M8Switch, {
            checked: current.write,
            disabled: state.saving === true,
            label: M8.write,
            onChange: (next) => save({ write: next }),
          })),
          h(M8Row, {
            label: M8.ledgerRecent,
            hint: M8.ledgerHint,
            source: sources.ledgerRecent,
          }, h('select', {
            className: 'm8-select',
            'aria-label': M8.ledgerRecent,
            disabled: state.saving === true,
            value: String(current.ledgerRecent),
            onChange: (event) => save({ ledgerRecent: Number(event.target.value) }),
          }, [3, 5, 10, 15, 20, 30].map(value => h('option', { key: value, value: String(value) }, String(value)))),
          ),
          h(M8Row, {
            label: M8.checkCommand,
            hint: M8.checkHint,
            source: sources.checkCommand,
          }, h('input', {
            className: 'm8-input m8-inputNarrow',
            type: 'text',
            spellCheck: false,
            disabled: state.saving === true,
            placeholder: '自动探测',
            value: checkDraft,
            onChange: (event) => setCheckDraft(event.target.value),
            onBlur: commitCheck,
            onKeyDown: (event) => {
              if (event.key === 'Enter') { commitCheck(); if (typeof event.preventDefault === 'function') event.preventDefault() }
            },
          })),
          state.toast !== null && state.toast !== undefined
            ? h('p', { className: state.toast.kind === 'error' ? 'm8-error' : 'm8-note' }, state.toast.text)
            : null,
        ),

        // ── 该项目任务账（最近 N 行）─────────────────────────────────
        h('div', { className: 'm8-detailBlock' },
          h('h4', { className: 'm8-blockTitle' }, M8.ledgerText),
          detail === null
            ? h('p', { className: 'm8-empty' }, M8.loading)
            : h(M8Ledger, { rows: detail.ledgerRows, limit: Math.min(current.ledgerRecent, MAX_LEDGER_ROWS) }),
        ),

        // ── §3.3 待拍板（全部，不剪）───────────────────────────────
        h('div', { className: 'm8-detailBlock' },
          h('h4', { className: 'm8-blockTitle' }, M8.pendingTitle),
          detail === null || detail.pending === ''
            ? h('p', { className: 'm8-empty' }, M8.pendingEmpty)
            : h(M8Pre, { text: detail.pending }),
        ),

        // ── STATUS 实测快照 ─────────────────────────────────────────
        h('div', { className: 'm8-detailBlock' },
          h('h4', { className: 'm8-blockTitle' }, M8.snapshotTitle),
          detail === null || detail.statusSnapshot === ''
            ? h('p', { className: 'm8-empty' }, M8.snapshotEmpty)
            : h(M8Pre, { text: detail.statusSnapshot }),
        ),

        // ── devlog 列表（按 id 倒序，点开看正文）─────────────────────
        h('div', { className: 'm8-detailBlock' },
          h('h4', { className: 'm8-blockTitle' }, M8.devlogs),
          // 正文放在列表**上方**：列表常有十几条，正文压在列表底下就得先滚到底
          // 才看得见（真机目视时的实际手感）。点一条 → 正文立刻出现在列表顶上。
          opened === null || opened === undefined
            ? null
            : h('div', { className: 'm8-devlogBody' },
              h('div', { className: 'm8-devlogBodyHead' },
                h('span', { className: 'm8-blockTitle' }, `${M8.devlogBody} ${opened.id ?? ''}`),
                h('button', {
                  type: 'button',
                  className: 'm8-btn',
                  onClick: () => props.store.closeDevlog(),
                }, M8.close),
              ),
              opened.found === true
                ? h(M8Pre, { text: opened.text })
                : h('p', { className: 'm8-error' }, opened.reason ?? M8.requestFailed),
              ),
          devlogList.length === 0
            ? h('p', { className: 'm8-empty' }, M8.devlogsEmpty)
            : h('div', { className: 'm8-devlogs' },
              devlogList.map(item => h('button', {
                key: item.id,
                type: 'button',
                className: 'm8-devlog' + (opened?.id === item.id ? ' m8-devlogOpen' : ''),
                title: M8.devlogOpenHint,
                onClick: () => { void store.openDevlog(state.selected, item.id) },
              },
              h('span', { className: 'm8-devlogId' }, item.id),
              h('span', { className: 'm8-devlogTitle' }, item.title),
              )),
            ),
        ),
      )
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
      }, makeLimbsSettingsSection(ctx))), 'dsh-limbs: settings section')

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
          // `inject(sessionId)` is the seat's per-session face: the model
          // directory and the one action the panel performs.
          inject: limbsReviewFace(ctx),
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

      // ── 模块八 · 项目管理 ────────────────────────────────────────────────
      // 左栏「项目」入口 = sidebar.panellist 的新 id（'limbs-projects'）；
      // 点进去 = main 的一个 keyed 面板。占位同 dsh-context / dsh-github-flow：
      // 它们也各占一个 panellist id + 一个 main key。
      //
      // 槽位事实（cordis_inspect_query 实测，2026-11-24）：
      //   sidebar.panellist  occupants: plugins / schedules / dsh-context / github
      //   main               occupants: dsh-context / commandcode-panel / plugins /
      //                               conversation / github / schedules
      // 所以「同风格的那一排」就是 sidebar.panellist，不是 footer.action。
      ctx.effect(() => {
        const previous = document.getElementById(M8_STYLE_ID)
        if (previous !== null) previous.remove()
        const element = document.createElement('style')
        element.id = M8_STYLE_ID
        element.textContent = M8_CSS
        document.head.appendChild(element)
        return () => {
          const installed = document.getElementById(M8_STYLE_ID)
          if (installed !== null) installed.remove()
        }
      }, 'dsh-limbs: module 8 styles')
      const projectsStore = createProjectsStore()

      ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'limbs-projects',
        // 排在 github（20）之后：插件入口按字母/分组都在后半段，别插到官方的
        // 「插件」「自动化任务」前面去。
        order: 30,
        label: () => M8.nav,
      }, LimbsProjectsIcon)), 'dsh-limbs: projects panel icon')

      ctx.effect(() => slots.inject('main', () => slots.register({
        name: 'main',
        key: 'limbs-projects',
      }, props => h(LimbsProjectsPanel, { ...props, store: projectsStore }))),
      'dsh-limbs: projects main panel')
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
        mmReasoningSummary,
        // 模块三：设置页与复盘面板（供 .dev 离线断言直接调用）
        LIMBS_SETTINGS_ENTRY,
        LIMBS_SETTINGS_DEFAULTS,
        limbsNormalizeSettings,
        createLimbsSettingsStore,
        LimbsSettingsSection,
        makeLimbsSettingsSection,
        LIMBS_REVIEW_COMMAND,
        escapeHtml,
        renderInline,
        renderMarkdown,
        limbsReviewFace,
        limbsRemoteCommands,
        LimbsReviewPanel,
        LimbsReviewTitle,
        LimbsReviewHeaderButton,
        createModelSettingsStore,
        makeModelManagementSection,
        // 模块八：项目管理（供 .dev 离线断言直接调用，不暴露给运行时 UI）
        M8,
        M8_CSS,
        M8_STYLE_ID,
        createProjectsStore,
        m8Bridge,
        LimbsProjectsPanel,
        LimbsProjectsIcon,
        LimbsProjectDetail,
        M8Ledger,
        M8Switch,
        M8Flag,
      },
    }
  },
})
