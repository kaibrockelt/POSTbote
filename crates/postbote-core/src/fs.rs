//! A collection is a set of text files. It lives either on disk (desktop
//! mode, opt-in server storage) or in memory (browser-stored collections that
//! are shipped along with a run and never persisted on the server).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

pub const MAX_FILE_SIZE: usize = 2 << 20;
pub const MAX_FILES: usize = 5000;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".svn", ".hg", "target"];

#[derive(Debug)]
pub struct NotFound(pub String);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: file not found", self.0)
    }
}

impl std::error::Error for NotFound {}

pub fn is_not_found(e: &anyhow::Error) -> bool {
    e.downcast_ref::<NotFound>().is_some()
}

pub trait Fs: Send {
    fn read(&self, p: &str) -> Result<String>;
    fn write(&mut self, p: &str, content: &str) -> Result<()>;
    fn delete(&mut self, p: &str) -> Result<()>;
    fn rename(&mut self, from: &str, to: &str) -> Result<()>;
    /// Every text file of the collection keyed by its slash path.
    fn list(&self) -> Result<BTreeMap<String, String>>;
}

/// Normalises a collection-relative path and rejects anything that would
/// escape the collection root or touch the git directory.
pub fn clean(p: &str) -> Result<String> {
    let p = p.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => bail!("invalid path {p:?}: '..' is not allowed"),
            ".git" => bail!("access to .git is not allowed"),
            s if s.contains(':') || s.contains('\0') => bail!("invalid path {p:?}"),
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        bail!("empty path");
    }
    Ok(parts.join("/"))
}

pub fn parent(p: &str) -> &str {
    p.rfind('/').map(|i| &p[..i]).unwrap_or("")
}

// ---------------------------------------------------------------- memory

#[derive(Default, Clone)]
pub struct MemFs {
    files: BTreeMap<String, String>,
}

impl MemFs {
    pub fn new(files: BTreeMap<String, String>) -> Result<Self> {
        if files.len() > MAX_FILES {
            bail!("too many files ({} > {MAX_FILES})", files.len());
        }
        let mut out = BTreeMap::new();
        for (k, v) in files {
            out.insert(clean(&k)?, v);
        }
        Ok(Self { files: out })
    }
}

impl Fs for MemFs {
    fn read(&self, p: &str) -> Result<String> {
        let c = clean(p)?;
        self.files.get(&c).cloned().ok_or_else(|| NotFound(c).into())
    }

    fn write(&mut self, p: &str, content: &str) -> Result<()> {
        let c = clean(p)?;
        if content.len() > MAX_FILE_SIZE {
            bail!("{c}: file too large");
        }
        self.files.insert(c, content.to_string());
        Ok(())
    }

    fn delete(&mut self, p: &str) -> Result<()> {
        self.files.remove(&clean(p)?);
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (clean(from)?, clean(to)?);
        let v = self.files.remove(&f).ok_or_else(|| NotFound(f.clone()))?;
        self.files.insert(t, v);
        Ok(())
    }

    fn list(&self) -> Result<BTreeMap<String, String>> {
        Ok(self.files.clone())
    }
}

// ---------------------------------------------------------------- disk

/// A collection directory. Every access is checked against the canonical
/// root, so symlinks cannot be used to reach files outside of it.
pub struct DiskFs {
    root: PathBuf,
}

impl DiskFs {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        std::fs::create_dir_all(dir.as_ref())?;
        let root = dir.as_ref().canonicalize()?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves a clean path and verifies that the deepest existing ancestor
    /// stays inside the root.
    fn resolve(&self, c: &str) -> Result<PathBuf> {
        let full = self.root.join(c);
        let mut probe = full.as_path();
        loop {
            if probe.exists() {
                let canon = probe.canonicalize()?;
                if !canon.starts_with(&self.root) {
                    bail!("{c}: path escapes the collection");
                }
                return Ok(full);
            }
            probe = match probe.parent() {
                Some(p) => p,
                None => return Ok(full),
            };
        }
    }

    fn prune(&self, mut dir: String) {
        while !dir.is_empty() {
            if std::fs::remove_dir(self.root.join(&dir)).is_err() {
                return;
            }
            dir = parent(&dir).to_string();
        }
    }

    fn walk(&self, dir: &Path, rel: &str, out: &mut BTreeMap<String, String>) -> Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let ft = match e.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    self.walk(&e.path(), &path, out)?;
                }
                continue;
            }
            // symlinks and special files are not part of a collection
            if !ft.is_file() || name == ".DS_Store" {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.len() as usize > MAX_FILE_SIZE {
                continue;
            }
            if out.len() >= MAX_FILES {
                bail!("collection has more than {MAX_FILES} files");
            }
            if let Ok(bytes) = std::fs::read(e.path()) {
                if let Ok(text) = String::from_utf8(bytes) {
                    out.insert(path, text);
                }
            }
        }
        Ok(())
    }
}

impl Fs for DiskFs {
    fn read(&self, p: &str) -> Result<String> {
        let c = clean(p)?;
        let full = self.resolve(&c)?;
        match std::fs::read_to_string(&full) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(NotFound(c).into()),
            Err(e) => Err(anyhow!(e).context(c)),
        }
    }

    fn write(&mut self, p: &str, content: &str) -> Result<()> {
        let c = clean(p)?;
        if content.len() > MAX_FILE_SIZE {
            bail!("{c}: file too large");
        }
        let full = self.resolve(&c)?;
        if let Some(dir) = full.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // re-check after creating directories
        let full = self.resolve(&c)?;
        std::fs::write(&full, content).with_context(|| c.clone())
    }

    fn delete(&mut self, p: &str) -> Result<()> {
        let c = clean(p)?;
        let full = self.resolve(&c)?;
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow!(e).context(c)),
        }
        self.prune(parent(&c).to_string());
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (clean(from)?, clean(to)?);
        let (ff, tf) = (self.resolve(&f)?, self.resolve(&t)?);
        if let Some(dir) = tf.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&ff, &tf).with_context(|| format!("rename {f} -> {t}"))?;
        self.prune(parent(&f).to_string());
        Ok(())
    }

    fn list(&self) -> Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        self.walk(&self.root, "", &mut out)?;
        Ok(out)
    }
}

impl Fs for Box<dyn Fs> {
    fn read(&self, p: &str) -> Result<String> {
        (**self).read(p)
    }
    fn write(&mut self, p: &str, content: &str) -> Result<()> {
        (**self).write(p, content)
    }
    fn delete(&mut self, p: &str) -> Result<()> {
        (**self).delete(p)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        (**self).rename(from, to)
    }
    fn list(&self) -> Result<BTreeMap<String, String>> {
        (**self).list()
    }
}

// ---------------------------------------------------------------- tracking

/// Records every change made through it so it can be reported back to the
/// client (None = deleted).
pub struct Tracking<F: Fs> {
    pub inner: F,
    pub changes: BTreeMap<String, Option<String>>,
}

impl<F: Fs> Tracking<F> {
    pub fn new(inner: F) -> Self {
        Self { inner, changes: BTreeMap::new() }
    }
}

impl<F: Fs> Fs for Tracking<F> {
    fn read(&self, p: &str) -> Result<String> {
        self.inner.read(p)
    }
    fn write(&mut self, p: &str, content: &str) -> Result<()> {
        self.inner.write(p, content)?;
        self.changes.insert(clean(p)?, Some(content.to_string()));
        Ok(())
    }
    fn delete(&mut self, p: &str) -> Result<()> {
        self.inner.delete(p)?;
        self.changes.insert(clean(p)?, None);
        Ok(())
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.inner.rename(from, to)?;
        let t = clean(to)?;
        let content = self.inner.read(&t).ok();
        self.changes.insert(clean(from)?, None);
        self.changes.insert(t, content);
        Ok(())
    }
    fn list(&self) -> Result<BTreeMap<String, String>> {
        self.inner.list()
    }
}

// ---------------------------------------------------------------- overlay

/// Unsaved editor content on top of a collection: reads prefer the overlay,
/// writes go to the underlying collection (and drop the overlay entry).
pub struct Overlay<F: Fs> {
    pub inner: F,
    over: BTreeMap<String, String>,
}

impl<F: Fs> Overlay<F> {
    pub fn new(inner: F, over: BTreeMap<String, String>) -> Result<Self> {
        let mut clean_over = BTreeMap::new();
        for (k, v) in over {
            clean_over.insert(clean(&k)?, v);
        }
        Ok(Self { inner, over: clean_over })
    }
}

impl<F: Fs> Fs for Overlay<F> {
    fn read(&self, p: &str) -> Result<String> {
        match self.over.get(&clean(p)?) {
            Some(v) => Ok(v.clone()),
            None => self.inner.read(p),
        }
    }
    fn write(&mut self, p: &str, content: &str) -> Result<()> {
        self.over.remove(&clean(p)?);
        self.inner.write(p, content)
    }
    fn delete(&mut self, p: &str) -> Result<()> {
        self.over.remove(&clean(p)?);
        self.inner.delete(p)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.over.remove(&clean(from)?);
        self.inner.rename(from, to)
    }
    fn list(&self) -> Result<BTreeMap<String, String>> {
        let mut all = self.inner.list()?;
        all.extend(self.over.clone());
        Ok(all)
    }
}

/// Sorted paths below `dir` ("" = everything).
pub fn list_dir(fs: &dyn Fs, dir: &str) -> Result<Vec<String>> {
    let prefix = if dir.is_empty() || dir == "." { String::new() } else { format!("{}/", clean(dir)?) };
    Ok(fs.list()?.into_keys().filter(|p| p.starts_with(&prefix)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_rejects_escapes() {
        assert_eq!(clean("/a//b/./c").unwrap(), "a/b/c");
        assert!(clean("a/../../etc").is_err());
        assert!(clean(".git/config").is_err());
        assert!(clean("C:/windows").is_err());
        assert!(clean("").is_err());
    }

    #[test]
    fn disk_roundtrip_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let mut fs = DiskFs::open(dir.path()).unwrap();
        fs.write("requests/a/b.req.yaml", "x").unwrap();
        assert_eq!(fs.read("requests/a/b.req.yaml").unwrap(), "x");
        assert_eq!(fs.list().unwrap().len(), 1);
        fs.delete("requests/a/b.req.yaml").unwrap();
        assert!(!dir.path().join("requests").exists());
        assert!(is_not_found(&fs.read("nope").unwrap_err()));
    }

    #[test]
    fn overlay_prefers_unsaved_content() {
        let mut base = BTreeMap::new();
        base.insert("a.txt".to_string(), "saved".to_string());
        let mut over = BTreeMap::new();
        over.insert("a.txt".to_string(), "draft".to_string());
        let mut fs = Overlay::new(MemFs::new(base).unwrap(), over).unwrap();
        assert_eq!(fs.read("a.txt").unwrap(), "draft");
        fs.write("a.txt", "written").unwrap();
        assert_eq!(fs.read("a.txt").unwrap(), "written");
        assert_eq!(fs.inner.read("a.txt").unwrap(), "written");
    }

    #[cfg(unix)]
    #[test]
    fn disk_blocks_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let mut fs = DiskFs::open(dir.path()).unwrap();
        assert!(fs.write("link/evil.txt", "x").is_err());
        assert!(fs.read("link/evil.txt").is_err());
    }
}
