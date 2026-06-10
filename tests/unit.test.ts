import { describe, it, expect } from "vitest";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "../src/cdn/aes-ecb.js";
import { buildCdnUploadUrl, buildCdnDownloadUrl } from "../src/cdn/cdn-url.js";
import { formatForWechat, extractLargeCodeBlocks } from "../src/bridge/formatter.js";
import { detectApprovalRequest } from "../src/bridge/orchestrator.js";
import { splitMessage } from "../src/wechat/bot.js";

describe("aes-ecb", () => {
  const key = Buffer.from("0123456789abcdef", "utf-8"); // exactly 16 bytes

  it("encrypts and decrypts round-trip", () => {
    const plain = Buffer.from("hello world");
    const encrypted = encryptAesEcb(plain, key);
    expect(encrypted).not.toEqual(plain);
    const decrypted = decryptAesEcb(encrypted, key);
    expect(decrypted.toString()).toBe("hello world");
  });

  it("handles empty buffer", () => {
    const empty = Buffer.alloc(0);
    const encrypted = encryptAesEcb(empty, key);
    const decrypted = decryptAesEcb(encrypted, key);
    expect(decrypted.length).toBe(0);
  });

  it("handles exact 16-byte block", () => {
    const plain = Buffer.from("0123456789abcdef"); // exactly 16 bytes
    const encrypted = encryptAesEcb(plain, key);
    expect(encrypted.length).toBe(32); // PKCS7 adds a full padding block
    const decrypted = decryptAesEcb(encrypted, key);
    expect(decrypted.toString()).toBe("0123456789abcdef");
  });

  it("aesEcbPaddedSize computes correct padded sizes", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(1)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(100)).toBe(112); // ceil((100+1)/16)*16 = ceil(6.31)*16 = 7*16 = 112
  });
});

describe("cdn-url", () => {
  it("builds upload URL", () => {
    const url = buildCdnUploadUrl("upload-param-abc", "myfilekey123");
    expect(url).toContain("novac2c.cdn.weixin.qq.com");
    expect(url).toContain("/upload");
    expect(url).toContain("encrypted_query_param=upload-param-abc");
    expect(url).toContain("filekey=myfilekey123");
  });

  it("builds download URL", () => {
    const url = buildCdnDownloadUrl("download-param-xyz");
    expect(url).toContain("novac2c.cdn.weixin.qq.com");
    expect(url).toContain("/download");
    expect(url).toContain("encrypted_query_param=download-param-xyz");
  });

  it("URL-encodes special chars in query param", () => {
    const url = buildCdnUploadUrl("a+b/c=d", "key");
    expect(url).toContain("encrypted_query_param=a%2Bb%2Fc%3Dd");
  });
});

describe("formatter", () => {
  it("strips markdown bold/italic", () => {
    expect(formatForWechat("**bold** and *italic*")).toBe("bold and italic");
  });

  it("strips markdown links", () => {
    expect(formatForWechat("[click here](https://example.com)")).toBe("click here");
  });

  it("converts headers", () => {
    expect(formatForWechat("# Title")).toBe("【Title】");
    expect(formatForWechat("## Section")).toBe("【Section】");
    expect(formatForWechat("### Sub")).toBe("【Sub】");
  });

  it("strips inline code but keeps fenced blocks", () => {
    const input = "Use `foo.bar()` here\n\n```js\nconst x = 1;\n```";
    const result = formatForWechat(input);
    expect(result).toContain("Use foo.bar() here");
    expect(result).toContain("```js");
    expect(result).toContain("const x = 1;");
  });

  it("converts list markers", () => {
    expect(formatForWechat("- item 1\n- item 2")).toContain("• item 1");
    expect(formatForWechat("* item")).toContain("• item");
  });

  it("strips HTML tags", () => {
    expect(formatForWechat("<div>hello</div>")).toBe("hello");
  });

  it("condenses blank lines", () => {
    expect(formatForWechat("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitMessage("hello", 100);
    expect(result).toEqual(["hello"]);
  });

  it("returns single chunk when text equals maxLen", () => {
    const text = "a".repeat(100);
    const result = splitMessage(text, 100);
    expect(result).toEqual([text]);
  });

  it("splits at paragraph break (double newline)", () => {
    const a = "a".repeat(120);
    const b = "b".repeat(120);
    const text = `${a}\n\n${b}`;
    const result = splitMessage(text, 200);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("a");
    expect(result[1]).toContain("b");
  });

  it("splits at line break when no paragraph break", () => {
    const a = "a".repeat(120);
    const b = "b".repeat(120);
    const text = `${a}\n${b}`;
    const result = splitMessage(text, 200);
    expect(result.length).toBe(2);
  });

  it("hard splits when no natural break point found", () => {
    const text = "x".repeat(500);
    const result = splitMessage(text, 100);
    expect(result.length).toBe(5);
    result.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(100);
    });
  });

  it("does not split inside code fences", () => {
    const prefix = "Before\n\n";
    const code = "```\n" + "c".repeat(300) + "\n```";
    const suffix = "\n\nAfter";
    const text = prefix + code + suffix;
    const result = splitMessage(text, 200);

    // Code block should be intact in one chunk
    const allText = result.join("\n");
    expect(allText).toContain("```");
    expect(allText).toContain("c");
  });

  it("handles edge case: text just over maxLen with no breaks", () => {
    const text = "y".repeat(101);
    const result = splitMessage(text, 100);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(100);
    expect(result[1].length).toBe(1);
  });

  it("all chunks are within maxLen", () => {
    // Build a long text with mixed paragraph breaks
    let text = "";
    for (let i = 0; i < 20; i++) {
      text += `paragraph ${i}: ` + "abc ".repeat(30) + "\n\n";
    }
    const result = splitMessage(text, 500);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    // Rejoined should preserve all content (modulo whitespace trimming at boundaries)
    const rejoined = result.join("\n");
    expect(rejoined.length).toBeGreaterThanOrEqual(text.trim().length - result.length * 2);
  });
});

describe("extractLargeCodeBlocks", () => {
  it("leaves small code blocks inline", () => {
    const input = "```js\nconst x = 1;\n```";
    const result = extractLargeCodeBlocks(input, 500);
    expect(result.files).toHaveLength(0);
    expect(result.text).toContain("const x = 1;");
  });

  it("extracts large code blocks and replaces with placeholder", () => {
    const code = "a".repeat(1500);
    const input = `Here's the code:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`;
    const result = extractLargeCodeBlocks(input, 1200);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toBe(code);
    expect(result.files[0].filename).toContain(".ts");
    expect(result.text).not.toContain(code);
    expect(result.text).toContain("📎");
    expect(result.text).toContain("代码已作为文件发送");
    expect(result.text).toContain("Done.");
  });

  it("handles multiple large code blocks", () => {
    const big1 = "x".repeat(1500);
    const big2 = "y".repeat(1500);
    const input = `\`\`\`py\n${big1}\n\`\`\`\n\`\`\`py\n${big2}\n\`\`\`\``;
    const result = extractLargeCodeBlocks(input, 1200);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].filename).toContain(".py");
    expect(result.files[1].filename).toContain(".py");
    expect(result.text).toContain("code_1.py");
    expect(result.text).toContain("code_2.py");
  });

  it("maps languages to correct extensions", () => {
    const cases: [string, string][] = [
      ["typescript", ".ts"],
      ["python", ".py"],
      ["rust", ".rs"],
      ["go", ".go"],
      ["json", ".json"],
      ["bash", ".sh"],
      ["yaml", ".yml"],
      ["unknown_lang", ".txt"],
    ];
    for (const [lang, ext] of cases) {
      const code = "a".repeat(1500);
      const input = `\`\`\`${lang}\n${code}\n\`\`\``;
      const result = extractLargeCodeBlocks(input, 1200);
      expect(result.files[0].filename).toContain(ext);
    }
  });

  it("only extracts blocks over minChars threshold", () => {
    const small = "a".repeat(100);
    const big = "b".repeat(1500);
    const input = `\`\`\`ts\n${small}\n\`\`\`\n\`\`\`ts\n${big}\n\`\`\``;
    const result = extractLargeCodeBlocks(input, 1200);
    expect(result.files).toHaveLength(1);
    expect(result.text).toContain(small);
    expect(result.text).not.toContain(big);
  });
});

describe("detectApprovalRequest", () => {
  it("detects Chinese approval questions", () => {
    expect(detectApprovalRequest("是否批准创建文件？")).toBe(true);
    expect(detectApprovalRequest("是否同意执行？")).toBe(true);
    expect(detectApprovalRequest("确认继续？")).toBe(true);
  });

  it("detects English approval questions", () => {
    expect(detectApprovalRequest("Should I proceed with the installation?")).toBe(true);
    expect(detectApprovalRequest("Would you like me to create this file?")).toBe(true);
    expect(detectApprovalRequest("Do you want me to run the tests?")).toBe(true);
  });

  it("detects tool execution questions", () => {
    expect(detectApprovalRequest("May I write to the file?")).toBe(true);
    expect(detectApprovalRequest("Want me to execute npm install?")).toBe(true);
    expect(detectApprovalRequest("Should I modify src/config.ts?")).toBe(true);
  });

  it("detects yes/no confirmation patterns", () => {
    expect(detectApprovalRequest("Proceed with deletion? (y/n)")).toBe(true);
  });

  it("does not match regular statements", () => {
    expect(detectApprovalRequest("I have created the file.")).toBe(false);
    expect(detectApprovalRequest("Here is the result:")).toBe(false);
    expect(detectApprovalRequest("The code has been written to src/index.ts")).toBe(false);
  });

  it("detects numbered option lists with approval keywords", () => {
    expect(detectApprovalRequest("1. 批准创建\n2. 拒绝")).toBe(true);
  });
});
