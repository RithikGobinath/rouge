// Approved satin artwork, split into a fixed base and the upper curve that feeds out.
(() => {
  'use strict';
  const { S, CX, CY, smooth, mix } = window.RougeWandGeometry;
  const W=720,H=864,ROWS=2048,COLS=96;
  const clamp=x=>Math.max(0,Math.min(1,x));
  const ease=(a,b,x)=>smooth((x-a)/(b-a));
  const opacity=(r,g,b)=>Math.max(ease(5,22,r-Math.max(g,b)),ease(43,72,Math.max(r,g,b)));
  const assetRoot=window.RougeWandAssets?null:new URL('wand-assets/',document.currentScript.src||document.baseURI);
  const images=['closed.jpg','material.jpg','base.jpg'].map(name=>{const image=new Image();image.src=window.RougeWandAssets?.[name]||new URL(name,assetRoot).href;return image;});
  const makeCanvas=()=>{const c=document.createElement('canvas');c.width=W;c.height=H;return c;};
  const fixed=makeCanvas(),frontBand=makeCanvas(),arch=makeCanvas(),scratch=makeCanvas(),ctx=scratch.getContext('2d');
  let restSurface,openSurface;
  function readImage(image) {
    const c=makeCanvas(),p=c.getContext('2d');p.drawImage(image,0,0,W,H);return p.getImageData(0,0,W,H);
  }
  function cutLayers(closed,base) {
    const fixedData=ctx.createImageData(W,H),archData=ctx.createImageData(W,H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++) {
      const k=(y*W+x)*4;
      if(x<520*S||y<790*S||y>1240*S)continue;
      const ba=opacity(base.data[k],base.data[k+1],base.data[k+2]);
      const ca=opacity(closed.data[k],closed.data[k+1],closed.data[k+2]);
      const aa=x>675*S&&x<912*S&&y<1035*S?ca:0;
      for(let c=0;c<3;c++){
        fixedData.data[k+c]=ba?clamp((base.data[k+c]-26*(1-ba))/(255*ba))*255:0;
        archData.data[k+c]=aa?clamp((closed.data[k+c]-26*(1-aa))/(255*aa))*255:0;
      }
      fixedData.data[k+3]=ba*255;archData.data[k+3]=aa*255;
    }
    fixed.getContext('2d').putImageData(fixedData,0,0);arch.getContext('2d').putImageData(archData,0,0);
    const front=frontBand.getContext('2d');front.save();front.scale(S,S);front.beginPath();front.moveTo(550,1040);front.bezierCurveTo(650,1029,759,970,850,978);front.bezierCurveTo(914,974,949,990,955,1020);front.lineTo(1010,1260);front.lineTo(530,1260);front.closePath();front.clip();front.drawImage(fixed,0,0,W/S,H/S);front.restore();
  }
  function bake(path,raw) {
    const length=path.getTotalLength()*S,frames=[],atlas=document.createElement('canvas');atlas.width=COLS;atlas.height=ROWS;
    const paint=atlas.getContext('2d'),texture=paint.createImageData(COLS,ROWS);
    function pixel(x,y,c){const ix=Math.max(0,Math.min(W-1,Math.round(x))),iy=Math.max(0,Math.min(H-1,Math.round(y)));return raw.data[(iy*W+ix)*4+c];}
    for(let i=0;i<ROWS;i++) {
      const s=i/(ROWS-1)*length,p=path.getPointAtLength(s/S),a=path.getPointAtLength(Math.max(0,s/S-5)),b=path.getPointAtLength(Math.min(length/S,s/S+5));
      const d=Math.hypot(b.x-a.x,b.y-a.y),nx=-(b.y-a.y)/d,ny=(b.x-a.x)/d,x=p.x*S,y=p.y*S;
      const runs=[];let first=null;
      for(let q=-65*S;q<=65*S;q+=.5){const hit=opacity(pixel(x+nx*q,y+ny*q,0),pixel(x+nx*q,y+ny*q,1),pixel(x+nx*q,y+ny*q,2))>.6;
        if(hit&&first===null)first=q;if(!hit&&first!==null){runs.push([first,q-.5]);first=null;}}
      if(first!==null)runs.push([first,65*S]);
      let bounds=runs.find(r=>r[0]<=0&&r[1]>=0);
      if(!bounds&&runs.length)bounds=runs.reduce((best,r)=>Math.min(Math.abs(r[0]),Math.abs(r[1]))<Math.min(Math.abs(best[0]),Math.abs(best[1]))?r:best,runs[0]);
      if(!bounds)bounds=[-.4,.4];
      const [lo,hi]=bounds;frames.push({x,y,nx,ny,lo,hi,s});
      for(let u=0;u<COLS;u++){
        const q=mix(lo,hi,u/(COLS-1)),px=x+nx*q,py=y+ny*q,k=(i*COLS+u)*4;
        const r=pixel(px,py,0),g=pixel(px,py,1),b=pixel(px,py,2),alpha=Math.max(.01,opacity(r,g,b));
        for(let c=0;c<3;c++)texture.data[k+c]=clamp((pixel(px,py,c)-26*(1-alpha))/(255*alpha))*255;
        texture.data[k+3]=Math.min(1,u/1.5,(COLS-1-u)/1.5)*255;
      }
    }
    return {length,frames,atlas,texture,paint};
  }
  function restoreCrossing(surface,from,to) {
    const {frames,texture}=surface;
    const nearest=(x,y,min=0)=>frames.reduce((best,p,i)=>i>=min&&(p.x-x*S)**2+(p.y-y*S)**2<(frames[best].x-x*S)**2+(frames[best].y-y*S)**2?i:best,min);
    const min=from[2]||0,a=nearest(from[0],from[1],min),b=nearest(to[0],to[1],min);
    if(b<=a)throw new Error('Invalid crossing order');
    const first=texture.data.slice(a*COLS*4,(a+1)*COLS*4),last=texture.data.slice(b*COLS*4,(b+1)*COLS*4);
    const low={lo:frames[a].lo,hi:frames[a].hi},high={lo:frames[b].lo,hi:frames[b].hi};
    for(let i=a;i<=b;i++){
      const t=(i-a)/(b-a),weight=smooth(t/.15)*smooth((1-t)/.15),p=frames[i];
      p.lo=mix(p.lo,mix(low.lo,high.lo,t),weight);p.hi=mix(p.hi,mix(low.hi,high.hi,t),weight);
      for(let u=0;u<COLS;u++)for(let c=0;c<3;c++){const k=(i*COLS+u)*4+c;texture.data[k]=mix(texture.data[k],mix(first[u*4+c],last[u*4+c],t),weight);}
    }
    return [a,b];
  }
  function restoreFeed() {
    const {frames,texture}=openSurface;
    const end=frames.reduce((best,p,i)=>(p.x-855*S)**2+(p.y-735*S)**2<(frames[best].x-855*S)**2+(frames[best].y-735*S)**2?i:best,0);
    const closedRow=Math.round(ROWS*.2),highlightRow=Math.round(ROWS*.36),first=restSurface.texture.data.slice(closedRow*COLS*4,(closedRow+1)*COLS*4),highlight=restSurface.texture.data.slice(highlightRow*COLS*4,(highlightRow+1)*COLS*4),last=texture.data.slice(end*COLS*4,(end+1)*COLS*4),lo=frames[end].lo,hi=frames[end].hi;
    // The closed arch overlaps the feed in the source still; it is not feed material.
    for(let i=0;i<=end;i++){
      const t=i/end,p=frames[i],blend=smooth(t);
      p.lo=mix(-30*S,lo,blend);p.hi=mix(30*S,hi,blend);
      for(let u=0;u<COLS;u++)for(let c=0;c<3;c++){const k=u*4+c;texture.data[(i*COLS+u)*4+c]=t<.55?mix(first[k],highlight[k],smooth(t/.55)):mix(highlight[k],last[k],smooth((t-.55)/.45));}
    }
    const rest=restSurface.frames,restTexture=restSurface.texture.data;
    for(const [start,end,startLo,startHi] of [[0,Math.round(ROWS*.25),-30*S,30*S],[ROWS-1,Math.round(ROWS*.79),-14*S,14*S]]){
      const colors=restTexture.slice(end*COLS*4,(end+1)*COLS*4),endLo=rest[end].lo,endHi=rest[end].hi;
      const direction=end>start?1:-1;
      for(let i=start;direction>0?i<=end:i>=end;i+=direction){const t=smooth((i-start)/(end-start));rest[i].lo=mix(startLo,endLo,t);rest[i].hi=mix(startHi,endHi,t);for(let u=0;u<COLS;u++)for(let c=0;c<3;c++)restTexture[(i*COLS+u)*4+c]=colors[u*4+c];}
    }
  }

  function withFrame(paint,frame,draw){paint.save();paint.translate(frame.x,frame.y);paint.scale(frame.scale,frame.scale);paint.translate(-CX,-CY);draw();paint.restore();}
  const drawBase=(paint,frame)=>withFrame(paint,frame,()=>paint.drawImage(fixed,0,0));
  const drawFront=(paint,frame)=>withFrame(paint,frame,()=>paint.drawImage(frontBand,0,0));
  const drawArch=(paint,frame)=>withFrame(paint,frame,()=>paint.drawImage(arch,0,0));
  function drawClosed(paint,frame,clock,calm,level=0){
    withFrame(paint,frame,()=>{paint.drawImage(fixed,0,0);paint.drawImage(arch,0,0);paint.drawImage(frontBand,0,0);});
    if(calm)return;
    const p=restSurface.frames[Math.floor((clock*.08%1)*ROWS)];
    paint.save();paint.globalCompositeOperation='source-atop';
    const x=frame.x+(p.x-CX)*frame.scale,y=frame.y+(p.y-CY)*frame.scale,radius=Math.max(4,22*frame.scale);
    const light=paint.createRadialGradient(x,y,0,x,y,radius);light.addColorStop(0,`rgba(255,235,220,${.12+level*.1})`);light.addColorStop(1,'rgba(255,235,220,0)');paint.fillStyle=light;paint.fillRect(x-radius,y-radius,radius*2,radius*2);paint.restore();
  }

  function softwareRenderer(){
    const canvas=makeCanvas(),paint=canvas.getContext('2d');
    function color(surface,u,v,c){const row=Math.min(ROWS-1,Math.max(0,Math.round(v*(ROWS-1)))),col=Math.round(u*(COLS-1));return surface.texture.data[(row*COLS+col)*4+c];}
    return {draw(mesh,width,height,ratio){
      const w=Math.ceil(width*ratio),h=Math.ceil(height*ratio);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}paint.setTransform(ratio,0,0,ratio,0,0);paint.clearRect(0,0,width,height);
      const points=mesh.centers,edges=points.map((p,i)=>{const a=points[Math.max(0,i-2)],b=points[Math.min(points.length-1,i+2)],d=Math.hypot(b.x-a.x,b.y-a.y)||1,nx=-(b.y-a.y)/d,ny=(b.x-a.x)/d;return {l:{x:p.x+nx*p.lo,y:p.y+ny*p.lo},r:{x:p.x+nx*p.hi,y:p.y+ny*p.hi}};});
      for(let i=0;i<points.length-1;i++){
        const a=edges[i],b=edges[i+1],p=points[i],gradient=paint.createLinearGradient(a.l.x,a.l.y,a.r.x,a.r.y);
        for(const u of [0,.2,.5,.8,1]){const rgb=[0,1,2].map(c=>Math.round(mix(color(restSurface,u,p.restU,c),color(openSurface,u,p.openU,c),mesh.opening)));gradient.addColorStop(u,`rgb(${rgb.join(',')})`);}
        paint.beginPath();paint.moveTo(a.l.x,a.l.y);paint.lineTo(a.r.x,a.r.y);paint.lineTo(b.r.x,b.r.y);paint.lineTo(b.l.x,b.l.y);paint.closePath();paint.fillStyle=paint.strokeStyle=gradient;paint.lineWidth=.7;paint.fill();paint.stroke();
      }
      return canvas;
    },destroy(){canvas.width=canvas.height=1;}};
  }

  function createRenderer(){
    const canvas=makeCanvas();let gl=null;
    try{gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:true});}catch(_){/* Canvas 2D keeps the wand available without a GPU. */}
    if(!gl)return softwareRenderer();
    function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    const program=gl.createProgram(),shaders=[],textures=[];
    try{
      shaders.push(shader(gl.VERTEX_SHADER,'attribute vec2 p;attribute vec3 uv;uniform vec2 viewport;varying vec3 v;void main(){gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);v=uv;}'));
      shaders.push(shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D restTex;uniform sampler2D openTex;uniform float opening;uniform float clock;varying vec3 v;void main(){vec4 color=mix(texture2D(restTex,vec2(v.x,v.y)),texture2D(openTex,vec2(v.x,v.z)),opening);float d=abs(v.z-fract(clock*.07));color.rgb+=vec3(.035,.025,.02)*exp(-d*d/.0015);gl_FragColor=color;}'));
      shaders.forEach(s=>gl.attachShader(program,s));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    }catch(error){shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program);console.warn('Rouge ribbon uses Canvas 2D:',error.message);return softwareRenderer();}
    for(const [i,surface] of [restSurface,openSurface].entries()){
      const texture=gl.createTexture();textures.push(texture);gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,surface.atlas);gl.uniform1i(gl.getUniformLocation(program,i?'openTex':'restTex'),i);
    }
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    const position=gl.getAttribLocation(program,'p'),uv=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(position);gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(position,2,gl.FLOAT,false,20,0);gl.vertexAttribPointer(uv,3,gl.FLOAT,false,20,8);
    gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    const viewport=gl.getUniformLocation(program,'viewport'),opening=gl.getUniformLocation(program,'opening'),clock=gl.getUniformLocation(program,'clock');
    const limit=gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    let fallback=null;
    return {draw(mesh,width,height,ratio,time=0){
      if(gl.isContextLost()){fallback||=softwareRenderer();return fallback.draw(mesh,width,height,ratio);}
      const scale=Math.min(ratio,limit/width,limit/height),w=Math.ceil(width*scale),h=Math.ceil(height*scale);
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);gl.uniform2f(viewport,width,height);gl.uniform1f(opening,mesh.opening);gl.uniform1f(clock,time);
      const points=mesh.centers,n=points.length-1,vertices=new Float32Array(n*30);let k=0;
      function vertex(i,side){const p=points[i],a=points[Math.max(0,i-2)],b=points[Math.min(n,i+2)],d=Math.hypot(b.x-a.x,b.y-a.y)||1,q=side?p.hi:p.lo;vertices[k++]=p.x-(b.y-a.y)/d*q;vertices[k++]=p.y+(b.x-a.x)/d*q;vertices[k++]=side;vertices[k++]=p.restU;vertices[k++]=p.openU;}
      for(let i=0;i<n;i++){vertex(i,0);vertex(i,1);vertex(i+1,0);vertex(i+1,0);vertex(i,1);vertex(i+1,1);}
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,n*6);return canvas;
    },destroy(){fallback?.destroy();textures.forEach(t=>gl.deleteTexture(t));shaders.forEach(s=>gl.deleteShader(s));gl.deleteBuffer(buffer);gl.deleteProgram(program);canvas.width=canvas.height=1;}};
  }

  const ready=Promise.all(images.map(image=>image.decode())).then(()=>{
    const closed=readImage(images[0]),open=readImage(images[1]),base=readImage(images[2]);cutLayers(closed,base);
    const path=d=>{const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);return p;};
    restSurface=bake(path('M 716 1033 C 716 944 767 869 817 868 C 867 867 869 921 874 992'),closed);
    openSurface=bake(path('M 716 1033 C 705 969 744 879 805 802 C 850 747 881 688 905 641 C 964 542 979 432 938 346 C 909 283 875 214 834 170 C 759 90 538 54 360 98 C 257 123 177 164 202 236 C 227 313 383 364 539 365 C 710 367 851 264 942 218 C 1012 183 1071 168 1098 108'),open);
    restoreFeed();restoreCrossing(openSurface,[938,346],[834,170]);restoreCrossing(openSurface,[800,300,Math.floor(ROWS*.65)],[965,204]);
    for(const surface of [restSurface,openSurface]){
      const bounds=surface.frames.map(p=>({lo:p.lo,hi:p.hi}));
      surface.frames.forEach((p,i)=>{let lo=0,hi=0,count=0;for(let j=Math.max(0,i-12);j<=Math.min(ROWS-1,i+12);j++){lo+=bounds[j].lo;hi+=bounds[j].hi;count++;}p.lo=lo/count;p.hi=hi/count;});
      surface.paint.putImageData(surface.texture,0,0);
    }
    return {rest:restSurface.frames,material:openSurface.frames};
  });
  window.RougeWandArt={ready,drawBase,drawFront,drawArch,drawClosed,createRenderer};
})();
