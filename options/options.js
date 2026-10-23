(() => {
  'use strict';
  const api=globalThis.browser||globalThis.chrome;
  const ids=document.getElementById('ids');
  const theme=document.getElementById('theme');
  const output=document.getElementById('message');
  const THEMES=new Set(['system','light','dark']);
  const GRANTS='chatqueue:api-grants:v2';
  const SCOPES=new Set(['discover','read','append','edit','control','rules']);
  const ID=/^[a-zA-Z0-9_.@-]{4,160}$/;
  api.storage.local.get(['allowedExtensionIds',GRANTS,'chatqueue:settings:v1']).then(data=>{
    const grants=data[GRANTS]?.version===2?data[GRANTS].grants:null;
    ids.value=grants&&typeof grants==='object'?
      Object.entries(grants).map(([id,scopes])=>`${id} | ${Array.isArray(scopes)?scopes.join(','):''}`).join('\n'):'';
    if(!grants&&Array.isArray(data.allowedExtensionIds)&&data.allowedExtensionIds.length)
      output.textContent='The legacy broad allowlist is inactive. Reauthorize desired extension IDs with explicit scopes.';
    const chosen=data['chatqueue:settings:v1']?.theme;
    theme.value=THEMES.has(chosen)?chosen:'system';
    document.documentElement.dataset.theme=theme.value;
  }).catch(()=>{output.textContent='Could not load saved preferences';});
  theme.addEventListener('change',async()=>{
    if(!THEMES.has(theme.value))return;
    document.documentElement.dataset.theme=theme.value;
    try{await api.storage.local.set({'chatqueue:settings:v1':{theme:theme.value}});}
    catch{output.textContent='Could not save theme preference';}
  });
  api.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes['chatqueue:settings:v1'])return;
    const chosen=changes['chatqueue:settings:v1'].newValue?.theme;
    theme.value=THEMES.has(chosen)?chosen:'system';
    document.documentElement.dataset.theme=theme.value;
  });
  document.getElementById('save').addEventListener('click',async()=>{
    const lines=ids.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(lines.length>20){output.textContent='At most 20 extension grants are supported.';return;}
    const grants=Object.create(null);
    for(const line of lines){
      const parts=line.split('|');
      const id=parts[0]?.trim();
      const scopes=parts[1]?.split(',').map(x=>x.trim());
      if(parts.length!==2||!ID.test(id)||Object.hasOwn(grants,id)||
         !Array.isArray(scopes)||!scopes.length||
         scopes.some(scope=>!SCOPES.has(scope))||new Set(scopes).size!==scopes.length){
        output.textContent='Use one unique valid ID | comma-separated scopes per line.';return;
      }
      grants[id]=scopes;
    }
    try{
      await api.storage.local.set({[GRANTS]:{version:2,grants}});
      // Old broad permissions are no longer consulted, even if cleanup fails.
      await api.storage.local.remove('allowedExtensionIds').catch(()=>{});
      output.textContent=`Saved ${lines.length} scoped extension grant(s).`;
    }
    catch{output.textContent='Could not save permissions';}
  });
})();
