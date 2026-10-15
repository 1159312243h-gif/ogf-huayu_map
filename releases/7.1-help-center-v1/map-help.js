(() => {
  "use strict";
  const view = document.getElementById("help-view");
  if (!view) return;
  const search = document.getElementById("help-search");
  const clear = document.getElementById("help-search-clear");
  const status = document.getElementById("help-search-status");
  const empty = document.getElementById("help-no-results");
  const normalize = value => String(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();
  const topics = [...view.querySelectorAll("[data-help-section]")];
  const text = new Map(topics.map(topic => [topic,normalize(topic.textContent)]));
  let previousOpen = null;

  function filter() {
    const terms = normalize(search.value).split(" ").filter(Boolean);
    if (terms.length && !previousOpen) previousOpen = new Set(topics.filter(topic => topic.open));
    let matches = 0;
    for (const topic of topics) {
      const match = terms.every(term => text.get(topic).includes(term));
      topic.hidden = !match;
      if (match) matches++;
      if (terms.length) topic.open = match;
      else if (previousOpen) topic.open = previousOpen.has(topic);
    }
    if (!terms.length) previousOpen = null;
    clear.hidden = !search.value;
    empty.hidden = matches !== 0;
    status.textContent = terms.length ? `找到 ${matches} 组相关说明，已展开匹配内容。`
      : `共 ${topics.length} 组说明，可搜索或从目录进入。`;
  }

  search.addEventListener("input",filter);
  search.addEventListener("keydown",event => {
    if (event.key !== "Escape" || !search.value) return;
    event.preventDefault();event.stopPropagation();search.value = "";filter();
  });
  clear.addEventListener("click",() => {search.value = "";filter();search.focus({preventScroll:true});});
  view.querySelectorAll("[data-help-target]").forEach(button => {
    button.addEventListener("click",() => {
      const target = document.getElementById(button.dataset.helpTarget);
      if (!topics.includes(target)) return;
      search.value = "";filter();target.open = true;
      target.scrollIntoView({block:"start",behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
      target.querySelector("summary").focus({preventScroll:true});
    });
  });
})();
