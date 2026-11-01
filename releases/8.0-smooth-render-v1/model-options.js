(function(root) {
  "use strict";
  const STORAGE_KEY = "ogf-atlas-model-candidates-v1";
  const EVENT = "huayu-model-candidates-change";
  const categories = Object.freeze([
    ["broadleaf", "阔叶树"], ["pine", "松树"], ["shrubs", "灌木"], ["flowers", "花簇"],
    ["pavilion", "亭子"], ["busShelter", "候车亭"], ["fountain", "喷泉"],
    ["fence", "栅栏"], ["wall", "围墙"], ["cityWall", "城墙"],
  ].map(([id, label]) => Object.freeze({id, label})));
  const candidates = Object.freeze([
    ["broadleaf", "birch-trees", "写实白桦", "de6263e5400b4a52a795decf84f06575", "Igor_K.", 1943392, "available-file"],
    ["pine", "pine-branches", "枝叶松树", "97c2929b18364d51bf201b225643bca9", "Bigbubble", 3446832],
    ["shrubs", "bush-lods", "写实灌木组", "f2d9ffd3e6a94cf0b9464ccd66a4c2f8", "LOLIPOP", 8048292],
    ["flowers", "daisy-flowers", "雏菊花簇", "857802babfd542e094e8ef2c396be360", "Anskar", 16688],
    ["pavilion", "gazebo", "木结构亭子", "f2e0bd56e9604b0f845d4ef3e60ec9d6", "anadaren", 152952],
    ["busShelter", "nz-bus-shelter", "开放式候车亭", "7c8c11d481bd4defab590809d38e1119", "Darren Price", 79612],
    ["fountain", "stone-fountain", "石质溢水喷泉", "8580500134194ba5be3f6df7593049f2", "yorre.detavernier", 8606600],
    ["fence", "chain-link-fence", "网状栅栏墙段", "bd85a8005ff0403cab2f1e9845016b8f", "FrodoUndead", 5365512],
    ["wall", "column-wall", "混凝土墙板", "3fd512b610cb4b2c9f1727524f669dff", "lowpolybrain", 575876],
    ["cityWall", "pingyao-reference", "平遥城墙段", "8e09151d99a148159599fbb37589d05b", "Lionel", 138568196, "reference-only"],
  ].map(([category, id, label, uid, author, listedGlbBytes, status = "pending-file"]) => Object.freeze({
    category, id, label, uid, author, listedGlbBytes, status,
    bundled: id === "birch-trees" ? Object.freeze({
      url: "./model-import/assets/birch-trees-7d8f84d32933.glb", bytes: 1943404,
      sha256: "7d8f84d3293378360ae60ee4119651b0d24588176d0973ea6c31527b433bb6c1",
      triangles: 3414, primitives: 2,
      config: Object.freeze({up: "y", yaw: 0, part: "0/0/0/0"}),
    }) : null,
    source: `https://sketchfab.com/models/${uid}`,
    license: status === "pending-license" ? "Standard" : "CC BY 4.0",
    licenseUrl: status === "pending-license" ? "https://sketchfab.com/licenses" : "https://creativecommons.org/licenses/by/4.0/",
  })));
  const defaults = Object.freeze(Object.fromEntries(categories.map(category => [category.id, "existing"])));
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const statusLabels = Object.freeze({
    "pending-file": "待导入", "pending-license": "待授权文件", "reference-only": "参考，待轻量化",
    "available-file": "已就绪",
  });
  function normalize(value) {
    return Object.fromEntries(categories.map(({id}) => {
      const candidate = byId.get(value?.[id]);
      return [id, candidate?.category === id ? candidate.id : "existing"];
    }));
  }
  let selections = {...defaults};
  try {selections = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY)));} catch {}
  let persisted = true;
  let controls = [];
  function getState(category) {
    const selection = selections[category] || "existing";
    const candidate = byId.get(selection) || null;
    const asset=candidate && root.HuayuModelAssets?.state(candidate.id);
    return {selection, effective: asset?.status === "ready" ? "imported" : "existing",
      status: asset?.record ? asset.status : candidate?.status || "existing", candidate, asset};
  }
  function updateControls() {
    const summary=root.document?.getElementById("model-options-summary");
    if(summary) {
      const files=candidates.filter(candidate=>candidate.bundled || root.HuayuModelAssets?.state(candidate.id).record);
      const available=files.filter(candidate=>root.HuayuModelAssets?.supported(candidate.category)
        && (root.HuayuModelAssets?.state(candidate.id).record?.triangles || candidate.bundled?.triangles)<=20000);
      summary.textContent=`${candidates.length} 款方案 · ${files.length} 款已有文件 · ${available.length} 款可替换`;
    }
    for (const {category, select, detail, status, source, license, meta, importButton, removeButton} of controls) {
      const state = getState(category);
      for(const option of select.children) {
        const candidate=byId.get(option.value);if(!candidate)continue;
        option.textContent=candidate.label;
      }
      select.value = state.selection;
      detail.hidden = !state.candidate;
      if (!state.candidate) continue;
      const label={ready:["fence","wall","cityWall"].includes(category) ? "已导入 · 透视近景按预算应用" : "已导入 · 近景按预算应用",stored:state.asset?.record?.packaged ? "内置文件 · 选择后准备" : "已保存 · 正在准备",failed:"文件未能恢复，请重新导入",
        "adapter-pending":"已导入 · 地图替换待适配", "heavy-pending":"已导入 · 待进一步轻量化"}[state.status] || statusLabels[state.status];
      status.textContent = `${label}${state.effective === "imported" ? "" : " · 当前仍用现有模型"}${persisted ? "" : " · 本次打开暂存"}`;
      source.textContent = `${state.candidate.author} · Sketchfab`;
      source.href = state.candidate.source;
      license.textContent = state.candidate.license;
      license.href = state.candidate.licenseUrl;
      const bytes = state.candidate.listedGlbBytes;
      meta.textContent = `平台标示 GLB：${bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`}`;
      importButton.title=state.asset?.record ? "预览与调整模型" : "导入合法取得的 GLB";
      importButton.setAttribute("aria-label",importButton.title);
      removeButton.hidden=!state.asset?.record || state.asset.record.packaged;
      if(state.asset?.record) meta.textContent=`${state.asset.record.packaged ? "内置文件" : "本地文件"}：${state.asset.record.name} · ${Math.ceil(state.asset.record.bytes/1024)} KiB · ${Math.round(state.asset.record.triangles)} 三角面`;
    }
  }
  function save(value) {
    selections = normalize(value);
    persisted = true;
    try {root.localStorage.setItem(STORAGE_KEY, JSON.stringify(selections));} catch {persisted = false;}
    updateControls();
    root.dispatchEvent(new root.CustomEvent(EVENT, {detail: {saved: persisted}}));
    return persisted;
  }
  function setSelection(category, id) {
    if (!Object.hasOwn(defaults, category)) return false;
    return save({...selections, [category]: id});
  }
  function mount(container) {
    const document = container.ownerDocument;
    const fragment = document.createDocumentFragment();
    controls = categories.map(category => {
      const row = document.createElement("div"); row.className = "model-option-row";
      const label = document.createElement("label"); label.className = "render-setting-field model-option-field";
      const span = document.createElement("span"); span.textContent = category.label;
      const select = document.createElement("select"); select.id = `setting-model-candidate-${category.id}`;
      label.htmlFor = select.id;
      for (const candidate of [null, ...candidates.filter(candidate => candidate.category === category.id)]) {
        const option = document.createElement("option");
        option.value = candidate?.id || "existing";
        option.textContent = candidate?.label || "沿用现有模型";
        select.append(option);
      }
      select.addEventListener("change", () => setSelection(category.id, select.value));
      const detail = document.createElement("div"); detail.className = "model-option-detail";
      detail.id = `${select.id}-status`; detail.setAttribute("aria-live", "polite");
      select.setAttribute("aria-describedby", detail.id);
      const status = document.createElement("span"); status.className = "model-option-status";
      const source = document.createElement("a"), license = document.createElement("a");
      for (const link of [source, license]) {link.target = "_blank"; link.rel = "noopener noreferrer";}
      const meta = document.createElement("span"); meta.className = "model-option-meta";
      const actions=document.createElement("div");actions.className="model-option-actions";
      const importButton=document.createElement("button"),removeButton=document.createElement("button");
      for(const [button,iconName,title] of [[importButton,"upload","导入 GLB"],[removeButton,"trash-2","移除本地模型"]]) {
        button.type="button";button.className="icon-button";button.title=title;button.setAttribute("aria-label",title);
        const icon=document.createElement("i");icon.dataset.lucide=iconName;button.append(icon);actions.append(button);
      }
      importButton.addEventListener("click",()=>root.HuayuModelAssets?.showImport(getState(category.id).selection));
      removeButton.addEventListener("click",async()=>{
        const id=getState(category.id).selection;
        if(!root.confirm("移除此浏览器中的模型文件？地图将恢复候选的内置模型（如有）或原有模型。"))return;
        try{await root.HuayuModelAssets.remove(id);}catch(error){status.textContent=error.message;}
      });
      label.append(span, select); detail.append(status, source, license, meta);
      detail.append(actions);
      row.append(label, detail); fragment.append(row);
      return {category: category.id, select, detail, status, source, license, meta, importButton, removeButton};
    });
    container.replaceChildren(fragment);
    updateControls();
    root.lucide?.createIcons({root:container});
  }
  root.HuayuModelOptions = Object.freeze({
    STORAGE_KEY, EVENT, categories, candidates, defaults, normalize, getState, mount,
    getSelections: () => ({...selections}), setSelection, reset: () => save(defaults),
  });
  const container = root.document?.getElementById("model-option-controls");
  if (container) mount(container);
  if(root.HuayuModelAssets) {
    root.addEventListener(root.HuayuModelAssets.EVENT,updateControls);
    root.addEventListener(EVENT,()=>root.HuayuModelAssets.activateSelections());
    void root.HuayuModelAssets.activateSelections();
  }
})(typeof window !== "undefined" ? window : globalThis);
