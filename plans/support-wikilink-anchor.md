# 支持 `[[页面#锚点]]` 链接语法

## 背景

LLM Wiki 的 wiki 链接目前只支持 `[[页面标题]]` 和 `[[页面标题|别名]]`，不支持 Obsidian 风格的 `[[页面标题#标题锚点]]`。入库流水线（LLM 生成端）会自然写出这种语法，而链接校验器（lint "失效引用"）不认，导致合法链接被判为 structure/失效引用 噪音。2026-11-02 清理知识库时曾手工把十余处此类链接改成纯文本/纯页面链接，现保留 1 处作为测试用例：

- 测试用例：`wiki/others/202602-元数据工单月度汇总.md:87` → `[[工单分析-2025.3统计与结论#主要发现]]`
- 目标页存在：`wiki/others/工单分析-2025.3统计与结论.md`，其内含 `## 主要发现` 标题（cases 目录下无同名文件，注意目标在 `others/`）。

## 需求

1. **链接解析**：`[[target#anchor]]`、`[[target#anchor|alias]]` 均合法。在**第一个** `#` 处切分（标题文本本身可能含 `#` 的场景极少，但不要按最后一个切）；`[[#anchor]]`（当前页锚点）可暂不支持，按现状处理即可。
2. **校验器（lint）**：
   - 页面部分按现有标题/路径匹配逻辑校验；
   - 锚点部分在目标页中按标题文本匹配，建议归一化比较（去空格/全半角空格、大小写不敏感；`#` 开头锚点忽略首尾 `#` 与空白）；
   - 页面存在但锚点找不到时：**降级为整页链接，不报失效引用**（可考虑低级别 hint，非必须）；
   - 页面不存在：仍报失效引用（描述里只提页面部分）。
3. **渲染/跳转**（若前端有 wikilink 渲染与点击跳转）：点击 `[[页面#锚点]]` 应打开目标页并滚动到对应标题。
4. **相关位置参考**（当前实现）：
   - `src/lib/lint.ts` — `extractWikilinks()`（第 42 行附近，regex 需兼容 `#`）、`runStructuralLint()` 的失效引用判定；
   - `src/lib/wiki-reference-maintenance.ts`、`src/lib/wiki-review.ts`、`src/lib/ingest-review-repair.ts` — 同样解析 wikilink 的地方，统一处理；
   - 渲染端搜索 `[[` 的 markdown 渲染/点击处理组件（`src/components/`、`src/lib/` 下 grep `\[\[` 定位）；
   - Rust 侧若有链接索引（`src-tauri/src/commands/search/evidence/relation_index.rs` 等），确认是否也按 `[[...]]` 提取，需同样容错。
5. **验收**：
   - 上述测试用例不再产生"失效引用"审核项；
   - `[[不存在的页面#任意锚点]]` 仍报失效引用；
   - 单测：lint.ts 附近已有 `lint.test.ts`，补充锚点用例。

## 决策记录

- 2026-11-02 与用户确认：选择"支持该语法"而非"入库 prompt 禁止"。
- corpus 中现存该语法仅 1 处（即测试用例），支持后无存量噪音。

## 实现记录（2026-11-02）

- 新增 `src/lib/wikilink-anchor.ts`：`splitWikilinkTarget`（按第一个 `#` 切分）、`normalizeHeadingAnchor`（NFKC、大小写不敏感、去全部空白、去首尾 `#`、去行内强调）、`findHeadingElement`。
- `wiki-reference-maintenance.ts`：`hasWikiSection` 改为归一化比较；`inspectWikiReferences` 在页面存在但锚点缺失时不再报「目标章节不存在」，只报页面缺失/重名，描述与 `pageEvidence` 只含页面部分。
- `lint-structural-core.ts`：缺失页面的多个锚点链接合并为一条，`brokenTarget`/描述只含页面部分；`lint-fixes.ts` 重写失效目标时保留锚点。
- `dedup.ts`：`rewriteCrossReferences` / `lineRefersToSlug` 兼容 `[[slug#anchor]]`。
- 前端：`wiki-store.pendingScrollHeading`（含目标路径）；`wiki-reader.tsx` 点击 `[[页面#锚点]]` 先按完整目标再按页面部分解析，同页/`[[#锚点]]` 直接滚动，跨页打开后由 `wiki-editor.tsx` 滚动并高亮标题；聊天 `WikiLink` 解析时剥离锚点并同样跳转。
- Rust 侧 `relation_index.rs` / `wiki_move.rs`、`ingest-sanitize.ts`、`page-merge.ts` 原本已按 `#` 切分，未改。
- 测试：更新/新增 `lint.test.ts`、`lint-structural-core.test.ts`、`lint-fixes.test.ts`、`dedup.test.ts`、`wiki-reference-maintenance.integration.test.ts` 的锚点用例；`tsc --noEmit` 通过，mock 套件与改动前相比无新增失败。
