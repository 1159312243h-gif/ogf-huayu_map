// Metre-based, synthetic topology for repeatable profile and browser reviews.
// These fixtures never enter OGF, the production map data or navigation graphs.
export const coordinate = ([x, y]) => [148.36 + x / (111320 * Math.cos(12.5 * Math.PI / 180)), 12.5 + y / 111320];
export function road(id, points, properties = {}, nodes) {
  return {type: "Feature", id: `bridge-test:${id}`, properties: {osmId: String(id), renderKind: "road",
    highway: "secondary", layer: 0, bridge: 0, tunnel: 0, layerExplicit: 1, width: "9", ...properties,
    roadNodes: nodes || points.map(([x, y]) => `${x}:${y}`)},
  geometry: {type: "LineString", coordinates: points.map(coordinate)}};
}

export function simpleBridge(length = 240, {start = 0, end = 0, layer = 1, approach = 160, y = 0, id = "b"} = {}) {
  return [road(`${id}-left`, [[-approach, y], [0, y]], {layer: start}),
    road(id, [[0, y], [length / 2, y], [length, y]], {bridge: 1, layer}),
    road(`${id}-right`, [[length, y], [length + approach, y]], {layer: end})];
}

export const reviewFixtures = [
  ...simpleBridge(240, {y: 450, id: "arch"}),
  ...simpleBridge(600, {y: 220, id: "plateau"}),
  ...simpleBridge(180, {y: 0, id: "incline", end: 1}),
  // A genuinely unconnected road passes under the upper deck. No pier may
  // occupy its footprint and the bridge must not snap to it.
  road("underpass", [[120, 340], [120, 560]], {}, ["underpass-a", "underpass-b"]),
  // An elevated junction has three branches with identical anchor heights.
  road("junction-west", [[-160, -230], [0, -230]]),
  road("junction-core", [[0, -230], [150, -230], [300, -230]], {bridge: 1, layer: 1}),
  road("junction-east", [[300, -230], [550, -230]], {bridge: 1, layer: 1}),
  road("junction-east-end", [[550, -230], [710, -230]]),
  road("junction-north", [[300, -230], [400, -150], [550, -100]], {bridge: 1, layer: 1}),
  road("junction-north-end", [[550, -100], [680, -60]]),
];
