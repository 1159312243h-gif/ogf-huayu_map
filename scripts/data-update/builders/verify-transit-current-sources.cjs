const fs = require("node:fs");
const {createHash} = require("node:crypto");
const {fetchWithRetry} = require("./overpass-network.cjs");
const {recoverSourceBody} = require("./source-body-recovery.cjs");
const types = new Set(["node", "way", "relation"]);
const routeTypes = new Set(["train", "subway", "light_rail", "monorail", "tram", "bus", "trolleybus", "ferry"]);
const key = ref => ref.type + ":" + ref.id;
function ref(value, fallback = "node") {
  const match = String(value ?? "").match(/^(?:(node|way|relation)[:/])?([1-9]\d*)$/u);
  if (!match) return null;
  return {type: match[1] || fallback, id: Number(match[2])};
}
function sourceRef(element) {
  return ref(element?.tags?.["ogf_atlas:source_id"]) || ref(element?.tags?.["ogf_atlas:source"])
    || ref(element?.id,element?.type);
}
function aliasesFor(relations) {
  return new Map(relations.flatMap(s => s.elements.map(e => [key(e),sourceRef(e)]).filter(([,r])=>r)));
}
function applicable(element, role) {
  if (role === "member") return Boolean(element);
  const t = element?.tags || {};
  if (role === "route") return ["route", "route_master"].includes(t.type) && routeTypes.has(t.route || t.route_master);
  return ["station", "halt", "tram_stop", "stop"].includes(t.railway) || t.station === "subway"
    || ["station", "platform", "stop_position"].includes(t.public_transport)
    || t.highway === "bus_stop" || t.amenity === "bus_station" || t.train === "yes"
    || t.subway === "yes" || t.light_rail === "yes" || t.monorail === "yes";
}
function validate(payload, refs) {
  if (payload?.remark || !Array.isArray(payload?.elements) || !Number.isFinite(Date.parse(payload.osm3s?.timestamp_osm_base)))
    throw Error("Incomplete current transit source response");
  const elements = payload.elements.filter(e => types.has(e.type)), counts = payload.elements.filter(e => e.type === "count");
  const requested = new Set(refs.map(key));
  if (counts.length !== 1 || Number(counts[0].tags?.total) !== elements.length
    || payload.elements.length !== elements.length + 1 || new Set(elements.map(key)).size !== elements.length
    || elements.some(e => !requested.has(key(e)))
    || [...types].some(type => Number(counts[0].tags?.[type + "s"]) !== elements.filter(e => e.type === type).length))
    throw Error("Current transit source count/identity mismatch");
  return elements;
}
async function verifySources(requested, options = {}) {
  const refs = [...new Map(requested.map(r => [key(r), r])).values()].sort((a,b) => key(a).localeCompare(key(b)));
  const prefix = options.cachePrefix || "work/transit-current-sources-v1", fetch = options.fetchImpl || fetchWithRetry;
  const current = new Map(), removed = [], officialChecks = [], sourceTimestamps = [];
  if (refs.some(r => !types.has(r.type) || !Number.isSafeInteger(r.id) || r.id <= 0)) throw Error("Invalid transit source identity");
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  for (let offset = 0; offset < refs.length; offset += 300) {
    const batch = refs.slice(offset, offset + 300), hash = createHash("sha256").update(JSON.stringify(batch)).digest("hex").slice(0,16);
    const file = prefix + "-" + hash + ".json";
    let payload;
    if (fs.existsSync(file)) payload = JSON.parse(fs.readFileSync(file,"utf8"));
    else {
      const query = '[out:json][timeout:90];(' + [...types].map(type => {
        const ids = batch.filter(r => r.type === type).map(r => r.id);
        return ids.length ? type + '(id:' + ids.join(',') + ');' : '';
      }).join('') + ');out body center;out count;';
      payload = await recoverSourceBody(async () => {
        const r = await fetch("https://overpass.opengeofiction.net/api/interpreter", {method:"POST",
          headers:{"content-type":"application/x-www-form-urlencoded;charset=UTF-8"},body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(120000)});
        if (!r.ok) throw Error("Current transit source HTTP " + r.status);
        return r.json();
      }, {wait:options.wait});
      validate(payload,batch); save(file,payload);
    }
    const byId = new Map(validate(payload,batch).map(e => [key(e),e]));
    sourceTimestamps.push(payload.osm3s.timestamp_osm_base);
    for (const source of batch) {
      let element = byId.get(key(source)), status;
      if (!element || !applicable(element,source.role)) {
        const officialFile = prefix + "-official-" + key(source).replace(':','-') + ".json";
        let official;
        if (fs.existsSync(officialFile)) official = JSON.parse(fs.readFileSync(officialFile,"utf8"));
        else {
          official = await recoverSourceBody(async () => {
            const r = await fetch("https://opengeofiction.net/api/0.6/" + source.type + "/" + source.id + ".json",{signal:AbortSignal.timeout(60000)});
            if (![200,410].includes(r.status)) throw Error("Official transit verification HTTP " + r.status + ": " + key(source));
            return {status:r.status,checkedAt:new Date().toISOString(),payload:r.status===410?null:await r.json()};
          }, {wait:options.wait});
        }
        status = official.status;
        if (![200,410].includes(status) || !Number.isFinite(Date.parse(official.checkedAt))) throw Error("Invalid official transit proof");
        if (status === 200) {
          const matches = official.payload?.elements?.filter(e => key(e) === key(source));
          if (matches?.length !== 1) throw Error("Incomplete official transit response: " + key(source));
          element = matches[0];
        } else element = null;
        save(officialFile,official); officialChecks.push({...source,status,checkedAt:official.checkedAt});
      }
      if (!element || !applicable(element,source.role)) removed.push({...source,reason:element?"no-longer-transit":"deleted",status});
      else current.set(key(source),element);
    }
    options.onBatch?.({checked:Math.min(offset+300,refs.length),total:refs.length,removed:removed.length});
  }
  return {current,verification:{checkedAt:new Date().toISOString(),checkedSources:refs,removed,officialChecks,sourceTimestamps}};
}
function reconcile(preload, relations, result) {
  const removed = new Set(result.verification.removed.map(key));
  const aliases = aliasesFor(relations.snapshots);
  const resolve = value => aliases.get(key(value)) || value;
  const kept = value => !removed.has(key(resolve(value)));
  for (const snapshot of preload.snapshots) {
    const n = snapshot.network;
    const routeIndexes = new Map();
    const activeRoutes = n.routeTable.filter((route,index) => {
      if (removed.has("relation:"+route[0])) return false;
      routeIndexes.set(index,routeIndexes.size); return true;
    });
    const indexes = values => values?.filter(i => routeIndexes.has(i)).map(i => routeIndexes.get(i));
    for (const field of ["lines","displayTracks"]) n[field] = (n[field] || []).map(line => {
      const copy = [...line]; copy[2] = indexes(copy[2]); return copy;
    }).filter(line => line[2]?.length);
    for (const field of ["stops","displayStops"]) if (Array.isArray(n[field])) n[field] = n[field].filter(stop => {
      const source = ref(stop[10] ?? stop[0]) || aliases.get("node:"+stop[0]); return !source || kept(source);
    }).map(stop => {const copy=[...stop];copy[8]=indexes(copy[8]);copy[11]=indexes(copy[11]);return copy;});
    n.routeTable = activeRoutes;
    n.displayRelations = n.displayRelations?.filter(kept);
    snapshot.currentSourceVerification = {checkedAt:result.verification.checkedAt,removed:result.verification.removed};
  }
  for (const snapshot of relations.snapshots) snapshot.elements = snapshot.elements.filter(kept).map(e =>
    Array.isArray(e.members) ? {...e,members:e.members.filter(m => kept({type:m.type,id:m.ref}))} : e);
  preload.currentSourceVerification = result.verification;
  return {preload,relations};
}
function assertReconciled(preload, relations) {
  const proof = preload.currentSourceVerification;
  if (!proof) return; // Published older generations are retained until a complete rebuilt candidate succeeds.
  if (!Number.isFinite(Date.parse(proof.checkedAt)) || !Array.isArray(proof.checkedSources)
    || !proof.sourceTimestamps?.length || proof.sourceTimestamps.some(t => !Number.isFinite(Date.parse(t))))
    throw Error("Incomplete transit source verification proof");
  const checked = new Set(proof.checkedSources.map(key)), official = new Map(proof.officialChecks.map(e => [key(e),e]));
  const removed = new Set(proof.removed.map(e => {
    if (!checked.has(key(e)) || !["deleted","no-longer-transit"].includes(e.reason)
      || official.get(key(e))?.status !== (e.reason === "deleted" ? 410 : 200)) throw Error("Unproved transit source removal");
    return key(e);
  }));
  const aliases = aliasesFor(relations.snapshots);
  for (const s of preload.snapshots) {
    const n=s.network;
    if(JSON.stringify(s.currentSourceVerification?.removed)!==JSON.stringify(proof.removed))throw Error("Mismatched transit source tombstones");
    for(const stop of [...n.stops,...(n.displayStops||[])]){const r=ref(stop[10]??stop[0])||aliases.get("node:"+stop[0]);if(r&&removed.has(key(r)))throw Error("Removed transit station reintroduced");}
    if(n.routeTable.some(r=>removed.has("relation:"+r[0])))throw Error("Removed transit route reintroduced");
  }
  for(const s of relations.snapshots)if(s.elements.some(e=>removed.has(key(e))||(e.members||[]).some(m=>removed.has(m.type+":"+m.ref))))throw Error("Removed transit source reintroduced");
}

async function run() {
  const root = "outputs/ogf-atlas/", preload = JSON.parse(fs.readFileSync(root+"transit-preload.json","utf8"));
  const relations = JSON.parse(fs.readFileSync(root+"transit-relations.json","utf8"));
  const routing = JSON.parse(fs.readFileSync(root+"railway-routing.json","utf8"));
  const aliases = aliasesFor(relations.snapshots);
  const resolveStop = value => aliases.get("node:"+value) || ref(value);
  const stationTypes = new Map(relations.snapshots.flatMap(s => s.elements.filter(e => applicable(e,"station")).map(e => [String(e.id),e.type])));
  const resolveRoutingStation = station => ref(station[6]) || aliases.get("node:"+station[0])
    || (stationTypes.has(String(station[0])) ? {type:stationTypes.get(String(station[0])),id:Number(station[0])} : ref(station[0]));
  const memberIds = new Set(relations.snapshots.flatMap(s => s.elements.filter(e =>
    e.type === "relation" && applicable(e,"route")).flatMap(e => (e.members || []).map(m => m.type+":"+m.ref))));
  const refs=[];
  for (const s of preload.snapshots) {
    for (const stop of [...s.network.stops,...(s.network.displayStops||[])]) {const source=resolveStop(stop[10]??stop[0]);if(source)refs.push({...source,role:memberIds.has(key(source))?"member":"station"});}
    for (const r of s.network.routeTable) if (typeof r[0] === "number" && r[0]>0) refs.push({type:"relation",id:r[0],role:"route"});
  }
  const knownSources = new Set(refs.map(key));
  for (const station of routing.stations || []) {
    const original = resolveRoutingStation(station);
    if (!original) throw Error("Missing current source identity for railway station: " + station[0]);
    const source={...original,role:"station"};
    if(!knownSources.has(key(source)))refs.push(source);
  }
  const result = await verifySources(refs,{onBatch:progress=>console.log(JSON.stringify(progress))});
  reconcile(preload,relations,result);
  assertReconciled(preload,relations);
  const removed = new Set(result.verification.removed.map(key));
  routing.stations = routing.stations.filter(s => !removed.has(key(resolveRoutingStation(s))));
  routing.coverage.currentStationVerification = result.verification;
  // All proofs must succeed before either candidate is written; published files are replaced later by the existing atomic gate.
  fs.writeFileSync(root+"transit-preload.json",JSON.stringify(preload));
  fs.writeFileSync(root+"transit-relations.json",JSON.stringify(relations));
  fs.writeFileSync(root+"railway-routing.json",JSON.stringify(routing));
  console.log(JSON.stringify({status:"verified",checked:result.verification.checkedSources.length,removed:result.verification.removed}));
}
module.exports={ref,sourceRef,validate,verifySources,reconcile,assertReconciled};
if(require.main===module)run().catch(e=>{console.error(e.name+": "+e.message);process.exitCode=1;});
