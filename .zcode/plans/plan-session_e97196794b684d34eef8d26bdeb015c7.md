## 目标

在 Skills 管理页（`src/components/settings/sections/skills-section.tsx`）点击某个 Skill 的"编辑"按钮，弹出大对话框：**左侧是该技能文件夹的文件树，右侧是所选文件的查看/编辑视图**，保存直接写回磁盘。复用现有 `WikiReader`（查看）和纯文本 textarea（编辑）模式。

## 后端改动（`src-tauri/src/agent/skills.rs`）

1. **`AvailableAgentSkill` 增加 `location: String`**（SKILL.md 绝对路径）：`list_available_skills` 里 `load_skill_path` 已算出该路径，直接透传到结构体。
2. **新增命令 `agent_list_skill_files(project_path, id) -> Vec<SkillFileInfo>`**：返回该技能目录下所有文件的相对路径列表（`{ relative_path, size }`，平铺，前端按路径缩进渲染成树）。实现要点：
   - 先用现有 `load_one_skill_from_roots` 定位到该技能的 `base_dir`；
   - 递归遍历，复用现有安全防护（跳过符号链接、隐藏目录、`node_modules`，单文件上限 `MAX_SKILL_FILE_BYTES`）；
   - 相对路径规范化为 `/` 分隔；
   - 在 `lib.rs` 的 `generate_handler!` 注册。
3. 读写文件内容**不需要新命令**：前端用现有 `readFile` / `writeFile`（`src/commands/fs.ts`），传 `baseDir + "/" + relativePath` 的绝对路径。`write_file` 自带原子写 + 文件历史记录。

## 前端改动

### `skills-section.tsx`
- 每张技能卡片标题旁加"编辑"按钮（lucide `Pencil` 图标），点击打开对话框。接口 `AvailableAgentSkill` 增加 `location` 字段。

### 新组件 `src/components/settings/sections/skill-editor-dialog.tsx`
受控对话框（`Dialog` 组件，`max-w-4xl`，高 `80vh`）：
- **左栏（约 240px）**：文件列表，按相对路径缩进展示目录层级；`SKILL.md` 置顶加粗；目录节点可折叠。选中项高亮。数据来自 `agent_list_skill_files`。
- **右栏**：所选文件的内容视图，顶部工具条：
  - 文件名 + "查看 / 编辑"模式切换（默认查看）；
  - 查看模式：`WikiReader`（传 `filePath` 绝对路径）；
  - 编辑模式：等宽 textarea（与 wiki-editor 编辑模式一致），底部"保存"按钮 → `writeFile`，成功后显示已保存提示；若编辑的是 SKILL.md，保存后回调父组件重新 `scan()` 刷新 name/description；
  - 附件类文件（.sh/.json 等）查看模式直接等宽只读文本展示，不走 WikiReader 渲染。
- 切换文件或关闭对话框时若有未保存修改，提示确认。
- 打开对话框时调用 `agent_list_skill_files` + 默认选中 SKILL.md 并 `readFile`。

## i18n（4 个语言文件，注意 `i18n-parity.test.ts` 强制键同步）

`settings.sections.skills` 下新增：`editSkill`、`files`、`view`、`edit`、`save`、`saved`、`unsavedConfirm`、`loadError`、`saveError`、`emptyFolder` 等键，zh/en/it/ru 四份同步。

## 测试

- **Rust**（`skills.rs` 测试模块）：改造现有 `list_available_skills_*` 测试断言 `location` 正确；新增 `agent_list_skill_files` 测试——含嵌套目录、跳过符号链接/隐藏文件、技能不存在时返回空。
- **前端**：新增 `skill-editor-dialog.test.tsx`：打开后文件树列出文件并选中 SKILL.md、切换编辑并保存调用 writeFile、保存 SKILL.md 后触发 rescan、未保存修改时切换文件弹确认。

## 不做的事

- 不做新建/删除/重命名文件，只做查看+编辑现有文件。
- 不引入 CodeMirror/Monaco，保持与 wiki 编辑器一致的 textarea 体验。
- 不改扫描逻辑与启用/禁用功能。