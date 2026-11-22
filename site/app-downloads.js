(async function loadApplicationPackages() {
  const target=document.getElementById("app-packages");if(!target)return;
  const releaseURL="https://github.com/1159312243h-gif/ogf-huayu_map/releases";
  function message(title,text,link=false){
    const card=document.createElement("section"),heading=document.createElement("strong"),body=document.createElement("p");
    heading.textContent=title;body.className="muted";body.textContent=text;card.append(heading,body);
    if(link){const anchor=document.createElement("a");anchor.href=releaseURL;anchor.textContent="打开 GitHub 发布页";anchor.rel="noopener";card.append(anchor);}
    target.replaceChildren(card);
  }
  try {
    const response=await fetch("/app-releases.json",{cache:"no-store"});if(!response.ok)throw Error("unavailable");
    const data=await response.json();
    if(data.schema!=="huayu-app-releases-v1"||!Array.isArray(data.items))throw Error("invalid");
    if(!data.items.length){message("原生安装包尚未发布","可以先使用上方的浏览器安装方式。");return;}
    const cards=data.items.map(item=>{
      const url=new URL(item.url);
      if(url.protocol!=="https:"||url.hostname!=="github.com"||url.username||url.password
        ||!url.pathname.startsWith("/1159312243h-gif/ogf-huayu_map/releases/download/")
        ||url.search||url.hash||typeof item.sha256!=="string"||!/^[a-f0-9]{64}$/iu.test(item.sha256)
        ||!Number.isSafeInteger(item.bytes)||item.bytes<1||typeof item.label!=="string"||!item.label.trim()
        ||typeof item.version!=="string")throw Error("invalid");
      const card=document.createElement("section"),link=document.createElement("a"),detail=document.createElement("p");
      link.href=url.href;link.textContent=item.label;link.rel="noopener";
      detail.className="muted";detail.textContent="版本 "+item.version+" · "+(item.bytes/1048576).toFixed(1)+" MiB · "+(item.signing||"签名状态未提供");
      const checksum=document.createElement("details"),summary=document.createElement("summary"),value=document.createElement("code");
      summary.textContent="核对 SHA-256";value.textContent=item.sha256;checksum.append(summary,value);
      card.append(link,detail,checksum);return card;
    });
    target.replaceChildren(...cards);
  } catch {message("安装包列表暂时无法读取","请重新加载页面，或从 GitHub 发布页下载。",true);}
})();