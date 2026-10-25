// The approved upper-U release, used by the live overlay and the wand development page.
(() => {
  'use strict';
  const G=window.RougeWandGeometry,Art=window.RougeWandArt;
  const media=()=>window.matchMedia('(prefers-reduced-motion: reduce)');
  const forcedCalm=()=>new URLSearchParams(location.search).get('motion')==='reduce';

  function mountMark(canvas,options={}) {
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    let size=options.scale||.2,calm=media().matches||forcedCalm(),feeding=false,paused=false,destroyed=false,data=null,raf=0,level=0,state='idle';
    const motion=media();
    function localFrame(){const r=canvas.getBoundingClientRect();return {x:r.width/2,y:r.height/2,scale:Math.min(r.width,r.height)*size*2/(440*G.S)};}
    function getFrame(){const r=canvas.getBoundingClientRect(),f=localFrame();return {...f,x:r.left+f.x,y:r.top+f.y};}
    function paint(now=performance.now()){
      const r=canvas.getBoundingClientRect(),ratio=Math.min(2,devicePixelRatio||1),w=Math.max(1,Math.round(r.width*ratio)),h=Math.max(1,Math.round(r.height*ratio));
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,r.width,r.height);
      if(data&&!feeding)Art.drawClosed(ctx,localFrame(),now/1000*(state==='idle'?1:1.5),calm,level);
    }
    // The only motion is a highlight that takes about 12 seconds to travel the ribbon, so a resting ribbon needs far fewer
    // than 60 frames a second. The window covers the whole screen and is transparent, so every frame costs a full repaint.
    const FRAME_MS={idle:66,ready:66,reading:66,thinking:33,listening:33,speaking:33};
    let timer=0,lastPaint=-1e9;
    function schedule(){
      if(calm||timer||raf||destroyed||paused||feeding||document.hidden)return;
      const wait=Math.max(0,(FRAME_MS[state]||66)-(performance.now()-lastPaint)-8);   // the 8 ms leaves room for the frame to line up
      timer=setTimeout(()=>{timer=0;if(!raf&&!destroyed)raf=requestAnimationFrame(tick);},wait);
    }
    function tick(now){raf=0;if(destroyed||paused||document.hidden||feeding)return;lastPaint=performance.now();paint(now);schedule();}
    function halt(){cancelAnimationFrame(raf);raf=0;clearTimeout(timer);timer=0;}
    function resume(){if(!destroyed&&!paused&&!feeding&&!document.hidden){paint();lastPaint=performance.now();schedule();}}
    function setReducedMotion(value){calm=!!value;halt();resume();}
    const onMotion=()=>setReducedMotion(motion.matches||forcedCalm());
    const onVisibility=()=>{if(document.hidden)halt();else resume();};
    const onResize=()=>paint();
    motion.addEventListener('change',onMotion);document.addEventListener('visibilitychange',onVisibility);window.addEventListener('resize',onResize);
    const observer=window.ResizeObserver?new ResizeObserver(onResize):null;observer?.observe(canvas);
    const ready=Art.ready.then(value=>{if(destroyed)return null;data=value;resume();return value;}).catch(error=>{console.error('Rouge artwork:',error);return null;});
    return {
      design:'upper-u',ready,getFrame,
      setFeeding(value){feeding=!!value;halt();paint();if(!feeding)resume();},
      setState(value){state=value;paint();},setLevel(value){level=Math.max(0,Math.min(1,Number(value)||0));},
      setScale(value){size=Math.max(.08,Math.min(.4,Number(value)||.2));paint();},
      // The base keeps its approved pose when a target changes direction.
      setRotate(){},getRotate:()=>0,setUnravel(){},getUnravel:()=>feeding?1:0,
      getTailFrame(){const f=getFrame();return {x:f.x+(716*G.S-G.CX)*f.scale,y:f.y+(1033*G.S-G.CY)*f.scale,tx:0,ty:-1,r:30*G.S*f.scale,hw:30*G.S*f.scale};},
      getTailAnchor(){return this.getTailFrame();},
      setReducedMotion,pause(){paused=true;halt();},resume(){paused=false;resume();},
      still(){halt();paint(2350);},
      destroy(){destroyed=true;halt();observer?.disconnect();motion.removeEventListener('change',onMotion);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('resize',onResize);},
    };
  }

  function mountStrand(canvas,mark,options={}) {
    const ctx=canvas.getContext('2d');if(!ctx||!mark)return null;
    const onArrive=typeof options.onArrive==='function'?options.onArrive:()=>{},onRewound=typeof options.onRewound==='function'?options.onRewound:()=>{};
    const motion=media();let calm=motion.matches||forcedCalm(),data=null,renderer=null,failed=false,destroyed=false,paused=false,raf=0,holdTimer=0;
    let hold=G.HOLD_MS,box=null,queued=null,path=null,previous=null,planAt=0,startedAt=0,startReach=0,forcedBack=null,reach=0,phase='idle',arrived=false,tip=null;
    const stopFrame=()=>{cancelAnimationFrame(raf);raf=0;clearTimeout(holdTimer);holdTimer=0;};
    function finish(notify=true){const active=!!box||!!queued;stopFrame();box=queued=path=previous=forcedBack=tip=null;reach=0;phase='idle';mark.setFeeding(false);ctx.clearRect(0,0,canvas.width,canvas.height);if(active&&notify)onRewound();}
    // Once the glide to a new path has finished, the old target no longer matters.
    function currentPath(now){if(previous&&now-planAt>=350)previous=null;return previous?G.blendPlans(previous,path,G.smooth((now-planAt)/350)):path;}
    function stateAt(now){
      if(forcedBack){const t=(now-forcedBack.at)/G.BACK_MS;return {phase:t>=1?'idle':'rewinding',reach:forcedBack.from*(1-G.smooth(t))};}
      return G.timeline(now-startedAt,startReach,hold);
    }
    function armHold(now){clearTimeout(holdTimer);holdTimer=setTimeout(()=>finish(),Math.max(0,G.OUT_MS+hold-(now-startedAt)));}
    function frame(now){
      raf=0;if(destroyed||paused||!box||!data)return;
      const state=stateAt(now);
      if(state.phase==='idle'||calm&&(forcedBack||now-startedAt>=G.OUT_MS+hold)){finish();return;}
      phase=calm?'pointing':state.phase;reach=calm?1:state.reach;
      const width=innerWidth,height=innerHeight,ratio=Math.min(2,devicePixelRatio||1),w=Math.ceil(width*ratio),h=Math.ceil(height*ratio);
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
      const layout=mark.getFrame(),live=currentPath(now),mesh=G.pose(data.rest,data.material,live,reach,layout);
      Art.drawBase(ctx,layout);
      const released=G.smooth(reach/.025);
      if(reach>.00001){
        ctx.save();
        // Clip just the ribbon, never the fixed knot or the application underneath.
        for(const target of [box,previous?.box].filter(Boolean)){ctx.beginPath();ctx.rect(0,0,width,height);ctx.rect(target.x-3,target.y-3,target.w+6,target.h+6);ctx.clip('evenodd');}
        ctx.globalAlpha=released;ctx.drawImage(renderer.draw(mesh,width,height,ratio,calm?0:now/1000),0,0,width,height);ctx.restore();
      }
      if(released<1){ctx.save();ctx.globalAlpha=1-released;Art.drawArch(ctx,layout);ctx.restore();}
      Art.drawFront(ctx,layout);
      tip=G.sample(live.points,Math.min(live.length*reach,live.entry.s));
      if(!arrived&&phase==='pointing'){arrived=true;onArrive();}
      if(!box||destroyed)return;
      if(calm){armHold(now);return;}
      raf=requestAnimationFrame(frame);
    }
    function launch(target){
      const now=performance.now(),old=path?currentPath(now):null,current=box?(calm?1:stateAt(now).reach):0;
      stopFrame();box=target;path=G.plan(mark.getFrame(),box);previous=old;planAt=startedAt=now;startReach=current;hold=G.HOLD_MS;forcedBack=null;arrived=false;phase='unwinding';mark.setFeeding(true);
      if(calm)startedAt-=G.OUT_MS;
      if(!paused)frame(now);
    }
    // The same target has moved (its window scrolled): glide there without restarting the cycle or its hold.
    function follow(target){
      const now=performance.now();previous=currentPath(now);box=target;path=G.plan(mark.getFrame(),box);planAt=now;
      if(!paused){stopFrame();frame(now);}
    }
    function setTarget(value,options){
      if(value==null){rewind();return true;}
      const target=G.rect(value);if(!target||destroyed||failed)return false;
      if(options&&options.follow){
        if(queued&&!box)queued=target;
        else if(box)follow(target);   // once it has drawn back in, a late update must not bring it out again
        return true;
      }
      if(!data){queued=target;return true;}
      queued=null;launch(target);return true;
    }
    function rewind(){
      if(queued&&!box){finish();return;}
      if(!box||phase==='rewinding')return;
      if(calm){finish();return;}
      const now=performance.now();reach=stateAt(now).reach;stopFrame();forcedBack={at:now,from:reach};phase='rewinding';if(!paused)frame(now);
    }
    // Stay on the target long enough to read what is said about it; never cut a hold already spent.
    function setHold(text){
      if(!box||forcedBack||phase==='rewinding')return;
      const now=performance.now(),spent=Math.max(0,now-startedAt-G.OUT_MS);
      hold=Math.max(G.holdFor(text),spent);
      if(calm&&data&&!paused)armHold(now);
    }
    function relayout(){if(!box||!data)return;const now=performance.now();previous=currentPath(now);path=G.plan(mark.getFrame(),box);planAt=now;if(!paused){stopFrame();frame(now);}}
    function setReducedMotion(value){calm=!!value;mark.setReducedMotion(calm);if(box){stopFrame();if(!paused)frame(performance.now());}}
    const onMotion=()=>setReducedMotion(motion.matches||forcedCalm());
    const onVisibility=()=>{if(document.hidden)stopFrame();else if(box&&!paused)frame(performance.now());};
    motion.addEventListener('change',onMotion);window.addEventListener('resize',relayout);document.addEventListener('visibilitychange',onVisibility);
    mark.ready.then(value=>{
      if(destroyed)return;
      if(!value){failed=true;finish();return;}
      data=value;
      try{renderer=Art.createRenderer();}catch(error){failed=true;console.error('Rouge wand:',error);finish();return;}
      if(queued){const target=queued;queued=null;launch(target);}
    });
    return {setTarget,setHold,rewind,relayout,setReducedMotion,
      getTip:()=>tip?{...tip}:null,getTarget:()=>box?{...box}:queued?{...queued}:null,getState:()=>phase,getProgress:()=>reach,
      setTask(task){canvas.dataset.task=String(task||'');},
      cancel(){finish();},pause(){paused=true;stopFrame();},resume(){paused=false;if(box)frame(performance.now());},
      destroy(){finish(false);destroyed=true;renderer?.destroy();motion.removeEventListener('change',onMotion);window.removeEventListener('resize',relayout);document.removeEventListener('visibilitychange',onVisibility);},
    };
  }
  window.RougeWand={mountMark,mountStrand};
})();
