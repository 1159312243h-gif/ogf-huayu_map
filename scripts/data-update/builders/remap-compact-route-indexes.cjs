const assert = require("node:assert/strict");

function routeKey(route) {
  return `${route?.[1] || ""}|${route?.[0] ?? ""}|${route?.[3] || ""}`;
}

// Compact indexes belong to one route table. Copying a station between
// generations requires translating display memberships as well as routing.
function remapCompactRouteIndexes(indexes, sourceRoutes, targetRoutes, targetIndexes, label) {
  if (indexes == null) return null;
  assert.ok(Array.isArray(indexes), `${label}: display routes must be an array`);
  return [...new Set(indexes.map((index) => {
    assert.ok(Number.isInteger(index) && index >= 0 && sourceRoutes[index],
      `${label}: invalid baseline display route index ${index}`);
    const route = sourceRoutes[index];
    const key = routeKey(route);
    let mapped = targetIndexes.get(key);
    if (mapped === undefined) {
      mapped = targetRoutes.length;
      targetRoutes.push(route);
      targetIndexes.set(key, mapped);
    }
    return mapped;
  }))];
}

module.exports = {remapCompactRouteIndexes};
