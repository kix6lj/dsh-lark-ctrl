/**
 * Image media-type sniffing for inbound Feishu images.
 *
 * The resource download returns raw bytes with no declared MIME, while DSH's
 * attachment admission verifies a caller-declared media type against the bytes —
 * so the declaration has to come from the bytes themselves.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { imageExtensionOf, parseImageKey, parseRichContent, sniffImageMediaType } from '../lib/image.js'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])

test('sniffImageMediaType recognises the accepted formats', () => {
  assert.equal(sniffImageMediaType(png), 'image/png')
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
  assert.equal(sniffImageMediaType(gif), 'image/gif')
  assert.equal(sniffImageMediaType(webp), 'image/webp')
})

test('sniffImageMediaType rejects everything else', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined)
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50])), undefined)
  assert.equal(sniffImageMediaType(undefined), undefined)
})

test('imageExtensionOf maps media types to display extensions', () => {
  assert.equal(imageExtensionOf('image/png'), 'png')
  assert.equal(imageExtensionOf('image/jpeg'), 'jpg')
  assert.equal(imageExtensionOf('image/webp'), 'webp')
  assert.equal(imageExtensionOf('image/gif'), 'gif')
  assert.equal(imageExtensionOf('application/octet-stream'), 'bin')
})

test('parseImageKey reads the key out of a raw message body', () => {
  assert.equal(parseImageKey('{"image_key":"img_v3_abc"}'), 'img_v3_abc')
  assert.equal(parseImageKey('{"image_key":""}'), undefined)
  assert.equal(parseImageKey('{"other":1}'), undefined)
  assert.equal(parseImageKey('not json'), undefined)
  assert.equal(parseImageKey(''), undefined)
  assert.equal(parseImageKey(undefined), undefined)
})

test('parseRichContent reads text and images out of a post message', () => {
  const post = JSON.stringify({
    title: '',
    content: [[
      { tag: 'text', text: '看这个截图：' },
      { tag: 'img', image_key: 'img_v3_one' },
    ], [
      { tag: 'text', text: '第二段' },
      { tag: 'img', image_key: 'img_v3_two' },
    ]],
  })
  assert.deepEqual(parseRichContent(post), { text: '看这个截图：\n第二段', imageKeys: ['img_v3_one', 'img_v3_two'] })
  assert.deepEqual(parseRichContent('{"image_key":"img_v3_x"}'), { text: '', imageKeys: ['img_v3_x'] })
  assert.equal(parseRichContent('not json'), undefined)
  assert.equal(parseRichContent(undefined), undefined)
})
