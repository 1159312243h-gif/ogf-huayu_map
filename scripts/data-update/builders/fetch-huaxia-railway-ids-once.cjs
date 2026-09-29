const fs = require("node:fs");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const output = "work/railway-routing-ids-current.json";
const query = `[out:json][timeout:180];
rel(28652);map_to_area->.country;
way["railway"~"^(rail|narrow_gauge)$"][!"service"](area.country);
out ids;`;

(async () => {
  if (process.argv.includes("--resume") && fs.existsSync(output)) {
    const cached = JSON.parse(fs.readFileSync(output, "utf8"));
    if (Array.isArray(cached.elements) && cached.elements.length) {
      console.log(JSON.stringify({ output, cached: true, ways: cached.elements.length }, null, 2));
      return;
    }
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(210000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Overpass ${response.status}: ${body.slice(0, 1000)}`);
  const payload = JSON.parse(body);
  if (payload.remark || !Array.isArray(payload.elements) || !payload.elements.length) {
    throw new Error(payload.remark || "Huaxia railway ID response is empty");
  }
  fs.writeFileSync(output, JSON.stringify(payload));
  console.log(JSON.stringify({ output, ways: payload.elements.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
