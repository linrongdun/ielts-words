/* Pure text helpers, shared by the page and verification script. */
(function (root) {
  'use strict';
  const contractions = {"i'll":"i will","we'll":"we will","there's":"there is","don't":"do not","doesn't":"does not","they're":"they are","let's":"let us","it's":"it is","can't":"cannot","isn't":"is not","we're":"we are","that's":"that is"};
  const key = text => String(text).toLowerCase().replace(/[’‘]/g,"'");
  function tokens(text) {
    let s = key(text).replace(/(\d),(?=\d{3}\b)/g,'$1').replace(/°\s*c\b/g,' degrees celsius').replace(/%/g,' percent');
    s = s.replace(/\b(?:one|a) hundred(?: and)? sixty\b/g,'160').replace(/\bten thousand\b/g,'10000').replace(/\b(?:one|a) hundred\b/g,'100').replace(/\bsixty\b/g,'60').replace(/\beighty\b/g,'80');
    s = s.replace(/\bsea water\b/g,'seawater').replace(/\bsun ?drop\b/g,'sundrop').replace(/\bmeters\b/g,'metres').replace(/\bliters\b/g,'litres').replace(/\bsummarise\b/g,'summarize');
    return (s.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/g)||[]).flatMap(w=>(contractions[w]||w).split(' '));
  }
  function compare(expected, submitted) {
    const a=tokens(expected), b=tokens(submitted);
    if (a.length>1200 || b.length>1200) throw Error('文本过长，请按一句一句练习。');
    const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
    for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
    const diff=[];let i=0,j=0;
    while(i<a.length || j<b.length) {
      if(i<a.length&&j<b.length&&a[i]===b[j]) {diff.push({type:'match',text:a[i++]});j++;}
      else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j])) diff.push({type:'extra',text:b[j++]});
      else diff.push({type:'missing',text:a[i++]});
    }
    return {score:Math.round(100*dp[0][0]/Math.max(a.length,b.length,1)),diff,missing:diff.filter(x=>x.type==='missing').length,extra:diff.filter(x=>x.type==='extra').length};
  }
  function lexical(text) {
    return Array.from(String(text).matchAll(/[A-Za-z]+(?:[’'][A-Za-z]+)?|\d[\d,]*(?:\s*°C)?/g),m=>({text:m[0],offset:m.index,start:null,end:null}));
  }
  function timestamp(text) {
    const m=String(text).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{3})$/);
    if(!m || +m[2]>59 || +m[3]>59) throw Error('字幕时间格式不正确。请使用 00:00:01,200 格式。');
    return (+m[1]||0)*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
  }
  function parseSrt(text) {
    return text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/).map(block=>{
      const lines=block.split('\n'),i=lines.findIndex(l=>l.includes('-->'));
      if(i<0) throw Error('找不到字幕时间轴；请使用 SRT 或课程 JSON。');
      const t=lines[i].split('-->').map(s=>s.trim().split(/\s+/)[0]);
      const content=lines.slice(i+1).map(s=>s.replace(/<[^>]*>/g,'').trim()).filter(Boolean);
      return {start:timestamp(t[0]),end:timestamp(t[1]),en:content.filter(s=>!/[\u3400-\u9fff]/.test(s)).join(' '),zh:content.filter(s=>/[\u3400-\u9fff]/.test(s)).join(' ')};
    });
  }
  function validateSentences(rows, duration=Infinity) {
    if(!Array.isArray(rows)||!rows.length||rows.length>1000) throw Error('课程需要 1–1000 句带时间轴的英文。');
    let lastStart=-1;
    return rows.map((s,i)=>{
      const start=Number(s.start),end=Number(s.end);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||start<lastStart||end>duration+.1||end>86400) throw Error(`第 ${i+1} 句时间无效或超出音频范围。`);
      if(typeof s.en!=='string'||!s.en.trim()||s.en.length>5000) throw Error(`第 ${i+1} 句缺少英文或文字过长。`);
      lastStart=start;
      return {id:'s'+i,start,end,en:s.en.trim(),zh:String(s.zh||'').slice(0,5000),section:String(s.section||'我的材料').slice(0,60),words:lexical(s.en.trim()),wave:[]};
    });
  }
  const api={key,tokens,compare,lexical,parseSrt,validateSentences};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  root.ListeningCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
