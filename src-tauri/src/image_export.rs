use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use tauri::ipc::{InvokeBody, Request, Response};

const MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;

fn image_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" | "jpe" | "png" | "webp" | "avif" => Some(extension),
        _ => None,
    }
}

fn is_animated(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "webp" => {
            bytes.get(12..16) == Some(b"VP8X")
                && bytes.get(20).is_some_and(|flags| flags & 0x02 != 0)
        }
        "avif" if bytes.get(4..8) == Some(b"ftyp") => {
            let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            bytes.get(8..size).is_some_and(|brands| {
                brands.get(..4) == Some(b"avis")
                    || brands.get(8..).is_some_and(|compatible| {
                        compatible.chunks_exact(4).any(|brand| brand == b"avis")
                    })
            })
        }
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {
            let mut chunks = &bytes[8..];
            while let Some(header) = chunks.get(..8) {
                match &header[4..8] {
                    b"acTL" => return true,
                    b"IDAT" | b"IEND" => return false,
                    _ => {}
                }
                let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
                let Some(next) = length.checked_add(12).and_then(|end| chunks.get(end..)) else {
                    break;
                };
                chunks = next;
            }
            false
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn read_export_image(file_path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        let extension = image_extension(path).ok_or("Unsupported image type.")?;
        if !path.is_file() {
            return Err("The source image is no longer available.".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .and_then(|file| file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|error| format!("Could not read the source image. {error}"))?;
        if bytes.len() as u64 > MAX_INPUT_BYTES {
            return Err("The source image exceeds 128 MiB.".into());
        }
        if is_animated(&extension, &bytes) {
            return Err("Image export supports still images only.".into());
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_export_image(request: Request<'_>) -> Result<String, String> {
    // A NUL separates the UTF-8 source path from the encoded image bytes.
    let fallback;
    let payload = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(value) => {
            fallback = serde_json::from_value::<Vec<u8>>(value.clone())
                .map_err(|_| "Missing encoded image.")?;
            &fallback
        }
    };
    let boundary = payload
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("Missing source path.")?;
    let source = std::str::from_utf8(&payload[..boundary]).map_err(|error| error.to_string())?;
    let source = PathBuf::from(source);
    let bytes = payload[boundary + 1..].to_vec();

    tauri::async_runtime::spawn_blocking(move || {
        if !source.is_absolute() || image_extension(&source).is_none() {
            return Err("Invalid source image path.".into());
        }
        let extension = if bytes.get(4..12) == Some(b"ftypavif") {
            "avif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "webp"
        } else {
            return Err("The encoder returned an unsupported image.".into());
        };
        write_export(&source, extension, &bytes)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| format!("Could not save the image. {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn write_export(source: &Path, extension: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let stem = source
        .file_stem()
        .ok_or(io::ErrorKind::InvalidInput)?
        .to_string_lossy();
    let mut index = 1;
    loop {
        let name = if index == 1 {
            format!("{stem}_optimized.{extension}")
        } else {
            format!("{stem}_optimized_{index}.{extension}")
        };
        let destination = source.with_file_name(name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                index += 1;
                continue;
            }
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
        return Ok(destination);
    }
}
