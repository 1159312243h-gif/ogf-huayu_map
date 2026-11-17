(() => {
  "use strict";
  function start() {
    const atlas = window.HuayuAtlas, $ = id => document.getElementById(`feature-info${id ? `-${id}` : ""}`);
    const section = $(""), list = $("list"), form = $("form"), status = $("status"), writeStatus = $("write-status");
    if (!section || !atlas) return;
    let feature = null, items = [], nextCursor = null, active = false, loaded = false;
    let readController = null, readEpoch = 0, busy = false, editing = null, accountKey = "";
    let searchController = null, searchEpoch = 0, contextEpoch = 0;
    let propertySequence = 0;
    const propertyLabels = Object.assign(Object.create(null),{name:"名称","name:zh":"中文名称",alt_name:"别名",building:"建筑用途",
      "building:levels":"地上层数",height:"高度（米）","building:colour":"墙体颜色","roof:shape":"屋顶形状",
      "roof:colour":"屋顶颜色",operator:"运营者",brand:"品牌",opening_hours:"开放时间",website:"网站",
      "addr:street":"街道","addr:housenumber":"门牌号"});
    const currentUser = () => window.HuayuPersonalData?.getCurrentUser() || null;
    const key = item => item ? `${item.type}/${item.id}` : "";
    const canEdit = item => {
      const user = currentUser();
      return Boolean(user && (user.id === item.author.id || user.role === "admin"));
    };
    const messages = {
      authentication_required:"登录已失效，请重新登录后提交。", contribution_forbidden:"你只能修改或删除自己的信息。",
      contribution_conflict:"内容已被更新。你的草稿仍保留，请刷新并核对最新内容后重新编辑。",
      contribution_not_found:"该投稿已被删除，请刷新查看。", contribution_limit:"已达到发布频率或数量上限：每分钟 5 条，同一要素每人 20 条，总计 1000 条。",
      invalid_contribution_text:"请检查标题和正文长度，不能只填空格或包含控制字符。",
      invalid_contribution_source:"来源链接只能使用有效 HTTP／HTTPS 地址。",
      invalid_contribution_properties:"属性最多 32 项；名称使用文字、数字、下划线、冒号、点或短横线，不能重复或包含空格。",
      payload_too_large:"本次文字和属性超过 32 KiB，请分成多条投稿。草稿已保留。",
      personal_data_service_not_configured:"共享信息服务尚未配置，地图其他功能可继续使用。",
    };
    function report(element, message, error = false) {
      element.textContent = message; element.classList.toggle("is-error", error);
    }
    function errorText(error) {
      return messages[error.message] || (error.name === "AbortError" ? "请求超时或已取消，请重试。" : "共享信息暂时无法读取或保存，请稍后重试。");
    }
    async function request(path, options = {}) {
      const controller = new AbortController(), abort = () => controller.abort();
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort",abort,{once:true});
      const timeout = setTimeout(abort,20000);
      try {
        const response = await fetch(path,{method:options.method || "GET",credentials:"same-origin",cache:"no-store",
          signal:controller.signal,headers:{Accept:"application/json",...(options.body ? {"Content-Type":"application/json"} : {})},
          ...(options.body ? {body:JSON.stringify(options.body)} : {})});
        const payload = await response.json();
        if (!response.ok) throw Object.assign(Error(payload.error || "request_failed"),{status:response.status});
        return payload;
      } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort",abort); }
    }
    function button(label, action) {
      const element = document.createElement("button"); element.type = "button"; element.className = "text-button";
      element.textContent = label; element.disabled = busy; element.addEventListener("click",action); return element;
    }
    function resetForm() {
      editing = null; form.reset(); $("property-rows").replaceChildren(); report(writeStatus,""); renderForm();
    }
    function originalValue(propertyKey) {
      const tags = feature?.originalTags || {};
      return Object.hasOwn(tags,propertyKey) ? String(tags[propertyKey]) : feature?.originalTagsKnown ? "未标注" : "尚未读取原始标签";
    }
    function addPropertyRow(property = {}, focus = false) {
      if ($("property-rows").childElementCount >= 32) {report(writeStatus,"每条投稿最多补充 32 项属性。",true); return;}
      const row = document.createElement("div"); row.className = "feature-info-property-row";
      const number = ++propertySequence;
      const keyLabel = document.createElement("label"), valueLabel = document.createElement("label");
      const keyInput = document.createElement("input"), valueInput = document.createElement("input");
      keyLabel.textContent = "属性名"; valueLabel.textContent = "属性值";
      keyInput.id = `shared-property-key-${number}`; valueInput.id = `shared-property-value-${number}`;
      keyLabel.htmlFor = keyInput.id; valueLabel.htmlFor = valueInput.id;
      keyInput.className = "feature-info-property-key"; valueInput.className = "feature-info-property-value";
      keyInput.maxLength = 80; valueInput.maxLength = 512; keyInput.required = true; valueInput.required = true;
      keyInput.setAttribute("list","feature-info-property-keys"); keyInput.placeholder = "例如 name、building:levels";
      valueInput.placeholder = "例如 北城图书馆、3"; keyInput.value = property.key || ""; valueInput.value = property.value || "";
      const original = document.createElement("p"); original.className = "feature-info-meta";
      const update = () => {const key = keyInput.value.trim(); original.textContent = key ? `${propertyLabels[key] || key} · OGF 原值：${originalValue(key)}` : "可选常用属性名或输入自定义属性名。";};
      keyInput.addEventListener("input",update); update();
      const remove = button("移除本项",() => {row.remove();renderForm();});
      keyLabel.append(keyInput); valueLabel.append(valueInput); row.append(keyLabel,valueLabel,original,remove);
      $("property-rows").append(row); renderForm();
      if (focus) (property.key ? valueInput : keyInput).focus();
    }
    function draftProperties() {
      return [...$("property-rows").children].map(row => ({key:row.querySelector(".feature-info-property-key").value.trim(),
        value:row.querySelector(".feature-info-property-value").value.trim()}));
    }
    function renderForm() {
      const user = currentUser(); form.hidden = !user; $("login").hidden = Boolean(user);
      $("form-heading").textContent = editing ? (editing.author.id === user?.id ? "编辑我的信息" : "管理员编辑信息（保留原作者）") : "补充信息";
      $("submit").textContent = busy ? "正在保存…" : editing ? "保存修改" : "发布信息";
      $("cancel").hidden = !editing;
      for (const element of form.elements) element.disabled = busy;
      $("add-name").disabled ||= $("property-rows").childElementCount >= 32;
      $("add-property").disabled ||= $("property-rows").childElementCount >= 32;
    }
    function renderItems() {
      list.replaceChildren();
      for (const item of items) {
        const card = document.createElement("article"); card.className = "feature-info-card"; card.dataset.contributionId = item.id;
        const title = document.createElement("h3"); title.textContent = item.title;
        const author = document.createElement("p"); author.className = "feature-info-meta";
        const date = timestamp => new Date(timestamp).toLocaleString("zh-CN");
        author.textContent = `${item.author.displayName} (@${item.author.username}) · ${date(item.createdAt)}`;
        if (item.revision > 1) author.textContent += ` · ${item.editedBy?.displayName || "用户"} 于 ${date(item.updatedAt)} 编辑`;
        card.append(title,author);
        if (item.properties?.length) {
          const table = document.createElement("table"); table.className = "feature-info-property-table";
          const caption = document.createElement("caption"); caption.textContent = `用户补充属性 · ${item.author.displayName}`;
          const head = table.createTHead().insertRow();
          for (const text of ["属性","OGF 原值","用户补充值"]) {const th = document.createElement("th"); th.scope = "col"; th.textContent = text; head.append(th);}
          const tbody = table.createTBody();
          for (const property of item.properties) {
            const row = tbody.insertRow();
            for (const text of [`${propertyLabels[property.key] || property.key}${propertyLabels[property.key] ? ` (${property.key})` : ""}`,originalValue(property.key),property.value]) row.insertCell().textContent = text;
          }
          table.prepend(caption); card.append(table);
        }
        if (item.content) {const content = document.createElement("p"); content.className = "feature-info-content"; content.textContent = item.content; card.append(content);}
        if (item.sourceUrl) {
          try {
            const url = new URL(item.sourceUrl);
            if (["http:","https:"].includes(url.protocol) && !url.username && !url.password) {
              const link = document.createElement("a"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer nofollow";
              link.textContent = `来源：${url.hostname}`; card.append(link);
            }
          } catch {}
        }
        if (canEdit(item)) {
          const actions = document.createElement("div"); actions.className = "feature-info-actions";
          actions.append(button("编辑",() => {
            if (!canEdit(item)) return;
            if ((editing || $("title").value || $("content").value || $("source").value || $("property-rows").childElementCount)
              && !window.confirm("放弃当前表单草稿，编辑这条信息？")) return;
            editing = item; $("title").value = item.title; $("content").value = item.content; $("source").value = item.sourceUrl;
            $("property-rows").replaceChildren();
            for (const property of item.properties || []) addPropertyRow(property);
            report(writeStatus,""); renderForm(); $("title").focus({preventScroll:true}); form.scrollIntoView({block:"nearest"});
          }),button("删除",() => remove(item)));
          card.append(actions);
        }
        list.append(card);
      }
      $("more").hidden = !nextCursor;
    }
    function syncAccount() {
      const user = currentUser(), next = user ? JSON.stringify([user.id,user.role,user.displayName]) : "";
      if (next !== accountKey) {
        contextEpoch++; accountKey = next; busy = false; resetForm(); renderItems();
      }
      renderForm();
    }
    function selectionChanged() {
      const selected = atlas.getSelectedFeature();
      if (key(feature) === key(selected)) {
        feature = selected; $("target").textContent = feature ? `${feature.label} · ${key(feature)}` : ""; renderItems();
        for (const input of $("property-rows").querySelectorAll(".feature-info-property-key")) input.dispatchEvent(new Event("input"));
        return;
      }
      contextEpoch++; readEpoch++; readController?.abort(); feature = selected;
      loaded = false; items = []; nextCursor = null; busy = false; resetForm(); renderItems();
      section.hidden = !feature;
      $("target").textContent = feature ? `${feature.label} · ${key(feature)}` : "";
      report(status,"");
      if (active && feature) load();
    }
    async function load(more = false) {
      if (!feature || !active) return;
      readController?.abort(); const controller = new AbortController(); readController = controller;
      const epoch = ++readEpoch, identity = key(feature);
      $("refresh").disabled = true; $("more").disabled = true;
      report(status,"正在读取共享信息…");
      try {
        const query = new URLSearchParams({type:feature.type,id:feature.id});
        if (more && nextCursor) query.set("after",nextCursor);
        const payload = await request(`/api/feature-info?${query}`,{signal:controller.signal});
        if (epoch !== readEpoch || identity !== key(feature)) return;
        items = more ? [...new Map([...items,...payload.items].map(item => [item.id,item])).values()] : payload.items;
        nextCursor = payload.nextCursor; loaded = true; renderItems();
        report(status,payload.total ? `共 ${payload.total} 条投稿，已显示 ${items.length} 条。` : "还没有投稿，欢迎补充简介、名称或属性。");
      } catch (error) {
        if (epoch !== readEpoch || controller.signal.aborted) return;
        report(status,`${errorText(error)}${items.length ? " 已保留已读内容。" : ""}`,true);
      } finally {
        if (epoch === readEpoch) { readController = null; $("refresh").disabled = false; $("more").disabled = false; }
      }
    }
    async function mutate(path, method, body, success) {
      if (busy || !feature || !currentUser()) return;
      const epoch = contextEpoch;
      busy = true; renderForm(); renderItems(); report(writeStatus,"正在保存…");
      try {
        await request(path,{method,body});
        if (epoch !== contextEpoch) return;
        if (method !== "DELETE" || editing?.id === path.split("/").at(-1)) resetForm();
        report(writeStatus,success); loaded = false; await load();
      } catch (error) {
        if (epoch !== contextEpoch) return;
        report(writeStatus,errorText(error),true);
        if (error.status === 401) window.HuayuPersonalData?.refreshSession();
      } finally {
        if (epoch === contextEpoch) {busy = false; renderForm(); renderItems();}
      }
    }
    function remove(item) {
      if (busy || !canEdit(item) || !window.confirm(`删除“${item.title}”？所有人将无法再看到这条信息。`)) return;
      mutate(`/api/feature-info/${item.id}`,"DELETE",{revision:item.revision},"信息已删除。");
    }
    form.addEventListener("submit",event => {
      event.preventDefault();
      if (!feature || !form.reportValidity()) return;
      const properties = draftProperties();
      if (properties.some(property => !/^[\p{L}\p{N}][\p{L}\p{N}_:.-]*$/u.test(property.key))
        || new Set(properties.map(property => property.key)).size !== properties.length) {
        report(writeStatus,messages.invalid_contribution_properties,true); return;
      }
      if (!properties.length && (!$("title").value.trim() || !$("content").value.trim())) {
        report(writeStatus,"请填写标题和简介，或添加至少一项属性。",true); return;
      }
      const body = {title:$("title").value,content:$("content").value,sourceUrl:$("source").value,properties};
      if (editing) { if (!canEdit(editing)) return; body.revision = editing.revision; }
      else {const {type,id,label,lat,lng} = feature; body.feature = {type,id,label,lat,lng};}
      mutate(editing ? `/api/feature-info/${editing.id}` : "/api/feature-info",editing ? "PATCH" : "POST",body,"信息已公开保存。");
    });
    $("cancel").addEventListener("click",resetForm);
    $("add-property").addEventListener("click",() => addPropertyRow({},true));
    $("add-name").addEventListener("click",() => {
      const existing = [...$("property-rows").children].find(row => row.querySelector(".feature-info-property-key").value.trim() === "name");
      if (existing) existing.querySelector(".feature-info-property-value").focus(); else addPropertyRow({key:"name"},true);
    });
    $("refresh").addEventListener("click",() => load());
    $("more").addEventListener("click",() => load(true));
    $("login").addEventListener("click",() => atlas.openView("account"));
    function clearSearch() {
      searchEpoch++; searchController?.abort(); searchController = null;
      $("search").replaceChildren(); $("search").hidden = true;
    }
    async function search(query) {
      clearSearch();
      if (!query.trim() || [...query].length > 100) return;
      const epoch = searchEpoch, controller = new AbortController(); searchController = controller;
      try {
        const payload = await request(`/api/feature-info/search?q=${encodeURIComponent(query)}`,{signal:controller.signal});
        if (epoch !== searchEpoch) return;
        const heading = document.createElement("h3"); heading.textContent = "共享词条";
        const children = [heading];
        for (const item of payload.items) {
          children.push(button(`${item.sharedNames ? `${item.sharedNames}（用户补充名称） · ${item.label}` : item.label} · ${key(item)} · ${item.matchingCount} 条匹配信息`,() => {
            clearSearch(); atlas.selectSharedFeature(item);
          }));
        }
        if (payload.hasMore) {const note = document.createElement("p"); note.textContent = "仅显示前 12 个词条，请补全关键词。"; children.push(note);}
        $("search").replaceChildren(...children); $("search").hidden = !payload.items.length;
      } catch (error) {
        if (controller.signal.aborted || epoch !== searchEpoch) return;
        $("search").textContent = `共享词条搜索暂不可用；地名搜索可继续使用。`;
        $("search").hidden = false;
      }
    }
    window.HuayuFeatureInfo = Object.freeze({search,clearSearch,setActive(value) {
      const wasActive = active; active = Boolean(value);
      if (!active) {readEpoch++; readController?.abort(); readController = null; $("refresh").disabled = false; $("more").disabled = false;}
      if (active && !wasActive && feature && !loaded) load();
    }});
    window.addEventListener("huayu:feature-selected",selectionChanged);
    window.addEventListener("huayu:account-changed",syncAccount);
    syncAccount(); selectionChanged();
    window.HuayuFeatureInfo.setActive(atlas.getCurrentView() === "place" && !document.getElementById("tool-panel").classList.contains("is-hidden"));
  }
  if (window.HuayuAtlas) start(); else window.addEventListener("huayu:map-ready",start,{once:true});
})();
