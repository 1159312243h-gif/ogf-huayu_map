(function(root) {
  "use strict";
  const EVENT="huayu-model-assets-change",DB_NAME="ogf-atlas-imported-models-v1",MAX_BYTES=128*1024*1024;
  const supported=new Set(["broadleaf","pine","shrubs","flowers","pavilion","busShelter","fountain","fence","wall","cityWall"]);
  const records=new Map(),loaded=new Map(),pending=new Map(),packagedRecords=new Map(),extraBundles=new Map();
  let catalogPromise;
  let database,initializing,runtimePromise,dialog,activePreview,dialogGeneration=0,mutationTail=Promise.resolve();
  function mutate(action) {
    const result=mutationTail.then(action);mutationTail=result.catch(()=>{});return result;
  }
  const runtime=()=>runtimePromise ||= import("./model-import/runtime.js?v=birch-coverage-v1").catch(error=>{runtimePromise=null;throw error;});
  const emit=()=>root.dispatchEvent(new root.CustomEvent(EVENT));
  const requestValue=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  async function loadCatalog() {
    return catalogPromise ||= (async()=>{
      const response=await root.fetch("./model-import/bundled-candidates.json",{credentials:"omit",signal:AbortSignal.timeout(5000)});
      if(!response.ok)return;
      const catalog=await response.json();
      if(catalog.schema!==1 || !Array.isArray(catalog.models) || catalog.models.length>12)return;
      for(const model of catalog.models) {
        const candidate=root.HuayuModelOptions?.candidates.find(candidate=>candidate.id===model.id);
        if(!candidate || candidate.bundled || candidate.uid!==model.uid || candidate.category!==model.category
          || model.license!=="CC BY 4.0" || model.licenseUrl!=="https://creativecommons.org/licenses/by/4.0/"
          || !/^\.\/model-import\/assets\/[a-z0-9-]+\.glb$/u.test(model.url) || !/^[a-f0-9]{64}$/u.test(model.sha256)
          || !Number.isSafeInteger(model.bytes) || model.bytes<28 || model.bytes>24*1024*1024
          || !Number.isSafeInteger(model.triangles) || model.triangles<1 || model.triangles>100000
          || !Number.isSafeInteger(model.primitives) || model.primitives<1 || model.primitives>24
          || !["y","z"].includes(model.config?.up) || !/^(all|\d+(\/\d+)*)$/u.test(model.config?.part || ""))continue;
        extraBundles.set(model.id,model);
      }
      emit();
    })().catch(()=>{});
  }
  function openDatabase() {
    return new Promise((resolve,reject)=>{
      const request=root.indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{request.result.createObjectStore("metadata",{keyPath:"id"});request.result.createObjectStore("files");};
      request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();database=null;};resolve(request.result);};
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error("模型存储正在被其他页面占用。"));
    });
  }
  async function init() {
    await loadCatalog();
    return initializing ||= (async()=>{
      database=await openDatabase();
      const all=await requestValue(database.transaction("metadata").objectStore("metadata").getAll());
      for(const record of all) if(record.schema===1 && typeof record.id==="string") records.set(record.id,record);
      emit();return true;
    })().catch(()=>{initializing=null;return false;});
  }
  function getRecord(id) {
    if(records.has(id))return records.get(id);
    const candidate=root.HuayuModelOptions?.candidates.find(candidate=>candidate.id===id);
    const bundled=candidate?.bundled || extraBundles.get(id);
    if(!bundled)return null;
    if(!packagedRecords.has(id))packagedRecords.set(id,{schema:1,id,category:candidate.category,name:candidate.label,
      ...bundled,source:bundled.source || candidate.source,author:bundled.author || candidate.author,license:candidate.license,
      authorized:true,packaged:true,importedAt:bundled.sha256});
    return packagedRecords.get(id);
  }
  async function readBlob(record) {
    if(!record.packaged)return requestValue(database.transaction("files").objectStore("files").get(record.id));
    if(!/^\.\/model-import\/assets\/[a-z0-9-]+\.glb$/u.test(record.url))throw new Error("内置模型路径无效。");
    const response=await root.fetch(record.url,{credentials:"omit",signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error("内置模型暂时无法加载，继续显示原有模型。");
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength!==record.bytes)throw new Error("内置模型文件大小不一致。");
    const digest=await root.crypto.subtle.digest("SHA-256",buffer);
    const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
    if(hash!==record.sha256)throw new Error("内置模型完整性校验失败。");
    return new root.Blob([buffer],{type:"model/gltf-binary"});
  }
  function state(id) {
    const record=getRecord(id),asset=loaded.get(id);
    return {record:record ? {...record} : null,ready:Boolean(asset),supported:supported.has(record?.category),
      status:!record ? "missing" : !supported.has(record.category) ? "adapter-pending" : record.triangles>20000
        ? "heavy-pending" : asset ? "ready" : record.error ? "failed" : "stored"};
  }
  async function prepare(id) {
    if (loaded.has(id)) return loaded.get(id);
    if(pending.has(id)) return pending.get(id);
    const promise=(async()=>{
      await init();
      const record=getRecord(id);if(!record) return null;
      const blob=await readBlob(record);
      if(!blob) throw new Error("模型文件缺失，请重新导入。");
      const engine=await runtime(),gltf=await engine.parse(await blob.arrayBuffer());
      let normalized;
      try {normalized=engine.bundle(gltf,record.config);} catch(error){engine.disposeScene(gltf.scene);throw error;}
      if(getRecord(id)!==record){normalized.dispose();engine.disposeScene(gltf.scene);return null;}
      const asset={...normalized,gltf,record};loaded.set(id,asset);emit();return asset;
    })().catch(error=>{const record=getRecord(id);if(record)record.error=error.message;emit();console.warn("Imported model unavailable; keeping existing rendering.",error);return null;}).finally(()=>pending.delete(id));
    pending.set(id,promise);return promise;
  }
  async function activateSelections() {
    await init();
    const ids=Object.values(root.HuayuModelOptions?.getSelections() || {}).filter(id=>id!=="existing"
      && supported.has(getRecord(id)?.category) && getRecord(id).triangles<=20000);
    await Promise.all(ids.map(prepare));
  }
  function write(record,blob) {
    return new Promise((resolve,reject)=>{
      const transaction=database.transaction(["metadata","files"],"readwrite");
      transaction.objectStore("metadata").put(record);transaction.objectStore("files").put(blob,record.id);
      transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
    });
  }
  function release(id) {
    const asset=loaded.get(id);loaded.delete(id);
    if(asset){asset.dispose();runtime().then(engine=>engine.disposeScene(asset.gltf.scene));}
  }
  async function install(id,blob,config,authorized) {
    if(!authorized) throw new Error("请确认模型来源和使用授权。");
    const candidate=root.HuayuModelOptions.candidates.find(candidate=>candidate.id===id);
    if(!candidate) throw new Error("未知候选模型。");
    if(!Number.isFinite(blob?.size) || blob.size>24*1024*1024 || !blob.size)throw new Error("GLB 文件需小于 24 MiB，且包含完整模型。");
    if(!await init()) throw new Error("浏览器未允许持久保存模型，已保留原有模型。");
    const bytes=[...records.values()].filter(record=>record.id!==id).reduce((sum,record)=>sum+record.bytes,0)+blob.size;
    if(bytes>MAX_BYTES) throw new Error("本地模型总容量超过 128 MiB，请先移除不再使用的模型。");
    const engine=await runtime(),gltf=await engine.parse(await blob.arrayBuffer());
    let normalized;
    try {
      normalized=engine.bundle(gltf,config);
      const record={schema:1,id,category:candidate.category,name:blob.name || candidate.label,bytes:blob.size,
        config:engine.normalizeConfig(config),triangles:normalized.triangles,primitives:normalized.pieces.length,
        source:candidate.source,author:candidate.author,license:candidate.license,authorized:true,importedAt:new Date().toISOString()};
      await write(record,blob);
      records.set(id,record);release(id);
      if(supported.has(candidate.category) && normalized.triangles<=20000)loaded.set(id,{...normalized,gltf,record});
      else {normalized.dispose();engine.disposeScene(gltf.scene);}
      emit();return record;
    } catch(error){normalized?.dispose();engine.disposeScene(gltf.scene);throw error;}
  }
  async function remove(id) {
    if(!await init()) throw new Error("本地模型存储不可用。");
    await new Promise((resolve,reject)=>{
      const transaction=database.transaction(["metadata","files"],"readwrite");
      transaction.objectStore("metadata").delete(id);transaction.objectStore("files").delete(id);
      transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
    });
    records.delete(id);release(id);emit();void activateSelections();
  }
  function element(tag,className,text) {
    const node=root.document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;
  }
  function buildDialog() {
    const box=element("dialog","model-import-dialog");box.id="model-import-dialog";
    const heading=element("h2",null,"导入模型");heading.id="model-import-title";box.setAttribute("aria-labelledby",heading.id);
    const close=element("button","icon-button");close.type="button";close.title="关闭";close.setAttribute("aria-label","关闭");
    const icon=element("i");icon.dataset.lucide="x";close.append(icon);close.addEventListener("click",()=>box.close());
    const header=element("div","model-import-heading");header.append(heading,close);
    const fileLabel=element("label","model-import-file");fileLabel.textContent="GLB 文件";
    const file=element("input");file.type="file";file.accept=".glb,model/gltf-binary";file.id="model-import-file";fileLabel.append(file);
    const preview=element("div","model-import-preview");preview.setAttribute("aria-label","模型预览");
    const settings=element("div","model-import-fields");
    const up=element("select"),part=element("select"),yaw=element("input");yaw.type="number";yaw.min="-180";yaw.max="180";yaw.step="15";yaw.value="0";
    for(const [value,label] of [["y","Y 轴向上"],["z","Z 轴向上"]]) {const option=element("option",null,label);option.value=value;up.append(option);}
    for(const [name,field] of [["朝上轴",up],["旋转角度",yaw],["模型部件",part]]) {
      const label=element("label","render-setting-field");label.append(element("span",null,name),field);settings.append(label);
    }
    const consentLabel=element("label","model-import-consent"),consent=element("input");consent.type="checkbox";consent.id="model-import-consent";
    consentLabel.append(consent,element("span",null,"确认已合法取得文件，并获准在本机使用"));
    const status=element("p","model-import-status");status.id="model-import-status";status.setAttribute("role","status");
    const actions=element("div","model-import-actions");
    const cancel=element("button","secondary-button", "取消"),save=element("button","primary-button","保存并应用");
    cancel.type=save.type="button";cancel.addEventListener("click",()=>box.close());actions.append(cancel,save);
    box.append(header,fileLabel,preview,settings,consentLabel,status,actions);root.document.body.append(box);
    box.addEventListener("close",()=>{dialogGeneration++;activePreview?.dispose();activePreview=null;});
    root.lucide?.createIcons({root:box});return {box,heading,file,preview,up,part,yaw,consent,status,save};
  }
  async function showImport(id) {
    const candidate=root.HuayuModelOptions.candidates.find(candidate=>candidate.id===id);if(!candidate)return;
    dialog ||= buildDialog();
    const d=dialog;let gltf,blob,busy=false,readRevision=0,previewValid=false;
    activePreview?.dispose();activePreview=null;
    const generation=++dialogGeneration;
    d.heading.textContent=`导入 ${candidate.label}`;d.file.value="";d.consent.checked=false;d.up.value="y";d.yaw.value="0";
    for(const field of [d.file,d.up,d.part,d.yaw,d.consent])field.disabled=false;
    d.part.replaceChildren();d.preview.replaceChildren();d.save.disabled=true;
    d.save.textContent=supported.has(candidate.category) ? "保存并应用" : "保存候选文件";
    d.status.textContent=supported.has(candidate.category) ? "未选择文件" : "此类模型可保存和预览，地图替换待适配。";
    const config=()=>({up:d.up.value,yaw:Number(d.yaw.value),part:d.part.value || "all"});
    const sync=()=>{
      d.save.disabled=busy || !gltf || !d.consent.checked;
      if(!gltf)return;
      try {
        const info=activePreview.update(config());
        previewValid=true;
        if(info.triangles>20000 && supported.has(candidate.category))d.save.textContent="保存，待轻量化";
        else d.save.textContent=supported.has(candidate.category) ? "保存并应用" : "保存候选文件";
        d.status.textContent=`${blob.name || candidate.label} · ${Math.ceil(blob.size/1024)} KiB · ${Math.round(info.triangles)} 三角面${supported.has(candidate.category) ? "" : " · 地图替换待适配"}`;
      } catch(error){previewValid=false;d.status.textContent=error.message;d.save.disabled=true;}
    };
    const read=async next=>{
      const revision=++readRevision;
      busy=true;previewValid=false;d.save.disabled=true;d.status.textContent="正在校验与准备预览…";
      activePreview?.dispose();activePreview=null;
      if(gltf){const engine=await runtime();engine.disposeScene(gltf.scene);gltf=null;}
      try {
        if(next.size>24*1024*1024)throw new Error("GLB 文件需小于 24 MiB，请先轻量化。");
        const engine=await runtime(),nextGltf=await engine.parse(await next.arrayBuffer());
        if(generation!==dialogGeneration || revision!==readRevision){engine.disposeScene(nextGltf.scene);return;}
        gltf=nextGltf;blob=next;
        d.part.replaceChildren(...engine.parts(gltf).map(item=>{const option=element("option",null,item.label);option.value=item.value;return option;}));
        if(state(id).record && !d.file.files.length){const old=state(id).record.config;d.up.value=old.up;d.yaw.value=old.yaw;d.part.value=old.part;}
        activePreview=engine.createPreview(d.preview,gltf,config());
      } catch(error){if(generation===dialogGeneration && revision===readRevision){d.status.textContent=error.message;d.save.disabled=true;}}
      finally{if(revision===readRevision){busy=false;if(gltf && activePreview && generation===dialogGeneration)sync();}}
    };
    d.file.onchange=()=>{if(d.file.files[0])void read(d.file.files[0]);};
    d.up.onchange=d.part.onchange=d.yaw.onchange=sync;
    d.consent.onchange=()=>{d.save.disabled=busy || !previewValid || !d.consent.checked;};
    d.save.onclick=async()=>{
      if(d.save.disabled)return;busy=true;d.save.disabled=true;
      const fileToSave=blob,configToSave=config(),authorized=d.consent.checked;
      for(const field of [d.file,d.up,d.part,d.yaw,d.consent])field.disabled=true;
      try {await mutate(()=>install(id,fileToSave,configToSave,authorized));if(generation===dialogGeneration)d.box.close();}
      catch(error){if(generation===dialogGeneration){d.status.textContent=error.message;busy=false;d.save.disabled=false;
        for(const field of [d.file,d.up,d.part,d.yaw,d.consent])field.disabled=false;}}
    };
    d.box.addEventListener("close",()=>{if(gltf)runtime().then(engine=>engine.disposeScene(gltf.scene));},{once:true});
    d.box.showModal();
    await init();
    const previousRecord=getRecord(id);
    if(previousRecord && generation===dialogGeneration){
      try {
        const previous=await readBlob(previousRecord);
        if(previous && generation===dialogGeneration)await read(previous);
      } catch(error){if(generation===dialogGeneration)d.status.textContent=error.message;}
    }
  }
  root.HuayuModelAssets={EVENT,DB_NAME,init,state,prepare,activateSelections,loadCatalog,
    install:(...args)=>mutate(()=>install(...args)),remove:id=>mutate(()=>remove(id)),showImport,
    get:id=>loaded.get(id),supported:category=>supported.has(category),runtime};
})(typeof window!=="undefined" ? window : globalThis);
