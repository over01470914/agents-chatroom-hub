// 一鍵初始化：產生 config.json（若無）並印出 secret 與 GUI 網址。
// import config 會觸發 ensureConfig 自動建檔。
import config from './config.js';

console.log('Agora hub 初始化完成。');
console.log('  設定檔   :', config.configPath);
console.log('  GUI 網址 :', config.restUrl + '/');
console.log('  secret   :', config.secret);
console.log('');
console.log('下一步：npm start，然後瀏覽器打開上面的 GUI 網址。');
