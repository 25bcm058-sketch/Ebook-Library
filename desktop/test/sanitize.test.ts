/**
 * sanitize.test.ts — end-to-end check of the EPUB reader's sanitization path.
 *
 * Builds a synthetic EPUB in /tmp (real zip: mimetype, container.xml, OPF
 * with a 3-chapter spine, an NCX, an image — chapter 1 is hostile: <script>,
 * an onerror handler, a javascript: link, an iframe, an external http image,
 * plus a legitimate internal image and a cross-chapter link), then runs it
 * through the same functions the /api/books/:id/read endpoint uses and
 * asserts the hostile markup is gone and the legitimate markup survived.
 *
 * Run from the desktop/ directory (after npm install):
 *   bun test/sanitize.test.ts
 */
import AdmZip from 'adm-zip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readEpubStructure, readEpubEntryText, readEpubEntryBuffer } from '../src/main/epub';
import { sanitizeChapter } from '../src/main/sanitize';

const EPUB_PATH = '/tmp/shelfmark-test-book.epub';
const BOOK_ID = 'test-book-123';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>Hostile Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>Chapter Three</text></navLabel><content src="text/ch3.xhtml#s3"/></navPoint>
  </navMap>
</ncx>`;

// Hostile chapter: script, event handler, javascript: URL, iframe, style,
// external image — plus legitimate content that must survive.
const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title><style>body { color: red }</style></head>
<body>
  <h1 onclick="steal()">Chapter One</h1>
  <p>This is <em>legitimate</em> text.</p>
  <script>alert('pwned')</script>
  <script src="http://evil.example/x.js"></script>
  <p><img src="../images/pic.jpg" alt="A picture" onerror="alert('img pwned')"/></p>
  <p><img src="http://evil.example/track.png" alt="tracker"/></p>
  <p><a href="javascript:alert('link pwned')">evil link</a></p>
  <p><a href="ch2.xhtml">Go to chapter two</a></p>
  <p><a href="#local-anchor">same-page anchor</a></p>
  <p><a href="https://example.com/">external link</a></p>
  <iframe src="http://evil.example/frame"></iframe>
  <object data="evil.swf"></object>
  <p id="local-anchor" style="background:url(javascript:x)">Anchor target.</p>
</body>
</html>`;

const CH2 = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter Two</h1>
  <p>Second chapter body.</p>
</body></html>`;

const CH3 = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1 id="s3">Chapter Three</h1>
  <p>Third chapter body.</p>
</body></html>`;

// A 1x1 white JPEG.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAT//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

function buildEpub(): void {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'), '', 0); // stored, per spec
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER));
  zip.addFile('OEBPS/content.opf', Buffer.from(OPF));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(NCX));
  zip.addFile('OEBPS/text/ch1.xhtml', Buffer.from(CH1));
  zip.addFile('OEBPS/text/ch2.xhtml', Buffer.from(CH2));
  zip.addFile('OEBPS/text/ch3.xhtml', Buffer.from(CH3));
  zip.addFile('OEBPS/images/pic.jpg', JPEG);
  zip.writeZip(EPUB_PATH);
}

function main(): void {
  buildEpub();
  console.log(`Built synthetic EPUB at ${EPUB_PATH} (${fs.statSync(EPUB_PATH).size} bytes)`);

  // 1. Structure: spine order + NCX TOC resolution.
  const structure = readEpubStructure(EPUB_PATH);
  assert.equal(structure.spine.length, 3, 'spine should have 3 items');
  assert.deepEqual(
    structure.spine.map((s) => s.href),
    ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml', 'OEBPS/text/ch3.xhtml'],
    'spine hrefs should be resolved zip-entry paths',
  );
  assert.equal(structure.toc.length, 3, 'TOC should have 3 entries');
  assert.equal(structure.toc[0].label, 'Chapter One');
  assert.equal(structure.toc[0].href, 'OEBPS/text/ch1.xhtml');
  assert.equal(structure.toc[2].href, 'OEBPS/text/ch3.xhtml#s3', 'NCX fragments are preserved');
  console.log('✓ spine + NCX TOC parsed and resolved');

  // 2. Sanitize the hostile chapter exactly as the read endpoint does.
  const ch1 = readEpubEntryText(EPUB_PATH, structure.spine[0].href);
  assert.ok(ch1, 'chapter 1 should be readable');
  const html = sanitizeChapter(ch1, { bookId: BOOK_ID, chapterPath: structure.spine[0].href });

  // Hostile content must be gone.
  assert.ok(!/<script/i.test(html), 'script tags must be stripped');
  assert.ok(!/pwned/.test(html), 'script contents must be stripped');
  assert.ok(!/onerror/i.test(html), 'onerror handler must be stripped');
  assert.ok(!/onclick/i.test(html), 'onclick handler must be stripped');
  assert.ok(!/javascript:/i.test(html), 'javascript: URLs must be stripped');
  assert.ok(!/<iframe/i.test(html), 'iframes must be stripped');
  assert.ok(!/<object/i.test(html), 'objects must be stripped');
  assert.ok(!/<style/i.test(html), 'style elements must be stripped');
  assert.ok(!/style=/i.test(html), 'inline style attributes must be stripped');
  assert.ok(!/evil\.example/.test(html), 'external URLs must be dropped');
  console.log('✓ script / event handlers / javascript: / iframe / object / style / external URLs stripped');

  // Legitimate content must survive.
  assert.ok(html.includes('<h1>Chapter One</h1>'), 'heading should survive');
  assert.ok(html.includes('<em>legitimate</em>'), 'inline formatting should survive');

  // Image src rewritten to the media endpoint, resolved relative to the chapter dir.
  assert.ok(
    html.includes(`src="/api/books/${BOOK_ID}/media/OEBPS/images/pic.jpg"`),
    `img src should be rewritten to the media endpoint; got: ${html.match(/<img[^>]*>/)?.[0]}`,
  );
  assert.ok(html.includes('alt="A picture"'), 'img alt should survive');
  console.log('✓ internal <img> rewritten to /api/books/:id/media/OEBPS/images/pic.jpg');

  // Cross-chapter link rewritten to data-href for reader-side spine navigation,
  // resolved against the chapter's directory to the full zip-entry path
  // (so it matches the hrefs in the spine array returned by /api/books/:id/toc).
  assert.ok(
    html.includes('data-href="OEBPS/text/ch2.xhtml"'),
    `cross-chapter link should carry the resolved data-href; got: ${html.match(/<a[^>]*data-href[^>]*>/)?.[0]}`,
  );
  assert.ok(html.includes('href="#local-anchor"'), 'same-page anchor should keep its fragment href');
  assert.ok(html.includes('id="local-anchor"'), 'id attributes should survive (anchor targets)');
  console.log('✓ cross-chapter link rewritten to data-href; same-page anchors preserved');

  // 3. Media serving path: the rewritten URL's entry must be readable.
  const pic = readEpubEntryBuffer(EPUB_PATH, 'OEBPS/images/pic.jpg');
  assert.ok(pic && pic.length > 0, 'media entry should be readable');
  assert.equal(pic[0], 0xff, 'media bytes should be the JPEG we embedded');
  assert.equal(readEpubEntryBuffer(EPUB_PATH, '../escape.txt'), null, 'traversal must be rejected');
  assert.equal(readEpubEntryBuffer(EPUB_PATH, '/abs/path'), null, 'absolute paths must be rejected');
  console.log('✓ media endpoint source bytes readable; traversal/absolute paths rejected');

  console.log('\nALL SANITIZE TESTS PASSED');
}

main();
