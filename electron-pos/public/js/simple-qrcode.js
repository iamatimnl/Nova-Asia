/* Minimal QR code generator (version 1, level L) for small strings */
(function(){
  'use strict';

  function initGF(){
    const exp=[]; const log=[];
    exp[0]=1;
    for(let i=1;i<256;i++){
      let v=exp[i-1]<<1;
      if(v&0x100) v^=0x11d;
      exp[i]=v;
    }
    for(let i=0;i<255;i++) exp[i+255]=exp[i];
    for(let i=0;i<255;i++) log[exp[i]]=i;
    return {exp,log};
  }

  const GF=initGF();
  function gmul(a,b){ if(a===0||b===0) return 0; return GF.exp[GF.log[a]+GF.log[b]]; }

  function generatorPoly(ec){
    let poly=[1];
    for(let i=0;i<ec;i++){
      const next=[1,GF.exp[i]];
      const tmp=[];
      for(let j=0;j<poly.length;j++){
        tmp[j]=poly[j];
      }
      poly=Array(poly.length+1).fill(0);
      for(let j=0;j<tmp.length;j++){
        poly[j]^=gmul(tmp[j],next[0]);
        poly[j+1]^=gmul(tmp[j],next[1]);
      }
    }
    return poly;
  }

  function addECC(data, ecLen){
    const gen=generatorPoly(ecLen);
    const res=data.slice();
    for(let i=0;i<ecLen;i++) res.push(0);
    for(let i=0;i<data.length;i++){
      const coef=res[i];
      if(coef!==0){
        for(let j=0;j<gen.length;j++){
          res[i+j]^=gmul(coef,gen[j]);
        }
      }
    }
    const ecc=res.slice(data.length);
    return data.concat(ecc);
  }

  function makeData(text){
    const bytes=[];
    for(let i=0;i<text.length;i++) bytes.push(text.charCodeAt(i));
    const bits=[];
    function push(val,len){for(let i=len-1;i>=0;i--) bits.push((val>>i)&1);}
    push(4,4); // mode 8bit
    push(bytes.length,8);
    bytes.forEach(b=>push(b,8));
    push(0,4); // terminator
    while(bits.length%8) bits.push(0);
    let pad=0xec;
    while(bits.length<152){ push(pad,8); pad=pad===0xec?0x11:0xec; }
    const data=[];
    for(let i=0;i<bits.length;i+=8){
      let b=0; for(let j=0;j<8;j++) b=(b<<1)|bits[i+j];
      data.push(b);
    }
    return data;
  }

  function buildMatrix(data){
    const size=21;
    const m=Array.from({length:size},()=>Array(size).fill(null));
    function setFinder(x,y){
      for(let i=-1;i<=7;i++) for(let j=-1;j<=7;j++){
        const xx=x+j, yy=y+i;
        if(xx<0||xx>=size||yy<0||yy>=size) continue;
        m[yy][xx]=(i>=0&&i<=6&&j>=0&&j<=6&&(i===0||i===6||j===0||j===6|| (i>=2&&i<=4&&j>=2&&j<=4)))?1:0;
      }
    }
    setFinder(0,0); setFinder(size-7,0); setFinder(0,size-7);
    for(let i=8;i<size-8;i++){ m[6][i]=i%2?0:1; m[i][6]=i%2?0:1; }
    m[size-8][8]=1;

    let dir=-1,col=size-1,row=size-1,bit=0; // mask0
    while(col>0){ if(col===6) col--; for(let i=0;i<size;i++){ let r=row+dir*i; for(let c=0;c<2;c++){ let cc=col-c; if(m[r][cc]==null){ let val=((data[Math.floor(bit/8)]>>(7-(bit%8)))&1); m[r][cc]=val; bit++; } } } dir=-dir; row+=dir*size; col-=2; }

    const fmt=0b111011111000100;
    function setFormat(mask){
      for(let i=0;i<7;i++) m[8][i]= (fmt>>i)&1;
      for(let i=0;i<8;i++) m[size-1-i][8]=(fmt>>i)&1;
      for(let i=0;i<7;i++) m[i+1][8]=(fmt>>(i+8))&1;
      for(let i=0;i<8;i++) m[8][size-1-i]=(fmt>>(i+7))&1;
    }
    setFormat();
    return m;
  }

  function matrixToDataURL(m,scale){
    const canvas=document.createElement('canvas');
    const size=m.length*scale;
    canvas.width=size; canvas.height=size;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,size,size);
    ctx.fillStyle='#000';
    for(let r=0;r<m.length;r++){
      for(let c=0;c<m.length;c++){
        if(m[r][c]) ctx.fillRect(c*scale,r*scale,scale,scale);
      }
    }
    return canvas.toDataURL();
  }

  window.SimpleQR={
    generate:function(text,size){
      const data=makeData(text);
      const codewords=addECC(data,7);
      const matrix=buildMatrix(codewords);
      return matrixToDataURL(matrix,size||200);
    }
  };
})();
