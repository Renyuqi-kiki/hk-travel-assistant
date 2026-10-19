'use strict';
import {readSavedPlan, savePlan, clearPlan} from './plan-storage.mjs';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {places: [], status: {}, plan: null, must: new Set(), sources: [], busy: new Set()};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sourceURL = value => {try {const u = new URL(value); return u.protocol === 'https:' ? esc(u.href) : '#';} catch {return '#';}};
const mapsURL = p => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('香港 ' + p.name);
let toastTimer, searchTimer, libraryRequest = 0;

function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 3200);
}
function switchView(name) {
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + name));
  $$('.tab').forEach(el => {el.classList.toggle('active', el.dataset.view === name); if(el.dataset.view === name) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');});
}
async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
  try {
    const res = await fetch(path, {method: body ? 'POST':'GET', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal:controller.signal});
    if (!res.ok) {
      let obj = {}; try {obj = await res.json();} catch {}
      throw new Error(typeof obj.detail === 'string' ? obj.detail : '输入无效或服务暂不可用，请检查条件后重试。');
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('等待时间过长，请检查本地服务后重试。');
    if (err instanceof TypeError) throw new Error('无法连接本地服务，请检查终端中的应用是否仍在运行。');
    throw err;
  } finally {clearTimeout(timer);}
}
const loading = text => `<div class="loading" role="status"><span class="spinner"></span><span>${esc(text)}</span></div>`;
const errorHTML = text => `<div class="error" role="alert">${esc(text)}</div>`;

function addMust(id) {
  if (state.must.has(id)) {state.must.delete(id); toast('已从必去地点移除');}
  else if (state.must.size >= 3) {toast('最多选 3 个必去地点，请先移除一个'); return;}
  else {state.must.add(id); toast('已加入必去地点，可在“排个行程”查看');}
  syncMust();
}
function syncMust() {
  [...$('#must-visit').options].forEach(opt => opt.selected = state.must.has(opt.value));
  $$('[data-action="must"]').forEach(btn => {btn.textContent = state.must.has(btn.dataset.id) ? '已加入 ✓' : '加入必去 +'; btn.setAttribute('aria-pressed',state.must.has(btn.dataset.id));});
}
function card(p, i) {
  return `<article class="place-card"><div class="card-top"><span class="subtle">${esc(p.region)} / ${esc(p.area)}</span><span class="card-number">${String(i+1).padStart(2,'0')}</span></div><h3>${esc(p.name)}</h3><span class="card-en">${esc(p.en)}</span><div class="tags">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}<span class="tag">${p.kind === 'food' ? '餐饮候选' : p.indoor ? '有室内空间':'露天为主'}</span></div><p>${esc(p.summary)}</p><div class="card-actions"><button class="text-button" data-action="detail" data-id="${esc(p.id)}">查看详情 ↗</button><button class="small-button" data-action="must" data-id="${esc(p.id)}" aria-pressed="${state.must.has(p.id)}">${state.must.has(p.id)?'已加入 ✓':'加入必去 +'}</button><a href="${sourceURL(p.source)}" target="_blank" rel="noopener noreferrer">官方来源 ↗</a></div>${p.match_reason ? `<div class="match-note">${esc(p.match_reason)}</div>`:''}</article>`;
}
function traceHTML(trace) {
  return `<details class="trace"><summary>查看这次工具调用 · MCP 真实通信记录</summary>${trace.map(t => `<code>${esc(t.server)} · ${esc(t.transport)} · ${esc(t.elapsed_ms)} ms\n${esc(t.steps.join(' → '))}\n参数：${esc(JSON.stringify(t.arguments,null,2))}\n状态：${esc(t.status)}；高德实时调用：${t.live_amap ? '是':'否'}</code>`).join('')}</details>`;
}
function answerHTML(data) {
  let text = esc(data.answer.text);
  const valid = new Set(data.answer.citations);
  text = text.replace(/\[([a-z0-9-]+)\]/g, (all,id) => valid.has(id) ? `<button class="inline-citation" data-action="detail" data-id="${esc(id)}" aria-label="查看引用 ${esc(id)}">出处 ↗</button>`:all);
  return `<div class="panel"><div class="answer-head"><h3>${data.answer.mode === 'model' ? '为你整理的回答':'从资料里找到的线索'}</h3><span class="badge">${esc(data.answer.notice)}</span></div><div class="answer-text">${text}</div>${data.sources.length ? `<div class="source-label">这次回答的资料来源 · ${data.sources.length} 个地点</div><div class="source-grid">${data.sources.map(card).join('')}</div>`:''}${traceHTML(data.trace)}</div>`;
}
async function ask(event) {
  event?.preventDefault();
  if(state.busy.has('ask')) return;
  const question = $('#question').value.trim();
  if(question.length < 2) {toast('先输入至少两个字的问题'); return;}
  state.busy.add('ask'); $('#ask-submit').disabled = true;
  $('#ask-result').innerHTML = loading($('#use-model').checked ? '先查找资料，再请模型整理回答……' : '正在查找香港资料，并整理相关出处……');
  try {
    const data = await api('/api/ask', {question,region:$('#ask-region').value,indoor_only:$('#ask-indoor').checked,use_model:$('#use-model').checked});
    state.sources = data.sources; $('#ask-result').innerHTML = answerHTML(data);
  } catch (err) {$('#ask-result').innerHTML = errorHTML(err.message);}
  finally {state.busy.delete('ask'); $('#ask-submit').disabled = false;}
}
function mapHTML(plan) {
  const points = plan.days.flatMap(day => day.stops.map(stop => ({...stop.place,day:day.day})));
  if(!points.length) return '';
  const minLon = Math.min(...points.map(p=>p.lon))-.012, maxLon=Math.max(...points.map(p=>p.lon))+.012;
  const minLat = Math.min(...points.map(p=>p.lat))-.009, maxLat=Math.max(...points.map(p=>p.lat))+.009;
  const pos = p => [55+(p.lon-minLon)/(maxLon-minLon)*510,220-(p.lat-minLat)/(maxLat-minLat)*170];
  const grid = Array.from({length:5},(_,i)=>`<path d="M55 ${50+i*42.5}H565 M${55+i*127.5} 50V220" stroke="#d6dfcf" stroke-width="1"/>`).join('');
  const lines = plan.days.map(d=>`<polyline points="${d.stops.map(s=>pos(s.place).join(',')).join(' ')}" fill="none" stroke="#9cae98" stroke-width="1.5" stroke-dasharray="4 5"/>`).join('');
  const circles = points.map((p,i)=>{const [x,y]=pos(p);return `<g><title>${esc(p.name)}</title><circle class="point" cx="${x}" cy="${y}" r="11"/><text class="point-num" x="${x}" y="${y+3.5}">${i+1}</text></g>`;}).join('');
  return `<div class="map-panel"><h3>这一程，在香港的哪里</h3><p class="fine-print">方位示意 · 人工近似坐标 · 虚线表示游览顺序，不是导航路线</p><svg viewBox="0 0 620 260" role="img" aria-label="行程地点方位示意图">${grid}<text x="55" y="30" class="map-label">北 ↑</text><text x="565" y="243" class="map-label" text-anchor="end">东 →</text>${lines}${circles}</svg><div class="tags">${points.map((p,i)=>`<button class="small-button" data-action="detail" data-id="${esc(p.id)}">${i+1} ${esc(p.name)}</button>`).join('')}</div></div>`;
}
function planHTML(plan) {
  return `<div class="plan-tools"><h3>你的 ${plan.days.length} 天香港草案</h3><div><button class="small-button" data-action="download">下载行程 ↓</button> <button class="small-button" data-action="clear-plan">清除</button></div></div>${mapHTML(plan)}${plan.days.map(day=>`<article class="day-card"><div class="day-heading"><span class="day-num">${String(day.day).padStart(2,'0')}</span><div><h3>${esc(day.title)}</h3><p>${day.stops.length} 个停留点 · 预计 ${esc(day.end)} 结束 · 转场估算共 ${esc(day.transfer_minutes)} 分钟</p></div></div>${day.stops.map((stop,i)=>`<div class="stop"><div class="stop-time">${esc(stop.start)}<br>— ${esc(stop.end)}</div><div class="stop-content"><h4>${esc(stop.place.name)}</h4><p>${esc(stop.place.summary)}</p>${stop.free_before_minutes ? `<p class="fine-print">此站前留有 ${esc(stop.free_before_minutes)} 分钟自由活动时间，便于衔接傍晚安排；可自行调整。</p>` : ""}<button class="text-button" data-action="detail" data-id="${esc(stop.place.id)}">详情与出处 ↗</button>${day.legs[i] ? `<div class="leg">↓ 下一站：${esc(day.legs[i].mode)}约 ${esc(day.legs[i].minutes)} 分钟（非实时）</div>`:''}</div></div>`).join('')}<p class="fine-print">${esc(day.meal_note)}</p></article>`).join('')}<div class="plan-notes">${plan.warnings.map(w=>`<p>· ${esc(w)}</p>`).join('')}</div>${traceHTML(plan.trace)}`;
}
async function createPlan(event) {
  event.preventDefault(); if(state.busy.has('plan')) return;
  state.must = new Set([...$('#must-visit').selectedOptions].map(opt=>opt.value));
  const input={days:Number($('#days').value),region:$('#plan-region').value,interests:$$('#interest-options input:checked').map(i=>i.value),pace:$('input[name="pace"]:checked').value,rain:$('#rain').checked,public_only:$('#public-only').checked,must_visit:[...state.must]};
  state.busy.add('plan'); $('#plan-submit').disabled=true; $('#plan-result').innerHTML=loading('正在按街区安排地点，预留停留与转场时间……');
  try {
    const plan=await api('/api/plan',input); state.plan=plan;
    $('#plan-result').innerHTML=planHTML(plan);
    try{if(!savePlan(localStorage,state.status.knowledge_version,plan,input))toast('行程已生成，但浏览器未能保存；请及时下载。');}
    catch{toast('行程已生成，浏览器存储不可用；请及时下载。');}
  } catch(err){$('#plan-result').innerHTML=errorHTML(err.message);}
  finally{state.busy.delete('plan');$('#plan-submit').disabled=false;}
}
function downloadPlan() {
  if(!state.plan)return;
  const plan=state.plan;
  const lines=['港慢游｜香港旅行草案','本地资料演示；未核验实时交通、天气、营业与票务。',''];
  for(const day of plan.days) {
    lines.push(`第 ${day.day} 天｜${day.title}`);
    day.stops.forEach((s,i)=>{if(s.free_before_minutes)lines.push(`此站前自由活动约 ${s.free_before_minutes} 分钟`);lines.push(`${s.start}–${s.end} ${s.place.name}`,s.place.summary,`来源：${s.place.source}`);if(day.legs[i])lines.push(`下一站：${day.legs[i].mode}约 ${day.legs[i].minutes} 分钟（估算）`);lines.push('');});
    lines.push(day.meal_note,'');
  }
  lines.push('出发前核对',...plan.warnings.map(w=>'· '+w),'',`资料版本：${state.status.knowledge_version}`,`规划方法：${plan.algorithm}`);
  const blob=new Blob(['\ufeff'+lines.join('\n')],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');a.href=url;a.download='港慢游_香港行程.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('行程已导出为文本文件');
}
function showDetail(id) {
  const p=state.places.find(p=>p.id===id); if(!p)return;
  $('#detail-content').innerHTML=`<span class="eyebrow">${esc(p.region)} / ${esc(p.area)}</span><h2>${esc(p.name)}</h2><span class="card-en">${esc(p.en)}</span><div class="tags">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><p>${esc(p.summary)}</p><p class="tip">${esc(p.tip)}</p><p class="fine-print">建议停留 ${esc(p.duration)} 分钟，为本项目规划假设。资料摘要核对日 ${esc(p.checked)}，不代表营业、票价和活动实时有效。</p><div class="detail-actions"><a href="${sourceURL(p.source)}" target="_blank" rel="noopener noreferrer">官方资料 ↗</a><a href="${esc(mapsURL(p))}" target="_blank" rel="noopener noreferrer">在地图中查找 ↗</a><button class="small-button" data-action="must" data-id="${esc(p.id)}">${state.must.has(p.id)?'已加入 ✓':'加入必去 +'}</button><button class="small-button" data-action="amap" data-id="${esc(p.id)}">高德查询${state.status.amap_configured?'':' · 待配置'}</button></div><div id="amap-result"></div>`;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
async function searchAmap(id,btn) {
  btn.disabled=true; $('#amap-result').innerHTML=loading('检查高德服务配置……');
  try{const res=await api('/api/amap/search',{place_id:id});$('#amap-result').innerHTML=`<p class="fine-print">${esc(res.message)}</p>${res.results ? `<pre>${esc(JSON.stringify(res.results,null,2))}</pre>`:''}`;}
  catch(err){$('#amap-result').innerHTML=errorHTML(err.message);}
  finally{btn.disabled=false;}
}
async function filterLibrary() {
  const request = ++libraryRequest;
  try{const params=new URLSearchParams({q:$('#place-search').value,region:$('#library-region').value});const res=await api('/api/places?'+params);if(request!==libraryRequest)return;$('#place-grid').innerHTML=res.places.length?res.places.map(card).join(''):'<div class="empty">暂未找到相关地点，试试其他关键词或地区。</div>';$('#library-count').textContent=`${res.places.length} 个结果`;}
  catch(err){if(request===libraryRequest)$('#place-grid').innerHTML=errorHTML(err.message);}
}
function statusHTML(s) {
  return `<div class="status-card"><h3>本地资料与 MCP</h3><span class="badge">已提供 · 无需密钥</span><p>${s.place_count} 条地点资料。问答与规划使用真正的 stdio 协议调用本地工具，调用记录可展开查看。</p></div><div class="status-card"><h3>大模型回答</h3><span class="badge">${s.model_configured?'已配置 · 可手动开启':'尚未配置'}</span><p>当前${s.model_configured?'可开启基于检索片段的模型回答。':'使用资料摘录回答，未调用大模型。'}接入后会校验引用编号，失败时退回本地摘录。</p></div><div class="status-card"><h3>高德地图 MCP</h3><span class="badge">${s.amap_configured?'已配置 · 待实际查询确认':'尚未配置'}</span><p>已实现官方 Streamable HTTP 客户端。需要 Key 后才能查询真实地点；未配置时不会伪造高德返回。</p></div>`;
}
function restorePlan() {
  try {
    const saved=readSavedPlan(localStorage,state.status.knowledge_version,state.places,state.status.interests);
    if(!saved)return;
    state.plan=saved.plan;
    $('#plan-result').innerHTML=planHTML(saved.plan);
    const v=saved.input;$('#days').value=v.days;$('#plan-region').value=v.region;
    $$('input[name="pace"]').forEach(el=>el.checked=el.value===v.pace);
    $$('#interest-options input').forEach(el=>el.checked=v.interests.includes(el.value));
    $('#rain').checked=v.rain;$('#public-only').checked=v.public_only;state.must=new Set(v.must_visit);syncMust();
  }catch{ /* 浏览器禁用存储时仍可重新生成。 */ }
}
async function init() {
  try {
    const [status,data]=await Promise.all([api('/api/status'),api('/api/places')]);
    state.status=status;state.places=data.places;
    $('#place-count').textContent=status.place_count;$('#data-version').textContent=status.knowledge_version;
    $('#status-grid').innerHTML=statusHTML(status);
    $('#interest-options').innerHTML=status.interests.map(t=>`<label><input type="checkbox" value="${esc(t)}" ${['海港夜景','本地美食'].includes(t)?'checked':''}><span>${esc(t)}</span></label>`).join('');
    $('#must-visit').innerHTML=state.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.region)}</option>`).join('');
    $('#place-grid').innerHTML=state.places.map(card).join('');$('#library-count').textContent=`${data.places.length} 个地点`;
    $('#use-model').disabled=!status.model_configured;$('#model-hint').textContent=status.model_configured?'可开启':'待配置';
    restorePlan();
  }catch(err){$('#ask-result').innerHTML=errorHTML(err.message);}
}
document.addEventListener('click',event=>{
  const tab=event.target.closest('[data-view]');if(tab){switchView(tab.dataset.view);return;}
  const suggestion=event.target.closest('[data-question]');if(suggestion){$('#question').value=suggestion.dataset.question;ask();return;}
  const btn=event.target.closest('[data-action]');if(!btn)return;
  if(btn.dataset.action==='must')addMust(btn.dataset.id);
  if(btn.dataset.action==='detail')showDetail(btn.dataset.id);
  if(btn.dataset.action==='download')downloadPlan();
  if(btn.dataset.action==='amap')searchAmap(btn.dataset.id,btn);
  if(btn.dataset.action==='clear-plan'){state.plan=null;try{clearPlan(localStorage);}catch{}$('#plan-result').innerHTML='<div class="plan-placeholder"><div class="large-mark">慢</div><h3>重新出发。</h3><p>调整偏好，再排一段新的旅程。</p></div>';}
});
$('#ask-form').addEventListener('submit',ask);$('#plan-form').addEventListener('submit',createPlan);
$('#must-visit').addEventListener('change',()=>{const selected=[...$('#must-visit').selectedOptions].map(o=>o.value);if(selected.length>3){toast('最多选择 3 个必去地点');syncMust();return;}state.must=new Set(selected);syncMust();});
$('#close-dialog').addEventListener('click',()=>$('#detail-dialog').close());
$('#detail-dialog').addEventListener('click',e=>{if(e.target===$('#detail-dialog')){const r=$('#detail-dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#detail-dialog').close();}});
$('#place-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(filterLibrary,250);});
$('#library-region').addEventListener('change',filterLibrary);
init();
