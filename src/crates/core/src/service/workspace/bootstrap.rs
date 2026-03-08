use crate::infrastructure::storage::{PersistenceService, StorageOptions};
use crate::infrastructure::try_get_path_manager_arc;
use crate::util::errors::*;
use log::debug;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

const BOOTSTRAP_STATE_KEY: &str = "local/bootstrap_state";
const BOOTSTRAP_FILE_NAME: &str = "BOOTSTRAP.md";
const SOUL_FILE_NAME: &str = "SOUL.md";
const USER_FILE_NAME: &str = "USER.md";
const IDENTITY_FILE_NAME: &str = "IDENTITY.MD";
const MEMORY_DIR: &str = ".bitfun/memory";
const MEMORY_INDEX_FILE: &str = "memory.md";
const BOOTSTRAP_TEMPLATE: &str = include_str!("templates/BOOTSTRAP.md");
const SOUL_TEMPLATE: &str = include_str!("templates/SOUL.md");
const USER_TEMPLATE: &str = include_str!("templates/USER.md");
const IDENTITY_TEMPLATE: &str = include_str!("templates/IDENTITY.MD");
const MEMORY_INDEX_TEMPLATE: &str = "# Memory Index\n";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceBootstrapState {
    bootstrap_completed: bool,
}

async fn ensure_markdown_placeholder(path: &Path, content: &str) -> BitFunResult<bool> {
    if path.exists() {
        return Ok(false);
    }

    fs::write(path, content)
        .await
        .map_err(|e| BitFunError::service(format!("Failed to create {}: {}", path.display(), e)))?;

    Ok(true)
}

pub(crate) async fn ensure_workspace_bootstrap_files(workspace_root: &Path) -> BitFunResult<()> {
    let path_manager = try_get_path_manager_arc()?;
    let persistence =
        PersistenceService::new_project_level(path_manager, workspace_root.to_path_buf())
            .await
            .map_err(|e| {
                BitFunError::service(format!("Failed to prepare project storage: {}", e))
            })?;

    let loaded_state = persistence
        .load_json::<WorkspaceBootstrapState>(BOOTSTRAP_STATE_KEY)
        .await
        .map_err(|e| BitFunError::service(format!("Failed to load bootstrap state: {}", e)))?;
    let bootstrap_state = loaded_state.clone().unwrap_or_default();

    if loaded_state.is_none() {
        persistence
            .save_json(
                BOOTSTRAP_STATE_KEY,
                &bootstrap_state,
                StorageOptions::default(),
            )
            .await
            .map_err(|e| BitFunError::service(format!("Failed to save bootstrap state: {}", e)))?;
    }

    let created_soul =
        ensure_markdown_placeholder(&workspace_root.join(SOUL_FILE_NAME), SOUL_TEMPLATE).await?;
    let created_user =
        ensure_markdown_placeholder(&workspace_root.join(USER_FILE_NAME), USER_TEMPLATE).await?;
    let created_identity =
        ensure_markdown_placeholder(&workspace_root.join(IDENTITY_FILE_NAME), IDENTITY_TEMPLATE)
            .await?;

    let created_bootstrap = if bootstrap_state.bootstrap_completed {
        false
    } else {
        ensure_markdown_placeholder(
            &workspace_root.join(BOOTSTRAP_FILE_NAME),
            BOOTSTRAP_TEMPLATE,
        )
        .await?
    };

    let memory_dir = workspace_root.join(MEMORY_DIR);
    if !memory_dir.exists() {
        fs::create_dir_all(&memory_dir).await.map_err(|e| {
            BitFunError::service(format!(
                "Failed to create memory directory {}: {}",
                memory_dir.display(),
                e
            ))
        })?;
    }
    let created_memory_index =
        ensure_markdown_placeholder(&memory_dir.join(MEMORY_INDEX_FILE), MEMORY_INDEX_TEMPLATE)
            .await?;

    debug!(
        "Ensured workspace bootstrap files: path={}, bootstrap_completed={}, created_bootstrap={}, created_soul={}, created_user={}, created_identity={}, created_memory_index={}",
        workspace_root.display(),
        bootstrap_state.bootstrap_completed,
        created_bootstrap,
        created_soul,
        created_user,
        created_identity,
        created_memory_index
    );

    Ok(())
}
