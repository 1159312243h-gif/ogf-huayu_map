import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const declaration = source.match(/  function huayuLiveLandSortKeyExpression\(\)[^]*?\n  \}/u)?.[0];
assert.ok(declaration, "live land overlap sort expression is missing");
const context = vm.createContext({});
vm.runInContext(declaration, context);
const expression = JSON.parse(JSON.stringify(context.huayuLiveLandSortKeyExpression()));
assert.deepEqual(expression.slice(0, 3), ["match", ["get", "featureClass"], "residential"]);

function sortKey(featureClass) {
  for (let index = 2; index < expression.length - 1; index += 2) {
    if (expression[index] === featureClass) return expression[index + 1];
  }
  return expression.at(-1);
}

// A campus polygon may cover a more specific orchard/farm polygon.  The
// agricultural detail must paint above education, while a sports field and a
// park retain their more specific higher priority.
assert.ok(sortKey("farm") > sortKey("education"), "farm detail must remain visible over school tint");
assert.ok(sortKey("farm") < sortKey("sports"), "sports surfaces retain priority over farm detail");
assert.ok(sortKey("farm") < sortKey("park"), "park surfaces retain priority over farm detail");
assert.equal(sortKey("unknown"), 2, "unknown classes keep the existing fallback order");
assert.match(source, /layout:\s*\{\s*"fill-sort-key":\s*landSortKey\s*\}/u,
  "live land layer must use the shared overlap order");
console.log("Land overlap ordering passed: farm detail remains visible over education without changing sports or park priority.");
