//! Schema 职责拆分：与前端共享兼容约定，普通 Agent 只加载核心规则。
use std::{fs, path::Path};

#[derive(Debug, Default)]
pub struct ProjectSchemaParts {
    pub core: String,
    pub rules: String,
    pub modules: String,
}

/// 忽略代码围栏中的标题，按完整章节拆分；未知自定义规范保留在核心中。
pub fn split_project_schema(markdown: &str) -> ProjectSchemaParts {
    let mut sections: [Vec<&str>; 3] = Default::default();
    let mut kind = 0;
    let mut level = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in markdown.lines() {
        let text = line.trim_start_matches(' ');
        let indent = line.len() - text.len();
        let first = text.chars().next().unwrap_or_default();
        let marker_len = text.chars().take_while(|c| *c == first).count();
        if indent <= 3 && matches!(first, '`' | '~') && marker_len >= 3 {
            match fence {
                None => fence = Some((first, marker_len)),
                Some((marker, length))
                    if first == marker
                        && marker_len >= length
                        && text[marker_len..].trim().is_empty() =>
                {
                    fence = None;
                }
                _ => {}
            }
        } else if fence.is_none() && indent <= 3 {
            let heading_level = text.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&heading_level)
                && text[heading_level..].starts_with(char::is_whitespace)
                && (kind == 0 || heading_level <= level)
            {
                let title = text[heading_level..]
                    .trim()
                    .trim_end_matches('#')
                    .trim()
                    .to_lowercase();
                kind = match title.as_str() {
                    "business modules" | "业务模块" => 2,
                    "naming conventions" | "frontmatter" | "index format" | "log format"
                    | "cross-referencing rules"
                    | "命名规范" | "命名约定" | "前置元数据" | "索引格式" | "日志格式"
                    | "交叉引用规则" => 1,
                    _ => 0,
                };
                level = heading_level;
            }
        }
        sections[kind].push(line);
    }
    ProjectSchemaParts {
        core: sections[0].join("\n").trim().to_string(),
        rules: sections[1].join("\n").trim().to_string(),
        modules: sections[2].join("\n").trim().to_string(),
    }
}

/// 先拆分再截断，避免体积较大的模块字典遮蔽后面的页面类型或自定义约束。
pub fn read_core_schema(root: &Path) -> Option<String> {
    let primary = root.join("schema.md");
    let path = if primary.exists() {
        primary
    } else {
        root.join("wiki/schema.md")
    };
    let parts = split_project_schema(&fs::read_to_string(path).ok()?);
    (!parts.core.is_empty()).then_some(parts.core)
}

/// 仅在创建新项目时调用；空模块文件不会启用分类，之后可直接编辑。
pub fn write_project_schema(root: &Path, markdown: &str) -> Result<(), String> {
    let parts = split_project_schema(markdown);
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    for (path, value) in [
        ("schema.md", parts.core),
        ("page-rules.md", parts.rules),
        ("business-modules.md", parts.modules),
    ] {
        let content = if value.is_empty() { value } else { format!("{value}\n") };
        fs::write(root.join(path), content)
            .map_err(|err| format!("Failed to write {path}: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_sections_match_shared_fixtures() {
        // 两端使用同一组输入输出，防止桌面聊天与入库对章节职责产生分歧。
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/test-helpers/fixtures/project-schema.json"
        )).unwrap();
        for case in cases.as_array().unwrap() {
            let parts = split_project_schema(case["input"].as_str().unwrap());
            assert_eq!(parts.core, case["core"].as_str().unwrap(), "{} core", case["name"]);
            assert_eq!(parts.rules, case["rules"].as_str().unwrap(), "{} rules", case["name"]);
            assert_eq!(parts.modules, case["modules"].as_str().unwrap(), "{} modules", case["name"]);
        }
    }

    #[test]
    fn new_project_files_keep_rules_out_of_agent_context() {
        let root = std::env::temp_dir().join(format!("schema-split-{}", uuid::Uuid::new_v4()));
        write_project_schema(&root, "# Schema\n## Page Types\nCore\n## Frontmatter\nFields\n## Business Modules\nDictionary").unwrap();
        assert_eq!(read_core_schema(&root).unwrap(), "# Schema\n## Page Types\nCore");
        assert_eq!(fs::read_to_string(root.join("page-rules.md")).unwrap(), "## Frontmatter\nFields\n");
        assert_eq!(fs::read_to_string(root.join("business-modules.md")).unwrap(), "## Business Modules\nDictionary\n");
        fs::remove_dir_all(root).unwrap();
    }
}
