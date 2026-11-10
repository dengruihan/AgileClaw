/**
 * Container-level detection shared by the Gateway entry points and the parser.
 *
 * Modern OOXML is always a ZIP, so OLE bytes behind a `.docx`/`.xlsx`/`.pptx`
 * name are either a renamed legacy file or the ECMA-376 encrypted package. This
 * module stays free of parser imports so main-thread callers never load the
 * OOXML readers just to classify bytes.
 */

/** Legacy OLE compound-file signature, as produced by .xls/.doc/.ppt and encrypted OOXML. */
export const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

/**
 * Detects the ECMA-376 encrypted package: an OLE container holding an
 * `EncryptedPackage` stream. A plain legacy `.doc`/`.xls` container is a
 * different family and is reported as unsupported, never as password-protected.
 */
export function looksLikeEncryptedOfficePackage(buffer: Buffer): boolean {
  if (
    buffer.length < OLE_COMPOUND_FILE_SIGNATURE.length ||
    !buffer.subarray(0, OLE_COMPOUND_FILE_SIGNATURE.length).equals(OLE_COMPOUND_FILE_SIGNATURE)
  ) {
    return false;
  }
  // The stream directory stores the name as UTF-16LE.
  return buffer.includes(Buffer.from("EncryptedPackage", "utf16le"));
}
