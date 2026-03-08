//! System prompts module providing main dialogue and agent dialogue prompts
use crate::agentic::util::get_formatted_files_list;
use crate::infrastructure::try_get_path_manager_arc;
use crate::service::ai_memory::AIMemoryManager;
use crate::service::ai_rules::get_global_ai_rules_service;
use crate::service::config::global::GlobalConfigManager;
use crate::service::project_context::ProjectContextService;
use crate::util::errors::{BitFunError, BitFunResult};
use log::{debug, warn};
use std::path::Path;
use tokio::fs;

/// Placeholder constants
const PLACEHOLDER_PERSONA: &str = "{PERSONA}";
const PLACEHOLDER_ENV_INFO: &str = "{ENV_INFO}";
const PLACEHOLDER_PROJECT_LAYOUT: &str = "{PROJECT_LAYOUT}";
// PROJECT_CONTEXT_FILES needs configuration parsing
// const PLACEHOLDER_PROJECT_CONTEXT_FILES: &str = "{PROJECT_CONTEXT_FILES}";
const PLACEHOLDER_RULES: &str = "{RULES}";
const PLACEHOLDER_MEMORIES: &str = "{MEMORIES}";
const PLACEHOLDER_LANGUAGE_PREFERENCE: &str = "{LANGUAGE_PREFERENCE}";
const PLACEHOLDER_AGENT_MEMORY: &str = "{AGENT_MEMORY}";
const PLACEHOLDER_VISUAL_MODE: &str = "{VISUAL_MODE}";
const PERSONA_FILE_NAMES: [&str; 4] = ["BOOTSTRAP.md", "SOUL.md", "USER.md", "IDENTITY.MD"];

pub struct PromptBuilder {
    pub workspace_path: String,
    pub file_tree_max_entries: usize,
}

impl PromptBuilder {
    pub fn new(workspace_path: &str) -> Self {
        Self {
            workspace_path: workspace_path.replace("\\", "/"),
            file_tree_max_entries: 200,
        }
    }

    /// Provide complete environment information
    pub fn get_env_info(&self) -> String {
        let os_name = std::env::consts::OS;
        let os_family = std::env::consts::FAMILY;
        let arch = std::env::consts::ARCH;

        let now = chrono::Local::now();
        let current_date = now.format("%A, %B %d, %Y").to_string();

        format!(
            r#"# Environment Information
<environment_details>
- Current Working Directory: {}
- Operating System: {} ({})
- Architecture: {}
- Current Date: {}
</environment_details>

"#,
            self.workspace_path, os_name, os_family, arch, current_date
        )
    }

    /// Get workspace file list
    pub fn get_project_layout(&self) -> String {
        let (hit_limit, formatted_files_list) =
            get_formatted_files_list(&self.workspace_path, self.file_tree_max_entries, None)
                .unwrap_or_else(|e| (false, format!("Error listing directory: {}", e)));
        let mut project_layout = "# Workspace Layout\n<project_layout>\n".to_string();
        if hit_limit {
            project_layout.push_str(&format!("Below is a snapshot of the current workspace's file structure (showing up to {} entries).\n\n", self.file_tree_max_entries));
        } else {
            project_layout
                .push_str("Below is a snapshot of the current workspace's file structure.\n\n");
        }
        project_layout.push_str(&formatted_files_list);
        project_layout.push_str("\n</project_layout>\n\n");
        project_layout
    }

    /// Get user-provided project information files
    /// These files (e.g., AGENTS.md, CLAUDE.md) are provided by users to describe project architecture, conventions, and guidelines
    ///
    /// Parameters:
    /// - filter: Optional filter, supports `include=category1,category2` or `exclude=category1`
    pub async fn get_project_context(&self, filter: Option<&str>) -> Option<String> {
        let service = ProjectContextService::new();
        let workspace = Path::new(&self.workspace_path);

        match service.build_context_prompt(workspace, filter).await {
            Ok(prompt) if !prompt.is_empty() => {
                let result = format!(
                    r#"# Project Context
The following are project documentation that describe the project's architecture, conventions, and guidelines, etc.
These files are maintained by the user and should NOT be modified unless explicitly requested.

{}

"#,
                    prompt
                );
                Some(result)
            }
            _ => None,
        }
    }

    /// Get workspace persona files from the workspace root.
    pub async fn get_persona(&self) -> Option<String> {
        let workspace = Path::new(&self.workspace_path);
        let mut documents = Vec::new();

        for file_name in PERSONA_FILE_NAMES {
            let file_path = workspace.join(file_name);
            if !file_path.exists() {
                continue;
            }

            match fs::read_to_string(&file_path).await {
                Ok(content) => documents.push((file_name, content)),
                Err(e) => {
                    warn!(
                        "Failed to read persona file: path={} error={}",
                        file_path.display(),
                        e
                    );
                }
            }
        }

        if documents.is_empty() {
            return None;
        }

        let mut prompt = String::from("<persona>\n");
        for (file_name, content) in documents {
            prompt.push_str(&format!(
                "<persona_file name=\"{}\" description=\"{}\">\n{}\n</persona_file>\n",
                file_name,
                Self::persona_file_description(file_name),
                content
            ));
        }
        prompt.push_str("</persona>");

        Some(format!(
            r#"# Persona

The following files are located in the workspace root directory.

{}
"#,
            prompt
        ))
    }

    fn persona_file_description(file_name: &str) -> &'static str {
        match file_name {
            "BOOTSTRAP.md" => "Bootstrap guidance and initialization instructions",
            "SOUL.md" => "Core persona, values, and behavioral style",
            "USER.md" => "User profile, preferences, and collaboration expectations",
            "IDENTITY.MD" => "Workspace identity, role definition, and self-description",
            _ => "Workspace persona file",
        }
    }

    /// Load AI memories from disk and format as prompt
    pub async fn load_ai_memories(&self) -> Option<String> {
        let path_manager = match try_get_path_manager_arc() {
            Ok(pm) => pm,
            Err(e) => {
                warn!("Failed to create PathManager: {}", e);
                return None;
            }
        };

        let memory_manager = match AIMemoryManager::new(path_manager).await {
            Ok(mm) => mm,
            Err(e) => {
                warn!("Failed to create AIMemoryManager: {}", e);
                return None;
            }
        };

        match memory_manager.get_memories_for_prompt().await {
            Ok(Some(prompt)) => Some(prompt),
            Ok(None) => None,
            Err(e) => {
                warn!("Failed to load memories: {}", e);
                None
            }
        }
    }

    /// Build the agent memory section: instructions + auto-loaded memory index
    ///
    /// Replaces `<workspace>` with the real workspace path and `{YYYY-MM-DD}` with today's date.
    /// Appends the contents of `memory.md` (up to 200 lines) when present.
    pub async fn build_agent_memory(&self) -> String {
        let memory_dir = format!("{}/.bitfun/memory", self.workspace_path);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let mut section = format!(
            r#"# Memory

The following memories are persisted to disk under `{memory_dir}/`.

- **Index**: `memory.md` is auto-loaded (up to 200 lines) and serves as the memory index. Keep it concise — link to topic files rather than inlining details.
- **Daily journal**: Write or append to `{today}.md` for important user requests, decisions, constraints, and outcomes. Skip greetings, small talk, and trivial Q&A.
- **Topic files**: Organize long-lived knowledge as `<topic>.md` (e.g., `debugging.md`, `architecture.md`, `preferences.md`).
- **Write**: Use Edit/Write tools to create or update memory files.
- **Read**: Use Grep/Read tools to search and retrieve memories.
"#
        );

        let index_path = format!("{}/memory.md", memory_dir);
        match fs::read_to_string(&index_path).await {
            Ok(content) if !content.trim().is_empty() => {
                let truncated: String = content.lines().take(200).collect::<Vec<_>>().join("\n");
                section.push_str(&format!(
                    "\n<memory_index>\n{}\n</memory_index>\n",
                    truncated
                ));
            }
            _ => {}
        }

        section
    }

    /// Load AI rules from disk and format as prompt
    pub async fn load_ai_rules(&self) -> Option<String> {
        let rules_service = match get_global_ai_rules_service().await {
            Ok(service) => service,
            Err(e) => {
                warn!("Failed to get AIRulesService: {}", e);
                return None;
            }
        };

        let workspace_pathbuf = std::path::PathBuf::from(&self.workspace_path);
        match rules_service
            .build_system_prompt_for(Some(&workspace_pathbuf))
            .await
        {
            Ok(prompt) => {
                if prompt.is_empty() {
                    None
                } else {
                    Some(prompt)
                }
            }
            Err(e) => {
                warn!("Failed to build AI rules system prompt: {}", e);
                None
            }
        }
    }

    /// Get visual mode instruction from user config
    ///
    /// Reads `app.ai_experience.enable_visual_mode` from global config.
    /// Returns a prompt snippet when enabled, or empty string when disabled.
    async fn get_visual_mode_instruction(&self) -> String {
        let enabled = match GlobalConfigManager::get_service().await {
            Ok(service) => service
                .get_config::<bool>(Some("app.ai_experience.enable_visual_mode"))
                .await
                .unwrap_or(false),
            Err(e) => {
                debug!("Failed to read visual mode config: {}", e);
                false
            }
        };

        if enabled {
            r"# Visualizing complex logic as you explain
Use Mermaid diagrams to visualize complex logic, workflows, architectures, and data flows whenever it helps clarify the explanation.
Prefer MermaidInteractive tool when available, otherwise output Mermaid code blocks directly.
".to_string()
        } else {
            String::new()
        }
    }

    /// Get user language preference instruction
    ///
    /// Read app.language from global config, generate simple language instruction
    /// Returns empty string if config cannot be read
    /// Returns error if language code is unsupported
    async fn get_language_preference(&self) -> BitFunResult<String> {
        let language_code = GlobalConfigManager::get_service()
            .await?
            .get_config::<String>(Some("app.language"))
            .await?;

        Self::format_language_instruction(&language_code)
    }

    /// Format language instruction based on language code
    fn format_language_instruction(lang_code: &str) -> BitFunResult<String> {
        let language = match lang_code {
            "zh-CN" => "**Simplified Chinese**",
            "en-US" => "**English**",
            _ => {
                return Err(BitFunError::config(format!(
                    "Unknown language code: {}",
                    lang_code
                )));
            }
        };
        Ok(format!("# Language Preference\nYou MUST respond in {} regardless of the user's input language. This is the system language setting and should be followed unless the user explicitly specifies a different language. This is crucial for smooth communication and user experience\n", language))
    }

    /// Build prompt from template, automatically fill content based on placeholders
    ///
    /// Supported placeholders:
    /// - `{PERSONA}` - Workspace persona files (BOOTSTRAP.md, SOUL.md, USER.md, IDENTITY.MD)
    /// - `{LANGUAGE_PREFERENCE}` - User language preference (read from global config)
    /// - `{ENV_INFO}` - Environment information
    /// - `{PROJECT_LAYOUT}` - Project file layout
    /// - `{PROJECT_CONTEXT_FILES}` - Project context files (AGENTS.md, CLAUDE.md, etc.)
    /// - `{AGENT_MEMORY}` - Agent memory instructions + auto-loaded memory index
    /// - `{RULES}` - AI rules
    /// - `{MEMORIES}` - AI memories
    /// - `{VISUAL_MODE}` - Visual mode instruction (Mermaid diagrams, read from global config)
    ///
    /// If a placeholder is not in the template, corresponding content will not be added
    pub async fn build_prompt_from_template(&self, template: &str) -> BitFunResult<String> {
        let mut result = template.to_string();

        // Replace {PERSONA}
        if result.contains(PLACEHOLDER_PERSONA) {
            let persona = self.get_persona().await.unwrap_or_default();
            result = result.replace(PLACEHOLDER_PERSONA, &persona);
        }

        // Replace {LANGUAGE_PREFERENCE}
        if result.contains(PLACEHOLDER_LANGUAGE_PREFERENCE) {
            let language_preference = self.get_language_preference().await?;
            result = result.replace(PLACEHOLDER_LANGUAGE_PREFERENCE, &language_preference);
        }

        // Replace {ENV_INFO}
        if result.contains(PLACEHOLDER_ENV_INFO) {
            let env_info = self.get_env_info();
            result = result.replace(PLACEHOLDER_ENV_INFO, &env_info);
        }

        // Replace {PROJECT_LAYOUT}
        if result.contains(PLACEHOLDER_PROJECT_LAYOUT) {
            let project_layout = self.get_project_layout();
            result = result.replace(PLACEHOLDER_PROJECT_LAYOUT, &project_layout);
        }

        // Replace {PROJECT_CONTEXT_FILES}
        // Supported syntax:
        // - {PROJECT_CONTEXT_FILES} - Include all enabled documents
        // - {PROJECT_CONTEXT_FILES:include=general,design} - Only include specified categories
        // - {PROJECT_CONTEXT_FILES:exclude=review} - Exclude specified categories
        while let Some(start) = result.find("{PROJECT_CONTEXT_FILES") {
            let start_pos = start;
            // Find placeholder end position
            let end_pos = result[start_pos..]
                .find('}')
                .map(|p| start_pos + p + 1)
                .unwrap_or(result.len());

            // Extract complete placeholder
            let placeholder = &result[start_pos..end_pos];

            // Parse filter
            let filter = if let Some(colon_pos) = placeholder.find(':') {
                // Has filter: {PROJECT_CONTEXT_FILES:include=xxx} or {PROJECT_CONTEXT_FILES:exclude=xxx}
                let filter_str = &placeholder[colon_pos + 1..placeholder.len() - 1];
                Some(filter_str.trim().to_string())
            } else {
                // No filter
                None
            };

            let filter_ref = filter.as_deref();
            let project_context = self
                .get_project_context(filter_ref)
                .await
                .unwrap_or_default();

            result = result.replace(placeholder, &project_context);
        }

        // Replace {AGENT_MEMORY}
        if result.contains(PLACEHOLDER_AGENT_MEMORY) {
            let agent_memory = self.build_agent_memory().await;
            result = result.replace(PLACEHOLDER_AGENT_MEMORY, &agent_memory);
        }

        // Replace {RULES}
        if result.contains(PLACEHOLDER_RULES) {
            let rules = self.load_ai_rules().await.unwrap_or_default();
            result = result.replace(PLACEHOLDER_RULES, &rules);
        }

        // Replace {MEMORIES}
        if result.contains(PLACEHOLDER_MEMORIES) {
            let memories = self.load_ai_memories().await.unwrap_or_default();
            result = result.replace(PLACEHOLDER_MEMORIES, &memories);
        }

        // Replace {VISUAL_MODE}
        if result.contains(PLACEHOLDER_VISUAL_MODE) {
            let visual_mode = self.get_visual_mode_instruction().await;
            result = result.replace(PLACEHOLDER_VISUAL_MODE, &visual_mode);
        }

        Ok(result.trim().to_string())
    }
}
