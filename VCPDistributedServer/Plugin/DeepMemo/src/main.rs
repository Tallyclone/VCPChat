use anyhow::{anyhow, Context, Result};
use glob::glob;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{doc, Index, tokenizer::BoxTokenStream};
use tokio::fs;

// --- Jieba Tokenizer for Tantivy ---

#[derive(Clone)]
pub struct JiebaTokenizer {
    jieba: Arc<jieba_rs::Jieba>,
}

pub struct JiebaTokenStream {
    tokens: Vec<Token>,
    index: usize,
}

impl Tokenizer for JiebaTokenizer {
    fn token_stream<'a>(&self, text: &'a str) -> BoxTokenStream<'a> {
        let mut tokens = Vec::new();
        let mut offset = 0;

        for word in self.jieba.cut(text, false) {
            if let Some(pos) = text[offset..].find(word) {
                let start = offset + pos;
                let end = start + word.len();

                tokens.push(Token {
                    offset_from: start,
                    offset_to: end,
                    position: tokens.len(),
                    text: word.to_string(),
                    position_length: 1,
                });

                offset = end;
            }
        }

        let stream: Box<dyn TokenStream + 'a> = Box::new(JiebaTokenStream { tokens, index: 0 });
        stream.into()
    }
}

impl TokenStream for JiebaTokenStream {
    fn advance(&mut self) -> bool {
        if self.index < self.tokens.len() {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.tokens[self.index - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.index - 1]
    }
}

// --- Structs for Serialization/Deserialization & Data Handling ---

// Custom deserializer to handle window_size being a string or an integer
fn deserialize_window_size_from_string_or_int<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrInt {
        String(String),
        Int(i32),
    }

    match StringOrInt::deserialize(deserializer)? {
        StringOrInt::String(s) => s.parse::<i32>().map_err(serde::de::Error::custom),
        StringOrInt::Int(i) => Ok(i),
    }
}

#[derive(Deserialize, Debug)]
struct ToolArgs {
    maid: String,
    #[serde(alias = "key_word", alias = "KeyWord")]
    keyword: String,
    #[serde(
        alias = "windowsize",
        default = "default_window_size",
        deserialize_with = "deserialize_window_size_from_string_or_int"
    )]
    window_size: i32,
}

fn default_window_size() -> i32 {
    3
}

#[derive(Serialize, Debug)]
struct SuccessResponse {
    status: &'static str,
    result: String,
}

#[derive(Serialize, Debug)]
struct ErrorResponse {
    status: &'static str,
    error: String,
}

#[derive(Debug, Clone)]
struct Config {
    vchat_data_url: PathBuf,
    max_memo_tokens: usize,
    rerank_search: bool,
    rerank_url: String,
    rerank_api: String,
    rerank_model: String,
    rerank_max_tokens_per_batch: usize,
    rerank_top_n: usize,
    blocked_keywords: HashSet<String>,
}

#[derive(Deserialize, Debug)]
struct AgentConfig {
    name: String,
}

#[derive(Deserialize, Debug)]
struct UserSettings {
    #[serde(default = "default_user_name", rename = "userName")]
    user_name: String,
}
fn default_user_name() -> String {
    "主人".to_string()
}

#[derive(Deserialize, Debug, Clone)]
struct HistoryEntry {
    role: String,
    content: String,
}

#[derive(Debug)]
struct AgentInfo {
    name: String,
    uuid: String,
}

#[derive(Serialize, Debug)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
    return_documents: bool,
    top_n: usize,
}

#[derive(Deserialize, Debug)]
struct RerankResult {
    index: usize,
    #[allow(dead_code)]
    relevance_score: f64,
}

#[derive(Deserialize, Debug)]
struct RerankResponse {
    results: Vec<RerankResult>,
}

// --- Main Application Logic ---

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        let error_response = ErrorResponse {
            status: "error",
            error: format!("[DeepMemo-rs] {:?}", e),
        };
        if let Ok(json_err) = serde_json::to_string(&error_response) {
            eprintln!("{}", json_err);
        } else {
            eprintln!("{{\"status\":\"error\",\"error\":\"[DeepMemo-rs] Failed to serialize error message.\"}}");
        }
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let config = load_config().context("Failed to load configuration")?;
    let input_json = read_stdin().context("Failed to read from stdin")?;
    let args: ToolArgs = serde_json::from_str(&input_json)
        .with_context(|| format!("Invalid input format, failed to parse JSON. Input: {}", input_json))?;

    let keywords = parse_keywords(&args.keyword);
    let filtered_keywords: Vec<String> = keywords
        .into_iter()
        .filter(|kw| !config.blocked_keywords.contains(kw))
        .collect();

    if filtered_keywords.is_empty() {
        return Err(anyhow!("Keywords are all blocked or empty."));
    }

    let agent_info = find_agent_info(&config.vchat_data_url, &args.maid)
        .await?
        .ok_or_else(|| anyhow!("Agent '{}' not found.", args.maid))?;
    let user_name = find_user_name(&config.vchat_data_url).await?;

    let mut memories = search_histories(
        &config.vchat_data_url,
        &agent_info.uuid,
        &filtered_keywords,
        args.window_size,
        &user_name,
        &agent_info.name,
    )
    .await?;

    if config.rerank_search && !memories.is_empty() {
        eprintln!("[DEBUG] Starting rerank for {} memories...", memories.len());
        memories = match rerank_memories(memories.clone(), &filtered_keywords.join(" "), &config).await {
            Ok(m) => {
                eprintln!("[DEBUG] Rerank completed. Got {} memories back.", m.len());
                m
            }
            Err(e) => {
                eprintln!("[DEBUG] Rerank failed: {}. Continuing with original results.", e);
                memories // Fallback to original memories
            }
        };
    }

    let mut output = memories.join("\n\n");
    if output.len() > config.max_memo_tokens {
        let mut new_len = config.max_memo_tokens;
        while !output.is_char_boundary(new_len) {
            new_len -= 1;
        }
        output.truncate(new_len);
        output.push_str("\n... [内容过长，已被截断]");
    }

    if output.trim().is_empty() {
        output = format!("[DeepMemo] 未找到与关键词“{}”相关的回忆。", filtered_keywords.join(", "));
    }

    let success_response = SuccessResponse {
        status: "success",
        result: output,
    };
    let output_json = serde_json::to_string(&success_response)?;
    println!("{}", output_json);

    Ok(())
}

// --- Core Logic Functions ---

async fn search_histories(
    vchat_path: &Path,
    agent_uuid: &str,
    keywords: &[String],
    window_size: i32,
    user_name: &str,
    agent_name: &str,
) -> Result<Vec<String>> {
    let topics_dir = vchat_path.join("UserData").join(agent_uuid).join("topics");
    if !topics_dir.exists() {
        return Ok(Vec::new());
    }

    let pattern = topics_dir.join("*").join("history.json");
    let mut history_files: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in glob(&pattern.to_string_lossy())? {
        if let Ok(path) = entry {
            if let Ok(metadata) = fs::metadata(&path).await {
                history_files.push((path, metadata.modified()?));
            }
        }
    }

    history_files.sort_by_key(|k| k.1);
    history_files.reverse();

    let mut all_memories = Vec::new();
    let mut memory_index = 1;

    for (file_path, _) in history_files.iter().skip(1) {
        let content = fs::read_to_string(file_path).await?;
        let history: Vec<HistoryEntry> = match serde_json::from_str(&content) {
            Ok(data) => data,
            Err(_) => continue,
        };
        if history.is_empty() {
            continue;
        }

        let schema = {
            let mut schema_builder = Schema::builder();
            let text_indexing_options = TextFieldIndexing::default()
                .set_tokenizer("jieba")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions);
            let text_options = TextOptions::default()
                .set_indexing_options(text_indexing_options)
                .set_stored();
            schema_builder.add_text_field("content", text_options);
            schema_builder.add_u64_field("id", INDEXED | STORED);
            schema_builder.build()
        };

        let index = Index::create_in_ram(schema.clone());
        let jieba_tokenizer = JiebaTokenizer {
            jieba: Arc::new(jieba_rs::Jieba::new()),
        };
        index.tokenizers().register("jieba", jieba_tokenizer);

        let mut index_writer = index.writer(50_000_000)?;
        let content_field = schema.get_field("content").unwrap();
        let id_field = schema.get_field("id").unwrap();

        for (i, entry) in history.iter().enumerate() {
            let clean_content = extract_text(&entry.content);
            if !clean_content.trim().is_empty() {
                index_writer.add_document(doc!(
                    content_field => clean_content,
                    id_field => i as u64
                ))?;
            }
        }
        index_writer.commit()?;

        let reader = index.reader()?;
        let searcher = reader.searcher();
        let query_parser = QueryParser::for_index(&index, vec![content_field]);

        let mut match_scores: HashMap<usize, usize> = HashMap::new();
        for keyword in keywords {
            if let Ok(query) = query_parser.parse_query(keyword) {
                let top_docs = searcher.search(&query, &TopDocs::with_limit(100))?;
                for (_score, doc_address) in top_docs {
                    let retrieved_doc = searcher.doc(doc_address)?;
                    let id = retrieved_doc.get_first(id_field).unwrap().as_u64().unwrap() as usize;
                    *match_scores.entry(id).or_insert(0) += 1;
                }
            }
        }

        let mut sorted_matches: Vec<(usize, usize)> = match_scores.into_iter().collect();
        sorted_matches.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        let mut used_indices = HashSet::new();
        for &(match_index, _) in &sorted_matches {
            if used_indices.contains(&match_index) {
                continue;
            }
            let start = (match_index as i32 - window_size).max(0) as usize;
            let end = (match_index + window_size as usize + 1).min(history.len());
            let context_slice = &history[start..end];
            if let Some(formatted_memory) = format_memory(context_slice, user_name, agent_name, memory_index) {
                all_memories.push(formatted_memory);
                memory_index += 1;
                for i in start..end {
                    used_indices.insert(i);
                }
            }
        }
    }
    Ok(all_memories)
}

// --- Rerank Logic ---

async fn rerank_memories(memories: Vec<String>, query: &str, config: &Config) -> Result<Vec<String>> {
    if config.rerank_url.is_empty() {
        return Ok(memories);
    }
    recursive_rerank(memories, query.to_string(), config.clone(), 1, 5).await
}

fn recursive_rerank(
    documents: Vec<String>,
    query: String,
    config: Config,
    level: usize,
    max_level: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<String>>> + Send>> {
    Box::pin(async move {
        eprintln!("[DEBUG] Rerank Level {}: {} docs", level, documents.len());

        if level > max_level {
            eprintln!("[WARNING] Max recursion level reached.");
            return Ok(documents.into_iter().take(config.rerank_top_n).collect());
        }

        if documents.len() <= config.rerank_top_n * 2 || documents.len() <= 10 {
            return perform_rerank_request(&documents, &query, &config).await;
        }

        let batches = create_batches(&documents, config.rerank_max_tokens_per_batch);
        if batches.len() >= documents.len() * 8 / 10 && documents.len() > 1 {
            eprintln!("[WARNING] Too many batches. Switching to tournament sort.");
            return tournament_sort(documents, &query, &config).await;
        }

        let mut tasks = Vec::new();
        for batch in batches {
            let q = query.clone();
            let cfg = config.clone();
            tasks.push(tokio::spawn(async move {
                perform_rerank_request(&batch, &q, &cfg).await
            }));
        }

        let mut candidates = Vec::new();
        let target_total = (config.rerank_top_n + 2).max(documents.len() / 2);
        let top_k_per_batch = (1).max(target_total / tasks.len());

        for task in tasks {
            if let Ok(Ok(results)) = task.await {
                candidates.extend(results.into_iter().take(top_k_per_batch));
            }
        }

        if candidates.is_empty() && !documents.is_empty() {
            return Ok(documents.into_iter().take(config.rerank_top_n).collect());
        }

        recursive_rerank(candidates, query, config, level + 1, max_level).await
    })
}

async fn tournament_sort(documents: Vec<String>, query: &str, config: &Config) -> Result<Vec<String>> {
    eprintln!("[DEBUG] Starting Tournament Sort with {} docs", documents.len());
    let mut champions = documents;
    
    while champions.len() > 1 {
        let mut next_round = Vec::new();
        let mut tasks = Vec::new();
        
        for pair in champions.chunks(2) {
            if pair.len() == 2 {
                let p = vec![pair[0].clone(), pair[1].clone()];
                let q = query.to_string();
                let cfg = config.clone();
                tasks.push(tokio::spawn(async move {
                    perform_rerank_request(&p, &q, &cfg).await
                }));
            } else {
                next_round.push(pair[0].clone()); // 轮空直接晋级
            }
        }
        
        let mut round_had_results = false;
        for (i, task) in tasks.into_iter().enumerate() {
            match task.await {
                Ok(Ok(mut winner)) if !winner.is_empty() => {
                    next_round.push(winner.remove(0));
                    round_had_results = true;
                }
                _ => {
                    // Rerank 失败时，保留原配对中的第一个
                    if let Some(original) = champions.get(i * 2) {
                        next_round.push(original.clone());
                    }
                }
            }
        }
        
        // 防止死循环：如果没有任何进展，直接返回
        if !round_had_results && next_round.is_empty() {
            eprintln!("[WARNING] Tournament sort failed. Returning original documents.");
            return Ok(champions.into_iter().take(config.rerank_top_n).collect());
        }
        
        champions = next_round;
        eprintln!("[DEBUG] Tournament: {} champions advance", champions.len());
    }
    
    perform_rerank_request(&champions, query, config).await
}

fn create_batches(documents: &[String], max_tokens: usize) -> Vec<Vec<String>> {
    let mut batches = Vec::new();
    let mut current_batch = Vec::new();
    let mut current_tokens = 0;
    
    for doc in documents {
        let doc_len = doc.len();
        
        let processed_doc = if doc_len > max_tokens * 8 / 10 {
            let mut keep_length = max_tokens / 4;
            if keep_length * 2 >= doc.len() {
                // 如果文档不够长，无法安全地截取头尾，则不处理
                doc.clone()
            } else {
                let mut head_end = keep_length;
                while head_end > 0 && !doc.is_char_boundary(head_end) {
                    head_end -= 1;
                }

                let mut tail_start = doc.len().saturating_sub(keep_length);
                while tail_start < doc.len() && !doc.is_char_boundary(tail_start) {
                    tail_start += 1;
                }
                
                if head_end >= tail_start {
                    // 如果头尾重叠，返回原文案全截断
                    let mut safe_len = max_tokens * 8 / 10;
                    while safe_len > 0 && !doc.is_char_boundary(safe_len) {
                        safe_len -= 1;
                    }
                    doc[..safe_len].to_string()
                } else {
                    format!(
                        "{}...[内容过长，中间已截断]...{}",
                        &doc[..head_end],
                        &doc[tail_start..]
                    )
                }
            }
        } else {
            doc.clone()
        };
        
        let processed_len = processed_doc.len();
        
        if !current_batch.is_empty()
            && (current_tokens + processed_len > max_tokens || current_batch.len() >= 15) {
            batches.push(current_batch);
            current_batch = Vec::new();
            current_tokens = 0;
        }
        
        current_batch.push(processed_doc);
        current_tokens += processed_len;
    }
    
    if !current_batch.is_empty() {
        batches.push(current_batch);
    }
    batches
}

async fn perform_rerank_request(documents: &[String], query: &str, config: &Config) -> Result<Vec<String>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::new();
    let rerank_endpoint = format!("{}v1/rerank", config.rerank_url);
    let request_body = RerankRequest {
        model: &config.rerank_model,
        query,
        documents,
        return_documents: false,
        top_n: documents.len(),
    };
    let response = client
        .post(&rerank_endpoint)
        .bearer_auth(&config.rerank_api)
        .json(&request_body)
        .send()
        .await?
        .json::<RerankResponse>()
        .await?;
    Ok(response
        .results
        .into_iter()
        .filter_map(|res| documents.get(res.index).cloned())
        .collect())
}

// --- Helper & Utility Functions ---

async fn find_agent_info(vchat_path: &Path, maid_name: &str) -> Result<Option<AgentInfo>> {
    let agents_dir = vchat_path.join("Agents");
    let mut read_dir = fs::read_dir(agents_dir).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let path = entry.path();
        if path.is_dir() {
            let config_path = path.join("config.json");
            if let Ok(content) = fs::read_to_string(config_path).await {
                if let Ok(config) = serde_json::from_str::<AgentConfig>(&content) {
                    if config.name.contains(maid_name) {
                        return Ok(Some(AgentInfo {
                            name: config.name,
                            uuid: entry.file_name().to_string_lossy().into_owned(),
                        }));
                    }
                }
            }
        }
    }
    Ok(None)
}

async fn find_user_name(vchat_path: &Path) -> Result<String> {
    let settings_path = vchat_path.join("settings.json");
    if let Ok(content) = fs::read_to_string(settings_path).await {
        if let Ok(settings) = serde_json::from_str::<UserSettings>(&content) {
            return Ok(settings.user_name);
        }
    }
    Ok("主人".to_string())
}

fn format_memory(slice: &[HistoryEntry], user_name: &str, agent_name: &str, memory_index: usize) -> Option<String> {
    let memory_string: String = slice
        .iter()
        .filter_map(|entry| {
            let name = if entry.role == "user" {
                user_name
            } else if entry.role == "assistant" {
                agent_name
            } else {
                return None;
            };
            let clean_content = extract_text(&entry.content);
            if clean_content.is_empty() {
                None
            } else {
                Some(format!("{}: {}", name, clean_content))
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    if memory_string.is_empty() {
        None
    } else {
        Some(format!("[回忆片段{}]:\n{}", memory_index, memory_string))
    }
}

fn extract_text(html: &str) -> String {
    // Using the advanced multi-step cleaning logic provided by the user.
    let mut clean = html.to_string();
    
    // 1. 移除 <style> 标签
    let style_re = Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    clean = style_re.replace_all(&clean, "").to_string();
    
    // 2. 移除 <script> 标签
    let script_re = Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    clean = script_re.replace_all(&clean, "").to_string();
    
    // 3. 【核心】移除裸露 CSS 块
    // 匹配从第一个 CSS 规则开始，到双换行或 HTML 标签为止
    // 这会匹配：@keyframes ... } .class { ... } .another { ... } 直到遇到空行
    let naked_css_re = Regex::new(
        r"(?s)@keyframes[\s\S]*?(\r?\n\r?\n|<[a-zA-Z]|$)"
    ).unwrap();
    clean = naked_css_re.replace_all(&clean, "$1").to_string();
    
    // 4. 兜底：移除任何剩余的 CSS 规则块
    let css_rule_re = Regex::new(r"(?m)^\s*[\w\-\.#@][\w\-\s,\.#>+~:()]*\{[^}]*\}").unwrap();
    clean = css_rule_re.replace_all(&clean, "").to_string();
    
    // 5. 清理 HTML
    let result = ammonia::clean(&clean);
    
    // 6. 清理空白
    let whitespace_re = Regex::new(r"\s+").unwrap();
    whitespace_re.replace_all(result.trim(), " ").to_string()
}

fn parse_keywords(raw: &str) -> Vec<String> {
    let re = Regex::new(r#""[^"]+"|'[^']+'|[^,，\s]+"#).unwrap();
    re.find_iter(raw)
        .map(|m| m.as_str().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn read_stdin() -> Result<String> {
    let mut buffer = String::new();
    std::io::stdin().read_to_string(&mut buffer)?;
    Ok(buffer)
}

fn load_config() -> Result<Config> {
    let exe_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
    let candidates = vec![
        exe_dir.join("config.env"),
        exe_dir.join("..").join("config.env"),
        exe_dir.join("..").join("..").join("config.env"),
    ];
    let config_path = candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| anyhow!("config.env not found in search paths"))?;
    
    dotenv::from_path(&config_path).with_context(|| format!("Failed to load .env file from {:?}", config_path))?;

    Ok(Config {
        vchat_data_url: std::env::var("VchatDataURL")?.into(),
        max_memo_tokens: std::env::var("MaxMemoTokens")?.parse()?,
        rerank_search: std::env::var("RerankSearch")?.to_lowercase() == "true",
        rerank_url: std::env::var("RerankUrl")?,
        rerank_api: std::env::var("RerankApi")?,
        rerank_model: std::env::var("RerankModel")?,
        rerank_max_tokens_per_batch: std::env::var("RerankMaxTokensPerBatch")?.parse()?,
        rerank_top_n: std::env::var("RerankTopN")?.parse()?,
        blocked_keywords: std::env::var("BlockedKeywords")?
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    })
}