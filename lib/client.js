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

    // ── Plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return

      // Style is installed and removed with this plugin's run: disabling the
      // row leaves no <style> behind.
      ctx.effect(() => {
        const CSS_ID = 'dsh-limbs-styles'
        if (document.getElementById(CSS_ID) === null) {
          const element = document.createElement('style')
          element.id = CSS_ID
          element.textContent = CSS
          document.head.appendChild(element)
        }
        return () => {
          const element = document.getElementById(CSS_ID)
          if (element !== null) element.remove()
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
    }

    return { inject, apply }
  },
})
