//! 从真实文件输入到审核结果的场景测试，不依赖保护模块内部实现。
use super::file_approval::*;
use super::fs::{apply_text_selection_edit, copy_directory, copy_file, delete_file, write_file, write_file_atomic, write_file_base64};
use std::fs;
use std::path::{Path, PathBuf};

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("llm-wiki-approval-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/policy.md"), "# 重要约定\n原始正文\n").unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn root(&self) -> String { self.0.to_string_lossy().into_owned() }
    fn file(&self) -> String { self.0.join("wiki/policy.md").to_string_lossy().into_owned() }
    fn protect(&self) { set_important_file(self.root(), self.file(), true).unwrap(); }
    fn state(&self) -> FileApprovalState { get_file_approvals(self.root()).unwrap() }
    fn propose(&self, content: &str) -> String {
        let error = guard_mutation(Path::new(&self.file()), Some(content.as_bytes()), "test.model").unwrap_err();
        assert!(error.contains("FILE_APPROVAL_REQUIRED"), "{error}");
        self.state().proposals.last().unwrap().id.clone()
    }
}

impl Drop for Project {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[tokio::test]
async fn important_file_stays_unchanged_until_the_exact_proposal_is_approved() {
    // 模拟入库使用的真实写入入口：提交成功也只能形成草稿，原文不变。
    let project = Project::new();
    project.protect();
    let original = fs::read_to_string(project.file()).unwrap();
    let error = write_file(project.file(), "# 模型新正文".to_string()).await.unwrap_err();
    assert!(error.contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), original);
    let state = project.state();
    assert_eq!(state.important_paths, vec!["wiki/policy.md"]);
    assert_eq!(state.proposals[0].original, original);
    assert_eq!(state.proposals[0].proposed.as_deref(), Some("# 模型新正文"));
    review_file_change(project.root(), state.proposals[0].id.clone(), true).unwrap();
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "# 模型新正文");
    assert_eq!(project.state().proposals[0].status, "approved");
    // 批准仅适用于这一份草稿，不授予模型后续永久写权限。
    assert!(write_file(project.file(), "下一次修改".to_string()).await.unwrap_err().contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "# 模型新正文");
}

#[test]
fn rejecting_a_proposal_preserves_the_original_and_records_the_decision() {
    let project = Project::new(); project.protect();
    let original = fs::read_to_string(project.file()).unwrap();
    let id = project.propose("待拒绝正文");
    review_file_change(project.root(), id.clone(), false).unwrap();
    assert_eq!(fs::read_to_string(project.file()).unwrap(), original);
    let state = project.state();
    assert_eq!(state.proposals[0].status, "rejected");
    assert!(state.proposals[0].reviewed_at.is_some());
    assert!(review_file_change(project.root(), id, true).is_err());
}

#[test]
fn manual_edit_invalidates_a_stale_proposal_without_losing_either_version() {
    let project = Project::new(); project.protect();
    let id = project.propose("模型草稿");
    save_human_file(project.file(), "用户后续编辑".to_string()).unwrap();
    let error = review_file_change(project.root(), id.clone(), true).unwrap_err();
    assert!(error.contains("FILE_APPROVAL_CONFLICT"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "用户后续编辑");
    assert_eq!(project.state().proposals[0].status, "pending");
    // 冲突只阻止批准，用户仍可拒绝旧草稿。
    review_file_change(project.root(), id, false).unwrap();
}

#[tokio::test]
async fn deletion_is_reviewed_and_a_directory_cannot_bypass_important_file_protection() {
    let project = Project::new(); project.protect();
    let error = delete_file(project.file()).await.unwrap_err();
    assert!(error.contains("FILE_APPROVAL_REQUIRED"));
    assert!(Path::new(&project.file()).exists());
    assert!(project.state().proposals[0].proposed.is_none());
    assert!(delete_file(project.0.join("wiki").to_string_lossy().into_owned()).await.is_err());
    assert!(Path::new(&project.file()).exists());
    let id = project.state().proposals[0].id.clone();
    review_file_change(project.root(), id, true).unwrap();
    assert!(!Path::new(&project.file()).exists());
    assert!(project.state().important_paths.is_empty());
    assert_eq!(project.state().proposals[0].status, "approved");
}

#[tokio::test]
async fn selection_edit_submits_the_complete_candidate_without_changing_the_original() {
    let project = Project::new(); project.protect();
    let original = fs::read_to_string(project.file()).unwrap();
    let error = apply_text_selection_edit(
        project.root(), project.file(), "# 重要约定\n".to_string(), "原始正文".to_string(),
        "\n".to_string(), "模型改写".to_string(),
    ).await.unwrap_err();
    assert!(error.contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), original);
    assert_eq!(project.state().proposals[0].proposed.as_deref(), Some("# 重要约定\n模型改写\n"));
}

#[tokio::test]
async fn atomic_binary_and_copy_writes_cannot_bypass_review() {
    let project = Project::new(); project.protect();
    let original = fs::read_to_string(project.file()).unwrap();
    assert!(write_file_atomic(project.file(), "atomic change".to_string()).await.unwrap_err().contains("FILE_APPROVAL_REQUIRED"));
    assert!(write_file_base64(project.file(), "YmluYXJ5IGNoYW5nZQ==".to_string()).await.unwrap_err().contains("FILE_APPROVAL_REQUIRED"));
    let source = project.0.join("copy.md");
    fs::write(&source, "copy change").unwrap();
    assert!(copy_file(source.to_string_lossy().into_owned(), project.file()).await.unwrap_err().contains("FILE_APPROVAL_REQUIRED"));
    let source_dir = project.0.join("source-tree");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(source_dir.join("policy.md"), "directory copy change").unwrap();
    assert!(copy_directory(source_dir.to_string_lossy().into_owned(), project.0.join("wiki").to_string_lossy().into_owned()).await.unwrap_err().contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), original);
    assert_eq!(project.state().proposals.len(), 4);
}

#[test]
fn agent_and_http_wiki_write_path_obeys_the_same_approval_boundary() {
    let project = Project::new(); project.protect();
    let original = fs::read_to_string(project.file()).unwrap();
    let error = crate::agent::tools::write_wiki_page_verified(&project.root(), "wiki/policy.md", "# Agent change", true).unwrap_err();
    assert!(error.contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(fs::read_to_string(project.file()).unwrap(), original);
    assert_eq!(project.state().proposals[0].source, "wiki.write_page");
}

#[test]
fn repeat_requests_reuse_the_pending_proposal_but_different_candidates_stay_separate() {
    let project = Project::new(); project.protect();
    let first = project.propose("候选 A");
    assert_eq!(project.propose("候选 A"), first);
    let second = project.propose("候选 B");
    assert_ne!(first, second);
    assert_eq!(project.state().proposals.len(), 2);
    review_file_change(project.root(), first, true).unwrap();
    assert!(review_file_change(project.root(), second, true).unwrap_err().contains("FILE_APPROVAL_CONFLICT"));
}

#[tokio::test]
async fn ordinary_files_and_unchanged_content_keep_their_existing_behavior() {
    let project = Project::new();
    write_file(project.file(), "普通修改".to_string()).await.unwrap();
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "普通修改");
    project.protect();
    write_file(project.file(), "普通修改".to_string()).await.unwrap();
    assert!(project.state().proposals.is_empty());
    set_important_file(project.root(), project.file(), false).unwrap();
    write_file(project.file(), "取消标记后修改".to_string()).await.unwrap();
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "取消标记后修改");
}

#[test]
fn invalid_state_fails_closed_and_model_writes_cannot_replace_the_policy() {
    let project = Project::new(); project.protect();
    let policy = project.0.join(".llm-wiki/file-approvals.json");
    assert!(guard_mutation(&policy, Some(b"{}"), "test.model").is_err());
    fs::write(&policy, "broken json").unwrap();
    assert!(guard_mutation(Path::new(&project.file()), Some(b"changed"), "test.model").is_err());
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "# 重要约定\n原始正文\n");
}

#[test]
fn nested_project_metadata_cannot_hide_a_parent_projects_important_file() {
    let project = Project::new(); project.protect();
    fs::create_dir_all(project.0.join("wiki/.llm-wiki")).unwrap();
    project.propose("不能绕过外层保护");
    assert_eq!(project.state().proposals.len(), 1);
    assert_eq!(fs::read_to_string(project.file()).unwrap(), "# 重要约定\n原始正文\n");
}

#[test]
fn marking_external_paths_or_project_metadata_is_rejected() {
    let project = Project::new();
    let outside = Project::new();
    assert!(set_important_file(project.root(), outside.file(), true).is_err());
    let metadata = project.0.join(".llm-wiki/settings.json");
    fs::write(&metadata, "{}").unwrap();
    assert!(set_important_file(project.root(), metadata.to_string_lossy().into_owned(), true).is_err());
}

#[cfg(unix)]
#[test]
fn changing_a_proposal_target_to_a_symlink_cannot_overwrite_another_file() {
    let project = Project::new(); project.protect();
    let id = project.propose("模型草稿");
    let outside = Project::new();
    fs::remove_file(project.file()).unwrap();
    std::os::unix::fs::symlink(outside.file(), project.file()).unwrap();
    assert!(review_file_change(project.root(), id, true).is_err());
    assert_eq!(fs::read_to_string(outside.file()).unwrap(), "# 重要约定\n原始正文\n");
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_protected_file_also_requires_approval() {
    let project = Project::new(); project.protect();
    let alias = project.0.join("wiki/alias.md");
    std::os::unix::fs::symlink(project.file(), &alias).unwrap();
    let error = guard_mutation(&alias, Some(b"alias update"), "test.model").unwrap_err();
    assert!(error.contains("FILE_APPROVAL_REQUIRED"));
    assert_eq!(project.state().proposals[0].path, "wiki/policy.md");
}
