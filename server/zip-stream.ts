// A zip written as it goes, for downloads too big to hold in memory.
//
// Stored (uncompressed) entries with a data descriptor (general-purpose flag
// bit 3): each entry's CRC and size are written after its data, so a file can
// be streamed in chunks without knowing either up front. Every unzip tool
// reads this. No ZIP64, so a single file and the whole archive stay under
// 4 GB, far beyond any export here.

import zlib from "node:zlib";
import type { Writable } from "node:stream";

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

/** A date as the zip format's DOS time and date fields. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipStream {
  private stamp = dosStamp(new Date());
  private entries: Entry[] = [];
  private offset = 0;
  private current: Entry | null = null;

  constructor(private out: Writable) {}

  /** Write, waiting for the socket to drain when it's full. */
  private async write(buf: Buffer) {
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      await new Promise<void>((resolve) => this.out.once("drain", resolve));
    }
  }

  async begin(name: string) {
    if (this.current) await this.end();
    const n = Buffer.from(name, "utf8");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // data descriptor follows + UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    // crc and sizes stay 0 here; they follow in the descriptor.
    h.writeUInt16LE(n.length, 26);
    this.current = { name: n, crc: 0, size: 0, offset: this.offset };
    await this.write(Buffer.concat([h, n]));
  }

  async data(chunk: Buffer | string) {
    if (!this.current) throw new Error("zip: data() before begin()");
    const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (b.length === 0) return;
    this.current.crc = zlib.crc32(b, this.current.crc);
    this.current.size += b.length;
    await this.write(b);
  }

  async end() {
    const e = this.current;
    if (!e) return;
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(e.crc >>> 0, 4);
    d.writeUInt32LE(e.size, 8);
    d.writeUInt32LE(e.size, 12);
    await this.write(d);
    this.entries.push(e);
    this.current = null;
  }

  async file(name: string, content: Buffer | string) {
    await this.begin(name);
    await this.data(content);
    await this.end();
  }

  /** Write the central directory. The caller ends the stream. */
  async finish() {
    await this.end();
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}
