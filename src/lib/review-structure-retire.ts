import type { ReviewItem } from "@/stores/review-store"

/**
 * 结构检查（失效引用、格式）是对页面当前正文的确定性检查，结果只对生成时的
 * 版本成立。页面随后被修改时，旧版本上报出的事项不会自行消失，会和新版本的
 * 结果并存，直到人工逐条关闭。
 *
 * 本轮对一组页面完成结构检查后，这些页面上仍未处理、且本轮没有重现的旧结构
 * 事项即为过期：按历史证据退役，不再出现在待审列表。只退役本轮确实检查过的
 * 页面，未检查页面上的事项保持不变。
 */
export function retireStaleStructureItems(
  existing: readonly ReviewItem[], checkedPaths: Iterable<string>, currentIds: Iterable<string>,
): ReviewItem[] {
  const checked = new Set(checkedPaths)
  const current = new Set(currentIds)
  return existing
    .filter((item) => item.type === "structure" && !item.resolved && !item.historical && !item.hidden && !item.dismissed
      && !current.has(item.id)
      && Array.isArray(item.affectedPages) && item.affectedPages.length > 0
      && item.affectedPages.every((path) => checked.has(path)))
    .map((item) => ({ ...item, historical: true }))
}
