//! Файлы с секретами — ссылки подписок, хеш пароля, бэкапы с токеном RCI — доступны только root (600).

use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tokio::io::AsyncWriteExt;

const MODE: u32 = 0o600;

/// Записывает файл с правами 600 (и сужает права, если файл уже был).
pub async fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(MODE)
        .open(path)
        .await?;
    file.write_all(contents.as_ref()).await?;
    file.flush().await?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(MODE)).await
}

/// Создаёт (или обнуляет) файл с правами 600 — для синхронной записи, например архива.
pub fn create(path: &Path) -> io::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(MODE)
        .open(path)?;
    file.set_permissions(std::fs::Permissions::from_mode(MODE))?;
    Ok(file)
}

/// Сужает права существующего файла до 600; отсутствующий файл не ошибка.
pub fn restrict(path: &Path) {
    if path.is_file() {
        _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(MODE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn files_are_root_only() {
        let dir = std::env::temp_dir().join(format!("private-file-{}", std::process::id()));
        _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let new = dir.join("new.json");
        write(&new, "{}").await.unwrap();
        assert_eq!(mode(&new), 0o600);
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "{}");

        // существующий файл с открытыми правами — права сужаются, содержимое заменяется
        let old = dir.join("old.json");
        std::fs::write(&old, "старое содержимое").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        write(&old, "new").await.unwrap();
        assert_eq!(mode(&old), 0o600);
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "new");

        let archive = dir.join("a.tar");
        drop(create(&archive).unwrap());
        assert_eq!(mode(&archive), 0o600);

        let loose = dir.join("loose.json");
        std::fs::write(&loose, "x").unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
        restrict(&loose);
        assert_eq!(mode(&loose), 0o600);
        restrict(&dir.join("missing.json"));

        _ = std::fs::remove_dir_all(&dir);
    }
}
