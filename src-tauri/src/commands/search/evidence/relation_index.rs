//! 每项目共享的引用索引：页面只解析一次，修改时仅重算受影响的出边和反向引用。
use super::*;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
struct IndexedPage {
    revision: String,
    names: BTreeSet<String>,
    links: Vec<Value>,
    lookup_keys: BTreeSet<String>,
}

/// 名称索引保留所有同名候选，不能为提速而吞掉重名歧义。
#[derive(Clone, Default)]
pub(super) struct RelationIndex {
    initialized: bool,
    pages: BTreeMap<String, Arc<IndexedPage>>,
    names: BTreeMap<String, BTreeSet<String>>,
    references: BTreeMap<String, BTreeSet<String>>,
    outgoing: BTreeMap<String, Arc<Vec<Value>>>,
    incoming: BTreeMap<String, BTreeSet<(String, usize)>>,
}

impl RelationIndex {
    /// 版本未变时直接复用；新增、删除和改名同时影响引用目标的解析结果。
    fn synchronize(&mut self, pages: &BTreeMap<String, Page>) -> usize {
        let changed: BTreeSet<String> = self.pages.keys().chain(pages.keys()).filter(|path|
            self.pages.get(*path).map(|page| page.revision.as_str()) != pages.get(*path).map(|page| page.revision.as_str())
        ).cloned().collect();
        self.initialized = true;
        self.apply_changes(pages, changed)
    }

    fn apply_changes(&mut self, pages: &BTreeMap<String, Page>, changed: BTreeSet<String>) -> usize {
        let mut affected = changed.clone();
        let mut keys = BTreeSet::new();
        let mut parsed = 0;
        for path in &changed {
            keys.insert(path.clone());
            if let Some(old) = self.pages.remove(path) {
                for name in &old.names { remove_member(&mut self.names, name, path); keys.insert(name.clone()); }
                for key in &old.lookup_keys { remove_member(&mut self.references, key, path); }
            }
            if let Some(page) = pages.get(path) {
                let mut names: BTreeSet<String> = extract_list_frontmatter(&page.text, "aliases").into_iter().collect();
                names.extend([file_stem(path), page.title.clone()]);
                let links = parse_links(page);
                let lookup_keys: BTreeSet<String> = links.iter().flat_map(|link|
                    lookup_keys(link["targetText"].as_str().unwrap_or_default())
                ).collect();
                for name in &names { self.names.entry(name.clone()).or_default().insert(path.clone()); keys.insert(name.clone()); }
                for key in &lookup_keys { self.references.entry(key.clone()).or_default().insert(path.clone()); }
                self.pages.insert(path.clone(), Arc::new(IndexedPage { revision: page.revision.clone(), names, links, lookup_keys }));
                parsed += 1;
            }
        }
        // 未解析成功的链接也保留依赖，目标创建或从重名变唯一时能自动恢复。
        for key in keys { if let Some(sources) = self.references.get(&key) { affected.extend(sources.iter().cloned()); } }
        for path in affected {
            if let Some(old) = self.outgoing.remove(&path) {
                for (index, edge) in old.iter().enumerate() { if let Some(target) = edge["toPath"].as_str() { remove_member(&mut self.incoming, target, &(path.clone(), index)); } }
            }
            let Some(page) = self.pages.get(&path) else { continue; };
            let edges: Vec<Value> = page.links.iter().map(|link| {
                let matches = self.resolve(&path, link["targetText"].as_str().unwrap_or_default());
                let mut edge = link.clone();
                edge["toPath"] = json!(if matches.len() == 1 { matches.first() } else { None });
                edge["resolution"] = json!(if matches.len() == 1 { "resolved" } else if matches.is_empty() { "missing" } else { "ambiguous" });
                edge
            }).collect();
            for (index, edge) in edges.iter().enumerate() { if let Some(target) = edge["toPath"].as_str() { self.incoming.entry(target.into()).or_default().insert((path.clone(), index)); } }
            self.outgoing.insert(path, Arc::new(edges));
        }
        parsed
    }

    fn resolve(&self, from: &str, target: &str) -> Vec<String> {
        let decoded = normalized_target(target);
        if decoded.is_empty() { return vec![from.into()]; }
        if decoded.contains("://") || decoded.starts_with("data:") { return Vec::new(); }
        let exact: BTreeSet<String> = exact_paths(&decoded).into_iter().filter(|path| self.pages.contains_key(path)).collect();
        if !exact.is_empty() { return exact.into_iter().collect(); }
        // 文件名匹配忽略 .md，标题和 aliases 维持原有精确匹配规则。
        let filename = decoded.trim_end_matches(".md");
        let mut matches = self.names.get(&decoded).cloned().unwrap_or_default();
        if filename != decoded {
            matches.extend(self.names.get(filename).into_iter().flatten().filter(|path| file_stem(path) == filename).cloned());
        }
        matches.into_iter().collect()
    }

    pub(super) fn outgoing(&self, path: &str) -> &[Value] {
        self.outgoing.get(path).map(|edges| edges.as_slice()).unwrap_or_default()
    }

    /// 按源页面排序，保持图谱候选截断和证据关系的确定性；不扫描无关页面。
    pub(super) fn for_pages(&self, paths: &BTreeSet<String>) -> Vec<Value> {
        let mut selected = BTreeMap::new();
        for path in paths {
            for (index, edge) in self.outgoing(path).iter().enumerate() { selected.insert((path.clone(), index), edge.clone()); }
            for (source, index) in self.incoming.get(path).into_iter().flatten() {
                if let Some(edge) = self.outgoing(source).get(*index) { selected.insert((source.clone(), *index), edge.clone()); }
            }
        }
        selected.into_values().collect()
    }
}

fn remove_member<T: Ord>(index: &mut BTreeMap<String, BTreeSet<T>>, key: &str, member: &T) {
    if let Some(paths) = index.get_mut(key) {
        paths.remove(member);
        if paths.is_empty() { index.remove(key); }
    }
}

fn normalized_target(target: &str) -> String {
    target.split('|').next().unwrap_or_default().split('#').next().unwrap_or_default().trim().replace("%20", " ")
}

fn exact_paths(decoded: &str) -> [String; 4] {
    [decoded.into(), format!("{decoded}.md"), format!("wiki/{decoded}"), format!("wiki/{decoded}.md")]
}

fn lookup_keys(target: &str) -> BTreeSet<String> {
    let decoded = normalized_target(target);
    let mut keys: BTreeSet<String> = exact_paths(&decoded).into_iter().collect();
    keys.insert(decoded.trim_end_matches(".md").into());
    keys
}

/// 项目之间不共用单槽缓存；更新在写锁外计算，已发布快照可供并发读者复用。
#[derive(Default)]
struct ProjectIndex {
    snapshot: RwLock<Arc<RelationIndex>>,
    update: Mutex<()>,
}
static INDEXES: OnceLock<Mutex<BTreeMap<std::path::PathBuf, Arc<ProjectIndex>>>> = OnceLock::new();

fn project_index(root: &Path) -> Result<Arc<ProjectIndex>, String> {
    Ok(INDEXES.get_or_init(Default::default).lock().map_err(|_| "关系索引注册表不可用")?
        .entry(root.to_path_buf()).or_default().clone())
}

pub(super) fn snapshot(project_path: &str, pages: &BTreeMap<String, Page>) -> Result<Arc<RelationIndex>, String> {
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    let project = project_index(&root)?;
    let _update = project.update.lock().map_err(|_| "关系索引更新锁不可用")?;
    let current = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.clone();
    if current.initialized && current.pages.len() == pages.len() && pages.iter().all(|(path, page)| current.pages.get(path).is_some_and(|old| old.revision == page.revision)) { return Ok(current); }
    let mut next = (*current).clone();
    next.synchronize(pages);
    let next = Arc::new(next);
    *project.snapshot.write().map_err(|_| "关系索引快照不可用")? = next.clone();
    Ok(next)
}

/// 显式页读取直接查询出入边；首次未初始化时补建一次，不再为每次读页扫描全库。
pub(super) fn for_page(project_path: &str, path: &str) -> Result<Vec<Value>, String> {
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    let project = project_index(&root)?;
    let initialized = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.initialized;
    if !initialized { refresh(project_path, None)?; }
    refresh(project_path, Some(&BTreeSet::from([root.join(path)])))?;
    let snapshot = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.clone();
    Ok(snapshot.for_pages(&BTreeSet::from([path.into()])))
}

/// 入库维护复用出入链和未解析依赖；只刷新声明的变更页，不重新扫描全库。
pub(super) fn maintenance_context(project_path: &str, paths: Vec<String>, targets: Vec<String>) -> Result<Value, String> {
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    if paths.iter().any(|path| !safe_relative(path, "wiki")) { return Err("引用维护路径无效".into()); }
    let project = project_index(&root)?;
    let previous = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.clone();
    let mut changed: BTreeSet<_> = paths.iter().map(|path| root.join(path)).collect();
    // 删除/改名事件可能尚未送达；不能因缓存中残留 A 而误判为“A 仍保留”。
    for target in &targets {
        for path in previous.resolve("", target) { changed.insert(root.join(path)); }
    }
    refresh(project_path, Some(&changed))?;
    let index = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.clone();
    let mut affected: BTreeSet<String> = paths.into_iter().collect();
    for target in targets {
        for key in lookup_keys(&target) {
            if let Some(sources) = index.references.get(&key) { affected.extend(sources.iter().cloned()); }
        }
        for path in index.resolve("", &target) {
            for (source, _) in index.incoming.get(&path).into_iter().flatten() { affected.insert(source.clone()); }
        }
    }
    let pages: Vec<Value> = index.pages.iter().map(|(path, page)| json!({"path":path,"names":page.names})).collect();
    let relations: Vec<Value> = affected.iter().flat_map(|path| index.outgoing(path).iter().cloned()).collect();
    Ok(json!({"pages":pages,"affectedPaths":affected,"relations":relations}))
}

/// 启动时全量建立一次；普通事件只读取变更文件，目录改名则核对受影响的子树。
pub(super) fn refresh(project_path: &str, paths: Option<&BTreeSet<std::path::PathBuf>>) -> Result<(), String> {
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    let project = project_index(&root)?;
    let _update = project.update.lock().map_err(|_| "关系索引更新锁不可用")?;
    let current = project.snapshot.read().map_err(|_| "关系索引快照不可用")?.clone();
    let mut next;
    if paths.is_none() || !current.initialized {
        let request = Request { project_path: root.to_string_lossy().into_owned(), scene: "qa".into(), targets: Vec::new(), scope: None, channels: None, budget: None, checkpoint: None };
        let mut warnings = Vec::new();
        let pages = read_pages(&request, "wiki", &mut warnings, Instant::now() + Duration::from_secs(60))?;
        if !warnings.is_empty() { return Err(warnings.join("；")); }
        next = (*current).clone();
        next.synchronize(&pages);
    } else if let Some(paths) = paths {
        let mut changed = BTreeSet::new();
        for path in paths {
            let Ok(relative) = path.strip_prefix(&root) else { continue; };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if path.is_dir() || !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) {
                changed.extend(current.pages.keys().filter(|page| *page == &relative || page.starts_with(&format!("{relative}/"))).cloned());
            }
            if path.is_dir() {
                changed.extend(WalkDir::new(path).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file())
                    .map(|entry| relative_to_project(root.to_str().unwrap_or_default(), entry.path())));
            } else { changed.insert(relative); }
        }
        let mut pages = BTreeMap::new();
        for path in &changed {
            if let Some(page) = read_changed_page(&root, path)? { pages.insert(path.clone(), page); }
        }
        changed.retain(|path| current.pages.get(path).map(|page| page.revision.as_str()) != pages.get(path).map(|page| page.revision.as_str()));
        if changed.is_empty() { return Ok(()); }
        next = (*current).clone();
        next.apply_changes(&pages, changed);
    } else { return Ok(()); }
    *project.snapshot.write().map_err(|_| "关系索引快照不可用")? = Arc::new(next);
    Ok(())
}

fn read_changed_page(root: &Path, path: &str) -> Result<Option<Page>, String> {
    if !safe_relative(path, "wiki") || path.split('/').any(|part| part.starts_with('.')) || !Path::new(path).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) { return Ok(None); }
    let absolute = root.join(path);
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8_000_000 { return Ok(None); }
    if !fs::canonicalize(&absolute).map_err(|error| error.to_string())?.starts_with(root) { return Ok(None); }
    let text = fs::read_to_string(&absolute).map_err(|error| error.to_string())?;
    Ok(Some(Page { path: path.into(), title: extract_title(&text, Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or_default()), revision: revision(&text), text }))
}

/// 代码示例不进入关系图；保留原方向和原始行号。
fn parse_links(page: &Page) -> Vec<Value> {
    let mut result = Vec::new();
    let mut fence: Option<char> = None;
    for (index, line) in page.text.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap();
            if fence == Some(marker) { fence = None; } else if fence.is_none() { fence = Some(marker); }
            continue;
        }
        if fence.is_some() || line.starts_with("    ") || line.starts_with('\t') { continue; }
        let mut rest = line;
        while let Some(start) = rest.find("[[") {
            rest = &rest[start + 2..];
            let Some(end) = rest.find("]]") else { break; };
            let target = rest[..end].split('|').next().unwrap_or_default();
            push_link(&mut result, page, target, "wikilink", Some(index + 1), Some(line));
            rest = &rest[end + 2..];
        }
        let mut rest = line;
        while let Some(start) = rest.find("](") {
            let image = rest[..start].rfind('[').is_some_and(|open| open > 0 && rest.as_bytes()[open - 1] == b'!');
            rest = &rest[start + 2..];
            let Some(end) = rest.find(')') else { break; };
            let target = rest[..end].split_whitespace().next().unwrap_or_default();
            if !image && target.split('#').next().unwrap_or_default().ends_with(".md") {
                let parent = Path::new(&page.path).parent().unwrap_or(Path::new("wiki"));
                let mut normalized = Vec::new();
                for part in parent.join(target.split('#').next().unwrap_or_default()).components() {
                    match part { std::path::Component::ParentDir => { normalized.pop(); }, std::path::Component::Normal(value) => normalized.push(value.to_string_lossy().into_owned()), _ => {} }
                }
                let target = format!("{}{}", normalized.join("/"), target.find('#').map(|offset| &target[offset..]).unwrap_or(""));
                push_link(&mut result, page, &target, "markdownLink", Some(index + 1), Some(line));
            }
            rest = &rest[end + 1..];
        }
    }
    for target in extract_related_frontmatter(&page.text) { push_link(&mut result, page, &target, "related", None, None); }
    result
}

fn push_link(result: &mut Vec<Value>, page: &Page, target: &str, kind: &str, line: Option<usize>, nearby: Option<&str>) {
    result.push(json!({"id":format!("relation-{}-{}", revision(&page.path), result.len()),"fromPath":page.path,"fromRevision":page.revision,
        "targetText":target,"kind":kind,"anchor":target.split_once('#').map(|(_, anchor)| anchor),
        "range":line.map(|line| json!({"startLine":line,"endLine":line})),"nearbyText":nearby,"usedForRecall":false}));
}

#[cfg(test)]
pub(super) fn relations(pages: &BTreeMap<String, Page>) -> Vec<Value> {
    let mut index = RelationIndex::default();
    index.synchronize(pages);
    index.for_pages(&pages.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(path: &str, text: &str) -> Page {
        Page { path: path.into(), title: extract_title(text, Path::new(path).file_name().unwrap().to_str().unwrap()), text: text.into(), revision: revision(text) }
    }

    fn all(index: &RelationIndex) -> Vec<Value> { index.for_pages(&index.pages.keys().cloned().collect()) }

    /// 入库既能定位缺失名称的原始引用，也能读取有效目标的反向引用；增量刷新不读取无关文件。
    #[test]
    fn maintenance_context_tracks_missing_names_and_refreshes_only_changed_pages() {
        let root = std::env::temp_dir().join(format!("relation-maintenance-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/history.md"), "---\nrelated: [A]\n---\n# 历史\n[[A#章节]] [[B]]").unwrap();
        fs::write(root.join("wiki/B.md"), "# B\n## 章节").unwrap();
        fs::write(root.join("wiki/unrelated.md"), "# 无关页").unwrap();
        let pp = root.to_str().unwrap();
        let context = maintenance_context(pp, vec!["wiki/B.md".into()], vec!["A".into()]).unwrap();
        assert_eq!(context["affectedPaths"], json!(["wiki/B.md", "wiki/history.md"]));
        assert!(context["relations"].as_array().unwrap().iter().any(|edge| edge["targetText"] == "A#章节" && edge["resolution"] == "missing"));
        // 若查询扫描了无关页，此处的非法 UTF-8 会令调用失败。
        fs::write(root.join("wiki/unrelated.md"), [0xff]).unwrap();
        fs::write(root.join("wiki/B.md"), "# 新标题\n## 章节").unwrap();
        let next = maintenance_context(pp, vec!["wiki/B.md".into()], vec!["B".into()]).unwrap();
        assert!(next["pages"].as_array().unwrap().iter().any(|page| page["names"].as_array().unwrap().contains(&json!("新标题"))));
        fs::write(root.join("wiki/A.md"), "# A").unwrap();
        refresh(pp, Some(&BTreeSet::from([root.join("wiki/A.md")]))).unwrap();
        fs::remove_file(root.join("wiki/A.md")).unwrap();
        let deleted = maintenance_context(pp, vec!["wiki/B.md".into()], vec!["A".into()]).unwrap();
        assert!(deleted["pages"].as_array().unwrap().iter().all(|page| page["path"] != "wiki/A.md"));
        assert!(maintenance_context(pp, vec!["../outside.md".into()], vec![]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    /// 首次全量解析，后续只解析修改页；无关页面的已解析关系保持同一份快照。
    #[test]
    fn unchanged_pages_and_unrelated_edges_are_reused() {
        let mut pages = BTreeMap::from([
            ("wiki/a.md".into(), page("wiki/a.md", "# A\n[[b]]")),
            ("wiki/b.md".into(), page("wiki/b.md", "# B\n[[c]]")),
            ("wiki/c.md".into(), page("wiki/c.md", "# C\n")),
        ]);
        let mut index = RelationIndex::default();
        assert_eq!(index.synchronize(&pages), 3);
        assert_eq!(index.synchronize(&pages), 0);
        let unrelated = index.outgoing["wiki/b.md"].clone();
        pages.insert("wiki/a.md".into(), page("wiki/a.md", "# A\n正文更新。\n[[b#配置]]"));
        assert_eq!(index.synchronize(&pages), 1);
        assert!(Arc::ptr_eq(&unrelated, &index.outgoing["wiki/b.md"]));
        assert_eq!(index.outgoing("wiki/a.md")[0]["anchor"], "配置");
        assert_eq!(index.for_pages(&BTreeSet::from(["wiki/b.md".into()])).len(), 2);
    }

    /// 新建目标、同名歧义、改名和删除都必须回填已有引用，而非只处理修改页的出边。
    #[test]
    fn target_lifecycle_updates_backlinks_without_reparsing_sources() {
        let mut pages = BTreeMap::from([("wiki/a.md".into(), page("wiki/a.md", "# A\n[[目标]]"))]);
        let mut index = RelationIndex::default();
        index.synchronize(&pages);
        assert_eq!(index.outgoing("wiki/a.md")[0]["resolution"], "missing");
        pages.insert("wiki/b.md".into(), page("wiki/b.md", "---\ntitle: B\naliases: [目标]\n---\n"));
        assert_eq!(index.synchronize(&pages), 1);
        assert_eq!(index.outgoing("wiki/a.md")[0]["toPath"], "wiki/b.md");
        assert_eq!(index.for_pages(&BTreeSet::from(["wiki/b.md".into()])).len(), 1);
        pages.insert("wiki/c.md".into(), page("wiki/c.md", "# 目标\n"));
        assert_eq!(index.synchronize(&pages), 1);
        assert_eq!(index.outgoing("wiki/a.md")[0]["resolution"], "ambiguous");
        pages.insert("wiki/b.md".into(), page("wiki/b.md", "# B\n移除旧别名。"));
        assert_eq!(index.synchronize(&pages), 1);
        assert_eq!(index.outgoing("wiki/a.md")[0]["toPath"], "wiki/c.md");
        pages.remove("wiki/c.md");
        assert_eq!(index.synchronize(&pages), 0);
        assert_eq!(index.outgoing("wiki/a.md")[0]["resolution"], "missing");
        assert!(index.incoming.is_empty());
    }

    /// 完整路径优先级和 .md 文件名解析规则须与旧实现一致，不能扩大别名匹配范围。
    #[test]
    fn exact_paths_precede_aliases_and_markdown_suffix_only_applies_to_stems() {
        let pages = BTreeMap::from([
            ("wiki/a.md".into(), page("wiki/a.md", "# A\n[[b]]\n[[b.md]]\n[[别名.md]]\n[[a#本页]]")),
            ("wiki/b.md".into(), page("wiki/b.md", "# B\n")),
            ("wiki/nested/b.md".into(), page("wiki/nested/b.md", "---\ntitle: 其他\naliases: [b, 别名]\n---\n")),
        ]);
        let edges = relations(&pages);
        assert_eq!(edges[0]["toPath"], "wiki/b.md");
        assert_eq!(edges[1]["toPath"], "wiki/b.md");
        assert_eq!(edges[2]["resolution"], "missing");
        assert_eq!(edges[3]["toPath"], "wiki/a.md");
    }

    /// 按项目复用快照；切换项目不能挤掉另一项目的索引，旧读者不受后续更新影响。
    #[test]
    fn project_snapshots_are_isolated_reused_and_immutable() {
        let first = std::env::temp_dir().join(format!("relation-index-{}", uuid::Uuid::new_v4()));
        let second = std::env::temp_dir().join(format!("relation-index-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&first).unwrap(); fs::create_dir_all(&second).unwrap();
        let mut pages = BTreeMap::from([("wiki/a.md".into(), page("wiki/a.md", "# A\n[[b]]"))]);
        let original = snapshot(first.to_str().unwrap(), &pages).unwrap();
        let other = snapshot(second.to_str().unwrap(), &pages).unwrap();
        assert!(!Arc::ptr_eq(&original, &other));
        assert!(Arc::ptr_eq(&original, &snapshot(first.to_str().unwrap(), &pages).unwrap()));
        pages.insert("wiki/b.md".into(), page("wiki/b.md", "# B\n"));
        let updated = snapshot(first.to_str().unwrap(), &pages).unwrap();
        assert_eq!(updated.outgoing("wiki/a.md")[0]["resolution"], "resolved");
        assert_eq!(original.outgoing("wiki/a.md")[0]["resolution"], "missing");
        fs::remove_dir_all(first).unwrap(); fs::remove_dir_all(second).unwrap();
    }

    /// 使用真实文件重放文件监听：目录改名、新目标创建和删除后，入边与出边同步变化。
    #[test]
    fn filesystem_updates_handle_page_and_directory_renames() {
        let root = std::env::temp_dir().join(format!("relation-events-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/old")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("wiki/a.md"), "# A\n[[wiki/old/b.md]]\n[[新目标]]").unwrap();
        fs::write(root.join("wiki/old/b.md"), "# B\n[[a]]").unwrap();
        let pp = root.to_str().unwrap();
        refresh(pp, None).unwrap();
        fs::rename(root.join("wiki/old"), root.join("wiki/new")).unwrap();
        refresh(pp, Some(&BTreeSet::from([root.join("wiki/old"), root.join("wiki/new")]))).unwrap();
        let edges = for_page(pp, "wiki/a.md").unwrap();
        assert!(edges.iter().any(|edge| edge["fromPath"] == "wiki/new/b.md" && edge["toPath"] == "wiki/a.md"));
        assert!(edges.iter().any(|edge| edge["targetText"] == "wiki/old/b.md" && edge["resolution"] == "missing"));
        fs::write(root.join("wiki/c.md"), "# 新目标\n").unwrap();
        refresh(pp, Some(&BTreeSet::from([root.join("wiki/c.md")]))).unwrap();
        assert!(for_page(pp, "wiki/a.md").unwrap().iter().any(|edge| edge["toPath"] == "wiki/c.md"));
        fs::remove_file(root.join("wiki/new/b.md")).unwrap();
        refresh(pp, Some(&BTreeSet::from([root.join("wiki/new/b.md")]))).unwrap();
        assert!(for_page(pp, "wiki/a.md").unwrap().iter().all(|edge| edge["fromPath"] != "wiki/new/b.md"));
        fs::remove_dir_all(root).unwrap();
    }

    /// 增量结果须与全量重建一致，同时保留旧页未修改关系的稳定标识。
    #[test]
    fn incremental_results_match_full_rebuild_after_mixed_updates() {
        let mut pages = BTreeMap::from([
            ("wiki/a.md".into(), page("wiki/a.md", "# A\n[[别名]]\n[B](b.md#章节)\n```md\n[[不是真实关系]]\n```")),
            ("wiki/b.md".into(), page("wiki/b.md", "---\ntitle: B\naliases: [别名]\nrelated: [a]\n---\n")),
        ]);
        let mut index = RelationIndex::default();
        index.synchronize(&pages);
        let mutations = [
            ("wiki/c.md", Some("# 别名\n")),
            ("wiki/b.md", Some("# 新标题\n[[c]]")),
            ("wiki/c.md", None),
            ("wiki/a.md", Some("# A\n[[新标题]]\n")),
        ];
        for (path, text) in mutations {
            if let Some(text) = text { pages.insert(path.into(), page(path, text)); } else { pages.remove(path); }
            index.synchronize(&pages);
            assert_eq!(all(&index), relations(&pages));
        }
    }
}
