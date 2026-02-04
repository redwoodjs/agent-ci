/**
 * Utility to convert Antigravity Protobug (.pb) conversation files to Markdown.
 * Protobug is a binary format based on Protobuf.
 */

enum Role {
  USER = 0,
  ASSISTANT = 1,
  SYSTEM = 2,
}

interface Entry {
  id?: string;
  timestamp?: number;
  role?: Role;
  content?: string;
  thought?: string;
}

export function convertPbToMarkdown(buffer: Buffer): string {
  const entries: Entry[] = [];
  let offset = 0;

  try {
    while (offset < buffer.length) {
      const { tag, wireType, newOffset } = readTag(buffer, offset);
      offset = newOffset;

      if (tag === 1 && wireType === 2) { // repeated Entry entries = 1;
        const { value: entryBuffer, newOffset: entryOffset } = readLengthDelimited(buffer, offset);
        offset = entryOffset;
        entries.push(parseEntry(entryBuffer));
      } else {
        offset = skipField(buffer, offset, wireType);
      }
    }
  } catch (error) {
    console.error("[Protobug] Error parsing conversation:", error);
    return `Error parsing conversation history: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (entries.length === 0) {
    return "No conversation entries found.";
  }

  return entries
    .map((entry) => {
      const roleStr = entry.role === Role.ASSISTANT ? "Assistant" : entry.role === Role.SYSTEM ? "System" : "User";
      let md = `### ${roleStr}\n\n${entry.content || ""}\n`;
      if (entry.thought) {
        md += `\n<details>\n<summary>Thought</summary>\n\n${entry.thought}\n\n</details>\n`;
      }
      return md;
    })
    .join("\n---\n\n");
}

function parseEntry(buffer: Buffer): Entry {
  const entry: Entry = {};
  let offset = 0;

  while (offset < buffer.length) {
    const { tag, wireType, newOffset } = readTag(buffer, offset);
    offset = newOffset;

    switch (tag) {
      case 1: // string id = 1;
        if (wireType === 2) {
          const { value, newOffset: nextOffset } = readString(buffer, offset);
          entry.id = value;
          offset = nextOffset;
        } else offset = skipField(buffer, offset, wireType);
        break;
      case 2: // int64 timestamp = 2;
        if (wireType === 0) {
          const { value, newOffset: nextOffset } = readVarint(buffer, offset);
          entry.timestamp = Number(value);
          offset = nextOffset;
        } else offset = skipField(buffer, offset, wireType);
        break;
      case 3: // Role role = 3;
        if (wireType === 0) {
          const { value, newOffset: nextOffset } = readVarint(buffer, offset);
          entry.role = Number(value) as Role;
          offset = nextOffset;
        } else offset = skipField(buffer, offset, wireType);
        break;
      case 4: // string content = 4;
        if (wireType === 2) {
          const { value, newOffset: nextOffset } = readString(buffer, offset);
          entry.content = value;
          offset = nextOffset;
        } else offset = skipField(buffer, offset, wireType);
        break;
      case 5: // string thought = 5;
        if (wireType === 2) {
          const { value, newOffset: nextOffset } = readString(buffer, offset);
          entry.thought = value;
          offset = nextOffset;
        } else offset = skipField(buffer, offset, wireType);
        break;
      default:
        offset = skipField(buffer, offset, wireType);
    }
  }

  return entry;
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; newOffset: number } {
  let value = BigInt(0);
  let shift = BigInt(0);
  while (true) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += BigInt(7);
  }
  return { value, newOffset: offset };
}

function readTag(buffer: Buffer, offset: number): { tag: number; wireType: number; newOffset: number } {
  const { value, newOffset } = readVarint(buffer, offset);
  const tag = Number(value >> BigInt(3));
  const wireType = Number(value & BigInt(7));
  return { tag, wireType, newOffset };
}

function readLengthDelimited(buffer: Buffer, offset: number): { value: Buffer; newOffset: number } {
  const { value: length, newOffset: nextOffset } = readVarint(buffer, offset);
  const len = Number(length);
  return { value: buffer.slice(nextOffset, nextOffset + len), newOffset: nextOffset + len };
}

function readString(buffer: Buffer, offset: number): { value: string; newOffset: number } {
  const { value, newOffset } = readLengthDelimited(buffer, offset);
  return { value: value.toString("utf8"), newOffset };
}

function skipField(buffer: Buffer, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: // Varint
      return readVarint(buffer, offset).newOffset;
    case 1: // 64-bit
      return offset + 8;
    case 2: // Length-delimited
      const { value: len, newOffset: nextOffset } = readVarint(buffer, offset);
      return nextOffset + Number(len);
    case 5: // 32-bit
      return offset + 4;
    default:
      throw new Error(`Unsupported wire type: ${wireType}`);
  }
}
