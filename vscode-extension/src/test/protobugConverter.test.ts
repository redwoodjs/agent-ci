import { convertPbToMarkdown } from "../protobugConverter";
import * as assert from "assert";

// Helper to encode a string as length-delimited protobuf field
function encodeString(tag: number, value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const header = encodeVarint((tag << 3) | 2);
  const length = encodeVarint(content.length);
  return Buffer.concat([header, length, content]);
}

// Helper to encode a varint protobuf field
function encodeVarintField(tag: number, value: number | bigint): Buffer {
  const header = encodeVarint((tag << 3) | 0);
  const val = encodeVarint(value);
  return Buffer.concat([header, val]);
}

function encodeVarint(value: number | bigint): Buffer {
  const bytes = [];
  let v = BigInt(value);
  while (v >= 128n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

// Helper to encode an Entry
function encodeEntry(entry: { id: string; timestamp: number; role: number; content: string; thought?: string }): Buffer {
  const chunks = [
    encodeString(1, entry.id),
    encodeVarintField(2, entry.timestamp),
    encodeVarintField(3, entry.role),
    encodeString(4, entry.content),
  ];
  if (entry.thought) {
    chunks.push(encodeString(5, entry.thought));
  }
  const entryContent = Buffer.concat(chunks);
  const header = encodeVarint((1 << 3) | 2); // Entry is field 1 in Conversation
  const length = encodeVarint(entryContent.length);
  return Buffer.concat([header, length, entryContent]);
}

function testConversion() {
  console.log("Running Protobug conversion tests...");

  const entries = [
    { id: "msg1", timestamp: Date.now(), role: 0, content: "Hello, how are you?" },
    { id: "msg2", timestamp: Date.now(), role: 1, content: "I am fine, thank you!", thought: "The user is being polite." },
    { id: "msg3", timestamp: Date.now(), role: 0, content: "What is the weather like?" },
  ];

  const buffer = Buffer.concat(entries.map(encodeEntry));
  const markdown = convertPbToMarkdown(buffer);

  console.log("Generated Markdown:\n");
  console.log(markdown);

  assert.ok(markdown.includes("### User"), "Should include User role");
  assert.ok(markdown.includes("### Assistant"), "Should include Assistant role");
  assert.ok(markdown.includes("Hello, how are you?"), "Should include user message");
  assert.ok(markdown.includes("I am fine, thank you!"), "Should include assistant message");
  assert.ok(markdown.includes("<details>"), "Should include thought details");
  assert.ok(markdown.includes("The user is being polite."), "Should include thought content");

  console.log("\nTests passed successfully!");
}

testConversion();
