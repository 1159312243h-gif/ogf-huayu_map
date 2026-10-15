(() => {
  "use strict";

  const MIN_SPAN = 0.000001;
  const copy = bounds => bounds ? {...bounds} : null;
  function normalize(value) {
    if (!value || ["west", "south", "east", "north"].some(key => value[key] == null
      || String(value[key]).trim() === "" || !Number.isFinite(Number(value[key])))) return null;
    const bounds = Object.fromEntries(["west", "south", "east", "north"].map(key => [key, Number(value[key])]));
    const width = bounds.east - bounds.west, height = bounds.north - bounds.south;
    return bounds.west >= -180 && bounds.east <= 180 && bounds.south >= -85 && bounds.north <= 85
      && width >= MIN_SPAN && height >= MIN_SPAN && width <= 30 && height <= 30 ? bounds : null;
  }
  function fromPoints(a, b) {
    return {west:Math.min(a.lng,b.lng),east:Math.max(a.lng,b.lng),south:Math.min(a.lat,b.lat),north:Math.max(a.lat,b.lat)};
  }
  function translate(bounds, delta) {
    const dx = Math.min(180-bounds.east, Math.max(-180-bounds.west,delta.lng));
    const dy = Math.min(85-bounds.north, Math.max(-85-bounds.south,delta.lat));
    return {west:bounds.west+dx,east:bounds.east+dx,south:bounds.south+dy,north:bounds.north+dy};
  }
  function corners(bounds) {
    return [{lat:bounds.north,lng:bounds.west},{lat:bounds.north,lng:bounds.east},
      {lat:bounds.south,lng:bounds.east},{lat:bounds.south,lng:bounds.west}];
  }

  function create({map, onChange=()=>{}, onState=()=>{}, onError=()=>{}}) {
    const container = map.getContainer(), svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS,"svg");
    svg.classList.add("overlay-bounds-editor");svg.setAttribute("aria-hidden","true");
    const image = document.createElementNS(svgNS,"image");image.setAttribute("preserveAspectRatio","none");
    const polygon = document.createElementNS(svgNS,"polygon");polygon.classList.add("overlay-bounds-outline");
    const handles = Array.from({length:4},(_,i) => {
      const node=document.createElementNS(svgNS,"circle");node.setAttribute("r","6");node.dataset.corner=String(i);
      node.classList.add("overlay-bounds-handle");return node;
    });
    svg.append(image,polygon,...handles);container.appendChild(svg);
    let visible=false,bounds=null,original=null,mode="idle",anchor=null,gesture=null,armedCorner=-1;
    let interactionStates=null,suppressClickUntil=0,suppressContextUntil=0,imageUrl="",opacity=.75;
    let frame=0,destroyed=false;
    const listeners=[];
    const enabled=()=>visible && !container.closest(".is-vector-perspective");
    const editing=()=>mode!=="idle" || Boolean(gesture);
    const point=event=>map.mouseEventToLatLng(event);
    const screen=event=>map.mouseEventToContainerPoint(event);
    const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
    const ignoreTarget=event=>event.target.closest?.(".leaflet-control,.leaflet-popup,button,input,select,a");
    function lock() {
      if (interactionStates) return;
      interactionStates=["dragging","doubleClickZoom","boxZoom","touchZoom"].map(name=>[map[name],Boolean(map[name]?.enabled())]);
      interactionStates.forEach(([handler,wasEnabled])=>{if(wasEnabled)handler.disable();});
    }
    function unlock() {
      interactionStates?.forEach(([handler,wasEnabled])=>{if(wasEnabled)handler.enable();});interactionStates=null;
    }
    function render() {
      frame=0;if(destroyed)return;
      svg.style.display=enabled() && bounds ? "block" : "none";
      if (!bounds) return;
      const size=map.getSize(),points=corners(bounds).map(p=>map.latLngToContainerPoint(p));
      svg.setAttribute("viewBox",`0 0 ${size.x} ${size.y}`);
      polygon.setAttribute("points",points.map(p=>`${p.x},${p.y}`).join(" "));
      const width=points[1].x-points[0].x,height=points[3].y-points[0].y;
      image.setAttribute("x",points[0].x);image.setAttribute("y",points[0].y);
      image.setAttribute("width",Math.max(0,width));image.setAttribute("height",Math.max(0,height));
      image.setAttribute("opacity",opacity);image.style.display=imageUrl ? "" : "none";
      handles.forEach((node,i)=>{
        node.setAttribute("cx",points[i].x);node.setAttribute("cy",points[i].y);
        node.classList.toggle("is-active",armedCorner===i);
      });
    }
    function schedule() {if(!frame)frame=requestAnimationFrame(render);}
    function notify() {
      container.classList.toggle("is-overlay-picking",enabled()&&editing());
      container.classList.toggle("is-overlay-moving",enabled()&&(mode==="move"||gesture?.kind==="move"));
      onState({mode,editing:editing(),hasAnchor:Boolean(anchor),bounds:copy(bounds)});schedule();
    }
    function preview(value) {bounds=value;onChange(copy(bounds),{preview:true});schedule();}
    function finish() {
      const valid=normalize(bounds);
      if(!valid){onError();return false;}
      bounds=valid;original=copy(bounds);mode="idle";anchor=null;gesture=null;armedCorner=-1;unlock();
      onChange(copy(bounds),{preview:false});notify();return true;
    }
    function cancel(clear=false) {
      bounds=clear?null:copy(original);original=copy(bounds);mode="idle";anchor=null;gesture=null;armedCorner=-1;unlock();
      onChange(copy(bounds),{preview:false});notify();
    }
    function begin() {
      cancel();original=copy(bounds);mode="draw";anchor=null;lock();notify();
    }
    function setBounds(value) {
      const valid=normalize(value);if(!valid){onError();return false;}
      cancel();bounds=valid;return finish();
    }
    function beginMove() {
      if(!normalize(bounds))return false;
      original=copy(bounds);mode="move";anchor=null;lock();notify();return true;
    }
    function nearCorner(event) {
      if(!bounds)return -1;
      const p=screen(event),radius=event.pointerType==="touch"?22:13;
      return corners(bounds).findIndex(c=>{const q=map.latLngToContainerPoint(c);return Math.hypot(p.x-q.x,p.y-q.y)<=radius;});
    }
    function inside(event) {
      if(!bounds)return false;const p=point(event);
      return p.lng>=bounds.west&&p.lng<=bounds.east&&p.lat>=bounds.south&&p.lat<=bounds.north;
    }
    function pointerDown(event) {
      if(!enabled()||ignoreTarget(event)||event.isPrimary===false)return;
      if(gesture){stop(event);return;}
      const corner=nearCorner(event),right=event.button===2;
      if(event.button!==0&&!right)return;
      let kind;
      if(right && inside(event))kind="move";
      else if(right)return;
      else if(mode==="draw")kind="draw";
      else if(mode==="move")kind="move";
      else if(mode==="resize"||corner>=0)kind="resize";
      else return;
      stop(event);map.stop();lock();
      if(mode==="idle")original=copy(bounds);
      const here=point(event);
      const armed=mode==="resize"&&armedCorner>=0;
      const fixed=kind==="resize" ? corners(armed?original:bounds)[((armedCorner>=0?armedCorner:corner)+2)%4] : null;
      gesture={id:event.pointerId,kind,start:here,screen:screen(event),base:copy(bounds),fixed,
        hadAnchor:Boolean(anchor),anchor:anchor||here,moved:false,armed};
      if(kind==="resize"){armedCorner=armedCorner>=0?armedCorner:corner;mode="resize";}
      if(kind==="move")mode="move";
      notify();
    }
    function updateGesture(event) {
      const p=point(event),g=gesture;
      const pixel=screen(event);g.moved ||= Math.hypot(pixel.x-g.screen.x,pixel.y-g.screen.y)>4;
      if(g.kind==="move")preview(translate(g.base,{lat:p.lat-g.start.lat,lng:p.lng-g.start.lng}));
      else preview(fromPoints(g.kind==="draw"?g.anchor:g.fixed,p));
    }
    function pointerMove(event) {
      if(!enabled())return;
      if(gesture&&event.pointerId===gesture.id){stop(event);updateGesture(event);}
      else if(mode==="draw"&&anchor&&container.contains(event.target)&&!ignoreTarget(event))preview(fromPoints(anchor,point(event)));
      else if(mode==="resize"&&armedCorner>=0&&container.contains(event.target)&&!ignoreTarget(event)){
        preview(fromPoints(corners(original)[(armedCorner+2)%4],point(event)));
      }
    }
    function pointerUp(event) {
      if(!gesture||event.pointerId!==gesture.id)return;
      stop(event);const g=gesture;updateGesture(event);gesture=null;
      suppressClickUntil=performance.now()+600;
      if(event.button===2)suppressContextUntil=performance.now()+750;
      if(g.kind==="draw"){
        if(g.moved||g.hadAnchor){if(!finish()){anchor=g.anchor;mode="draw";notify();}}
        else{anchor=g.start;bounds=copy(original);onChange(copy(bounds),{preview:true});notify();}
      }else if(g.moved||g.armed){if(!finish()){bounds=copy(original);finish();}}
      else if(g.kind==="resize"){
        // A single tap keeps the frame unchanged; double-click arms precise placement.
        bounds=copy(original);mode="idle";armedCorner=-1;unlock();onChange(copy(bounds),{preview:false});notify();
      }else if(event.button===2){cancel();}
      else{bounds=copy(original);onChange(copy(bounds),{preview:true});notify();}
    }
    function doubleClick(event) {
      if(!enabled()||ignoreTarget(event))return;
      const corner=nearCorner(event);
      if(corner<0)return;
      stop(event);original=copy(bounds);mode="resize";armedCorner=corner;lock();notify();
    }
    function click(event) {
      if(!enabled()||ignoreTarget(event))return;
      if(editing()||nearCorner(event)>=0||performance.now()<suppressClickUntil)stop(event);
    }
    function contextMenu(event) {
      if(enabled()&&!ignoreTarget(event)&&(inside(event)||performance.now()<suppressContextUntil))stop(event);
    }
    function keyDown(event) {
      if(event.key!=="Escape"||!editing())return;
      stop(event);cancel();
    }
    function listen(target,type,callback,options) {
      target.addEventListener(type,callback,options);listeners.push(()=>target.removeEventListener(type,callback,options));
    }
    listen(container,"pointerdown",pointerDown,{capture:true});
    listen(document,"pointermove",pointerMove,{capture:true,passive:false});
    listen(document,"pointerup",pointerUp,{capture:true});
    listen(document,"pointercancel",event=>{if(gesture?.id===event.pointerId)cancel();},{capture:true});
    listen(container,"click",click,{capture:true});listen(container,"dblclick",doubleClick,{capture:true});
    listen(container,"contextmenu",contextMenu,{capture:true});listen(document,"keydown",keyDown,{capture:true});
    listen(window,"blur",()=>{if(editing())cancel();});
    map.on("move zoom resize",schedule);
    return Object.freeze({begin,beginMove,setBounds,cancel,isEditing:editing,getBounds:()=>copy(bounds),
      setVisible(value){if(visible===Boolean(value))return;if(!value&&editing())cancel();visible=Boolean(value);notify();},
      setImage(url,value=.75){imageUrl=url||"";opacity=value;if(imageUrl)image.setAttribute("href",imageUrl);else image.removeAttribute("href");schedule();},
      destroy(){cancel(true);destroyed=true;listeners.forEach(off=>off());map.off("move zoom resize",schedule);cancelAnimationFrame(frame);svg.remove();},
    });
  }
  window.HuayuOverlayBounds=Object.freeze({normalize,fromPoints,translate,corners,create});
})();
