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
  // Word almost always writes these with attributes — `<w:br w:type="text
  // Wrapping"/>` rather than a bare `<w:br/>`. Missing them silently welds
  // lines together ("GermistonMobile:", "6093Email:"), and a phone number with
  // a letter jammed against it stops looking like a phone number at all.
  // Rewritten as text nodes, not raw characters: only the contents of <w:t>
  // are harvested below, so a bare "\n" dropped between elements would be
  // thrown away and the lines would still weld together.
  const normalised = paragraph
    .replace(/<w:tab(?:\s[^>]*)?\/>/g, '<w:t>\t</w:t>')
    .replace(/<w:(?:br|cr)(?:\s[^>]*)?\/>/g, '<w:t>\n</w:t>')

  return [...normalised.matchAll(TEXT_NODE_RE)]
    .map((node) => unescapeXml(node[2]))
    .join('')
}
