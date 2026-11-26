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

/** 默认档位；恢复默认只写这一个字段。 */
export const DEFAULT_SETTINGS = Object.freeze({
  reasoning: 'provider-default',
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
 * @returns {{version:number, reasoning:object[], defaults:object, showMax:boolean}}
 */
export function buildLevels(options = {}) {
  const showMax = options.showMax !== false
  const maxSupported = options.maxSupported === true

  const reasoning = REASONING_LEVELS
    .filter((level) => level.id !== 'max' || showMax)
    .map((level) => {
      if (level.id === 'max' && !maxSupported) {
        return { ...level, disabledReason: '当前服务商不支持最高档' }
      }
      return { ...level }
    })

  return {
    version: MODEL_SETTINGS_VERSION,
    reasoning,
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
 * 旧配置 → 新档位。记录每一条迁移，供界面与测试使用。
 *
 * 兼容字段（按优先级）：
 *   推理：reasoning / effort / reasoningEffort / reasoningLevel
 *
 * @param {object} raw
 * @returns {{settings:{reasoning:string}, changes:Array<object>, fellBack:boolean}}
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

/**
 * 把已保存的设置收敛到当前可用档位。
 * 当前档位失效时回到对应默认档，并给出中文原因。
 *
 * @param {object} settings
 * @param {{reasoning:object[]}} levels
 * @returns {{settings:object, changes:Array<{field:string,from:string,to:string,reason:string}>}}
 */
export function normalizeSettings(settings, levels) {
  const source = settings !== null && typeof settings === 'object' ? settings : {}
  const reasoningIds = new Set((levels.reasoning || []).filter(isLevelEnabled).map((level) => level.id))
  const changes = []
  let reasoning = source.reasoning

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

  return {
    settings: {
      ...source,
      reasoning,
    },
    changes,
  }
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

/** 只比较两个模块关心的字段，避免保存状态被无关字段扰动。 */
export function settingsEqual(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return false
  return left.reasoning === right.reasoning
}
