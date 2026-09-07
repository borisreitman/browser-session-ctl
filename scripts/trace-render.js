#!/usr/bin/env node
/**
 * Render a trace markdown file (commands, snapshots, screenshots) to PDF.
 *
 *   scripts/trace-render.js doc/demo-trace.md
 *   scripts/trace-render.js               # every markdown file under doc/
 *
 * Writes <name>.pdf next to each source. Uses local Chrome --print-to-pdf.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineHtml(text, mdDir) {
  const parts = [];
  const pattern =
    /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    parts.push(escapeHtml(text.slice(last, match.index)));
    if (match[2]) {
      const alt = escapeHtml(match[1]);
      const href = /^https?:\/\//i.test(match[2])
        ? match[2]
        : pathToFileURL(path.resolve(mdDir, match[2])).href;
      parts.push(`<img src="${escapeHtml(href)}" alt="${alt}" />`);
    } else if (match[4]) {
      parts.push(
        `<a href="${escapeHtml(match[4])}">${escapeHtml(match[3])}</a>`
      );
    } else if (match[5] != null) {
      parts.push(`<code>${escapeHtml(match[5])}</code>`);
    } else {
      parts.push(`<strong>${escapeHtml(match[6])}</strong>`);
    }
    last = match.index + match[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

function markdownToHtml(markdown, mdDir) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineHtml(paragraph.join(" "), mdDir)}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushParagraph();
      const lang = escapeHtml(line.slice(3).trim());
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      out.push(
        `<pre><code class="language-${lang}">${escapeHtml(body.join("\n"))}</code></pre>`
      );
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr />");
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineHtml(heading[2], mdDir)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      out.push("<ul>");
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        out.push(`<li>${inlineHtml(lines[i].replace(/^[-*]\s+/, ""), mdDir)}</li>`);
        i += 1;
      }
      out.push("</ul>");
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join("\n");
}

function pageHtml(title, body) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: letter; margin: 16mm 14mm; }
      :root { color-scheme: light; }
      body {
        margin: 0;
        color: #1f2328;
        font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
      }
      h1 { font-size: 22px; margin: 0 0 12px; }
      h2 { font-size: 16px; margin: 22px 0 10px; page-break-after: avoid; }
      p, ul { margin: 0 0 10px; }
      hr { border: 0; border-top: 1px solid #d0d7de; margin: 18px 0; }
      a { color: #0969da; }
      code {
        font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #f6f8fa;
        padding: 0.1em 0.35em;
        border-radius: 4px;
      }
      pre {
        background: #f6f8fa;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        padding: 8px 10px;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        page-break-inside: avoid;
      }
      pre code { background: none; padding: 0; }
      img {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 8px 0 14px;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        page-break-inside: avoid;
      }
    </style>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    process.env.GOOGLE_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  return candidates[0];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function collectMarkdown(argv) {
  if (argv.length > 0) return argv.map((file) => path.resolve(file));
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  }
  await walk(path.join(repoRoot, "doc"));
  return found.sort();
}

async function renderOne(mdPath) {
  const markdown = await readFile(mdPath, "utf8");
  const mdDir = path.dirname(mdPath);
  const title = path.basename(mdPath, ".md");
  const html = pageHtml(title, markdownToHtml(markdown, mdDir));
  const pdfPath = mdPath.replace(/\.md$/i, ".pdf");
  const work = await mkdtemp(path.join(tmpdir(), "trace-render-"));
  const htmlPath = path.join(work, `${title}.html`);
  await writeFile(htmlPath, html);

  const chrome = findChrome();
  try {
    await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ]);
  } finally {
    await unlink(htmlPath).catch(() => {});
  }
  return pdfPath;
}

async function main(argv) {
  const files = await collectMarkdown(argv);
  if (files.length === 0) {
    process.stderr.write("trace-render: no markdown files to render\n");
    process.exit(1);
  }
  for (const file of files) {
    const pdf = await renderOne(file);
    process.stdout.write(`${path.relative(process.cwd(), pdf) || pdf}\n`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
