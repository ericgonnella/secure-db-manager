use crate::local_store::{load_store, save_store};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;

    // Make sure the directory exists before we try to open it.
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Could not create app data directory: {e}"))?;

    let path_str = path.to_string_lossy().into_owned();

    // Use the OS shell to open the folder (Explorer / Finder / xdg-open).
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("Could not open folder: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn clear_audit_log(app: AppHandle) -> Result<usize, String> {
    let mut store = load_store(&app);
    let removed = store.audit_log.len();
    store.audit_log.clear();
    save_store(&app, &store)?;
    Ok(removed)
}

// ── Backup file operations ─────────────────────────────────────────────────

/// Copy an existing backup file to a chosen destination directory.
/// Returns the path to the exported copy.
#[tauri::command]
pub fn export_backup(
    app: AppHandle,
    backup_id: String,
    destination_dir: String,
) -> Result<String, String> {
    let store = load_store(&app);
    let record = store
        .backups
        .iter()
        .find(|b| b.id == backup_id)
        .ok_or("Backup record not found.")?;

    // Validate destination dir is absolute and exists.
    let dest_dir = {
        let p = std::path::PathBuf::from(&destination_dir);
        if !p.is_absolute() {
            return Err("Destination path must be absolute.".into());
        }
        p
    };
    if !dest_dir.exists() || !dest_dir.is_dir() {
        return Err("Destination directory does not exist.".into());
    }

    let src = std::path::PathBuf::from(&record.file_path);

    // Defence-in-depth: backup files are written by us into the app data
    // directory. Refuse to copy from anywhere else even if the store has been
    // tampered with, and resolve symlinks before deciding.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    let canonical_src = std::fs::canonicalize(&src)
        .map_err(|e| format!("Backup file is not accessible: {e}"))?;
    let canonical_root = std::fs::canonicalize(&app_data)
        .map_err(|e| format!("App data directory is not accessible: {e}"))?;
    if !canonical_src.starts_with(&canonical_root) {
        return Err("Refusing to export a backup file located outside the app data directory.".into());
    }

    let file_name = src
        .file_name()
        .ok_or("Could not determine backup filename.")?;
    let dest_file = dest_dir.join(file_name);

    std::fs::copy(&canonical_src, &dest_file)
        .map_err(|e| format!("Copy failed: {e}"))?;

    Ok(dest_file.to_string_lossy().into_owned())
}

/// Open the folder that contains a backup file in the OS file explorer.
#[tauri::command]
pub fn open_backup_folder(app: AppHandle, backup_id: String) -> Result<(), String> {
    let store = load_store(&app);
    let record = store
        .backups
        .iter()
        .find(|b| b.id == backup_id)
        .ok_or("Backup record not found.")?;

    let src = std::path::PathBuf::from(&record.file_path);
    let folder = src
        .parent()
        .ok_or("Could not determine backup folder.")?;

    let folder_str = folder.to_string_lossy().into_owned();

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(folder_str, None::<&str>)
        .map_err(|e| format!("Could not open folder: {e}"))?;

    Ok(())
}
