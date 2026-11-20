/**
 * 模块二 · 档位配置中心（单一真源）。
 *
 * 这里只放纯数据与纯函数，不 import 任何运行时包：
 *   - Host 半侧（lib/host.js）用它校验保存请求、返回档位表；
 *   - 离线测试直接 import 本文件，逐项核对映射表；
 *   - Client 半侧（lib/client.js）保留一份同构内置档位，Host 可用时以
 *     Host 返回的档位表为准；测试会比对两份数据，防止漂移。
 *
 * 新增/删除档位只需要改下面的数组：
 *   - `id` 必须稳定，旧配置映射与保存校验都靠它；
 *   - `shortLabel` 是轨道上的短名（“服务商默认”在轨道上显示“默认”）；
 *   - `isDefault` 每类档位最多一个；
 *   - 最高档额外受 `showMax` 与 `maxSupported` 控制。
 */

export const MODEL_SETTINGS_VERSION = 2

/** 推理挡位：从左到右。 */
export const REASONING_LEVELS = [
  {
    id: 'off',
    label: '关闭',
    shortLabel: '关闭',
    description: '不启用推理，回答更快、更省。',
    fullDescription: '关闭：完全关闭推理，只做快速回答。',
  },
  {
    id: 'provider-default',
    label: '服务商默认',
    shortLabel: '默认',
    description: '跟随服务商给出的默认强度。',
    fullDescription: '服务商默认：使用服务商提供的默认强度。',
    isDefault: true,
  },
  {
    id: 'low',
    label: '低',
    shortLabel: '低',
    description: '轻量思考，适合日常问答。',
  },
  {
    id: 'medium',
    label: '中',
    shortLabel: '中',
    description: '平衡速度与质量，适合多数任务。',
  },
  {
    id: 'high',
    label: '高',
    shortLabel: '高',
    description: '更充分的推理，适合复杂问题。',
  },
  {
    id: 'max',
    label: '最高',
    shortLabel: '最高',
    description: '最强推理，耗时与花费更高。',
  },
]

/** 上下文长度：从左到右。 */
export const CONTEXT_LEVELS = [
  {
    id: '300k',
    label: '300K',
    shortLabel: '300K',
    statusLabel: '精简',
    description: '精简，满足基础对话。',
  },
  {
    id: '600k',
    label: '600K',
    shortLabel: '600K',
    statusLabel: '适中',
    description: '适中，满足长文阅读。',
    isDefault: true,
  },
  {
    id: '1m',
    label: '1M',
    shortLabel: '1M',
    statusLabel: '充足',
    description: '充足，满足超长文档处理。',
  },
]

/** 默认档位；恢复默认只写这两个字段。 */
export const DEFAULT_SETTINGS = Object.freeze({
  reasoning: 'provider-default',
  context: '600k',
})

/** 最高档开关：默认展示；服务商不支持时置灰，而不是隐藏。 */
export const DEFAULT_LEVEL_CONFIG = Object.freeze({
  showMax: true,
  maxSupported: false,
})

/**
 * 按配置生成 UI/Host 使用的档位表。
 *
 * @param {object} [options]
 * @param {boolean} [options.showMax] - false 时最高档整个不展示。
 * @param {boolean} [options.maxSupported] - false 时最高档置灰并给出中文原因。
 * @param {Record<string, boolean>} [options.contextAvailable] - 按上下文档位 id 控制可用性。
 * @returns {{version:number, reasoning:object[], context:object[], defaults:object, showMax:boolean}}
 */
export function buildLevels(options = {}) {
  const showMax = options.showMax !== false
  const maxSupported = options.maxSupported === true
  const contextAvailable = options.contextAvailable || {}

  const reasoning = REASONING_LEVELS
    .filter((level) => level.id !== 'max' || showMax)
    .map((level) => {
      if (level.id === 'max' && !maxSupported) {
        return { ...level, disabledReason: '当前服务商不支持最高档' }
      }
      return { ...level }
    })

  const context = CONTEXT_LEVELS.map((level) => (
    contextAvailable[level.id] === false
      ? { ...level, disabledReason: '当前配置不支持该上下文长度' }
      : { ...level }
  ))

  return {
    version: MODEL_SETTINGS_VERSION,
    reasoning,
    context,
    defaults: { ...DEFAULT_SETTINGS },
    showMax,
  }
}

/** 一组档位里的默认档；没有标记时取第一档。 */
export function defaultLevelOf(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined
  return levels.find((level) => level.isDefault === true) || levels[0]
}

/** 档位可用性：没有 disabledReason 即可用。 */
export function isLevelEnabled(level) {
  return level !== undefined && level !== null && typeof level.disabledReason !== 'string'
}

/** 某一类档位的默认 id。 */
export function defaultReasoningId() {
  return defaultLevelOf(REASONING_LEVELS).id
}

export function defaultContextId() {
  return defaultLevelOf(CONTEXT_LEVELS).id
}

/**
 * 把任意旧值映射成推理档位 id。
 * 无法识别返回 null，由调用方回退默认档并提示。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function mapLegacyReasoning(value) {
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

/**
 * 把任意旧值映射成上下文档位 id。
 * 支持 300000 / 600000 / 1000000、带 K/M 的字符串，以及模块三占位的
 * 128K / 256K / 512K（按最接近的档位向上取）。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function mapLegacyContext(value) {
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
  return mapLegacyContext(numeric * unit)
}

/**
 * 旧配置 → 新档位。记录每一条迁移，供界面与测试使用。
 *
 * 兼容字段（按优先级）：
 *   推理：reasoning / effort / reasoningEffort / reasoningLevel
 *   上下文：context / contextLength / contextWindow / contextSize
 *
 * @param {object} raw
 * @returns {{settings:{reasoning:string,context:string}, changes:Array<object>, fellBack:boolean}}
 */
export function migrateSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const changes = []
  let fellBack = false

  const rawReasoning = source.reasoning ?? source.effort ?? source.reasoningEffort ?? source.reasoningLevel
  let reasoning = mapLegacyReasoning(rawReasoning)
  if (reasoning === null) {
    reasoning = DEFAULT_SETTINGS.reasoning
    fellBack = true
    changes.push({
      field: 'reasoning',
      from: rawReasoning,
      to: reasoning,
      reason: '无法识别旧推理档位，已回退服务商默认',
    })
  } else if (rawReasoning !== undefined && rawReasoning !== null) {
    const legacyField = source.reasoning === undefined
    if (legacyField || String(rawReasoning) !== reasoning) {
      changes.push({ field: 'reasoning', from: rawReasoning, to: reasoning, reason: legacyField ? '旧推理字段已迁移' : '旧推理档位已迁移' })
    }
  }

  const rawContext = source.context ?? source.contextLength ?? source.contextWindow ?? source.contextSize
  let context = mapLegacyContext(rawContext)
  if (context === null) {
    context = DEFAULT_SETTINGS.context
    fellBack = true
    changes.push({
      field: 'context',
      from: rawContext,
      to: context,
      reason: '无法识别旧上下文长度，已回退 600K',
    })
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

/**
 * 把已保存的设置收敛到当前可用档位。
 * 当前档位失效时回到对应默认档，并给出中文原因。
 *
 * @param {object} settings
 * @param {{reasoning:object[], context:object[]}} levels
 * @returns {{settings:object, changes:Array<{field:string,from:string,to:string,reason:string}>}}
 */
export function normalizeSettings(settings, levels) {
  const source = settings !== null && typeof settings === 'object' ? settings : {}
  const reasoningIds = new Set((levels.reasoning || []).filter(isLevelEnabled).map((level) => level.id))
  const contextIds = new Set((levels.context || []).filter(isLevelEnabled).map((level) => level.id))
  const changes = []
  let reasoning = source.reasoning
  let context = source.context

  if (!reasoningIds.has(reasoning)) {
    const next = defaultLevelOf((levels.reasoning || []).filter(isLevelEnabled))
    reasoning = next === undefined ? DEFAULT_SETTINGS.reasoning : next.id
    changes.push({
      field: 'reasoning',
      from: source.reasoning,
      to: reasoning,
      reason: '当前推理档位不可用，已回退可用默认档',
    })
  }
  if (!contextIds.has(context)) {
    const next = defaultLevelOf((levels.context || []).filter(isLevelEnabled))
    context = next === undefined ? DEFAULT_SETTINGS.context : next.id
    changes.push({
      field: 'context',
      from: source.context,
      to: context,
      reason: '当前上下文长度不可用，已回退可用默认档',
    })
  }

  return {
    settings: {
      ...source,
      reasoning,
      context,
    },
    changes,
  }
}

/** 四舍五入到最近的可用档位；全被禁用时返回 -1。 */
export function nearestEnabledIndex(levels, ratio) {
  if (!Array.isArray(levels) || levels.length === 0) return -1
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const raw = Math.round(clamped * (levels.length - 1))
  for (let distance = 0; distance < levels.length; distance += 1) {
    const candidates = [raw - distance, raw + distance]
    for (const index of candidates) {
      if (index >= 0 && index < levels.length && isLevelEnabled(levels[index])) return index
    }
  }
  return -1
}

/** 方向键移动：跳过禁用档，到边界停住（不循环）。 */
export function moveEnabledIndex(levels, from, delta) {
  if (!Array.isArray(levels) || levels.length === 0) return -1
  let index = Number.isInteger(from) ? from : 0
  for (let step = 0; step < levels.length; step += 1) {
    index += delta
    if (index < 0 || index >= levels.length) return Math.max(0, Math.min(levels.length - 1, index - delta))
    if (isLevelEnabled(levels[index])) return index
  }
  return from
}

/** 第一个 / 最后一个可用档位。 */
export function edgeEnabledIndex(levels, edge) {
  if (!Array.isArray(levels)) return -1
  const indices = edge === 'last'
    ? levels.map((_level, index) => index).reverse()
    : levels.map((_level, index) => index)
  return indices.find((index) => isLevelEnabled(levels[index])) ?? -1
}

/** 无障碍值文本，例如“推理挡位：中，第 4 档，共 6 档”。 */
export function levelAriaText(groupLabel, levels, index) {
  if (!Array.isArray(levels) || levels.length === 0 || index < 0 || index >= levels.length) {
    return `${groupLabel}：不可用`
  }
  const level = levels[index]
  const total = levels.length
  const reason = level.disabledReason === undefined ? '' : `，${level.disabledReason}`
  return `${groupLabel}：${level.label}，第 ${index + 1} 档，共 ${total} 档${reason}`
}

/** 顶部摘要：关闭 / 服务商默认 / 具体档位。 */
export function reasoningSummary(settings, levels) {
  const level = (levels.reasoning || []).find((item) => item.id === settings.reasoning)
  if (settings.reasoning === 'off') return { text: '已关闭', detail: '推理已关闭', kind: 'off' }
  if (settings.reasoning === 'provider-default') {
    return {
      text: '服务商默认',
      detail: '服务商默认：使用服务商提供的默认强度',
      kind: 'default',
    }
  }
  return {
    text: level === undefined ? '未知' : level.label,
    detail: level === undefined ? '当前推理档位未知' : level.description,
    kind: 'level',
  }
}

/** 顶部摘要：例如“600K 上下文 · 适中”。 */
export function contextSummary(settings, levels) {
  const level = (levels.context || []).find((item) => item.id === settings.context)
  if (level === undefined) return { text: '上下文长度未知', detail: '当前上下文长度未知', kind: 'unknown' }
  return {
    text: `${level.label} 上下文 · ${level.statusLabel}`,
    detail: level.description,
    kind: 'level',
  }
}

/** 只比较两个模块关心的字段，避免保存状态被无关字段扰动。 */
export function settingsEqual(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return false
  return left.reasoning === right.reasoning && left.context === right.context
}
