// Restore from the offsite backup (see server/backup.ts).
//
// Runs on a laptop with the same BACKUP_* env vars the server has (put them
// in a local .env — never commit it). Nothing here touches the app database.
//
//   npx tsx script/restore-backup.ts list
//       every snapshot and document file in the bucket
//
//   npx tsx script/restore-backup.ts db <object-key> <out.sqlite>
//       download + decrypt + gunzip one database snapshot. Copy it to
//       DB_PATH on the volume (with the app stopped) to restore.
//
//   npx tsx script/restore-backup.ts documents <out-dir>
//       download + decrypt every document file into <out-dir>, preserving
//       the deals/<dealId>/<docId>/... layout DOCUMENTS_ROOT uses.
//
//   npx tsx script/restore-backup.ts decrypt <in.enc> <out> [--gunzip]
//       decrypt a file you already downloaded by other means.

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupConfig, decryptBuffer, s3GetToFile, s3List } from "../server/backup-s3";

async function main() {
  const [cmd, a, b, flag] = process.argv.slice(2);
  const { config, missing } = backupConfig();
  if (cmd === "decrypt") {
    if (!a || !b) usage();
    const keyHex = process.env.BACKUP_ENCRYPTION_KEY ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) fail("BACKUP_ENCRYPTION_KEY must be 64 hex chars");
    const out = decryptBuffer(fs.readFileSync(a), Buffer.from(keyHex, "hex"), { gunzip: flag === "--gunzip" });
    fs.writeFileSync(b, out);
    console.log(`wrote ${b} (${out.length} bytes)`);
    return;
  }
  if (!config) fail(`Missing env: ${missing.join(", ")}`);

  if (cmd === "list") {
    const objects = await s3List(config, `${config.prefix}/`);
    for (const o of objects) console.log(`${o.lastModified}  ${String(o.size).padStart(12)}  ${o.key}`);
    console.log(`${objects.length} object(s)`);
    return;
  }
  if (cmd === "db") {
    if (!a || !b) usage();
    const tmp = path.join(os.tmpdir(), `rre-restore-${Date.now()}.enc`);
    await s3GetToFile(config, a, tmp);
    const out = decryptBuffer(fs.readFileSync(tmp), config.key, { gunzip: true });
    fs.unlinkSync(tmp);
    fs.writeFileSync(b, out);
    console.log(`wrote ${b} (${(out.length / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }
  if (cmd === "documents") {
    if (!a) usage();
    const prefix = `${config.prefix}/documents/`;
    const objects = await s3List(config, prefix);
    let n = 0;
    for (const o of objects) {
      const rel = o.key.slice(prefix.length).replace(/\.enc$/, "");
      const dest = path.join(a, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.enc`;
      await s3GetToFile(config, o.key, tmp);
      fs.writeFileSync(dest, decryptBuffer(fs.readFileSync(tmp), config.key));
      fs.unlinkSync(tmp);
      n += 1;
      console.log(`restored ${rel}`);
    }
    console.log(`${n} file(s) restored to ${a}`);
    return;
  }
  usage();
}

function usage(): never {
  console.error("usage: restore-backup.ts list | db <key> <out> | documents <out-dir> | decrypt <in> <out> [--gunzip]");
  process.exit(2);
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => fail(String(e?.message ?? e)));
