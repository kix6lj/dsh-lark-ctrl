/**
 * Image media-type sniffing — pure byte arithmetic, no DSH or Lark imports.
 *
 * Feishu image messages carry only an opaque `image_key`; the resource download
 * returns raw bytes with no declared MIME. DSH's attachment service requires a
 * caller-declared media type that is verified against the decoded bytes, so the
 * type has to come from the bytes themselves: a wrong declaration fails
 * admission and the image never reaches the session.
 */

/** The media types DSH's attachment path accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Sniff the media type from image magic bytes.
 * @param {Uint8Array | undefined} bytes
 * @returns {'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined}
 */
export function sniffImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return undefined
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  // WEBP: "RIFF" .... "WEBP"
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

/**
 * File extension for an accepted media type (display name for the attachment).
 * @param {string} mediaType
 * @returns {string}
 */
export function imageExtensionOf(mediaType) {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'bin'
  }
}

/**
 * Image key out of a Feishu image message's `content` JSON string.
 * @param {unknown} content
 * @returns {string | undefined}
 */
export function parseImageKey(content) {
  if (typeof content !== 'string' || content.trim() === '') return undefined
  try {
    const parsed = JSON.parse(content)
    return typeof parsed?.image_key === 'string' && parsed.image_key !== '' ? parsed.image_key : undefined
  } catch {
    return undefined
  }
}

/**
 * Text and image keys out of a raw message body.
 *
 * A plain image message is `{ "image_key": "…" }`; a rich-text (`post`) message
 * is `{ "content": [[{ "tag": "text", … }, { "tag": "img", "image_key": "…" }]] }`,
 * which is how one Feishu message can carry text and pictures together.
 * @param {unknown} raw
 * @returns {{ text: string, imageKeys: string[] } | undefined}
 */
export function parseRichContent(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const imageKeys = []
  if (typeof parsed.image_key === 'string' && parsed.image_key !== '') imageKeys.push(parsed.image_key)
  const parts = []
  const paragraphs = Array.isArray(parsed.content) ? parsed.content : []
  for (const paragraph of paragraphs) {
    const nodes = Array.isArray(paragraph) ? paragraph : [paragraph]
    for (const node of nodes) {
      const tag = typeof node?.tag === 'string' ? node.tag : ''
      if ((tag === 'text' || tag === 'a' || tag === 'at') && typeof node.text === 'string') {
        parts.push(node.text)
      } else if (tag === 'img' && typeof node.image_key === 'string' && node.image_key !== '') {
        imageKeys.push(node.image_key)
      } else if (tag === 'code_block' && typeof node.text === 'string') {
        parts.push(node.text)
      }
    }
    parts.push('\n')
  }
  const text = parts.join('').trim()
  if (imageKeys.length === 0 && text === '') return undefined
  return { text, imageKeys }
}
