/**
 * Convert OpenCode markdown responses into channel-appropriate format.
 * WeChat: strip markdown to plain text (no markdown rendering).
 * Feishu: pass through markdown as-is (native markdown rendering).
 */

export interface ExtractedCodeFile {
  /** Display filename (e.g. "main.ts", "config.json") */
  filename: string;
  /** Code content */
  content: string;
  /** Language hint from markdown fence (e.g. "typescript", "python") */
  lang: string;
}

/**
 * Extract large code fence blocks from markdown and replace with placeholder notes.
 * Returns the cleaned text and the extracted code files.
 * Blocks under minChars are left inline.
 */
export function extractLargeCodeBlocks(
  text: string,
  minChars: number = 1200,
): { text: string; files: ExtractedCodeFile[] } {
  const files: ExtractedCodeFile[] = [];
  let result = text;
  let counter = 0;

  // Match fenced code blocks: ```lang\n...content...\n```
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang: string, code: string) => {
      if (code.length < minChars) {
        // Small block — leave it inline
        return `\`\`\`${lang}\n${code}\`\`\``;
      }

      // Large block — extract to file
      const ext = langToExt(lang);
      const filename = `code_${++counter}.${ext}`;
      files.push({ filename, content: code.trimEnd(), lang: lang || "text" });
      return `📎 [代码已作为文件发送: ${filename} (${code.split("\n").length} 行, ${code.length} 字符)]`;
    },
  );

  return { text: result, files };
}

/** Map common language identifiers to file extensions. */
function langToExt(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts", ts: "ts", tsx: "tsx",
    javascript: "js", js: "js", jsx: "jsx",
    python: "py", py: "py",
    rust: "rs", rs: "rs",
    go: "go", golang: "go",
    java: "java",
    csharp: "cs", cs: "cs", "c#": "cs",
    cpp: "cpp", "c++": "cpp", c: "c",
    ruby: "rb", rb: "rb",
    php: "php",
    swift: "swift",
    kotlin: "kt", kt: "kt",
    scala: "scala",
    shell: "sh", sh: "sh", bash: "sh", zsh: "sh",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss", sass: "sass",
    json: "json",
    yaml: "yml", yml: "yml",
    xml: "xml",
    markdown: "md", md: "md",
    dockerfile: "dockerfile", docker: "dockerfile",
    toml: "toml",
    ini: "ini", cfg: "cfg",
    diff: "diff", patch: "patch",
  };
  const key = lang.toLowerCase().trim();
  return map[key] ?? "txt";
}

/**
 * Format a markdown response for the given channel.
 * Dispatching wrapper — each channel gets its own formatting rules.
 */
export function formatForChannel(channel: string, md: string): string {
  switch (channel) {
    case "feishu":
      return formatForFeishu(md);
    case "wechat":
    default:
      return formatForWechat(md);
  }
}

/**
 * Feishu supports native markdown rendering (bold, code blocks, links, etc.).
 * Only minimal cleanup: strip HTML tags and fix heading levels.
 */
export function formatForFeishu(md: string): string {
  let text = md;

  // Strip raw HTML tags (Feishu markdown doesn't render them)
  text = text.replace(/<[^>]*>/g, "");

  // Convert ### heading → **heading** (Feishu markdown uses bold for emphasis)
  // Feishu supports # through ###### natively, so keep headings as-is unless they look bad

  // Condense 3+ blank lines → 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export function formatForWechat(md: string): string {
  let text = md;

  // 1. Strip HTML tags
  text = text.replace(/<[^>]*>/g, "");

  // 2. Convert markdown links [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 3. Convert ### heading → 【heading】
  text = text.replace(/^####?\s+(.*)$/gm, "【$1】");
  text = text.replace(/^##\s+(.*)$/gm, "【$1】");
  text = text.replace(/^#\s+(.*)$/gm, "【$1】");

  // 4. Strip bold (**text** → text) and italic (*text* → text)
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");

  // 5. Strip inline code (single backticks), keep triple-backtick blocks
  // First extract fenced code blocks, process the rest, then restore
  const fences: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `__FENCE_${fences.length - 1}__`;
  });

  text = text.replace(/(?<!`)`([^`\n]+)`(?!`)/g, "$1");

  // 6. Strip horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "───");

  // 7. Clean up markdown list markers for readability
  text = text.replace(/^[-*]\s+/gm, "• ");
  text = text.replace(/^\d+\.\s+/gm, (m) => m.trim());

  // 8. Condense 3+ blank lines → 2
  text = text.replace(/\n{3,}/g, "\n\n");

  // 9. Trim leading/trailing whitespace
  text = text.trim();

  // 10. Restore code fences (keep them — they look OK in WeChat)
  fences.forEach((f, i) => {
    text = text.replace(`__FENCE_${i}__`, f);
  });

  // 11. Collapse multiple spaces (but not in code fences)
  text = text.replace(/ {3,}/g, "  ");

  return text;
}
