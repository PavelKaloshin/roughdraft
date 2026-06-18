/**
 * Classify a file in the directory tree so the workspace knows how to present
 * it. Markdown is the only fully interactive unit of work (review, comment,
 * edit, save per ADR 0001/0005); every other file is opened read-only — code
 * with syntax highlighting, plain text as-is, images as a preview, and
 * anything else as a non-previewable stub.
 */
export type FileKind = "markdown" | "code" | "text" | "image" | "binary";

export interface FileTypeInfo {
  kind: FileKind;
}

/**
 * Markdown is detected exactly the way the server gates `/api/markdown-file`
 * (`endsWith(".md")`), so `.markdown` and `.mdx` are intentionally treated as
 * read-only text rather than routed into the comment/edit workspace where the
 * server would reject them.
 */
export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "bmp",
  "ico",
]);

// Files that are not text we can usefully render in a code viewer. Images are
// handled separately above; everything here falls back to a "no preview" stub.
const BINARY_EXTENSIONS = new Set([
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "rar",
  "7z",
  "bz2",
  "xz",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "wasm",
  "class",
  "jar",
  "node",
  "pyc",
  "o",
  "a",
  "lib",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "pages",
  "numbers",
  "key",
  "psd",
  "ai",
  "sketch",
  "fig",
  "db",
  "sqlite",
  "sqlite3",
]);

// Extensions that read as source code; used to pick the code icon. The viewer
// itself attempts syntax highlighting for any matched language, so this set
// only needs to be good enough to distinguish code from prose at a glance.
const CODE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "json",
  "json5",
  "jsonc",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "gradle",
  "cmake",
  "lua",
  "r",
  "dart",
  "scala",
  "clj",
  "cljs",
  "cljc",
  "edn",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "ml",
  "mli",
  "fs",
  "fsx",
  "pl",
  "pm",
  "proto",
  "graphql",
  "gql",
  "tf",
  "tfvars",
  "hcl",
  "bat",
  "cmd",
  "zig",
  "nim",
  "jl",
  "groovy",
  "tcl",
  "vim",
]);

// Well-known filenames without a useful extension that are still source code.
const CODE_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "rakefile",
  "gemfile",
  "brewfile",
  "procfile",
  "vagrantfile",
  "jenkinsfile",
  "cmakelists.txt",
]);

function fileName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function classifyFile(path: string): FileTypeInfo {
  if (isMarkdownPath(path)) return { kind: "markdown" };

  const name = fileName(path).toLowerCase();
  const extension = extensionOf(name);

  if (extension && IMAGE_EXTENSIONS.has(extension)) return { kind: "image" };
  if (extension && BINARY_EXTENSIONS.has(extension)) return { kind: "binary" };

  if (CODE_FILENAMES.has(name)) return { kind: "code" };
  if (extension && CODE_EXTENSIONS.has(extension)) return { kind: "code" };

  // Anything else that is not known-binary — including extensionless files like
  // LICENSE or README and plain `.txt`/`.log` — is treated as readable text.
  return { kind: "text" };
}

/** Files we can open read-only (everything except non-previewable binaries). */
export function isOpenableFile(path: string): boolean {
  return classifyFile(path).kind !== "binary";
}
