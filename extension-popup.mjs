import { requestApprovedSet } from './source-access.mjs';
const button=document.querySelector('#grant-cdn'), output=document.querySelector('#permission-result');
button.addEventListener('click', event => {
  if(!event.isTrusted || button.disabled) return;
  button.disabled=true; output.textContent='Ожидается решение о доступе к согласованным CDN…';
  // Request synchronously in the trusted gesture, before any await.
  requestApprovedSet(chrome).then(result=>{
    output.textContent=result.granted ? 'Доступ к согласованным CDN предоставлен. Скачивание запускайте отдельно на своей странице VK.' :
      result.reason==='DENIED' ? 'Доступ не предоставлен. Загрузка не запускалась.' :
      'Запрос доступа не выполнен. Загрузка не запускалась; подробности исключения скрыты.';
  }).finally(()=>{button.disabled=false;});
});
