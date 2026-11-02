//! 审阅事项统一增量提交；保留其他写入者新增的事项与人工处理状态。
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

#[tauri::command]
pub fn merge_review_items(project_path: String, items: Vec<Value>) -> Result<Vec<Value>, String> {
    let _mutation = crate::mutation::lock()?;
    merge_items(&project_path, items)
}

fn merge_items(project_path: &str, incoming: Vec<Value>) -> Result<Vec<Value>, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let existing: Vec<Value> = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("审阅记录损坏，停止覆盖：{error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    let mut by_id = BTreeMap::new();
    let mut order = Vec::new();
    for mut item in existing.into_iter().chain(incoming) {
        let id = crate::api_server::stable_review_id(&item).ok_or("审阅事项身份无效")?;
        if let Some(old_id) = item["id"].as_str().filter(|old| *old != id).map(str::to_string) {
            let mut aliases = item["legacyIds"].as_array().cloned().unwrap_or_default();
            if !aliases.contains(&Value::String(old_id.clone())) { aliases.push(Value::String(old_id)); }
            item["legacyIds"] = Value::Array(aliases);
        }
        item["id"] = Value::String(id.clone());
        if let Some(previous) = by_id.get(&id) {
            item = merge_item(previous, item);
        } else { order.push(id.clone()); }
        by_id.insert(id, item);
    }
    let result: Vec<Value> = order.into_iter().filter_map(|id| by_id.remove(&id)).collect();
    crate::mutation::atomic_write(&path, &serde_json::to_vec_pretty(&result).map_err(|error| error.to_string())?)?;
    Ok(result)
}

fn merge_item(previous: &Value, mut incoming: Value) -> Value {
    let previous_time = previous["resolutionUpdatedAt"].as_i64().unwrap_or(0);
    let incoming_time = incoming["resolutionUpdatedAt"].as_i64().unwrap_or(0);
    let keep_previous = previous_time > incoming_time || (previous_time == incoming_time && previous["resolved"].as_bool() == Some(true));
    let resolved = if previous_time > 0 || incoming_time > 0 {
        if keep_previous { previous["resolved"].as_bool().unwrap_or(false) } else { incoming["resolved"].as_bool().unwrap_or(false) }
    } else { previous["resolved"].as_bool().unwrap_or(false) || incoming["resolved"].as_bool().unwrap_or(false) };
    if let Some(fields) = incoming.as_object_mut() {
        // 未随本次请求携带的兼容字段不丢弃。
        if let Some(old) = previous.as_object() {
            for (key, value) in old { fields.entry(key.clone()).or_insert_with(|| value.clone()); }
        }
        fields.insert("resolved".to_string(), Value::Bool(resolved));
        if keep_previous {
            for key in ["resolvedAction", "resolvedEvidenceVersion", "dismissed", "hidden", "resolutionUpdatedAt"] {
                if let Some(value) = previous.get(key) { fields.insert(key.to_string(), value.clone()); }
            }
        }
        if !resolved { fields.remove("resolvedAction"); fields.remove("resolvedEvidenceVersion"); fields.remove("dismissed"); }
        for key in ["runIds", "legacyIds", "affectedPages"] {
            let mut values = previous[key].as_array().cloned().unwrap_or_default();
            for value in fields.get(key).and_then(Value::as_array).into_iter().flatten() {
                if !values.contains(value) { values.push(value.clone()); }
            }
            if !values.is_empty() { fields.insert(key.to_string(), Value::Array(values)); }
        }
    }
    incoming
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stale_save_preserves_api_resolution_and_new_evidence_is_independent() {
        let root = std::env::temp_dir().join(format!("review-state-{}", uuid::Uuid::new_v4()));
        let project = root.to_str().unwrap();
        let original = json!({"schemaVersion":2,"logicalId":"claim","evidenceVersion":"v1","type":"coverage","title":"校验","resolved":true,"resolvedAction":"API"});
        merge_items(project, vec![original.clone()]).unwrap();
        let mut stale = original.clone(); stale["resolved"] = json!(false); stale.as_object_mut().unwrap().remove("resolvedAction");
        let mut changed = stale.clone(); changed["evidenceVersion"] = json!("v2");
        let saved = merge_items(project, vec![stale, changed]).unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0]["resolvedAction"], "API");
        assert_eq!(saved[1]["resolved"], false);
        let mut hidden = original.clone(); hidden["hidden"] = json!(true); hidden["resolutionUpdatedAt"] = json!(1);
        merge_items(project, vec![hidden.clone()]).unwrap();
        let mut reopened = hidden.clone(); reopened["resolved"] = json!(false); reopened["hidden"] = json!(false); reopened["resolutionUpdatedAt"] = json!(2);
        let saved = merge_items(project, vec![reopened, hidden]).unwrap();
        assert_eq!(saved[0]["resolved"], false);
        assert_eq!(saved[0]["hidden"], false);
        fs::remove_dir_all(root).unwrap();
    }
}
