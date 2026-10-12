// notes. ⇄ Markdown. A note is kept as TipTap's JSON (notes.body); this turns
// it into Markdown (Download as Markdown, and the nightly backup in the
// hub-backups repo, which keeps a copy of this file: scripts/markdown.js) and
// turns Markdown into it (Import). Plain functions, no browser needed.
//
// Covered: headings, paragraphs, bullet / numbered / checklists (nested),
// quotes, code blocks, dividers, line breaks; bold, italic, strikethrough,
// inline code and links. Block colours and page styles aren't Markdown, so
// they're left out; images in imported Markdown are dropped.

// ─── To Markdown ─────────────────────────────────────────────────────
function inline(nodes = []) {
  return nodes.map((n) => {
    if (n.type === "hardBreak") return "  \n";
    if (n.type !== "text") return "";
    let t = n.text || "";
    const marks = n.marks || [];
    const has = (m) => marks.some(x => x.type === m);
    if (has("code")) return `\`${t}\``;
    t = t.replace(/([*_`~\[\]\\])/g, "\\$1");
    if (has("bold")) t = `**${t}**`;
    if (has("italic")) t = `*${t}*`;
    if (has("strike")) t = `~~${t}~~`;
    const link = marks.find(x => x.type === "link");
    if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`;
    return t;
  }).join("");
}

function blocks(nodes = [], indent = "") {
  const out = [];
  for (const n of nodes) {
    const c = n.content || [];
    switch (n.type) {
      case "heading": out.push(`${indent}${"#".repeat(Math.min(6, n.attrs?.level || 1))} ${inline(c)}`); break;
      case "paragraph": out.push(`${indent}${inline(c)}`); break;
      case "horizontalRule": out.push(`${indent}---`); break;
      case "codeBlock": out.push(`${indent}\`\`\`${n.attrs?.language || ""}\n${c.map(x => x.text || "").join("").split("\n").map(l => indent + l).join("\n")}\n${indent}\`\`\``); break;
      case "blockquote": out.push(blocks(c, "").split("\n").map(l => `${indent}> ${l}`.trimEnd()).join("\n")); break;
      case "bulletList": case "orderedList": case "taskList": {
        const lines = c.map((item, i) => {
          const marker = n.type === "orderedList" ? `${(n.attrs?.start || 1) + i}.` : n.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
          const [first, ...rest] = item.content || [];
          const head = `${indent}${marker} ${first?.type === "paragraph" ? inline(first.content) : ""}`.trimEnd();
          const more = rest.length ? blocks(rest, indent + " ".repeat(n.type === "orderedList" ? marker.length + 1 : 2)) : "";
          return more ? `${head}\n${more}` : head;
        });
        out.push(lines.join("\n"));
        break;
      }
      default: if (c.length) out.push(blocks(c, indent));
    }
  }
  // Lists keep their items together; everything else has a blank line between.
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

// A whole note: its title as a heading, then the note.
export function toMarkdown(doc, title = "") {
  const body = blocks(doc?.content || []).trim();
  return `${title ? `# ${title}\n\n` : ""}${body}\n`;
}

// ─── From Markdown ───────────────────────────────────────────────────
const text = (t, marks) => (t ? [{ type: "text", text: t, ...(marks?.length ? { marks } : {}) }] : []);

// **bold**, *italic*, ~~strike~~, `code`, [links](url) — nested where they nest.
function parseInline(src, marks = []) {
  const out = [];
  const rules = [
    { re: /`([^`]+)`/, make: (m) => text(m[1], [...marks, { type: "code" }]) },
    { re: /!\[[^\]]*\]\([^)]*\)/, make: () => [] },
    { re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: (m) => parseInline(m[1], [...marks, { type: "link", attrs: { href: m[2] } }]) },
    { re: /(\*\*|__)(.+?)\1/, make: (m) => parseInline(m[2], [...marks, { type: "bold" }]) },
    { re: /~~(.+?)~~/, make: (m) => parseInline(m[1], [...marks, { type: "strike" }]) },
    { re: /(\*|_)(?=\S)(.+?)(?<=\S)\1/, make: (m) => parseInline(m[2], [...marks, { type: "italic" }]) },
    { re: /<(https?:\/\/[^>\s]+)>/, make: (m) => text(m[1], [...marks, { type: "link", attrs: { href: m[1] } }]) },
  ];
  let rest = src;
  while (rest) {
    let best = null;
    for (const r of rules) {
      const m = rest.match(r.re);
      if (m && (best === null || m.index < best.m.index)) best = { m, r };
    }
    if (!best) { out.push(...text(unescape(rest), marks)); break; }
    if (best.m.index) out.push(...text(unescape(rest.slice(0, best.m.index)), marks));
    out.push(...best.r.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}
const unescape = (t) => t.replace(/\\([*_`~\[\]\\#>+\-.!])/g, "$1");
const para = (t) => ({ type: "paragraph", content: parseInline(t) });

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

// Markdown → { title, doc }: a first "# Heading" becomes the title.
export function fromMarkdown(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  let i = 0;
  function parseBlocks(stop = () => false) {
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(para(buf.join(" ").trim())); buf = []; } };
    while (i < lines.length && !stop(lines[i])) {
      const line = lines[i];
      if (!line.trim()) { flush(); i++; continue; }
      let m;
      if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/))) {
        flush();
        const fence = m[1], code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
        i++;
        out.push({ type: "codeBlock", attrs: { language: m[2] || null }, content: text(code.join("\n")) });
        continue;
      }
      if ((m = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); out.push({ type: "heading", attrs: { level: Math.min(3, m[1].length) }, content: parseInline(m[2]) }); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ type: "horizontalRule" }); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush();
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push({ type: "blockquote", content: fromMarkdown(quoted.join("\n")).doc.content.filter(Boolean) });
        continue;
      }
      if (LIST.test(line)) { flush(); out.push(parseList(line.match(LIST)[1].length)); continue; }
      buf.push(line.trim().endsWith("  ") ? line.trim() : line.trim());
      i++;
    }
    flush();
    return out;
  }
  // A run of list lines at one indent; deeper lines nest under the item before.
  function parseList(indent) {
    const first = lines[i].match(LIST);
    const kind = first[3] !== undefined ? "taskList" : /\d/.test(first[2]) ? "orderedList" : "bulletList";
    const list = { type: kind, content: [] };
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (!m) {
        // A blank line ends the list unless the next line carries on.
        if (!lines[i].trim() && LIST.test(lines[i + 1] || "") && lines[i + 1].match(LIST)[1].length >= indent) { i++; continue; }
        break;
      }
      const depth = m[1].length;
      if (depth < indent) break;
      if (depth > indent) { const last = list.content.at(-1); if (last) last.content.push(parseList(depth)); else i++; continue; }
      const itemKind = m[3] !== undefined ? "taskList" : /\d/.test(m[2]) ? "orderedList" : "bulletList";
      if (itemKind !== kind) break;
      i++;
      list.content.push(kind === "taskList"
        ? { type: "taskItem", attrs: { checked: /x/i.test(m[3]) }, content: [para(m[4])] }
        : { type: "listItem", content: [para(m[4])] });
    }
    if (kind === "orderedList") list.attrs = { start: Number(first[2].replace(/\D/g, "")) || 1 };
    return list;
  }
  const content = parseBlocks();
  let title = "";
  if (content[0]?.type === "heading" && content[0].attrs.level === 1) {
    title = (content.shift().content || []).map(n => n.text || "").join("").trim();
  }
  return { title, doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] } };
}

// The note's words, for search (notes.body_text).
export function plainText(doc) {
  const out = [];
  const walk = (n) => {
    if (n.type === "text") { out[out.length - 1] += n.text; return; }
    const block = !["text", "hardBreak"].includes(n.type) && n.type !== "doc" && !(n.content || []).some(c => !["text", "hardBreak"].includes(c.type));
    if (block) out.push("");
    for (const c of n.content || []) walk(c);
  };
  out.push("");
  walk(doc || {});
  return out.map(s => s.trim()).filter(Boolean).join("\n");
}
