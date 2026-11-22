(() => {
  "use strict";
  const view = document.getElementById("help-view");
  if (!view) return;
  const search = document.getElementById("help-search");
  const clear = document.getElementById("help-search-clear");
  const status = document.getElementById("help-search-status");
  const empty = document.getElementById("help-no-results");
  const directory = view.querySelector(".help-directory");
  const dialog = document.getElementById("help-dialog");
  const content = document.getElementById("help-dialog-content");
  const back = document.getElementById("help-return");
  const normalize = value => String(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();
  const topics = [...view.querySelectorAll("[data-help-section]")];
  const steps = [...view.querySelectorAll(".help-step")];
  const entries = [...topics,...steps];
  const text = new Map(entries.map(node => [node,normalize(node.textContent)]));
  const home = document.createComment("help home");
  view.parentNode.insertBefore(home,view);
  let previousOpen = null, origin = null;

  function filter() {
    const terms = normalize(search.value).split(" ").filter(Boolean);
    if (terms.length && !previousOpen) previousOpen = new Set(entries.filter(node => node.open));
    let matches = 0;
    for (const topic of topics) {
      const match = terms.every(term => text.get(topic).includes(term));
      topic.hidden = !match;
      if (match) matches++;
      if (terms.length) topic.open = match;
      else if (previousOpen) topic.open = previousOpen.has(topic);
      for (const step of topic.querySelectorAll(".help-step")) {
        const stepMatch = terms.every(term => text.get(step).includes(term));
        // A chapter match retains its full context, with matching steps expanded.
        if (terms.length) step.open = match && stepMatch;
        else if (previousOpen) step.open = previousOpen.has(step);
      }
    }
    if (!terms.length) previousOpen = null;
    directory.hidden = Boolean(terms.length);
    clear.hidden = !search.value;
    empty.hidden = matches !== 0;
    status.textContent = terms.length ? "找到 " + matches + " 个相关主题。"
      : "共 " + topics.length + " 个主题，选择小节查看详情。";
  }

  function focusTopic(id) {
    const target = topics.find(topic => topic.id === id);
    if (!target) throw Error("未找到帮助主题");
    search.value = ""; filter(); target.open = true;
    target.scrollIntoView({block:"start",behavior:"auto"});
    target.querySelector("summary").focus({preventScroll:true});
    return target;
  }

  function restore() {
    if (!origin) return;
    const saved = origin; origin = null;
    home.parentNode.insertBefore(view,home.nextSibling);
    view.hidden = saved.hidden;
    // Restoring the same nodes preserves forms, selection, scroll and ongoing tools.
    if (saved.focus?.isConnected) saved.focus.focus({preventScroll:true});
  }

  function close() {
    if (dialog.open) dialog.close();
    restore();
  }

  function open(id = "help-map", trigger = document.activeElement) {
    if (!topics.some(topic => topic.id === id)) throw Error("未找到帮助主题");
    if (view.hidden && !dialog.open) {
      origin = {hidden:view.hidden,focus:trigger};
      content.append(view); view.hidden = false;
      try { dialog.showModal(); } catch (error) { restore(); throw error; }
    }
    focusTopic(id);
    return {topic:id,contextual:dialog.open};
  }

  document.addEventListener("click",event => {
    const target = event.target.closest?.("[data-help-target]");
    if (target) {
      event.preventDefault();
      open(target.dataset.helpTarget,target);
      return;
    }
    // Return the help nodes before an existing menu handler changes pages.
    if (dialog.open && event.target.closest?.("[data-action]")) close();
  },true);
  back.addEventListener("click",close);
  dialog.addEventListener("close",restore);
  dialog.addEventListener("cancel",event => {event.preventDefault();event.stopPropagation();close();});
  window.addEventListener("keydown",event => {
    if (!dialog.open || event.key !== "Escape") return;
    event.preventDefault();event.stopImmediatePropagation();
    if (document.activeElement === search && search.value) {search.value = "";filter();}
    else close();
  },true);
  search.addEventListener("input",filter);
  search.addEventListener("keydown",event => {
    if (event.key !== "Escape" || !search.value) return;
    event.preventDefault();event.stopPropagation();search.value = "";filter();
  });
  clear.addEventListener("click",() => {search.value = "";filter();search.focus({preventScroll:true});});
  window.HuayuMapHelp = Object.freeze({open,close,topics:() => topics.map(topic => ({id:topic.id,title:topic.querySelector("summary").textContent.trim()}))});
  filter();
})();
