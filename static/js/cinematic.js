(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = '/api/workflow/cinematic';
  let project, projectId = null, dirty = false;
  const defaults = () => ({title:'My cinematic project',kind:'music_video',aspect_ratio:'16:9',preset:'cinema',script:'',continuity:'',characters:[],scenes:[]});
  const message = text => { $('status').textContent = text; };
  function changed() { dirty = true; message('Unsaved changes'); }
  async function api(path, method = 'GET', data) {
    const response = await fetch(base + path, {method, headers:{'X-App-Token':window.__APP_TOKEN__, 'Content-Type':'application/json'}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail || error)); }
    return response.json();
  }
  function action(id, fn) { $(id).onclick = async () => { $(id).disabled = true; try { await fn(); } catch(e) { message(e.message); } finally { $(id).disabled = false; } }; }
  function field(parent, labelText, object, key, multiline = false, onChange) {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement(multiline ? 'textarea' : 'input'); input.value = object[key] ?? '';
    input.oninput = () => { object[key] = input.value; changed(); if (onChange) onChange(); };
    label.append(input); parent.append(label); return input;
  }
  function select(parent, labelText, object, key, values) {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('select');
    values.forEach(([value,text]) => { const option = new Option(text,value); input.add(option); });
    input.value = object[key]; input.onchange = () => { object[key] = input.value; changed(); timeline(); };
    label.append(input); parent.append(label);
  }
  function timeline() { $('timeline').textContent = `${project.scenes.length} scenes · ${project.scenes.reduce((n,s)=>n+Number(s.duration || 0),0).toFixed(1)} seconds planned · ${project.scenes.filter(s=>s.timing==='verified').length} scenes marked verified`; }
  function render() {
    ['title','kind','aspect_ratio','preset','script','continuity'].forEach(key => { $(key).value = project[key]; $(key).oninput = () => { project[key] = $(key).value; changed(); }; });
    $('characters').replaceChildren(); $('scenes').replaceChildren();
    project.characters.forEach(character => {
      const box = document.createElement('div'); box.className = 'character';
      field(box,'Name',character,'name',false,renderScenes);
      field(box,'Identity lock — face, age, build',character,'identity',true);
      field(box,'Wardrobe',character,'wardrobe'); field(box,'Reference filename or URL (planning only)',character,'reference');
      const remove = document.createElement('button'); remove.textContent = 'Remove character';
      remove.onclick = () => { project.characters = project.characters.filter(c=>c.id!==character.id); project.scenes.forEach(s=>{s.characters=s.characters.filter(id=>id!==character.id);}); changed(); render(); };
      box.append(remove); $('characters').append(box);
    });
    renderScenes();
  }
  function renderScenes() {
    $('scenes').replaceChildren();
    project.scenes.forEach((scene,index) => {
      const box = document.createElement('article'); box.className='scene'; box.dataset.id=scene.id;
      const checkLabel=document.createElement('label'); checkLabel.className='check';
      const check=document.createElement('input'); check.type='checkbox'; check.className='scene-select'; check.checked=true; check.value=scene.id;
      checkLabel.append(check,document.createTextNode(`SC${String(index+1).padStart(3,'0')}`)); box.append(checkLabel);
      field(box,'Scene title',scene,'title'); field(box,'Action / emotional beat',scene,'description',true);
      field(box,'Location',scene,'location');
      const duration=field(box,'Planned duration (seconds)',scene,'duration',false,timeline); duration.type='number'; duration.min='0.1'; duration.max='600'; duration.step='0.1';
      duration.oninput=()=>{scene.duration=Number(duration.value);changed();timeline();};
      select(box,'Timing confidence',scene,'timing',[['draft','Draft — unverified'],['verified','Verified against source audio']]);
      project.characters.forEach(c=>{
        const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.checked=scene.characters.includes(c.id);
        input.onchange=()=>{scene.characters=input.checked?[...scene.characters,c.id]:scene.characters.filter(id=>id!==c.id);changed();};label.append(input,document.createTextNode(c.name));box.append(label);
      });
      field(box,'Camera / framing / movement',scene,'camera'); field(box,'Continuity into next scene',scene,'continuity',true);
      const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Prompt overrides and media references';details.append(summary);
      field(details,'Image prompt override (blank = preset + character + scene notes)',scene,'image_prompt',true);
      field(details,'Video prompt override (blank = preset + character + scene notes)',scene,'video_prompt',true);
      field(details,'Uploaded keyframe provider media_id (for image-to-video)',scene,'media_id');
      field(details,'Chosen image asset filename or URL',scene,'image_asset');field(details,'Chosen video asset filename or URL',scene,'video_asset');box.append(details);
      const controls=document.createElement('div');controls.className='toolbar';
      [['Move up',-1],['Move down',1],['Remove',0]].forEach(([text,offset])=>{const button=document.createElement('button');button.textContent=text;button.disabled=(offset===-1&&index===0)||(offset===1&&index===project.scenes.length-1);button.onclick=()=>{if(offset){[project.scenes[index],project.scenes[index+offset]]=[project.scenes[index+offset],project.scenes[index]];}else{project.scenes.splice(index,1);}changed();renderScenes();};controls.append(button);});
      box.append(controls);$('scenes').append(box);
    });timeline();
  }
  function addScene(description='') { project.scenes.push({id:crypto.randomUUID(),title:`Scene ${project.scenes.length+1}`,description,duration:8,timing:'draft',characters:[],location:'',camera:'Slow, steady push-in',continuity:'',image_prompt:'',video_prompt:'',media_id:'',image_asset:'',video_asset:''}); }
  async function refresh() { const rows=await api('/projects');$('projects').replaceChildren(new Option('Select a saved project',''));rows.forEach(p=>$('projects').add(new Option(`${p.title} (${p.scenes})`,p.id)));if(projectId)$('projects').value=projectId; }
  async function save() { const result=await api('/projects'+(projectId?'/'+projectId:''),projectId?'PUT':'POST',project);projectId=result.id;project=result.project;dirty=false;await refresh();message('Project saved.'); }
  function download(content,name,type) { const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  action('save',save);
  action('new',async()=>{if(dirty&&!confirm('Discard unsaved changes?'))return;project=defaults();projectId=null;dirty=false;render();message('New project.');});
  action('open',async()=>{const id=$('projects').value;if(!id)return;if(dirty&&!confirm('Discard unsaved changes?'))return;const result=await api('/projects/'+id);project=result.project;projectId=result.id;dirty=false;render();message('Project opened.');});
  action('add-character',async()=>{project.characters.push({id:crypto.randomUUID(),name:'New character',identity:'',wardrobe:'',reference:''});changed();render();});
  action('add-scene',async()=>{addScene();changed();renderScenes();});
  action('split',async()=>{const paragraphs=project.script.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);if(!paragraphs.length)throw new Error('Enter lyrics or script first.');if(project.scenes.length+paragraphs.length>500)throw new Error('Maximum 500 scenes per project.');paragraphs.forEach(addScene);changed();renderScenes();});
  $('import').onclick=()=>$('file').click();
  $('file').onchange=async()=>{try{if(!$('file').files[0])return;if(dirty&&!confirm('Discard unsaved changes?'))return;const candidate=JSON.parse(await $('file').files[0].text());const result=await api('/projects','POST',candidate);project=result.project;projectId=result.id;dirty=false;render();await refresh();message('Imported as a new saved project.');}catch(e){message('Import failed: '+e.message);}finally{$('file').value='';}};
  document.querySelectorAll('[data-export]').forEach(button=>{button.onclick=async()=>{try{await save();const format=button.dataset.export;const response=await fetch(`${base}/projects/${projectId}/export/${format}`,{headers:{'X-App-Token':window.__APP_TOKEN__}});if(!response.ok)throw new Error('Export failed');download(await response.text(),`cinematic-project.${format==='prompts'?'md':format}`,response.headers.get('Content-Type'));message('Export ready.');}catch(e){message(e.message);}};});
  action('graph',async()=>{const ids=Array.from(document.querySelectorAll('.scene-select:checked')).map(e=>e.value);if(!ids.length)throw new Error('Select at least one scene.');await save();const result=await api(`/projects/${projectId}/graph`,'POST',{stage:$('stage').value,scene_ids:ids});$('output').textContent=result.note;download(JSON.stringify(result.workflow,null,2),'cinematic-workflow.json','application/json');message('Workflow exported; no generation started.');});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  project=defaults();render();refresh().catch(e=>message(e.message));
})();
