/**
 * The little bit of WordprocessingML we need, shared by the reader and the
 * writer so both agree on what counts as a paragraph and where its text lives.
 */

export const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
export const TEXT_NODE_RE = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g

/** Parts of a document that can hold visible text. */
export const TEXT_PARTS_RE =
  /^word\/(document\d*|header\d*|footer\d*|footnotes|endnotes)\.xml$/

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The visible text of one <w:p>, with tabs and line breaks preserved. */
export function paragraphText(paragraph: string): string {
  const normalised = paragraph
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')

  return [...normalised.matchAll(TEXT_NODE_RE)]
    .map((node) => unescapeXml(node[2]))
    .join('')
}
