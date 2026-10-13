/** 项目业务模块字典；模块身份独立于文件路径及展示层级。 */
export interface BusinessModule {
  id: string
  name: string
  description: string
  children: BusinessModule[]
}

export interface ModuleCatalog {
  roots: BusinessModule[]
  byId: Map<string, BusinessModule>
}

export const MODULE_PREFIX = "module/"
export const UNCLASSIFIED_ID = "unclassified"

/** 未分类是保底节点；配置可提供其展示文案，但不能把它放入其他模块。 */
const UNCLASSIFIED: BusinessModule = {
  id: UNCLASSIFIED_ID,
  name: "未分类",
  description: "无法匹配已定义业务模块，或缺少足够分类依据的页面。",
  children: [],
}

/** 从独立章节提取唯一 JSON 字典；未配置时返回 null，保持原入库行为。 */
export function parseModuleCatalog(markdown: string): ModuleCatalog | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^#{1,6}\s+(?:Business Modules|业务模块)\s*#*\s*$/i.test(line))
  if (start < 0) return null
  const level = lines[start].match(/^#+/)![0].length
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^(#{1,6})\s+/)
    if (heading && heading[1].length <= level) break
    section.push(line)
  }
  const blocks = [...section.join("\n").matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error("业务模块章节必须包含一个 JSON 代码块。")
  let value: unknown
  try {
    value = JSON.parse(blocks[0][1])
  } catch {
    throw new Error("业务模块 JSON 格式无效。")
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.modules)) {
    throw new Error("业务模块配置必须使用 version: 1 和 modules 数组。")
  }
  const byId = new Map<string, BusinessModule>()
  const roots = value.modules.map((node) => parseNode(node, byId, 0))
  if (!byId.has(UNCLASSIFIED_ID)) {
    const fallback = { ...UNCLASSIFIED, children: [] }
    roots.push(fallback)
    byId.set(fallback.id, fallback)
  }
  return { roots, byId }
}

/** 校验配置节点，拒绝重复身份、空分类说明及过深/过大的字典。 */
function parseNode(value: unknown, byId: Map<string, BusinessModule>, depth: number): BusinessModule {
  if (depth > 30 || byId.size >= 1000) throw new Error("业务模块字典超过层级或节点数量限制。")
  if (!isRecord(value)) throw new Error("业务模块节点必须是 JSON 对象。")
  const { id, name, description, children = [] } = value
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(id)) {
    throw new Error("模块 id 必须是稳定的小写英文编码，可包含数字、横线及下划线。")
  }
  if (byId.has(id)) throw new Error(`业务模块 id 重复：${id}`)
  if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
    throw new Error(`模块 ${id} 必须填写 name 和 description。`)
  }
  if (!Array.isArray(children)) throw new Error(`模块 ${id} 的 children 必须是数组。`)
  if (id === UNCLASSIFIED_ID && (depth !== 0 || children.length > 0)) {
    throw new Error("未分类节点必须是无子节点的根模块。")
  }
  const node: BusinessModule = { id, name: name.trim(), description: description.trim(), children: [] }
  byId.set(id, node)
  node.children = children.map((child) => parseNode(child, byId, depth + 1))
  return node
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 获取节点自身及全部子节点身份，供父模块聚合及标签去重使用。 */
export function descendantIds(node: BusinessModule): Set<string> {
  const ids = new Set<string>([node.id])
  for (const child of node.children) {
    for (const id of descendantIds(child)) ids.add(id)
  }
  return ids
}

/** 验证模型分类，去重并移除已有更具体分类的祖先标签。 */
export function normalizeModuleIds(ids: readonly string[], catalog: ModuleCatalog): string[] {
  const valid = [...new Set(ids.filter((id) => catalog.byId.has(id) && id !== UNCLASSIFIED_ID))]
  const specific = valid.filter((id) => {
    const descendants = descendantIds(catalog.byId.get(id)!)
    return !valid.some((other) => other !== id && descendants.has(other))
  })
  return specific.length ? specific : [UNCLASSIFIED_ID]
}
