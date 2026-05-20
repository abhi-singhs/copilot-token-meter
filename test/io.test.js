"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJsonl, writeAtomic, writeTitleBar } = require("../lib/io");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmeter-io-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function findPidTmpFiles(dir) {
  const found = [];
  const stack = [dir];
  const suffix = `.tmp.${process.pid}`;

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.name.endsWith(suffix)) {
        found.push(entryPath);
      }
    }
  }

  return found;
}

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function saveTitleEnv(t) {
  const previousNoTitle = process.env.NO_TITLE;
  const previousTerm = process.env.TERM;

  t.after(() => {
    restoreEnvValue("NO_TITLE", previousNoTitle);
    restoreEnvValue("TERM", previousTerm);
  });
}

function patchWriteFileSync(t, replacement) {
  const original = fs.writeFileSync;
  fs.writeFileSync = replacement;
  t.after(() => {
    fs.writeFileSync = original;
  });
}

test("writeAtomic writes, creates parents, overwrites, and removes tmp file", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "nested", "state.json");

  writeAtomic(filePath, "first");

  assert.equal(fs.readFileSync(filePath, "utf8"), "first");
  assert.equal(fs.existsSync(path.dirname(filePath)), true);

  writeAtomic(filePath, "second");

  assert.equal(fs.readFileSync(filePath, "utf8"), "second");
  assert.deepEqual(findPidTmpFiles(dir), []);
});

test("writeTitleBar respects NO_TITLE=1", (t) => {
  saveTitleEnv(t);
  let writes = 0;
  patchWriteFileSync(t, () => {
    writes += 1;
  });

  process.env.NO_TITLE = "1";
  process.env.TERM = "xterm-256color";

  writeTitleBar("hidden");

  assert.equal(writes, 0);
});

test("writeTitleBar respects TERM=dumb", (t) => {
  saveTitleEnv(t);
  let writes = 0;
  patchWriteFileSync(t, () => {
    writes += 1;
  });

  delete process.env.NO_TITLE;
  process.env.TERM = "dumb";

  writeTitleBar("hidden");

  assert.equal(writes, 0);
});

test("writeTitleBar strips control bytes and clamps visible text", (t) => {
  saveTitleEnv(t);
  let written = "";
  patchWriteFileSync(t, (_filePath, content) => {
    written = content;
  });

  delete process.env.NO_TITLE;
  process.env.TERM = "xterm-256color";

  writeTitleBar(`a\x00b\x1fc\x7f${"d".repeat(200)}`);

  const prefix = "\x1b]2;";
  const suffix = "\x07";
  assert.equal(written.startsWith(prefix), true);
  assert.equal(written.endsWith(suffix), true);

  const title = written.slice(prefix.length, -suffix.length);
  assert.equal(title.length, 160);
  assert.equal(title.slice(0, 5), "a b c");
  assert.equal(/[\x00-\x1f\x7f]/.test(title), false);
});

test("writeTitleBar silently ignores an unwritable TTY", (t) => {
  saveTitleEnv(t);
  patchWriteFileSync(t, () => {
    throw new Error("unwritable");
  });

  delete process.env.NO_TITLE;
  process.env.TERM = "xterm-256color";

  assert.doesNotThrow(() => writeTitleBar("no tty"));
});

test("readJsonl parses well-formed JSONL into objects", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "events.jsonl");

  fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');

  assert.deepEqual(readJsonl(filePath), [{ a: 1 }, { b: 2 }]);
});

test("readJsonl skips malformed lines silently and keeps later valid lines", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "events.jsonl");

  fs.writeFileSync(filePath, '{"a":1}\nnot json\n{"b":2}\n');

  assert.deepEqual(readJsonl(filePath), [{ a: 1 }, { b: 2 }]);
});

test("readJsonl recovers a final line without trailing newline", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "events.jsonl");

  fs.writeFileSync(filePath, '{"tail":true}');

  assert.deepEqual(readJsonl(filePath), [{ tail: true }]);
});

test("readJsonl returns an empty array for an empty file", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "empty.jsonl");

  fs.writeFileSync(filePath, "");

  assert.deepEqual(readJsonl(filePath), []);
});
