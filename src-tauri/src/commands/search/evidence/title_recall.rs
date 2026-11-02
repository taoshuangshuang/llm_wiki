//! 标题独立召回：使用规范化字符二元组相似度，避免正文词数和超长标题主导候选。
use super::{in_scope, BTreeMap, Candidate, Instant, Page, Scope};

const MAX_CANDIDATES: usize = 3;
const MIN_SIMILARITY: f64 = 0.45;

/// 保留重复二元组的计数，使反复堆叠关键词的长标题也受到长度惩罚。
fn title_pairs(title: &str) -> BTreeMap<(char, char), usize> {
    let chars: Vec<_> = title.to_lowercase().chars().filter(|ch| ch.is_alphanumeric()).collect();
    let mut pairs = BTreeMap::new();
    for pair in chars.windows(2) { *pairs.entry((pair[0], pair[1])).or_default() += 1; }
    pairs
}

/// 对真实页面标题评分，不使用文件路径、来源名或正文中的泛相关词。
pub(super) fn candidates(pages: &BTreeMap<String, Page>, title: &str, scope: &Scope, deadline: Instant) -> Vec<Candidate> {
    let query = title_pairs(title);
    let query_size: usize = query.values().sum();
    if query_size == 0 { return Vec::new(); }
    let mut ranked: Vec<_> = pages.values().take_while(|_| Instant::now() < deadline).filter(|page| in_scope(&page.path, scope)).filter_map(|page| {
        let pairs = title_pairs(&page.title);
        let size: usize = pairs.values().sum();
        let shared: usize = query.iter().map(|(pair, count)| (*count).min(pairs.get(pair).copied().unwrap_or(0))).sum();
        let similarity = 2.0 * shared as f64 / (query_size + size) as f64;
        (similarity >= MIN_SIMILARITY).then_some((page.path.clone(), similarity))
    }).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(MAX_CANDIDATES).enumerate().map(|(index, (path, _))| Candidate {
        path, rank: index + 1, channel: "title".into(), quote: None,
    }).collect()
}
