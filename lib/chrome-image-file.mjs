import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MAX_CHROME_IMAGE_FILE_BYTES = 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
function imageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function detectedImageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "image/jpeg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
      && bytes.readUInt32LE(4) + 8 === bytes.length) return "image/webp";
  return null;
}

// Only an explicit file supplied by the caller is read. This helper never
// discovers paths, follows symlinks, fetches URLs, or returns a private path.
export async function prepareChromeImageFile({ localPath, expectedSha256, mimeType } = {}) {
  if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")
      || localPath.length > 4096 || path.resolve(localPath) !== localPath) {
    throw imageError("CHROME_IMAGE_PATH_INVALID", "An absolute normalized image path is required.");
  }
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw imageError("CHROME_IMAGE_MIME_INVALID", "Only PNG, JPEG and WebP images are supported.");
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw imageError("CHROME_IMAGE_HASH_MISMATCH", "The expected SHA-256 image digest is required.");
  }
  let handle;
  try {
    const initial = await fsp.lstat(localPath);
    if (initial.isSymbolicLink() || await fsp.realpath(localPath) !== localPath) {
      throw imageError("CHROME_IMAGE_SYMLINK", "The explicit image path must not contain a symlink.");
    }
    if (!initial.isFile()) throw imageError("CHROME_IMAGE_NOT_REGULAR", "The explicit image must be a regular file.");
    if (initial.size < 1 || initial.size > MAX_CHROME_IMAGE_FILE_BYTES) {
      throw imageError("CHROME_IMAGE_TOO_LARGE", "The image must be between 1 byte and 1 MiB.");
    }
    handle = await fsp.open(localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw imageError("CHROME_IMAGE_NOT_REGULAR", "The explicit image must be a regular file.");
    if (before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size
        || before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs) {
      throw imageError("CHROME_IMAGE_CHANGED", "The image changed before it could be read.");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fsp.lstat(localPath);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink()
        || current.dev !== before.dev || current.ino !== before.ino
        || await fsp.realpath(localPath) !== localPath) {
      throw imageError("CHROME_IMAGE_CHANGED", "The image changed while it was being read.");
    }
    const bytes = buffer.subarray(0, length);
    if (detectedImageMime(bytes) !== mimeType) {
      throw imageError("CHROME_IMAGE_SIGNATURE_MISMATCH", "The image signature does not match its declared MIME type.");
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) throw imageError("CHROME_IMAGE_HASH_MISMATCH", "The image no longer matches the reviewed SHA-256 digest.");
    const name = path.basename(localPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(name)) {
      throw imageError("CHROME_IMAGE_PATH_INVALID", "Use an image filename containing ordinary letters, digits, spaces, dots, underscores or hyphens.");
    }
    const permittedExtensions = { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] };
    if (!permittedExtensions[mimeType].includes(path.extname(name).toLowerCase())) {
      throw imageError("CHROME_IMAGE_SIGNATURE_MISMATCH", "The image filename extension does not match its MIME type.");
    }
    return { name, mimeType, size: bytes.length, sha256, base64: bytes.toString("base64"), lastModified: Math.floor(before.mtimeMs) };
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("CHROME_IMAGE_")) throw error;
    // Filesystem error strings contain local paths. Never forward or audit them.
    throw imageError(error?.code === "ELOOP" ? "CHROME_IMAGE_SYMLINK" : "CHROME_IMAGE_READ_FAILED", "The explicit image could not be read safely.");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
