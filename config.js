// Isolated-world admission is a UI hint. Every worker operation rechecks MAIN independently.
(() => {
  'use strict';
  globalThis.VkAudioPrototypeConfig = Object.freeze({ accountMode: 'own-data-descriptors' });
  globalThis.VkWorkingAccount = Object.freeze({allowed:false,code:'ACCOUNT_UNKNOWN',accountId:null,libraryOwnerId:null});
  let polling=false, previous='', notice=null, generation=0;
  function paint(value) {
    let page; try { page=new URL(location.href); } catch { return; }
    const library=page.origin==='https://vk.ru' && /^\/audios[1-9]\d*$/.test(page.pathname);
    if(!library || value.allowed) { notice?.remove(); notice=null; return; }
    if(!notice?.isConnected) {
      notice=document.createElement('aside'); notice.setAttribute('data-vkdl-ui',''); notice.setAttribute('data-vkdl-account-blocked','');
      notice.style.cssText='position:fixed;bottom:12px;left:12px;z-index:2147483646;max-width:min(365px,calc(100vw - 48px));box-sizing:border-box;background:white;color:#18283b;border:1px solid #8b9bac;border-radius:8px;padding:12px;font:13px/1.45 system-ui;white-space:pre-line';
      document.body.append(notice);
    }
    notice.textContent=`Действия расширения заблокированы · ${value.code}${value.sourceStatus ? '\nИсточник: '+value.sourceStatus : ''}\n${value.message || 'Аккаунт не установлен. Обновите VK. Владелец адреса не используется вместо ID пользователя.'}\nУстаревшие данные страницы могут потребовать обновления.`;
  }
  async function refresh() {
    if(polling) return; polling=true;
    const href=location.href;
    try {
      const response=await chrome.runtime.sendMessage({type:'WORK_ACCOUNT'});
      if(location.href!==href) return;
      const source=response?.account;
      const value=source && typeof source.allowed==='boolean' ? source : {allowed:false,code:response?.code || 'ACCOUNT_UNKNOWN',message:response?.message};
      const signature=JSON.stringify([href,value.allowed,value.code,value.accountId,value.libraryOwnerId]);
      const changed=signature!==previous;
      if(changed) generation++;
      globalThis.VkWorkingAccount=Object.freeze({...value,generation});
      if(changed) { previous=signature; dispatchEvent(new Event('vkdl-account-change')); }
      paint(value);
    } catch {
      const value={allowed:false,code:'ACCOUNT_UNKNOWN',message:'Связь с расширением недоступна. Новые задания заблокированы.'};
      globalThis.VkWorkingAccount=Object.freeze({...value,generation:++generation}); previous=''; dispatchEvent(new Event('vkdl-account-change')); paint(value);
    } finally { polling=false; }
  }
  function leaving() {
    previous='';
    globalThis.VkWorkingAccount=Object.freeze({allowed:false,code:'ACCOUNT_CHANGED',generation:++generation});
    dispatchEvent(new Event('vkdl-account-change')); void refresh();
  }
  addEventListener('popstate',leaving); addEventListener('hashchange',leaving);
  setInterval(()=>{void refresh();},1500); void refresh();
})();
