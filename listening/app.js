(function () {
  'use strict';
  const $=id=>document.getElementById(id), C=window.ListeningCore, data=window.LISTENING_DATA;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STORE='qihang-listening-v1', courses=data.courses.slice(), audio=$('audio');
  let state={version:1,records:{},words:{},settings:{speed:1,repeat:1,gap:2},current:{}}, storageOK=true;
  try {const saved=JSON.parse(localStorage.getItem(STORE)||'null'); if(saved) state=cleanState(saved);} catch(e) {storageOK=false;}
  let course=courses.find(c=>c.id===state.current.course)||courses[0], index=Math.min(Math.max(0,state.current.index||0),course.sentences.length-1);
  let view='practice', revealed=false, checked=false, translation=false, initials=false;
  let active=null, playToken=0, frame=0, boundaryTimer=0, repeatTimer=0, saveTimer=0, dictionary=null;
  let playing=false, pausedAt=null, storageWarned=false, loadedId='';
  function validKey(k) {return typeof k==='string'&&k.length<250&&!['__proto__','constructor','prototype'].includes(k);}
  function cleanState(s) {
    if(!s||s.version!==1||typeof s.records!=='object'||Array.isArray(s.records)||!s.records) throw Error('这不是精听室的学习备份。');
    const out={version:1,records:{},words:{},settings:{speed:1,repeat:1,gap:2},current:{}};
    for(const [k,r]of Object.entries(s.records).slice(0,20000)) {
      if(!validKey(k)||!r||typeof r!=='object')continue;
      const rec={answer:String(r.answer||'').slice(0,5000),note:String(r.note||'').slice(0,5000),hard:!!r.hard,reviewed:!!r.reviewed,updated:Math.min(Number(r.updated)||0,Date.now())};
      if(Number.isFinite(r.score))rec.score=Math.max(0,Math.min(100,r.score));
      if(Array.isArray(r.timing)&&r.timing.length===2&&r.timing.every(Number.isFinite)&&r.timing[0]>=0&&r.timing[1]>r.timing[0])rec.timing=r.timing;
      out.records[k]=rec;
    }
    if(s.words&&typeof s.words==='object') for(const [k,w]of Object.entries(s.words).slice(0,10000)) {
      if(!validKey(k)||!w||typeof w!=='object')continue;
      out.words[k]={text:String(w.text||k).slice(0,150),pos:String(w.pos||'').slice(0,100),zh:String(w.zh||'').slice(0,1000),context:String(w.context||'').slice(0,5000),course:String(w.course||'').slice(0,150),sentence:String(w.sentence||'').slice(0,150),offset:Number(w.offset)||0,updated:Math.min(Number(w.updated)||0,Date.now()),deleted:!!w.deleted};
    }
    if(s.settings) {
      if([.6,.75,.9,1,1.15].includes(+s.settings.speed))out.settings.speed=+s.settings.speed;
      if([0,1,2].includes(+s.settings.repeat))out.settings.repeat=+s.settings.repeat;
      if([1,2,3,5].includes(+s.settings.gap))out.settings.gap=+s.settings.gap;
    }
    if(s.current&&validKey(s.current.course))out.current={course:s.current.course,index:Math.max(0,Math.floor(Number(s.current.index)||0))};
    return out;
  }
  function message(text) {$('status-message').textContent=text;$('status-message').hidden=!text;}
  function save(now=false) {
    clearTimeout(saveTimer);
    const write=()=>{try{localStorage.setItem(STORE,JSON.stringify(state));storageOK=true;}catch(e){storageOK=false;if(!storageWarned){message('浏览器暂时不能保存记录。请用“材料与备份”导出进度，避免关闭后丢失。');storageWarned=true;}}};
    if(now)write();else saveTimer=setTimeout(write,250);
  }
  const sentence=()=>course.sentences[index];
  const recordKey=(c=course,s=sentence())=>c.id+'/'+s.id;
  const record=(c=course,s=sentence())=>state.records[recordKey(c,s)]||{answer:'',note:'',hard:false,reviewed:false};
  function update(values) {state.records[recordKey()]={...record(),...values,updated:Date.now()};save();}
  function bounds(c=course,s=sentence()) {
    const t=record(c,s).timing;
    return t&&t[0]>=0&&t[1]<=c.duration+.1&&t[1]>t[0]?t:[s.start,s.end];
  }
  const format=n=>`${String(Math.floor(Math.max(0,n)/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,n)%60)).padStart(2,'0')}`;
  function stop(status) {
    playToken++;playing=false;active=null;pausedAt=null;
    cancelAnimationFrame(frame);clearTimeout(boundaryTimer);clearTimeout(repeatTimer);audio.pause();
    if(window.speechSynthesis)window.speechSynthesis.cancel();
    $('play').textContent='▶';$('play').setAttribute('aria-label','播放当前句');
    if(status)$('play-status').textContent=status;
  }
  function loadAudio(c) {
    if(loadedId===c.id)return;
    audio.src=c.audio;audio.load();loadedId=c.id;
  }
  function paintPosition() {
    const [start,end]=bounds(),position=active?.kind==='sentence'&&active.course===course.id?Math.max(0,Math.min(end-start,audio.currentTime-start)):(pausedAt===null?0:pausedAt-start);
    const fraction=Math.max(0,Math.min(1,position/(end-start)));
    $('seek').value=Math.round(fraction*1000);$('position-time').textContent=format(position)+' / '+format(end-start);
    $('waveform').querySelectorAll('i').forEach((bar,i)=>bar.classList.toggle('played',i/70<fraction));
  }
  function scheduleBoundary(token) {
    clearTimeout(boundaryTimer);
    if(!active||token!==playToken||!playing)return;
    const left=(active.end-audio.currentTime)/audio.playbackRate;
    boundaryTimer=setTimeout(()=>{if(token!==playToken||!active)return;if(audio.currentTime>=active.end-.025)finishClip(token);else scheduleBoundary(token);},Math.max(10,Math.min(250,left*1000)));
  }
  function tick(token) {
    if(token!==playToken||!active||!playing)return;
    if(active.kind==='sentence')paintPosition();
    if(audio.currentTime>=active.end-.025){finishClip(token);return;}
    frame=requestAnimationFrame(()=>tick(token));
  }
  function finishClip(token) {
    if(token!==playToken||!active||!playing)return;
    playing=false;audio.pause();cancelAnimationFrame(frame);clearTimeout(boundaryTimer);
    const clip=active;
    $('play').textContent='▶';$('play').setAttribute('aria-label','播放当前句');
    if(clip.kind==='sentence'){active=null;pausedAt=clip.end;paintPosition();active=clip;}
    const repeats=+state.settings.repeat;
    if(clip.kind==='sentence'&&(repeats===0||clip.pass<repeats)) {
      $('play-status').textContent=`停 ${state.settings.gap} 秒后重听本句…`;
      $('play').textContent='■';$('play').setAttribute('aria-label','停止重复播放');
      repeatTimer=setTimeout(()=>{if(playToken===token)startClip(clip.courseObject,bounds()[0],clip.end,'sentence',clip.pass+1);},state.settings.gap*1000);
    } else {active=null;$('play-status').textContent=clip.kind==='word'?'单词播放结束。':'本句已听完。写好后，再进入下一句。';}
  }
  function startClip(c,start,end,kind='sentence',pass=1) {
    stop();loadAudio(c);
    const token=playToken;
    active={course:c.id,courseObject:c,start,end,kind,pass};playing=true;pausedAt=null;
    audio.playbackRate=+state.settings.speed;audio.preservesPitch=true;
    try{audio.currentTime=start;}catch(e){/* loadedmetadata applies the pending seek below. */}
    $('play').textContent='Ⅱ';$('play').setAttribute('aria-label','暂停当前播放');
    $('play-status').textContent=kind==='word'?'正在听原音中的发音…':`正在播放本句${pass>1?' · 第 '+pass+' 遍':''}`;
    const promise=audio.play();
    if(promise)promise.then(()=>{if(token===playToken){tick(token);scheduleBoundary(token);}}).catch(e=>{
      if(token!==playToken)return;stop('点播放按钮，再试一次。');message('音频未能播放。请检查音频文件是否完整，或在 Safari / Chrome 中重新点击播放。');
    });
  }
  function playSentence(from=null) {const [start,end]=bounds();startClip(course,from!==null&&from<end-.1?Math.max(start,from):start,end);}
  function togglePlay() {
    if(active) {
      const current=active.kind==='sentence'?audio.currentTime:null;
      stop('已暂停，点击继续。');pausedAt=current;paintPosition();
    } else playSentence(pausedAt);
  }
  audio.addEventListener('loadedmetadata',()=>{if(active&&active.start<audio.duration)audio.currentTime=active.start;});
  audio.addEventListener('timeupdate',()=>{if(active&&playing&&audio.currentTime>=active.end-.025)finishClip(playToken);});
  audio.addEventListener('ended',()=>finishClip(playToken));
  audio.addEventListener('error',()=>{if(active){stop('音频读取失败。');message('找不到音频。发布版请完整上传 audio 文件夹；单文件版请确认 HTML 下载完整。');}});
  audio.addEventListener('waiting',()=>{if(active)$('play-status').textContent='音频加载中…';});
  audio.addEventListener('playing',()=>{if(active)$('play-status').textContent=active.kind==='word'?'正在听原音中的发音…':`正在播放本句 · 第 ${active.pass} 遍`;});
  document.addEventListener('visibilitychange',()=>{save(true);if(document.hidden)stop('已暂停。回到页面后可继续听。');});
  window.addEventListener('pagehide',()=>{save(true);stop();});
  function renderSidebar() {
    $('lesson-list').innerHTML=courses.map(c=>`<button class="lesson-card ${c.id===course.id?'active':''}" data-course="${esc(c.id)}" ${c.id===course.id?'aria-current="true"':''}><span class="lesson-code">${esc(c.code)}</span><strong>${esc(c.title)}</strong><small>${c.sentences.length} 句 · ${format(c.duration)}</small></button>`).join('');
    let section='',html='',count=0;
    course.sentences.forEach((s,i)=>{
      const r=record(course,s);if($('only-hard').checked&&!r.hard)return;
      if(section!==s.section){if(section)html+='</div>';section=s.section;html+=`<p class="chapter-title">${esc(section)}</p><div class="sentence-grid">`;}
      html+=`<button class="sentence-jump ${i===index?'active':''} ${r.reviewed?'done':''} ${r.hard?'hard':''}" data-jump="${i}" aria-label="第 ${i+1} 句${r.reviewed?'，已核对':''}${r.hard?'，难句':''}" ${i===index?'aria-current="step"':''}>${i+1}</button>`;count++;
    });
    if(section)html+='</div>';
    $('sentence-nav').innerHTML=count?html:'<p class="small muted">还没有标记难句。点“☆ 标记难句”即可加入。</p>';
    const done=course.sentences.filter(s=>record(course,s).reviewed).length;
    $('progress-badge').textContent=`${done} / ${course.sentences.length} 句已核对`;$('lesson-progress').value=100*done/course.sentences.length;
    $('word-count').textContent=Object.values(state.words).filter(w=>!w.deleted).length;
  }
  function renderPractice() {
    const s=sentence(),r=record(),[start,end]=bounds();
    $('lesson-label').textContent=`AUDIO ${course.code} · ${course.title}`;$('sentence-label').textContent=`第 ${index+1} 句`;$('section-name').textContent=s.section;
    $('answer').value=r.answer;$('sentence-note').value=r.note;$('answer-count').textContent=`${C.lexical(r.answer).length} 词 · ${storageOK?'自动保存':'请导出备份'}`;
    $('clip-start').value=start.toFixed(2);$('clip-end').value=end.toFixed(2);
    $('mark-hard').setAttribute('aria-pressed',r.hard?'true':'false');$('mark-hard').textContent=r.hard?'★ 已标记难句':'☆ 标记难句';
    $('waveform').innerHTML=(s.wave.length?s.wave:Array(70).fill(.2)).map(v=>`<i style="height:${Math.round(5+25*v)}px"></i>`).join('');
    $('previous').disabled=index===0;$('next').disabled=false;$('next').textContent=index===course.sentences.length-1?'完成本段 ✓':'下一句并播放 →';$('navigation-count').textContent=`${index+1} / ${course.sentences.length}`;
    translation=false;initials=false;revealed=false;checked=false;
    $('translation-hint').hidden=true;$('initial-hint').hidden=true;$('feedback').hidden=true;
    for(const id of ['show-translation','show-initials','reveal'])$(id).setAttribute('aria-expanded','false');
    $('play-status').textContent='准备好，先听一句。';paintPosition();
  }
  function select(c,i,play=false) {
    stop();save(true);course=c;index=Math.max(0,Math.min(i,c.sentences.length-1));state.current={course:course.id,index};save();loadAudio(course);renderSidebar();renderPractice();
    if(view==='reading')renderReading();
    if(play){setView('practice');playSentence();}
  }
  function setView(name) {
    view=name;
    for(const v of ['practice','reading','words','library'])$(v+'-view').hidden=v!==name;
    document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('nav-active',b.dataset.view===name);b.setAttribute('aria-current',b.dataset.view===name?'page':'false');});
    if(name==='reading')renderReading();if(name==='words')renderWords();
    if(name!=='practice')stop('已暂停。');
  }
  function reference(s,c=course) {
    let html='',last=0;
    for(const w of s.words) {html+=esc(s.en.slice(last,w.offset))+`<button class="word-button" data-word="${esc(w.text)}" data-offset="${w.offset}" data-sentence="${esc(s.id)}" data-word-course="${esc(c.id)}">${esc(w.text)}</button>`;last=w.offset+w.text.length;}
    return html+esc(s.en.slice(last));
  }
  function relevantPhrases(s) {const text=C.key(s.en);return data.phrases.filter(p=>text.includes(C.key(p[0])));}
  function renderFeedback() {
    const s=sentence(),r=record();let result=null;
    if(checked)result=C.compare(s.en,r.answer);
    $('feedback').hidden=false;
    $('feedback').innerHTML=`<div class="feedback-head"><strong>${checked?(result.score===100?'这一句，写对了。':'找出没听清的地方。'):'听写原文'}</strong>${result?`<span class="score">${result.score}<small> / 100 匹配度</small></span>`:''}</div>`+
      (result&&result.score<100?`<p class="feedback-label">逐词比对 · 已统一缩写与数字</p><div class="diff">${result.diff.map(x=>`<span class="${x.type}">${esc(x.text)}</span>`).join(' ')}</div><p class="diff-legend">底色标出漏写 / 应写的词；删除线标出多写 / 写错的词。</p>`:'')+
      `<p class="feedback-label">英文原文 · 点词查义、听发音</p><div class="reference">${reference(s)}</div><p class="sentence-zh">${esc(s.zh||'这份材料暂未添加中文翻译。')}</p>`+
      `<div class="phrase-row">${relevantPhrases(s).map(p=>`<button class="phrase-chip" data-phrase="${esc(p[0])}" data-sentence="${esc(s.id)}" data-word-course="${esc(course.id)}">${esc(p[0])}</button>`).join('')}</div>`+
      (s.en.includes('160 °C')?'<p class="learning-note">160 °C 读作 one hundred and sixty degrees Celsius。截图中的 “from this process” 在这两段录音中未读出，答案按音频保留。</p>':'')+
      (s.en.includes('desalination plant')?'<p class="learning-note">留意 plant 的两种意思：grow plants 是“种植物”；desalination plant 是“海水淡化厂”。</p>':'')+
      `<button id="self-reviewed" class="quiet review-toggle">${r.reviewed?'✓ 已核对本句':'我已自己核对，记为已完成'}</button>`;
    $('self-reviewed').onclick=()=>{update({reviewed:!record().reviewed});renderSidebar();renderFeedback();};
  }
  function checkAnswer() {
    if(!$('answer').value.trim()){message('先写下你听到的内容，再来核对；也可以直接查看原文。');$('answer').focus();return;}
    if(C.tokens($('answer').value).length>1200){message('输入过长，请每次只听写当前这一句。');return;}
    message('');const result=C.compare(sentence().en,$('answer').value);
    update({answer:$('answer').value,score:result.score,reviewed:true});checked=true;revealed=true;$('reveal').setAttribute('aria-expanded','true');renderFeedback();renderSidebar();
  }
  function renderReading() {
    $('reading-content').innerHTML=course.sentences.map((s,i)=>`<article class="reading-card"><div class="reading-meta"><span>${String(i+1).padStart(2,'0')} · ${esc(s.section)}</span><span>${format(s.start)} – ${format(s.end)}</span></div><div class="reference">${reference(s)}</div><p class="sentence-zh" ${$('reading-zh').checked?'':'hidden'}>${esc(s.zh)}</p><div class="button-row"><button class="small-button" data-read-play="${i}">▶ 听这一句</button><button class="quiet" data-practice="${i}">去听写 →</button></div></article>`).join('');
  }
  function definition(text,s,c) {
    const key=C.key(text);let d=c.glossary?.[key]||data.glossary[key];
    if(key==='plant'&&/desalination plant/i.test(s?.en||''))d={pos:'n.',zh:'工厂；此处 desalination plant 指海水淡化厂'};
    if(/^\d/.test(key))d={pos:'number',zh:key.includes('°c')?'摄氏度；160 °C 读作 one hundred and sixty degrees Celsius':`数字 ${text}；听写时数字和常见英文数字写法均可。`};
    return d||{pos:'',zh:'这份材料尚未提供此词的本地释义。可打开在线词典查询。'};
  }
  function openWord(text,c,s,offset,phrase=false,savedDefinition=null) {
    const def=phrase?data.phrases.find(p=>p[0]===text):null;
    const d=savedDefinition|| (def?{pos:def[1],zh:def[2]}:definition(text,s,c));
    const key=C.key(text),saved=state.words[key]&&!state.words[key].deleted;
    let ws=s?.words?.filter(w=>w.offset>=offset&&w.offset<offset+text.length&&w.start!==null)||[];
    dictionary={text,key,c,s,offset,d,start:ws.length?Math.max(s.start,ws[0].start-.08):null,end:ws.length?Math.min(s.end,ws[ws.length-1].end+.10):null};
    $('dictionary-content').innerHTML=`<h2 id="dictionary-title" class="dict-word">${esc(text)}</h2><p class="dict-definition"><span class="dict-pos">${esc(d.pos||'词义')}</span>${esc(d.zh)}</p><div class="button-row"><button id="word-original" class="primary" ${dictionary.start===null?'disabled':''}>▶ 原音发音</button><button id="word-synth" class="secondary">设备发音</button><button id="save-word" class="secondary">${saved?'★ 已加入生词本':'☆ 加入生词本'}</button></div><p class="dict-tip">原音是本句中的声音片段，连读时可能带少量邻词。设备发音可单独读词。</p>${s?`<p class="dict-context">${esc(s.en)}</p><p class="sentence-zh">${esc(s.zh)}</p>`:''}<p class="dict-tip"><a href="https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer">在线词典查更多释义 ↗</a></p>`;
    $('word-original').onclick=()=>startClip(c,dictionary.start,dictionary.end,'word');
    $('word-synth').onclick=()=>speak(text);
    $('save-word').onclick=()=>{
      const deleted=state.words[key]&&!state.words[key].deleted;
      state.words[key]={text,pos:d.pos,zh:d.zh,context:s?.en||'',course:c.id,sentence:s?.id||'',offset,deleted:!!deleted,updated:Date.now()};save();renderSidebar();$('save-word').textContent=deleted?'☆ 加入生词本':'★ 已加入生词本';if(view==='words')renderWords();
    };
    if(!$('word-dialog').open)$('word-dialog').showModal();
  }
  function speak(text) {
    stop('设备发音中…');
    if(!('speechSynthesis'in window)){message('此浏览器不支持设备发音，请使用原音发音。');return;}
    const u=new SpeechSynthesisUtterance(text);u.lang='en-GB';u.rate=.85;
    const voices=speechSynthesis.getVoices();u.voice=voices.find(v=>v.lang==='en-GB')||voices.find(v=>v.lang.startsWith('en'))||null;
    u.onend=()=>{$('play-status').textContent='发音结束。'};u.onerror=()=>message('系统英语语音暂不可用，可听“原音发音”。');speechSynthesis.speak(u);
  }
  function renderWords() {
    const words=Object.entries(state.words).filter(([,w])=>!w.deleted).sort((a,b)=>b[1].updated-a[1].updated);
    $('saved-words').innerHTML=words.length?words.map(([k,w])=>`<article class="vocab-card"><h3>${esc(w.text)}</h3><p><span class="dict-pos">${esc(w.pos)}</span>${esc(w.zh)}</p><p>${esc(w.context)}</p><div class="button-row"><button class="small-button" data-saved-word="${esc(k)}">查看 / 发音</button><button class="quiet" data-remove-word="${esc(k)}">移出生词本</button></div></article>`).join(''):'<div class="empty"><strong>把今天的生词收进来</strong><p>核对原文后，点英文词，再点“加入生词本”。</p></div>';
  }
  function download(name,text,type='application/json;charset=utf-8') {
    const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  $('play').onclick=togglePlay;$('replay').onclick=()=>playSentence();$('check').onclick=checkAnswer;
  $('previous').onclick=()=>select(course,index-1,false);
  $('next').onclick=()=>{
    if(index<course.sentences.length-1){select(course,index+1,true);return;}
    stop('本段播放结束。');const done=course.sentences.filter(s=>record(course,s).reviewed).length;message(`已到本段最后一句。你已核对 ${done} / ${course.sentences.length} 句。可从左侧继续练习未核对的句子，或勾选“只看难句”复习。`);
  };
  $('answer').maxLength=5000;$('sentence-note').maxLength=5000;
  $('answer').addEventListener('input',()=>{update({answer:$('answer').value,reviewed:false,score:undefined});$('answer-count').textContent=`${C.lexical($('answer').value).length} 词 · 自动保存`;if(checked){checked=false;revealed=false;$('feedback').hidden=true;$('reveal').setAttribute('aria-expanded','false');}renderSidebar();});
  $('sentence-note').addEventListener('input',()=>update({note:$('sentence-note').value}));
  $('mark-hard').onclick=()=>{update({hard:!record().hard});$('mark-hard').setAttribute('aria-pressed',String(record().hard));$('mark-hard').textContent=record().hard?'★ 已标记难句':'☆ 标记难句';renderSidebar();};
  $('show-translation').onclick=()=>{translation=!translation;$('translation-hint').textContent=sentence().zh||'这份材料暂未添加中文。';$('translation-hint').hidden=!translation;$('show-translation').setAttribute('aria-expanded',String(translation));};
  $('show-initials').onclick=()=>{initials=!initials;$('initial-hint').textContent=sentence().words.map(w=>/^\d/.test(w.text)?w.text:w.text[0]+'＿'.repeat(Math.min(8,w.text.length-1))).join('  ');$('initial-hint').hidden=!initials;$('show-initials').setAttribute('aria-expanded',String(initials));};
  $('reveal').onclick=()=>{revealed=!revealed;$('reveal').setAttribute('aria-expanded',String(revealed));if(revealed)renderFeedback();else $('feedback').hidden=true;};
  for(const name of ['speed','repeat','gap']){$(name).value=String(state.settings[name]);$(name).onchange=()=>{state.settings[name]=+$(name).value;save();if(name==='speed'){audio.playbackRate=state.settings.speed;scheduleBoundary(playToken);}else if(active)stop('设置已更新，点击播放本句。');};}
  $('seek').oninput=()=>{const [a,b]=bounds(),wasPlaying=playing;const t=a+(b-a)*+$('seek').value/1000;stop('已调整到本句中的位置。');pausedAt=t;paintPosition();if(wasPlaying)playSentence(t);};
  $('only-hard').onchange=renderSidebar;$('reading-zh').onchange=renderReading;
  $('apply-timing').onclick=()=>{const start=+$('clip-start').value,end=+$('clip-end').value;if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>course.duration){message(`请输入有效起止时间，范围为 0–${course.duration.toFixed(2)} 秒。`);return;}update({timing:[start,end]});message('本句切分已保存。');playSentence();};
  $('reset-timing').onclick=()=>{stop();update({timing:undefined});$('clip-start').value=sentence().start.toFixed(2);$('clip-end').value=sentence().end.toFixed(2);paintPosition();message('已恢复本句的原始切分。');};
  $('close-word').onclick=()=>{$('word-dialog').close();stop('准备好，可以继续。');};
  $('word-dialog').addEventListener('cancel',()=>stop('准备好，可以继续。'));
  document.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.view)setView(b.dataset.view);
    if(b.dataset.course)select(courses.find(c=>c.id===b.dataset.course),0);
    if(b.dataset.jump!==undefined){select(course,+b.dataset.jump);setView('practice');}
    if(b.dataset.practice!==undefined){select(course,+b.dataset.practice);setView('practice');}
    if(b.dataset.readPlay!==undefined){const s=course.sentences[+b.dataset.readPlay];const [a,z]=bounds(course,s);startClip(course,a,z,'reading');}
    if(b.dataset.word||b.dataset.phrase){const c=courses.find(c=>c.id===b.dataset.wordCourse),s=c?.sentences.find(s=>s.id===b.dataset.sentence);if(!c||!s)return;const text=b.dataset.word||b.dataset.phrase,offset=b.dataset.phrase?C.key(s.en).indexOf(C.key(text)):+b.dataset.offset;openWord(text,c,s,offset,!!b.dataset.phrase);}
    if(b.dataset.savedWord){const w=state.words[b.dataset.savedWord],c=courses.find(c=>c.id===w.course)||course,s=c.sentences.find(s=>s.id===w.sentence);openWord(w.text,c,s,w.offset,data.phrases.some(p=>p[0]===w.text),{pos:w.pos,zh:w.zh});}
    if(b.dataset.removeWord){state.words[b.dataset.removeWord].deleted=true;state.words[b.dataset.removeWord].updated=Date.now();save();renderWords();renderSidebar();}
  });
  document.addEventListener('keydown',e=>{
    if($('word-dialog').open)return;
    if(view!=='practice')return;
    if(e.altKey&&e.code==='Space'){e.preventDefault();playSentence();}
    if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();checkAnswer();}
    if(e.altKey&&e.key==='ArrowRight'){e.preventDefault();$('next').click();}
    if(e.altKey&&e.key==='ArrowLeft'){e.preventDefault();if(index>0)$('previous').click();}
  });
  $('export-progress').onclick=()=>{save(true);download(`启航精听进度-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2));message('进度备份已生成。请保存到“文件”，可在其他设备导入。');};
  $('import-progress').onchange=async()=>{
    const file=$('import-progress').files[0];if(!file)return;
    try{if(file.size>20000000)throw Error('备份文件过大。');const incoming=cleanState(JSON.parse(await file.text()));for(const kind of ['records','words'])for(const [k,v]of Object.entries(incoming[kind]))if(!state[kind][k]||v.updated>state[kind][k].updated)state[kind][k]=v;save(true);stop();renderSidebar();renderPractice();renderWords();message('进度已合并；较新的记录已保留。');}catch(e){message('导入失败：'+e.message);}finally{$('import-progress').value='';}
  };
  $('export-words').onclick=()=>{const words=Object.values(state.words).filter(w=>!w.deleted);if(!words.length){message('先收藏几个单词，再导出生词本。');return;}const cell=s=>'"'+String(s).replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';download('启航精听生词本.csv','\uFEFF'+[['英文','词性','中文','原句'],...words.map(w=>[w.text,w.pos,w.zh,w.context])].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');};
  $('download-template').onclick=()=>download('精听课程示例.json',JSON.stringify({title:'我的新精听',sentences:[{start:0.5,end:3,en:'This is an example.',zh:'这是一个例子。',section:'第一段'}],glossary:{example:{pos:'n.',zh:'例子；实例'}}},null,2));
  $('import-lesson').onclick=async()=>{
    const af=$('new-audio').files[0],sf=$('new-subtitles').files[0];if(!af||!sf){message('请同时选择音频和 SRT / JSON 文本。');return;}
    const button=$('import-lesson');button.disabled=true;let url='';
    try{
      if(sf.size>5000000)throw Error('字幕文件不能超过 5 MB。');
      const text=await sf.text(),raw=sf.name.toLowerCase().endsWith('.srt')?{sentences:C.parseSrt(text)}:JSON.parse(text);
      url=URL.createObjectURL(af);const probe=new Audio();probe.preload='metadata';
      const duration=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{probe.removeAttribute('src');probe.load();reject(Error('音频读取超时，请换用 MP3。'));},15000);probe.onloadedmetadata=()=>{clearTimeout(timer);resolve(probe.duration);};probe.onerror=()=>{clearTimeout(timer);reject(Error('浏览器无法读取此音频，请换用 MP3。'));};probe.src=url;});
      probe.removeAttribute('src');probe.load();
      if(!Number.isFinite(duration))throw Error('无法读取音频时长。');
      const sentences=C.validateSentences(raw.sentences,duration);
      let hash=2166136261;for(const ch of af.name+af.size+JSON.stringify(sentences.map(s=>[s.en,s.start,s.end])))hash=Math.imul(hash^ch.charCodeAt(0),16777619)>>>0;
      const id='custom-'+hash.toString(16),old=courses.findIndex(c=>c.id===id),glossary={};
      if(raw.glossary&&typeof raw.glossary==='object')for(const [k,v]of Object.entries(raw.glossary).slice(0,10000))if(validKey(k)&&v&&typeof v.zh==='string')glossary[C.key(k)]={pos:String(v.pos||'').slice(0,100),zh:v.zh.slice(0,1000)};
      const c={id,code:'NEW',title:String(raw.title||sf.name.replace(/\.[^.]+$/,'')).slice(0,80),duration,audio:url,sentences,glossary};
      stop();if(old>=0){URL.revokeObjectURL(courses[old].audio);courses[old]=c;loadedId='';}else courses.push(c);
      select(c,0);setView('practice');message(`已载入 ${sentences.length} 句。新增材料刷新后需要重新选择；本次听写记录会自动保存。`);
    }catch(e){if(url)URL.revokeObjectURL(url);message('载入失败：'+e.message);}finally{button.disabled=false;}
  };
  loadAudio(course);renderSidebar();renderPractice();
  if(!storageOK)message('当前浏览器的保存功能可能受限。练习结束后请导出进度备份。');
})();
