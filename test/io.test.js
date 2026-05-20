"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const io = require("../lib/io");
const { readJsonl, writeAtomic, writeTitleBar, _sanitizeTitle } = io;

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

test("_sanitizeTitle returns null when NO_TITLE=1", (t) => {
  saveTitleEnv(t);
  process.env.NO_TITLE = "1";
  process.env.TERM = "xterm-256color";

  assert.equal(_sanitizeTitle("hidden"), null);
});

test("_sanitizeTitle returns null when TERM=dumb", (t) => {
  saveTitleEnv(t);
  delete process.env.NO_TITLE;
  process.env.TERM = "dumb";

  assert.equal(_sanitizeTitle("hidden"), null);
});

test("_sanitizeTitle strips control bytes and clamps to 160 visible chars", (t) => {
  saveTitleEnv(t);
  delete process.env.NO_TITLE;
  process.env.TERM = "xterm-256color";

  const seq = _sanitizeTitle(`a\x00b\x1fc\x7f${"d".repeat(200)}`);

  const prefix = "\x1b]2;";
  const suffix = "\x07";
  assert.equal(seq.startsWith(prefix), true);
  assert.equal(seq.endsWith(suffix), true);

  const title = seq.slice(prefix.length, -suffix.length);
  assert.equal(title.length, 160);
  assert.equal(title.slice(0, 5), "a b c");
  assert.equal(/[\x00-\x1f\x7f]/.test(title), false);
});

test("_sanitizeTitle coerces non-string input", (t) => {
  saveTitleEnv(t);
  delete process.env.NO_TITLE;
  process.env.TERM = "xterm-256color";

  assert.equal(typeof _sanitizeTitle(42), "string");
  assert.equal(typeof _sanitizeTitle(null), "string");
  assert.equal(typeof _sanitizeTitle(undefined), "string");
});

test("writeTitleBar never throws regardless of TTY availability", (t) => {
  saveTitleEnv(t);
  delete process.env.NO_TITLE;
  process.env.TERM = "xterm-256color";

  assert.doesNotThrow(() => writeTitleBar("no tty"));

  process.env.NO_TITLE = "1";
  assert.doesNotThrow(() => writeTitleBar("suppressed"));

  delete process.env.NO_TITLE;
  process.env.TERM = "dumb";
  assert.doesNotThrow(() => writeTitleBar("dumb"));
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
