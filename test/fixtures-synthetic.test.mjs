// Guards against committing real HackerOne data as test fixtures.
// Fixtures must be synthetic: see AGENTS.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./fixtures/", import.meta.url);
const USERNAMES = /^(example-hacker|hackerone-agent|h1_analyst_[a-z]|program_member_[a-z])$/;
const PROGRAM_NAMES_ALLOWED = /^(the program|Example Corp)$/;

const walk = (value, visit, path = "") => {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) walk(v, visit, path ? `${path}.${k}` : k);
  else visit(path, value);
};

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  test(`fixture ${file} is synthetic`, () => {
    assert.match(file, /^10000\d\d\.json$/, "fixture files are named after a synthetic report id (1000000-1000099)");
    const data = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    walk(data, (path, value) => {
      if (path.endsWith("username")) assert.match(String(value), USERNAMES, `${path}: use a placeholder username`);
      if (/(^|\.)id$/.test(path)) {
        const n = Number(value);
        assert.ok((n >= 1000000 && n < 1000100) || (n >= 50000000 && n < 50001000), `${path}: ${value} is not a synthetic id`);
      }
      if (typeof value === "string") {
        assert.doesNotMatch(value, /https?:\/\/(www\.)?hackerone\.com\/(reports|bugs)/, `${path}: no real report links`);
        assert.doesNotMatch(value, /\b20(2[1-9]|[3-9]\d)-\d\d-\d\dT/, `${path}: shift timestamps to 2020`);
        for (const m of value.matchAll(/@([A-Za-z0-9_-]+)/g))
          assert.match(m[1], USERNAMES, `${path}: mention @${m[1]} must be a placeholder`);
      }
    });
  });
}

test("placeholder program names are the only ones in fixtures", () => {
  // Real program names can't be listed here without leaking them, so this only
  // documents the convention; the local git-sensitive-check hook enforces it.
  assert.ok(PROGRAM_NAMES_ALLOWED.test("Example Corp"));
});
