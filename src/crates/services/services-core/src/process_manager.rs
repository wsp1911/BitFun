//! Unified process management to avoid Windows child process leaks

use std::process::{Command, Stdio};
use std::sync::LazyLock;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tokio::process::Command as TokioCommand;

#[cfg(windows)]
use log::warn;

#[cfg(windows)]
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use win32job::Job;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

static GLOBAL_PROCESS_MANAGER: LazyLock<ProcessManager> = LazyLock::new(ProcessManager::new);

pub struct ProcessManager {
    #[cfg(windows)]
    job: Arc<Mutex<Option<Job>>>,
}

impl ProcessManager {
    fn new() -> Self {
        let manager = Self {
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
        };

        #[cfg(windows)]
        {
            if let Err(e) = manager.initialize_job() {
                warn!("Failed to initialize Windows Job object: {}", e);
            }
        }

        manager
    }

    #[cfg(windows)]
    fn initialize_job(&self) -> Result<(), Box<dyn std::error::Error>> {
        use win32job::{ExtendedLimitInfo, Job};

        let job = Job::create()?;

        // Terminate all child processes when the Job closes
        let mut info = ExtendedLimitInfo::new();
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&info)?;
        allow_explicit_job_breakaway(&job)?;

        // Assign current process to Job so child processes inherit automatically
        job.assign_current_process()?;

        let mut job_guard = self.job.lock().map_err(|e| {
            std::io::Error::other(format!("Failed to lock process manager job mutex: {}", e))
        })?;
        *job_guard = Some(job);

        Ok(())
    }

    pub fn cleanup_all(&self) {
        #[cfg(windows)]
        {
            let mut job_guard = match self.job.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    warn!("Process manager job mutex was poisoned during cleanup, recovering lock");
                    poisoned.into_inner() as std::sync::MutexGuard<'_, Option<Job>>
                }
            };
            job_guard.take();
        }
    }
}

#[cfg(windows)]
fn allow_explicit_job_breakaway(job: &Job) -> Result<(), Box<dyn std::error::Error>> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };

    let handle = HANDLE(job.handle() as *mut c_void);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: `job` owns a live Job handle and `info` is a correctly sized,
    // writable buffer for the requested information class.
    unsafe {
        QueryInformationJobObject(
            Some(handle),
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            None,
        )?;
    }
    info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    // SAFETY: the same live Job handle and initialized information buffer are
    // passed with their exact byte size.
    unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
    }
    Ok(())
}

/// Create synchronous Command (Windows automatically adds CREATE_NO_WINDOW)
pub fn create_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let cmd = Command::new(program.as_ref());

    #[cfg(windows)]
    {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(windows))]
    cmd
}

/// Create Tokio async Command (Windows automatically adds CREATE_NO_WINDOW)
pub fn create_tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> TokioCommand {
    let cmd = TokioCommand::new(program.as_ref());

    #[cfg(target_os = "macos")]
    {
        let mut cmd = cmd;
        apply_cached_macos_path(&mut cmd);
        cmd
    }

    #[cfg(windows)]
    {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    cmd
}

/// Create a command that must survive the current GUI process exiting.
///
/// This is reserved for signed, product-owned process handoffs such as the
/// offline Data Migrator and the trusted main-app restart. Callers must resolve
/// the executable from an authenticated installation boundary; this helper
/// only supplies lifecycle and no-console-window behavior.
pub fn create_detached_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut command = Command::new(program.as_ref());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(detached_creation_flags());

    command
}

#[cfg(windows)]
const fn detached_creation_flags() -> u32 {
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
}

#[cfg(target_os = "macos")]
fn apply_cached_macos_path(cmd: &mut TokioCommand) {
    if let Some(path) = cached_macos_path_env() {
        cmd.env("PATH", path);
    }
}

#[cfg(target_os = "macos")]
fn cached_macos_path_env() -> Option<&'static std::ffi::OsString> {
    static MACOS_PATH_ENV: OnceLock<Option<std::ffi::OsString>> = OnceLock::new();
    MACOS_PATH_ENV.get_or_init(build_macos_path_env).as_ref()
}

#[cfg(target_os = "macos")]
fn build_macos_path_env() -> Option<std::ffi::OsString> {
    let existing_path = std::env::var_os("PATH");
    let mut entries = Vec::new();
    if let Some(path) = existing_path {
        entries.extend(std::env::split_paths(&path));
    }
    entries.extend(crate::system::platform_path_entries());

    if entries.is_empty() {
        return None;
    }

    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in entries {
        if path.as_os_str().is_empty() {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            merged.push(path);
        }
    }

    std::env::join_paths(merged).ok()
}

pub fn cleanup_all_processes() {
    GLOBAL_PROCESS_MANAGER.cleanup_all();
}

/// Keep descendants of a long-lived service in the process-wide Job.
pub fn contain_current_process_tree() -> std::io::Result<()> {
    #[cfg(windows)]
    if GLOBAL_PROCESS_MANAGER
        .job
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?
        .is_none()
    {
        return Err(std::io::Error::other("Windows process Job is unavailable"));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn detached_handoff_is_hidden_and_can_leave_the_process_job() {
        let flags = detached_creation_flags();
        assert_ne!(flags & CREATE_NO_WINDOW, 0);
        assert_ne!(flags & CREATE_NEW_PROCESS_GROUP, 0);
        assert_ne!(flags & CREATE_BREAKAWAY_FROM_JOB, 0);
    }
}
