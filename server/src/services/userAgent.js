// Браузер и система по заголовку User-Agent — коротко, для журнала и уведомлений администраторам:
// «Chrome 129 Android», «Safari 18 iPhone», «Edge 129 Windows». Порядок проверок важен: строка Edge, Оперы
// и Яндекса содержит и «Chrome/», строка Android — и «Linux», iPhone — и «Mac OS X».
function browserOf(ua) {
  const s = String(ua || '');
  const b = s.match(/(Edg|YaBrowser|OPR)\/(\d+)/) || s.match(/(Firefox|Chrome)\/(\d+)/);
  const safari = !b && s.match(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/);
  const names = { Edg: 'Edge', OPR: 'Opera', YaBrowser: 'Яндекс' };
  const name = b ? `${names[b[1]] || b[1]} ${b[2]}` : safari ? `Safari ${safari[1]}` : 'браузер ?';
  const os = ['Android', 'iPhone', 'iPad', 'Windows', 'Mac OS X', 'Linux'].find((x) => s.includes(x)) || '';
  return (name + ' ' + os.replace('Mac OS X', 'macOS')).trim();
}

module.exports = { browserOf };
