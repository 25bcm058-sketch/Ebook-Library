/**
 * magic.ts — magic-byte format detection, independent of file extension.
 *
 * Mirrors server-edition DESIGN.md §3.2: "extension ignored; mismatches
 * rejected and audited". A `.epub` that is actually a Windows PE binary
 * (`MZ...`) must be rejected before it ever reaches the zip/XML parsers.
 *
 * We use the `file-type` package (pinned to the last CommonJS-compatible
 * major, v16 — v17+ went ESM-only, which would force the whole Electron
 * main process into ESM for one dependency) as the primary detector, with
 * a small manual signature table as a fallback for formats file-type does
 * not recognise (MOBI/AZW3's PDB container, and bare FictionBook2 XML).
 */
import { fromBuffer } from 'file-type';

export type BookFormat = 'epub' | 'pdf' | 'mobi' | 'azw3' | 'cbz' | 'cbr' | 'cb7' | 'fb2';

const EXT_TO_FORMAT: Record<string, BookFormat> = {
  '.epub': 'epub',
  '.pdf': 'pdf',
  '.mobi': 'mobi',
  '.azw3': 'azw3',
  '.azw': 'azw3',
  '.cbz': 'cbz',
  '.cbr': 'cbr',
  '.cb7': 'cb7',
  '.fb2': 'fb2',
};

// The "family" a magic-byte sniff belongs to. Several extensions share a
// container format (epub/cbz are both zip; mobi/azw3 share the PDB format).
type Family = 'zip' | 'pdf' | 'rar' | '7z' | 'pdb' | 'xml' | 'unknown';

const FORMAT_FAMILY: Record<BookFormat, Family> = {
  epub: 'zip',
  cbz: 'zip',
  pdf: 'pdf',
  cbr: 'rar',
  cb7: '7z',
  mobi: 'pdb',
  azw3: 'pdb',
  fb2: 'xml',
};

export function formatFromExtension(filename: string): BookFormat | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return EXT_TO_FORMAT[ext] ?? null;
}

function sniffFamily(buf: Buffer, fileTypeMime: string | undefined): Family {
  if (fileTypeMime === 'application/zip' || fileTypeMime === 'application/epub+zip') return 'zip';
  if (fileTypeMime === 'application/pdf') return 'pdf';
  if (fileTypeMime === 'application/x-rar-compressed' || fileTypeMime === 'application/x-rar') return 'rar';
  if (fileTypeMime === 'application/x-7z-compressed') return '7z';
  if (fileTypeMime === 'application/x-mobipocket-ebook') return 'pdb';

  // Manual fallbacks for formats file-type may miss.
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return 'zip';
  if (buf.length >= 7 && buf.subarray(0, 7).toString('latin1') === 'Rar!\x1a\x07\x00') return 'rar';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1') === '7z\xBC\xAF\x27\x1C') return '7z';
  // PDB container: 60-byte header, type/creator IDs at offset 60..68.
  if (buf.length >= 68) {
    const typeCreator = buf.subarray(60, 68).toString('latin1');
    if (typeCreator === 'BOOKMOBI') return 'pdb';
  }
  // Bare XML (FictionBook2 is plain XML, not zipped).
  const head = buf.subarray(0, 200).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<FictionBook')) return 'xml';

  return 'unknown';
}

export interface MagicCheckResult {
  ok: boolean;
  detectedFamily: Family;
  reason?: string;
}

/**
 * Validates that `buf`'s real content family matches what `claimedFormat`
 * (derived from the upload's file extension) requires. Executables,
 * scripts, and other disguised payloads fail this check and must be
 * rejected by the caller — never written to the blob store.
 */
export async function validateMagicBytes(buf: Buffer, claimedFormat: BookFormat): Promise<MagicCheckResult> {
  const detected = await fromBuffer(buf);
  const family = sniffFamily(buf, detected?.mime);
  const expected = FORMAT_FAMILY[claimedFormat];

  if (family === 'unknown') {
    return { ok: false, detectedFamily: family, reason: 'Unrecognized file content (no matching magic bytes).' };
  }
  if (family !== expected) {
    return {
      ok: false,
      detectedFamily: family,
      reason: `File extension implies "${claimedFormat}" (${expected}) but content looks like "${family}".`,
    };
  }
  return { ok: true, detectedFamily: family };
}
