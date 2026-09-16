// Strip "owner password" encryption from an uploaded PDF.
//
// Forms exported from CREA WEBForms (and most PDF generators) are encrypted
// with an owner password that only restricts editing, copying and printing.
// They open without a password, but pdf-lib cannot stamp signatures onto
// encrypted content streams, so the copy we keep is decrypted first with
// qpdf (installed in the Docker image). A PDF that needs a password to *open*
// cannot be decrypted this way and is refused with a clear message.
//
// The decrypted bytes become the stored original — that is the document the
// signers see and the one whose SHA-256 is recorded. Appearance is unchanged.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Whether the file carries an /Encrypt dictionary. A byte scan rather than a
 * pdf-lib parse: parsing an encrypted file logs a page of warnings, and a
 * false positive here only costs a harmless qpdf pass-through.
 */
export async function isEncryptedPdf(bytes: Uint8Array): Promise<boolean> {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes("/Encrypt");
}

/**
 * Returns the bytes to store: decrypted when the input was encrypted with an
 * owner password only, untouched otherwise. Throws a user-facing error when
 * the PDF needs a password to open or the decrypt tool is unavailable.
 */
export async function decryptPdfIfNeeded(bytes: Buffer): Promise<{ bytes: Buffer; decrypted: boolean }> {
  if (!(await isEncryptedPdf(bytes))) return { bytes, decrypted: false };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rre-pdf-"));
  const input = path.join(dir, "in.pdf");
  const output = path.join(dir, "out.pdf");
  try {
    fs.writeFileSync(input, bytes);
    try {
      // --password='' : open with the empty user password (owner-only encryption).
      await execFileAsync("qpdf", ["--decrypt", "--password=", input, output], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch (e: any) {
      const stderr = String(e?.stderr ?? e?.message ?? "");
      if (e?.code === "ENOENT") {
        throw new Error("This PDF is encrypted and the server cannot decrypt it (qpdf is not installed). Print it to a new PDF and upload that.");
      }
      if (/invalid password|password/i.test(stderr)) {
        throw new Error("This PDF needs a password to open. Remove the password (open it, enter the password, and print or save it as a new PDF) and upload again.");
      }
      // Exit code 3 is "succeeded with warnings" — the output is still good.
      if (e?.code !== 3 || !fs.existsSync(output)) {
        throw new Error(`This PDF could not be decrypted: ${stderr.split("\n")[0]?.slice(0, 160) || "qpdf failed"}`);
      }
    }
    const out = fs.readFileSync(output);
    if (out.length < 100 || out.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("This PDF could not be decrypted.");
    return { bytes: out, decrypted: true };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
