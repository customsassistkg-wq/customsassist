/**
 * Customs Assist KG — приём входящей почты info@customsassist.trade (Cloudflare Email Worker).
 *
 * Этот файл живёт в репозитории, но НЕ выкладывается на сервер: он публикуется в аккаунте
 * Cloudflare владельца (Workers and Pages → создать Worker → вставить код → Deploy), а правило
 * Email Routing для info@ переключается с пересылки на этот Worker. Репозиторий держит его,
 * чтобы код этой части системы не существовал только в чужой панели управления.
 *
 * Почему письмо не разбирается здесь. На бесплатном тарифе у Worker 10 мс процессорного времени
 * на вызов, а Cloudflare принимает письмо размером до 25 МиБ; разбор MIME с вложениями в это не
 * укладывается, и документация Cloudflare прямо предупреждает, что сложный обработчик на бесплатном
 * тарифе не справится с письмом. Поэтому Worker только передаёт сырое письмо потоком: это
 * ввод-вывод, а не вычисления. Разбирает письмо сервер на Hetzner, где есть и время, и база.
 *
 * Переменные (Settings → Variables and Secrets):
 *   FALLBACK_TO     — подтверждённый адрес назначения Email Routing, обычная почта владельца.
 *                     Пока раздел «Обращения» не обкатан, копия уходит туда всегда.
 *   INBOUND_URL     — https://customsassist.trade/api/mail/inbound
 *   INBOUND_SECRET  — общий секрет с сервером (Secret, не Variable). Пока он не задан, шаг с
 *                     передачей на сервер пропускается, и Worker работает как обычная пересылка.
 *
 * Порядок действий намеренно такой: сначала пересылка, потом передача сервису. Так письмо не
 * теряется, даже если сервер недоступен. Если не сработало ни то, ни другое, отправитель получает
 * временный отказ и его почтовый сервер повторит доставку, вместо тихой потери письма.
 */
export default {
  // Worker не обслуживает веб-запросы, только почту; ответ нужен лишь чтобы проверить, что он жив.
  async fetch() {
    return new Response('Customs Assist KG inbound email worker', { status: 404 });
  },

  async email(message, env) {
    let delivered = false;

    // 1. Копия владельцу. Адрес обязан быть подтверждён в Email Routing, иначе forward бросает.
    if (env.FALLBACK_TO) {
      try {
        await message.forward(env.FALLBACK_TO);
        delivered = true;
      } catch (err) {
        console.log('forward failed: ' + err.message);
      }
    }

    // 2. Письмо целиком уходит сервису потоком, как есть, вместе с конвертом в заголовках.
    if (env.INBOUND_URL && env.INBOUND_SECRET) {
      try {
        const res = await fetch(env.INBOUND_URL, {
          method: 'POST',
          headers: {
            'content-type': 'message/rfc822',
            'x-ca-secret': env.INBOUND_SECRET,
            'x-ca-from': message.from,
            'x-ca-to': message.to,
            'x-ca-size': String(message.rawSize),
          },
          body: message.raw,
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) delivered = true;
        else console.log('inbound HTTP ' + res.status);
      } catch (err) {
        console.log('inbound failed: ' + err.message);
      }
    }

    // 3. Тихо терять письмо нельзя.
    if (!delivered) message.setReject('Temporary delivery failure, please retry later');
  },
};
