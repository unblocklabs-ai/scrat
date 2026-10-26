import { escapeSlack } from "./slack.ts";

type Style = { bold?: true; italic?: true; strike?: true; code?: true };
type Inline = { type: "text"; text: string; style?: Style } | { type: "link"; url: string; text?: string };

const inline = /`([^`\n]+)`|(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)|(?<!\w)~([^~\n]+)~(?!\w)|<(https?:\/\/[^|>\s]+)(?:\|([^>\n]*))?>/g;

function richTextElements(mrkdwn: string): Inline[] {
  const elements: Inline[] = [];
  let last = 0;
  const plain = (text: string) => { if (text) elements.push({ type: "text", text }); };
  for (const match of mrkdwn.matchAll(inline)) {
    plain(mrkdwn.slice(last, match.index));
    last = match.index + match[0].length;
    const [, code, bold, italic, strike, url, label] = match;
    if (url) elements.push({ type: "link", url, ...label ? { text: label } : {} });
    else if (code) elements.push({ type: "text", text: code, style: { code: true } });
    else if (bold) elements.push({ type: "text", text: bold, style: { bold: true } });
    else if (italic) elements.push({ type: "text", text: italic, style: { italic: true } });
    else elements.push({ type: "text", text: strike!, style: { strike: true } });
  }
  plain(mrkdwn.slice(last));
  return elements;
}

export function reviewBlocks(text: string) {
  const elements: unknown[] = [];
  let items: unknown[] | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const bullet = line.startsWith("• ") && line.slice(2).trim();
    if (!bullet) {
      items = undefined;
      elements.push({ type: "rich_text_section", elements: richTextElements(line) });
      continue;
    }
    if (!items) {
      items = [];
      elements.push({ type: "rich_text_list", style: "bullet", elements: items });
    }
    items.push({ type: "rich_text_section", elements: richTextElements(bullet) });
  }
  return [{ type: "rich_text", elements }];
}

export const tableBlock = (header: string[], rows: string[][], options: { align?: ("left" | "center" | "right")[] } = {}) => ({
  type: "table",
  ...options.align ? { column_settings: options.align.map((align) => ({ align })) } : {},
  rows: [header, ...rows].map((row) => row.map((text) => ({ type: "raw_text", text }))),
});

export const linkSection = (url: string, label: string) => ({ type: "section", text: { type: "mrkdwn", text: `<${url}|${escapeSlack(label)}>` } });
