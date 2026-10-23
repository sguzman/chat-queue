(() => {
  'use strict';
  const api=globalThis.browser||globalThis.chrome;
  const ids=document.getElementById('ids');
  const theme=document.getElementById('theme');
  const output=document.getElementById('message');
  const THEMES=new Set(['system','light','dark']);
  api.storage.local.get(['allowedExtensionIds','chatqueue:settings:v1']).then(data=>{
    ids.value=Array.isArray(data.allowedExtensionIds)?data.allowedExtensionIds.join('\n'):'';
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
    const list=[...new Set(ids.value.split(/\r?\n/).map(id=>id.trim()).filter(Boolean))];
    if(list.length>20||list.some(id=>!/^[a-zA-Z0-9_.@-]{4,160}$/.test(id))){
      output.textContent='Use up to 20 valid extension IDs.';return;
    }
    try{await api.storage.local.set({allowedExtensionIds:list});output.textContent=`Saved ${list.length} approved ID(s).`;}
    catch{output.textContent='Could not save permissions';}
  });
})();
