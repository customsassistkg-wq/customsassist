// Дашборд администраторов — интерфейс. Приходит через /api/dash.js только администратору
// (routes/dash.js) и исполняется страницей server/dash/index.html как blob. Данные —
// GET /api/dash/data раз в минуту, пока вкладка видна. Никаких библиотек: графики —
// собственный SVG, цвета — токены темы страницы (--series-*, --grid, --axis), у каждого
// графика есть табличный вид (details.tv), поэтому ни одно число не читается только по цвету.
(function () {
  'use strict';

  const TZ = 'Asia/Bishkek';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const n = (v) => (v == null || v === '' ? null : Number(v));

  // ── Форматирование ─────────────────────────────────────────────────────────
  const fmt = {
    int: (v) => (n(v) == null ? '—' : n(v).toLocaleString('ru-RU')),
    num: (v, d = 1) => (n(v) == null ? '—' : n(v).toLocaleString('ru-RU', { maximumFractionDigits: d })),
    pct: (v) => (n(v) == null ? '—' : Math.round(n(v)) + ' %'),
    usd: (v) => (n(v) == null ? '—' : '$' + n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    usd4: (v) => (n(v) == null ? '—' : '$' + n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })),
    bytes: (b) => {
      b = n(b); if (b == null) return '—';
      const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
      while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
      return b.toLocaleString('ru-RU', { maximumFractionDigits: b >= 100 ? 0 : 1 }) + ' ' + u[i];
    },
    ms: (v) => (n(v) == null ? '—' : n(v) < 1000 ? Math.round(n(v)) + ' мс' : (n(v) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' с'),
    dur: (s) => {
      s = n(s); if (s == null) return '—';
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} м` : m ? `${m} м` : 'меньше минуты';
    },
    time: (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'),
    dt: (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'),
    dtFull: (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
    date: (v) => {
      if (!v) return '—';
      const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(v));
      if (m) return `${m[3]}.${m[2]}.${m[1]}`;
      const d = new Date(v);
      return isNaN(d) ? String(v) : d.toLocaleDateString('ru-RU', { timeZone: TZ });
    },
    ago: (iso, now) => {
      if (!iso) return '—';
      const s = Math.max(0, Math.round(((now ? new Date(now) : new Date()) - new Date(iso)) / 1000));
      if (s < 60) return 'только что';
      if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
      if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
      return `${Math.floor(s / 86400)} дн назад`;
    },
    days: (d) => {
      const a = Math.abs(d), r = a % 10, rr = a % 100;
      const w = rr >= 11 && rr <= 14 ? 'дней' : r === 1 ? 'день' : r >= 2 && r <= 4 ? 'дня' : 'дней';
      return `${a} ${w}`;
    },
  };
  const ymdOf = (iso) => new Date(new Date(iso).getTime() + 6 * 3600e3).toISOString().slice(0, 10);
  const daysDiff = (ymdA, ymdB) => Math.round((Date.parse(ymdA + 'T00:00:00Z') - Date.parse(ymdB + 'T00:00:00Z')) / 86400e3);

  // Плашка состояния — .tag сайта с точкой и подписью: смысл несёт текст, цвет лишь помогает.
  const st = (kind, text) => `<span class="tag st ${kind}"><i class="dot"></i>${esc(text)}</span>`;
  const tile = (label, value, detail, opts = {}) =>
    `<div class="tile${opts.hero ? ' hero' : ''}"><div class="l" title="${esc(label)}">${esc(label)}</div><div class="v">${value}</div>${detail ? `<div class="d">${detail}</div>` : ''}</div>`;
  const tilesCard = (tiles) => `<div class="card tiles-card"><div class="tiles">${tiles.join('')}</div></div>`;
  const icon = (id) => `<span class="ico"><svg class="ic" aria-hidden="true"><use href="#${id}"/></svg></span>`;
  // Карточка в форме карточки выдачи сайта: .rh (иконка + заголовок), затем тело.
  const card = (title, body, sub, cls = '', ico = 'i-chart', sec = '') =>
    `<div class="card ${cls}"${sec ? ` data-sec="${sec}"` : ''}><div class="rh">${icon(ico)}<div><div class="rn-title">${esc(title)}</div>${sub ? `<div class="rn-sub">${sub}</div>` : ''}</div></div>${body}</div>`;
  // Раздел — .res-sec сайта: заголовок-полоса и сетка карточек в две колонки.
  const section = (id, title, sub, inner) =>
    `<section class="res-sec" id="${id}"><div class="res-sec-h">${esc(title)}${sub ? `<span class="res-sec-sub">${sub}</span>` : ''}</div>${inner}</section>`;
  const errBox = (s, what) => `<p class="err">${esc(what || 'Раздел')} недоступен: ${esc(s && s.error ? s.error : 'нет данных')}</p>`;
  const kv = (pairs) => `<div class="kv">${pairs.filter(Boolean).map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${v}</span>`).join('')}</div>`;
  const table = (heads, rows, empty) => rows.length
    ? `<div class="tbl"><table><thead><tr>${heads.map((h) => `<th${/^#/.test(h) ? ' class="num"' : ''}>${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${/^#/.test(heads[i]) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<p class="small">${esc(empty || 'Пусто')}</p>`;
  const meter = (value, max, warnAt, badAt) => {
    const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
    const cls = badAt != null && value >= badAt ? 'bad' : warnAt != null && value >= warnAt ? 'warn' : '';
    return `<div class="meter ${cls}" title="${pct} %"><i style="width:${pct}%"></i></div>`;
  };

  // ── Графики: столбцы (SVG) с подсказкой и табличным видом ────────────────────
  // points: [{label, value, tip}], opts: {series: 'var(--series-1)', unit, xTicks:[i…], height}
  let chartSeq = 0;
  function columns(points, opts = {}) {
    const W = 440, H = opts.height || 150, padL = 34, padR = 6, padT = 10, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(1, ...points.map((p) => p.value || 0));
    // Круглый максимум оси: 1-2-5.
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    const top = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= max) || max;
    const slot = plotW / Math.max(1, points.length), bw = Math.max(1.5, Math.min(24, slot - 2));
    const y = (v) => padT + plotH - (v / top) * plotH;
    const color = opts.series || 'var(--series-1)';
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || 'График')}">`;
    for (const g of [0, 0.5, 1]) {
      const yy = y(top * g);
      s += `<line class="${g === 0 ? 'base' : 'gl'}" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`;
      s += `<text class="ax" x="${padL - 5}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt.num(top * g, top < 10 ? 1 : 0))}</text>`;
    }
    points.forEach((p, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const v = p.value || 0;
      const h = Math.max(v > 0 ? 2 : 0, (v / top) * plotH);
      const yy = padT + plotH - h;
      const r = Math.min(4, bw / 2, h);
      // Скруглён только верх столбца: прямоугольник с path.
      const path = h > 0
        ? `M${x.toFixed(2)},${(yy + h).toFixed(2)} v${(-(h - r)).toFixed(2)} q0,-${r} ${r},-${r} h${(bw - 2 * r).toFixed(2)} q${r},0 ${r},${r} v${(h - r).toFixed(2)} z`
        : '';
      if (path) s += `<path d="${path}" fill="${p.color || color}"/>`;
      if (p.mark) s += `<circle cx="${(x + bw / 2).toFixed(2)}" cy="${(yy - 5).toFixed(2)}" r="3" fill="var(--red)"/>`;
      s += `<rect class="hit" data-i="${i}" x="${(padL + i * slot).toFixed(2)}" y="${padT}" width="${slot.toFixed(2)}" height="${plotH}" fill="transparent"/>`;
    });
    const ticks = opts.xTicks || [0, Math.floor(points.length / 2), points.length - 1];
    for (const i of ticks) {
      if (!points[i]) continue;
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      const x = padL + i * slot + (anchor === 'start' ? 0 : anchor === 'end' ? slot : slot / 2);
      s += `<text class="ax" x="${x.toFixed(1)}" y="${H - 5}" text-anchor="${anchor}">${esc(points[i].label)}</text>`;
    }
    s += '</svg>';
    const id = 'ch' + (++chartSeq);
    const tips = points.map((p) => p.tip || `${p.label}: ${fmt.num(p.value, 2)}`);
    const tbl = `<details class="tv"><summary>Таблица</summary>${table([opts.xName || 'Дата', '#' + (opts.unit || 'Значение')], points.map((p) => [esc(p.label), esc(fmt.num(p.value, 2))]))}</details>`;
    return `<div class="chart" id="${id}" data-tips="${esc(JSON.stringify(tips))}">${s}<div class="tip"></div></div>${tbl}`;
  }
  // Одна подсказка на все графики: делегирование по .chart .hit.
  function bindTips(root) {
    root.querySelectorAll('.chart').forEach((ch) => {
      let tips; try { tips = JSON.parse(ch.dataset.tips); } catch (e) { tips = []; }
      const tip = ch.querySelector('.tip');
      const show = (e) => {
        const t = e.target.closest('.hit'); if (!t) return;
        const i = Number(t.dataset.i);
        tip.textContent = tips[i] || ''; tip.classList.add('show');
        const r = ch.getBoundingClientRect(), tr = t.getBoundingClientRect();
        const x = Math.min(r.width - 20, Math.max(20, tr.left - r.left + tr.width / 2));
        tip.style.left = x + 'px'; tip.style.top = Math.max(28, tr.top - r.top) + 'px';
      };
      ch.addEventListener('mousemove', show);
      ch.addEventListener('touchstart', show, { passive: true });
      ch.addEventListener('mouseleave', () => tip.classList.remove('show'));
    });
  }

  // ── Разделы ──────────────────────────────────────────────────────────────
  function secHealth(d) {
    const sys = d.system || {}, db = d.db || {}, sd = d.systemd, sv = d.services || {}, http = d.http || {};
    const tiles = [];
    // API
    tiles.push(tile('API', esc(fmt.dur(sys.uptimeS)) + '<small>без перезапуска</small>',
      st('ok', 'работает') + ` <span class="small">Node ${esc(sys.node || '')}${sd && sd.api ? ` · перезапусков ${fmt.int(sd.api.restarts)}` : ''}</span>`));
    // БД
    if (db.error) tiles.push(tile('База данных', '—', st('bad', 'ошибка') + ` <span class="small">${esc(db.error)}</span>`));
    else {
      const lat = n(db.latencyMs);
      tiles.push(tile('База данных', esc(fmt.ms(lat)) + '<small>ответ</small>',
        st(lat < 100 ? 'ok' : lat < 500 ? 'warn' : 'bad', lat < 100 ? 'в норме' : 'медленно') + ` <span class="small">${esc(db.version || '')} · ${esc(fmt.bytes(db.sizeBytes))}</span>`));
    }
    // Цикл событий
    const loop = http.loop;
    if (loop) {
      const p99 = n(loop.p99Ms);
      tiles.push(tile('Цикл событий', esc(fmt.ms(p99)) + '<small>p99 за минуту</small>',
        st(p99 < 50 ? 'ok' : p99 < 200 ? 'warn' : 'bad', p99 < 50 ? 'свободен' : 'задержки') + ` <span class="small">макс ${esc(fmt.ms(loop.maxMs))}</span>`));
    }
    // Память процесса
    if (sys.memory) {
      const rss = n(sys.memory.rss), tot = n(sys.os && sys.os.totalMem);
      const share = tot ? rss / tot : 0;
      tiles.push(tile('Память API', esc(fmt.bytes(rss)) + '<small>RSS</small>',
        st(share < 0.4 ? 'ok' : share < 0.6 ? 'warn' : 'bad', tot ? fmt.pct(share * 100) + ' от машины' : '—') + ` <span class="small">heap ${esc(fmt.bytes(sys.memory.heapUsed))} / ${esc(fmt.bytes(sys.memory.heapTotal))}</span>`));
    }
    // Машина
    if (sys.os) {
      const free = n(sys.os.freeMem), tot = n(sys.os.totalMem), l = sys.os.load || [];
      const freeShare = tot ? free / tot : 1;
      tiles.push(tile('Сервер', esc(fmt.num(l[0], 2)) + '<small>load 1 мин</small>',
        st(freeShare > 0.15 ? 'ok' : freeShare > 0.07 ? 'warn' : 'bad', `свободно ${fmt.bytes(free)}`) + ` <span class="small">${esc(sys.os.hostname || '')} · ${esc(fmt.dur(sys.os.uptimeS))}</span>`));
    }
    // Диск
    if (sys.disk) {
      const used = 1 - sys.disk.free / sys.disk.total;
      tiles.push(tile('Диск', esc(fmt.pct(used * 100)) + '<small>занято</small>',
        st(used < 0.8 ? 'ok' : used < 0.9 ? 'warn' : 'bad', `свободно ${fmt.bytes(sys.disk.free)}`) + ` <span class="small">из ${esc(fmt.bytes(sys.disk.total))}</span>`));
    }
    // Бэкап
    if (sd && sd.backup) {
      const b = sd.backup, t = sd.timer || {};
      const ok = b.result === 'success';
      const ageH = b.lastExit ? (new Date(d.now) - new Date(b.lastExit)) / 3600e3 : null;
      tiles.push(tile('Ночной бэкап', esc(b.lastExit ? fmt.ago(b.lastExit, d.now) : '—'),
        st(!b.lastExit ? 'none' : ok && ageH < 30 ? 'ok' : ok ? 'warn' : 'bad', !b.lastExit ? 'нет данных' : ok ? (ageH < 30 ? 'успешно' : 'давно') : 'сбой: ' + (b.result || '?'))
        + ` <span class="small">следующий ${esc(fmt.dt(t.next))}</span>`));
    } else if (sd === null || (sd && !sd.backup)) {
      tiles.push(tile('Ночной бэкап', '—', st('none', 'systemd недоступен')));
    }
    // Вывоз копий на машину владельца: метку пишет её задача после удачной выгрузки.
    // Дамп делается в 03:31 UTC, задача забирает его в 06:00 UTC, поэтому «свежо» — до 30 часов.
    if (sd) {
      const at = sd.pull && sd.pull.at;
      const ageH = at ? (new Date(d.now) - new Date(at)) / 3600e3 : null;
      tiles.push(tile('Вывоз копий', esc(at ? fmt.ago(at, d.now) : '—'),
        st(!at ? 'none' : ageH < 30 ? 'ok' : ageH < 72 ? 'warn' : 'bad',
          !at ? 'нет отметки' : ageH < 30 ? 'копии у владельца' : ageH < 72 ? 'задержка' : 'копии не вывозятся')
        + ' <span class="small">задача на машине владельца, 12:00 по Бишкеку</span>'));
    }
    // Сертификаты
    for (const c of d.certs || []) {
      if (c.error) tiles.push(tile('TLS ' + c.host, '—', st('bad', 'не проверить') + ` <span class="small">${esc(c.error)}</span>`));
      else {
        const dl = n(c.daysLeft);
        tiles.push(tile('TLS ' + c.host, esc(fmt.int(dl)) + '<small>дн. до истечения</small>',
          st(c.covers === false ? 'warn' : dl > 20 ? 'ok' : dl > 7 ? 'warn' : 'bad', c.covers === false ? 'имя не в сертификате' : dl > 20 ? 'в порядке' : 'скоро истекает')
          + ` <span class="small">до ${esc(fmt.date(c.validTo))}${c.issuer ? ' · ' + esc(c.issuer) : ''}</span>`));
      }
    }
    // Курс НБКР
    if (sv.nbkr) {
      const r = sv.nbkr, ageH = r.updatedAt ? (new Date(d.now) - new Date(r.updatedAt)) / 3600e3 : null;
      tiles.push(tile('Курс НБКР', r.usd ? esc(fmt.num(r.usd, 2)) + '<small>сом за $</small>' : '—',
        st(!r.usd ? 'bad' : r.lastError ? 'warn' : ageH != null && ageH < 25 ? 'ok' : 'warn', !r.usd ? 'нет курса' : r.lastError ? 'сбой обновления' : 'обновляется')
        + ` <span class="small">на ${esc(r.date || '—')}${r.eur ? ' · € ' + esc(fmt.num(r.eur, 2)) : ''}${r.lastError ? ' · ' + esc(r.lastError.message) : ''}</span>`));
    }
    // Классификационные решения
    if (sv.classDecisions) {
      const c = sv.classDecisions, ageD = c.fetchedAt ? (new Date(d.now) - new Date(c.fetchedAt)) / 86400e3 : null;
      tiles.push(tile('Классрешения ЕАЭС', esc(fmt.int(c.count)) + '<small>записей</small>',
        st(!c.count ? 'bad' : c.lastError ? 'warn' : ageD != null && ageD < 2 ? 'ok' : 'warn', !c.count ? 'пусто' : c.lastError ? 'сбой обновления' : 'обновлено ' + fmt.ago(c.fetchedAt, d.now))
        + (c.lastError ? ` <span class="small">${esc(c.lastError.message)}</span>` : '')));
    }
    // AI
    if (sv.ai) {
      const a = sv.ai;
      tiles.push(tile('AI-помощник', a.configured ? esc(a.model) : '—',
        st(a.configured ? 'ok' : 'none', a.configured ? 'ключ задан' : 'выключен') + ` <span class="small">в работе ${fmt.int(a.inFlight)} · потолок ${a.budgetUsd > 0 ? esc(fmt.usd(a.budgetUsd)) + '/сутки' : 'нет'}</span>`));
    }
    // Прочие службы одной плиткой
    const chips = [
      st(sv.turnstile && sv.turnstile.enabled ? 'ok' : 'none', 'Turnstile ' + (sv.turnstile && sv.turnstile.enabled ? 'включён' : 'выключен')),
      st(sv.mail && sv.mail.configured ? 'ok' : 'none', 'Почта ' + (sv.mail && sv.mail.configured ? 'настроена' : 'выключена')),
      st(sv.ocr && sv.ocr.vision ? 'ok' : 'none', 'Vision ' + (sv.ocr && sv.ocr.vision ? 'есть' : 'нет')),
      st(sv.ocr && sv.ocr.documentAi ? 'ok' : 'none', 'Document AI ' + (sv.ocr && sv.ocr.documentAi ? 'есть' : 'нет')),
    ];
    tiles.push(`<div class="tile"><div class="l">Службы</div><div class="chips" style="margin-top:6px">${chips.join('')}</div></div>`);
    return section('sec-health', 'Состояние', `процесс запущен ${esc(fmt.dtFull(sys.startedAt))} · база разобрана за ${esc(fmt.ms(sys.base && sys.base.loadMs))}`, tilesCard(tiles));
  }

  function secHttp(d) {
    const h = d.http;
    if (!h) return '';
    const mins = h.minutes || [];
    const hour = mins.reduce((s, m) => s + m.n, 0), last = mins.length ? mins[mins.length - 1].n : 0;
    const e5h = mins.reduce((s, m) => s + m.e5, 0), e4h = mins.reduce((s, m) => s + m.e4, 0);
    const points = mins.map((m, i) => ({
      label: i === mins.length - 1 ? 'сейчас' : `−${mins.length - 1 - i} мин`,
      value: m.n, mark: m.e5 > 0,
      tip: `${fmt.time(m.t)} · ${m.n} запр.${m.e4 ? ` · 4xx ${m.e4}` : ''}${m.e5 ? ` · 5xx ${m.e5}` : ''}${m.n ? ` · ${m.avgMs} мс` : ''}`,
    }));
    const tiles = [
      tile('За последний час', esc(fmt.int(hour)) + '<small>запросов</small>', `сейчас ${fmt.int(last)} в минуту`),
      tile('С запуска', esc(fmt.int(h.total)), `с ${esc(fmt.dt(h.startedAt))}`),
      tile('Ошибки 5xx', esc(fmt.int(h.status.s5)), st(h.status.s5 ? 'bad' : 'ok', h.status.s5 ? `${e5h} за час` : 'нет')),
      tile('Отказы 4xx', esc(fmt.int(h.status.s4)), `${e4h} за час · 401: ${fmt.int(h.status.s401)} · 403: ${fmt.int(h.status.s403)} · 429: ${fmt.int(h.status.s429)}`),
    ];
    const routes = (h.routes || []).map((r) => [
      `<span class="mono">${esc(r.key)}</span>`, esc(fmt.int(r.count)), esc(fmt.ms(r.avgMs)), esc(fmt.ms(r.maxMs)),
      r.s4 ? esc(fmt.int(r.s4)) : '<span class="small">0</span>', r.s5 ? st('bad', fmt.int(r.s5)) : '<span class="small">0</span>',
    ]);
    const log = (h.errors || []).length
      ? `<div class="log">${h.errors.map((e) => `<div><span class="t">${esc(fmt.dt(e.t))}</span> <span class="${e.level === 'error' ? 'e' : 'w'}">${esc(e.level)}</span> ${esc(e.msg)}</div>`).join('')}</div>`
      : '<p class="small">С запуска процесса ошибок и предупреждений в журнале не было.</p>';
    return section('sec-http', 'Запросы к API', 'счётчики процесса; свои 429 Nginx отсекает раньше',
      tilesCard(tiles)
      + card('Запросов в минуту', columns(points, { unit: 'Запросов', xName: 'Минута', xTicks: [0, 30, mins.length - 1], aria: 'Запросы в минуту за последний час' }) + '<p class="note">Красная точка над столбцом — в эту минуту были ответы 5xx.</p>', 'последние 60 минут', '', 'i-pulse')
      + card('Маршруты', table(['Маршрут', '#Запросов', '#Среднее', '#Макс.', '#4xx', '#5xx'], routes, 'Запросов ещё не было.'), 'с запуска процесса', '', 'i-chart')
      + card('Журнал процесса', log, 'последние ' + Math.min(50, (h.errors || []).length) + ' строк console.error / console.warn', 'span2', 'i-clipboard', h.status.s5 ? 'warn' : ''));
  }

  function secUsers(d) {
    const u = d.users;
    if (!u || u.error) return section('sec-users', 'Пользователи', '', card('Пользователи', errBox(u, 'Раздел'), '', 'span2', 'i-users', 'danger'));
    const o = u.overview || {};
    const tiles = [
      tile('Всего учётных записей', esc(fmt.int(o.total)), `${fmt.int(o.active)} активны · ${fmt.int(o.admins)} админ.`, { hero: true }),
      tile('Онлайн сейчас', esc(fmt.int(o.online)), 'активность за 5 минут'),
      tile('Были за сутки', esc(fmt.int(o.seen_day)), `за 7 дней ${fmt.int(o.seen_week)} · за 30 дней ${fmt.int(o.seen_month)}`),
      tile('Новых за 7 дней', esc(fmt.int(o.new_week)), `за 30 дней ${fmt.int(o.new_month)}`),
      tile('Подписка истекает', esc(fmt.int(o.expiring_week)) + '<small>за 7 дней</small>', st(o.expired ? 'warn' : 'ok', `истекла у ${fmt.int(o.expired)}`) + ` <span class="small">без срока ${fmt.int(o.unlimited)}</span>`),
      tile('Не подтвердили почту', esc(fmt.int(o.unverified)), st(o.disabled ? 'none' : 'ok', `отключено ${fmt.int(o.disabled)}`)),
      tile('Приняли правила', esc(fmt.int(o.terms_current)) + `<small>из ${fmt.int(o.total)}</small>`, `редакция ${esc(u.termsVersion || '')}`),
      tile('Тарифы AI', `${esc(fmt.int(o.plan_base))}<small>base</small>`, `pro ${fmt.int(o.plan_pro)} · max ${fmt.int(o.plan_max)}`),
    ];
    // Регистрации по дням: пустые дни тоже на оси.
    const days = [];
    const today = ymdOf(d.now);
    const map = new Map((u.byDay || []).map((r) => [r.d, r.n]));
    for (let i = 29; i >= 0; i--) {
      const k = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10);
      days.push({ label: fmt.date(k).slice(0, 5), value: map.get(k) || 0, tip: `${fmt.date(k)}: ${map.get(k) || 0}` });
    }
    const recent = (u.recent || []).map((r) => [
      `${esc(r.email)}${r.role === 'admin' ? ' ' + st('info', 'admin') : ''}`,
      r.online ? st('ok', 'онлайн') : esc(fmt.ago(r.last_seen_at, d.now)),
      esc(fmt.dt(r.last_login_at)), esc(r.ai_plan || ''),
      r.subscription_expires_at ? esc(fmt.date(r.subscription_expires_at)) : '<span class="small">без срока</span>',
    ]);
    const expiring = (u.expiring || []).map((r) => {
      const dd = daysDiff(r.subscription_expires_at.slice ? ymdOf(r.subscription_expires_at) : today, today);
      return [esc(r.email), esc(fmt.date(r.subscription_expires_at)),
        dd < 0 ? st('bad', `истекла ${fmt.days(dd)} назад`) : dd === 0 ? st('warn', 'сегодня') : st(dd <= 3 ? 'warn' : 'info', `через ${fmt.days(dd)}`)];
    });
    const tk = u.tokens || {};
    const tokens = kv([
      ['Подтверждение почты', `ожидают ${fmt.int(tk.verify && tk.verify.pending)} · подтверждено за 7 дней ${fmt.int(tk.verify && tk.verify.usedWeek)} · просрочено за 7 дней ${fmt.int(tk.verify && tk.verify.expiredWeek)}`],
      ['Сброс пароля', `ожидают ${fmt.int(tk.reset && tk.reset.pending)} · использовано за 7 дней ${fmt.int(tk.reset && tk.reset.usedWeek)} · просрочено за 7 дней ${fmt.int(tk.reset && tk.reset.expiredWeek)}`],
      ['Сессии', d.db && d.db.sessions ? `активных ${fmt.int(d.db.sessions.active)} · на дашборде ${fmt.int(d.db.sessions.dash)} · истёкших в таблице ${fmt.int(d.db.sessions.expired)}` : '—'],
    ]);
    return section('sec-users', 'Пользователи', 'таблица users; онлайн — активность за 5 минут',
      tilesCard(tiles)
      + card('Регистрации по дням', columns(days, { unit: 'Регистраций', aria: 'Регистрации за 30 дней' }), 'последние 30 дней', '', 'i-users')
      + card('Письма и сессии', tokens, 'токены подтверждения и сброса, таблица session', '', 'i-lock')
      + card('Последняя активность', table(['Учётная запись', 'Был(а)', 'Последний вход', 'Тариф', 'Подписка до'], recent, 'Пока никто не заходил.'), 'по last_seen_at', 'span2', 'i-pulse')
      + card('Подписки: истекают и истекли', table(['Учётная запись', 'До', 'Статус'], expiring, 'В ближайшие 14 дней ничего не истекает.'), 'от −3 до +14 дней', 'span2', 'i-warn', expiring.length ? 'warn' : ''));
  }

  function secEngine(d) {
    const e = d.engine;
    if (!e || e.error) return section('sec-engine', 'Лимиты базы', '', card('Лимиты базы', errBox(e, 'Раздел'), '', 'span2', 'i-lock', 'danger'));
    const L = e.limits || {};
    const rows = (e.rows || []).map((r) => `<div class="row">
        <span class="n" title="${esc(r.email || 'учётная запись удалена')}">${esc(r.email || '(удалена)')}</span>
        ${meter(r.keys, L.keysLimit || 800, L.keysAlert || 300, L.keysLimit || 800)}
        <span class="x">${fmt.int(r.keys)} поз. · ${fmt.int(r.calls)} запр.${r.minuteCalls ? ` · ${r.minuteCalls}/мин` : ''}</span>
        ${r.alerted.includes('limit') ? st('bad', 'лимит') : r.alerted.includes('many') ? st('warn', 'письмо отправлено') : ''}
      </div>`).join('');
    const body = rows ? `<div class="rows">${rows}</div>` : '<p class="small">Сегодня к базе ещё никто не обращался (администраторы не считаются).</p>';
    const note = `<p class="note">Позиция — товарная позиция, группа дерева или текст поиска по названию. Письмо администраторам при ${fmt.int(L.keysAlert)} позициях, отказ до конца суток при ${fmt.int(L.keysLimit)}; ${fmt.int(L.perMinute)} запросов в минуту и ${fmt.int(L.perDay)} в сутки. Счётчик живёт в памяти процесса и обнуляется в полночь по Бишкеку.</p>`;
    const alerted = (e.rows || []).some((r) => r.alerted.length);
    return section('sec-engine', 'Лимиты базы', `/api/engine, сегодня по Бишкеку: ${fmt.int(e.accounts)} учётных записей, ${fmt.int(e.calls)} запросов`,
      card('Кто сколько открыл', body + note, 'самые активные учётные записи за сегодня', 'span2', 'i-lock', alerted ? 'warn' : ''));
  }

  function secAssistant(d) {
    const a = d.assistant;
    if (!a || a.error) return section('sec-assistant', 'AI-помощник', '', card('AI-помощник', errBox(a, 'Раздел'), '', 'span2', 'i-sparkles', 'danger'));
    const t = a.today || {}, m = a.month || {};
    const budget = n(a.budgetUsd) || 0;
    const spentShare = budget ? t.cost / budget : 0;
    const tiles = [
      `<div class="tile hero"><div class="l">Расход сегодня</div><div class="v">${esc(fmt.usd(t.cost))}${budget ? `<small>из ${esc(fmt.usd(budget))}</small>` : ''}</div>
        ${budget ? meter(t.cost, budget, budget * 0.7, budget) : ''}<div class="d">${budget ? st(spentShare < 0.7 ? 'ok' : spentShare < 1 ? 'warn' : 'bad', spentShare >= 1 ? 'потолок достигнут' : fmt.pct(spentShare * 100) + ' потолка') : 'потолок не задан'}</div></div>`,
      tile('Сегодня', esc(fmt.int(t.questions)) + '<small>вопросов</small>', `страниц ${fmt.int(t.pages)} · ошибок ${fmt.int(t.errors)}`),
      tile('За месяц', esc(fmt.usd(m.cost)), `с ${esc(fmt.date(m.start))} · ${fmt.int(m.users)} пользователей`),
      tile('Вопросов за месяц', esc(fmt.int(m.questions)), `страниц ${fmt.int(m.pages)} · ошибок ${fmt.int(m.errors)}`),
      tile('Оценки за месяц', `${esc(fmt.int(m.good))}<small>👍</small> ${esc(fmt.int(m.bad))}<small>👎</small>`, m.good + m.bad ? `${fmt.pct((m.good / (m.good + m.bad)) * 100)} положительных` : 'оценок нет'),
      tile('Ответ в среднем', esc(fmt.ms(m.avgMs)), 'по успешным вопросам месяца'),
      tile('Токены за месяц', esc(fmt.num(m.inputTokens / 1e6, 2)) + '<small>млн вход</small>', `кэш ${fmt.num(m.cacheTokens / 1e6, 2)} млн · выход ${fmt.num(m.outputTokens / 1e6, 2)} млн`),
    ];
    const today = ymdOf(d.now);
    const map = new Map((a.byDay || []).map((r) => [r.d, r]));
    const qs = [], cs = [];
    for (let i = 29; i >= 0; i--) {
      const k = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10);
      const r = map.get(k) || {};
      qs.push({ label: fmt.date(k).slice(0, 5), value: r.questions || 0, mark: (r.errors || 0) > 0, tip: `${fmt.date(k)}: ${r.questions || 0} вопр., ${r.pages || 0} стр.${r.errors ? `, ошибок ${r.errors}` : ''}` });
      cs.push({ label: fmt.date(k).slice(0, 5), value: n(r.cost) || 0, tip: `${fmt.date(k)}: ${fmt.usd4(r.cost || 0)}` });
    }
    const top = (a.top || []).map((r) => [esc(r.email), esc(r.ai_plan || ''), esc(fmt.int(r.questions)), esc(fmt.int(r.pages)), r.errors ? st('warn', fmt.int(r.errors)) : '<span class="small">0</span>', esc(fmt.usd4(r.cost)), esc(fmt.dt(r.last_at))]);
    const errs = (a.errors || []).map((r) => [esc(fmt.dt(r.created_at)), esc(r.email), esc(r.kind === 'read' ? 'страница' : 'вопрос'), `<span class="mono">${esc(r.error)}</span>`]);
    return section('sec-assistant', 'AI-помощник', `журнал assistant_log · в работе сейчас ${fmt.int(a.inFlight)}`,
      tilesCard(tiles)
      + card('Вопросов в день', columns(qs, { unit: 'Вопросов', aria: 'Вопросы помощнику за 30 дней' }) + '<p class="note">Красная точка — в этот день были ошибки.</p>', 'последние 30 дней', '', 'i-sparkles')
      + card('Расход в день, $', columns(cs, { unit: '$', series: 'var(--series-2)', aria: 'Расход на помощника за 30 дней' }), 'модель и распознавание страниц', '', 'i-coins')
      + card('Кто тратит', table(['Учётная запись', 'Тариф', '#Вопросов', '#Страниц', '#Ошибок', '#Расход', 'Последний'], top, 'В этом месяце вопросов не было.'), 'текущий месяц', 'span2', 'i-users')
      + card('Последние ошибки', table(['Когда', 'Учётная запись', 'Что', 'Ошибка'], errs, 'Ошибок не было.'), 'последние 8 записей с ошибкой', 'span2', 'i-warn', errs.length && t.errors ? 'warn' : ''));
  }

  function secBase(d) {
    const b = d.base;
    if (!b || b.error) return section('sec-base', 'Правовая база', '', card('Правовая база', errBox(b, 'Раздел'), '', 'span2', 'i-tree', 'danger'));
    const today = ymdOf(d.now);
    const au = b.audit || { counts: {}, rows: [] };
    const tiles = [
      tile('Позиций ЕТТ', esc(fmt.int(b.ett)), `переходов кодов ${fmt.int(b.tnvedMap)}`),
      tile('Запретов в базе', esc(fmt.int(b.bans)), `антидемпинговых мер ${fmt.int(b.antidump)}`),
      tile('Сверка источников', `${esc(fmt.int(au.counts.ok))}<small>✔</small> ${esc(fmt.int(au.counts.part))}<small>◐</small> ${esc(fmt.int(au.counts.old))}<small>○</small>`, `ревизия ${esc(au.rev || '')} · последняя ${esc(fmt.date(au.last))}`),
      tile('Реестр односторонних мер ЕЭК', esc(b.unimeasAsOf || '—'), 'состояние выгрузки в базе'),
      tile('База в памяти', esc(fmt.dt(d.system && d.system.base && d.system.base.loadedAt)), `разобрана за ${fmt.ms(d.system && d.system.base && d.system.base.loadMs)}`),
    ];
    const dated = (b.dated || []).map((m) => {
      const key = m.until || m.from;
      const dd = daysDiff(key, today);
      let status, order;
      if (m.until) { status = dd < 0 ? st('none', `истекла ${fmt.days(dd)} назад`) : dd <= 30 ? st('warn', `истекает через ${fmt.days(dd)}`) : st('ok', `действует ещё ${fmt.days(dd)}`); order = dd < 0 ? 1e6 + dd : dd; }
      else { status = dd > 0 ? st('info', `вступает через ${fmt.days(dd)}`) : st('ok', `действует с ${fmt.date(m.from)}`); order = dd > 0 ? dd : 5e5 - dd; }
      return { order, cells: [esc(m.kind) + (m.unver ? ' ' + st('warn', 'не подтверждено') : ''), esc(m.dir), esc(m.name), m.from ? esc(fmt.date(m.from)) : '<span class="small">—</span>', m.until ? esc(fmt.date(m.until)) : '<span class="small">—</span>', status] };
    }).sort((x, y) => x.order - y.order).map((x) => x.cells);
    const auditRows = (au.rows || []).map((r) => [
      r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name),
      r.st === 'ok' ? st('ok', 'сверено') : r.st === 'part' ? st('warn', 'частично') : st('none', 'не проверялось'),
      esc(r.d || '—'), `<span class="mono">${esc(r.key)}</span>`,
    ]);
    const soon = (b.dated || []).some((m) => m.until && daysDiff(m.until, today) >= 0 && daysDiff(m.until, today) <= 30);
    return section('sec-base', 'Правовая база', 'меняется только выкладкой; сроки считаются на сегодня по Бишкеку',
      tilesCard(tiles)
      + card('Датированные меры', table(['Мера', 'Напр.', 'Товар / страна', 'С', 'До', 'Статус'], dated, 'Датированных мер нет.'), 'запреты, антидемпинг, соглашения о ставках', 'span2', 'i-warn', soon ? 'warn' : '')
      + card('Записи сверки источников', `<details class="tv" open><summary>${au.rows.length} записей</summary>${table(['База', 'Статус', 'Дата', 'Ключ'], auditRows)}</details>`, 'SOURCE_AUDIT — то же, что панель «Актуальность баз» на сайте', 'span2', 'i-check'));
  }

  // ── Экономика: оплаты, постоянные расходы, расход API, по людям ──
  function secEconomy(d) {
    const e = d.economy;
    if (!e || e.error) return section('sec-economy', 'Экономика', '', card('Экономика', errBox(e, 'Раздел'), '', 'span2', 'i-coins', 'danger'));
    const rate = n(e.usdRate);
    const kgs = (v) => (n(v) == null ? '—' : n(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' сом');
    const byCur = e.payments.byCurrency || [];
    const paidKgs = (byCur.find((r) => r.currency === 'KGS') || {}).sum || 0;
    const paidN = byCur.reduce((s, r) => s + r.n, 0);
    const other = byCur.filter((r) => r.currency !== 'KGS').map((r) => `${fmt.num(r.sum, 2)} ${r.currency}`).join(', ');
    const apiUsd = e.api.totalUsd + e.api.visionUsd;
    const fx = e.fixed.monthlyByCurrency || {};
    const fixedUsd = fx.USD || 0, fixedKgs = fx.KGS || 0;
    const costKgs = rate ? (apiUsd + fixedUsd) * rate + fixedKgs : null;
    const margin = costKgs == null ? null : paidKgs - costKgs;
    const s = e.subscriptions;
    const tiles = [
      tile('Поступления за месяц', esc(kgs(paidKgs)), `${fmt.int(paidN)} оплат${other ? ' · ' + esc(other) : ''}`, { hero: true }),
      tile('Платных подписок', esc(fmt.int(s.paid)), `без срока ${fmt.int(s.unlimited)} · истекли ${fmt.int(s.expired)}`),
      tile('Ожидаемо в месяц', esc(kgs(s.mrrKgs)), 'по тарифам действующих подписок'),
      tile('Расход API за месяц', esc(fmt.usd(apiUsd)), `модель ${fmt.usd(e.api.modelUsd)} · Document AI ${fmt.usd(e.api.docaiUsd)} · Vision ${fmt.usd(e.api.visionUsd)}`),
      tile('Постоянные расходы', esc(fmt.usd(fixedUsd)) + (fixedKgs ? ` + ${esc(kgs(fixedKgs))}` : ''), 'в месяц: сервер, домен и прочее'),
      tile('Маржа за месяц', margin == null ? '—' : esc(kgs(margin)),
        margin == null ? st('none', 'нет курса НБКР') : st(margin >= 0 ? 'ok' : 'bad', margin >= 0 ? 'в плюсе' : 'в минусе') + ` <span class="small">расходы по курсу ${fmt.num(rate, 2)}</span>`),
    ];
    // Поступления по месяцам — 12 месяцев, пустые тоже на оси.
    const today = ymdOf(d.now);
    const [ty, tm] = today.split('-').map(Number);
    const pts = [];
    for (let i = 11; i >= 0; i--) {
      const dt = new Date(Date.UTC(ty, tm - 1 - i, 1));
      const key = dt.toISOString().slice(0, 7);
      const sum = (e.payments.byMonth || []).filter((r) => r.m === key && r.currency === 'KGS').reduce((a, r) => a + r.sum, 0);
      pts.push({ label: key.slice(5) + '.' + key.slice(2, 4), value: sum, tip: `${key.slice(5)}.${key.slice(0, 4)}: ${kgs(sum)}` });
    }
    const per = { month: 'в месяц', year: 'в год', once: 'разово' };
    const planName = (k) => (e.plans && e.plans[k] ? e.plans[k].name : k || '—');
    const plansRows = Object.values(e.plans || {}).map((p) => [`<span style="white-space:nowrap">${esc(p.name)}</span>`, `<span style="white-space:nowrap">${esc(fmt.int(p.price))} сом</span>`, `${esc(fmt.int(p.day))} / ${esc(fmt.int(p.month))}`, esc(fmt.int(p.pages))]);
    const fixedRows = (e.fixed.rows || []).map((x) => [esc(x.name), `${esc(fmt.num(x.amount, 2))} ${esc(x.currency)}`, esc(per[x.period] || x.period), `${esc(fmt.num(x.monthly, 2))} ${esc(x.currency)}`, `<span class="small">${esc(x.note || '')}</span>`]);
    const userRows = (e.users || []).map((u) => {
      const until = u.subscription_expires_at;
      const sub = !until ? '<span class="small">без срока</span>' : new Date(until) > new Date(d.now) ? esc(fmt.date(until)) : st('none', 'истекла ' + fmt.date(until));
      return [esc(u.email), esc(planName(u.ai_plan)), sub, esc(kgs(u.paid_total)), esc(kgs(u.paid_month)), esc(fmt.usd4(u.cost_total)), esc(fmt.usd4(u.cost_month)), esc(fmt.int(u.q_month)), esc(fmt.int(u.p_month))];
    });
    const recentRows = (e.payments.recent || []).map((p) => [esc(fmt.dt(p.created_at)), esc(p.email), `${esc(fmt.num(p.amount, 0))} ${esc(p.currency)}`, esc(planName(p.plan)), esc(fmt.int(p.months)), p.paid_until ? esc(fmt.date(p.paid_until)) : '—', esc(p.method || '')]);
    return section('sec-economy', 'Экономика', `месяц ${esc(fmt.date(e.month + '-01').slice(3))} по Бишкеку · курс НБКР ${rate ? esc(fmt.num(rate, 2)) + ' сом за $' : 'недоступен'}`,
      tilesCard(tiles)
      + card('Поступления по месяцам', columns(pts, { unit: 'Сом', xName: 'Месяц', aria: 'Поступления за 12 месяцев' }), 'оплаты в сомах, последние 12 месяцев', '', 'i-coins')
      + card('Тарифы', table(['Тариф', '#Цена в месяц', '#Вопросов в день / в месяц', '#Страниц в месяц'], plansRows), 'сетка от 22.09.2026', '', 'i-check')
      + card('Постоянные расходы', table(['Статья', '#Сумма', 'Период', '#В месяц', 'Заметка'], fixedRows, 'Постоянных расходов не записано.'), 'правятся в админке: «Оплаты и расходы»', 'span2', 'i-db')
      + card('Пользователи: заплатил и стоил', table(['Учётная запись', 'Тариф', 'До', '#Оплатил всего', '#За месяц', '#Стоил всего', '#За месяц', '#Вопр.', '#Стр.'], userRows, 'Пользователей нет.'), 'оплаты в сомах, расход API в долларах', 'span2', 'i-users')
      + card('Последние оплаты', table(['Когда', 'Кто', '#Сумма', 'Тариф', '#Мес.', 'До', 'Способ'], recentRows, 'Оплат ещё не записано: кнопка «Оплата» в строке пользователя в админке.'), 'последние 10', 'span2', 'i-coins'));
  }

  const ACTIONS = { create_user: 'создал учётную запись', set_role: 'изменил роль', enable_user: 'включил', disable_user: 'отключил',
    set_ai_plan: 'изменил тариф AI', set_subscription: 'изменил срок подписки', delete_user: 'удалил учётную запись', terms_accepted: 'принял правила',
    payment: 'записал оплату', delete_payment: 'удалил запись об оплате', expense_add: 'добавил статью расходов', expense_delete: 'удалил статью расходов' };
  function detailText(action, det) {
    if (!det || typeof det !== 'object') return '';
    const parts = [];
    if (det.email) parts.push(det.email);
    if (det.role) parts.push('роль ' + det.role);
    if (det.plan) parts.push('тариф ' + det.plan);
    if ('subscription_expires_at' in det) parts.push(det.subscription_expires_at ? 'до ' + fmt.date(det.subscription_expires_at) : 'без срока');
    if (det.version) parts.push('редакция ' + det.version);
    if (det.amount != null) parts.push(`${det.amount} ${det.currency || ''}`.trim());
    if (det.months) parts.push(det.months + ' мес.');
    if (det.paid_until) parts.push('до ' + fmt.date(det.paid_until));
    if (det.method) parts.push(det.method);
    if (det.name) parts.push(det.name);
    if (det.period) parts.push({ month: 'в месяц', year: 'в год', once: 'разово' }[det.period] || det.period);
    for (const [k, v] of Object.entries(det)) if (!['email', 'role', 'plan', 'subscription_expires_at', 'version', 'amount', 'currency', 'months', 'paid_until', 'method', 'name', 'period'].includes(k)) parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return parts.join(' · ');
  }
  function secAudit(d) {
    const rows = d.audit;
    if (!rows || rows.error) return section('sec-audit', 'Журнал администрирования', '', card('Журнал администрирования', errBox(rows, 'Раздел'), '', 'span2', 'i-clipboard', 'danger'));
    const body = table(['Когда', 'Кто', 'Действие', 'Над кем', 'Подробности'], rows.map((r) => [
      esc(fmt.dt(r.created_at)), esc(r.actor || '(удалён)'), esc(ACTIONS[r.action] || r.action),
      esc(r.target || (r.detail && r.detail.email) || '—'), `<span class="small">${esc(detailText(r.action, r.detail))}</span>`,
    ]), 'Записей нет.');
    return section('sec-audit', 'Журнал администрирования', 'admin_audit_log · последние 20 записей',
      card('Действия администраторов', body, 'кто, когда и что сделал с учётными записями', 'span2', 'i-clipboard'));
  }

  // ── Сборка и цикл обновления ─────────────────────────────────────────────────
  let ctx = null, timer = null, tick = null, last = null, lastAt = 0, fetching = false;
  function render(d) {
    const html = [secHealth(d), secHttp(d), secUsers(d), secEngine(d), secAssistant(d), secEconomy(d), secBase(d), secAudit(d)].join('');
    ctx.mount.innerHTML = html;
    bindTips(ctx.mount);
    if (ctx.onRender) ctx.onRender(); // страница подсвечивает раздел в меню по прокрутке
  }
  function stamp() {
    if (!ctx || !ctx.stamp) return;
    if (!lastAt) { ctx.stamp.textContent = ''; return; }
    const age = Date.now() - lastAt;
    ctx.stamp.textContent = 'обновлено ' + fmt.time(new Date(lastAt).toISOString()) + (age > 180e3 ? ' · устарело' : '');
    ctx.stamp.classList.toggle('stale', age > 180e3);
  }
  async function load() {
    if (fetching || !ctx) return;
    fetching = true;
    ctx.mount.classList.add('loading');
    if (ctx.refresh) ctx.refresh.disabled = true;
    try {
      const res = await fetch('/api/dash/data', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { stop(); ctx.onSessionEnd(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      last = await res.json();
      lastAt = Date.now();
      render(last);
    } catch (e) {
      const msg = `<div class="msg bad show">Не удалось обновить данные: ${esc(e.message)}. ${last ? 'Показаны данные на ' + esc(fmt.time(new Date(lastAt).toISOString())) + '.' : ''}</div>`;
      if (last) ctx.mount.insertAdjacentHTML('afterbegin', msg); else ctx.mount.innerHTML = msg;
    } finally {
      fetching = false;
      if (ctx) { ctx.mount.classList.remove('loading'); if (ctx.refresh) ctx.refresh.disabled = false; }
      stamp();
    }
  }
  function stop() {
    clearInterval(timer); clearInterval(tick); timer = tick = null;
    last = null; lastAt = 0;
    if (ctx && ctx.mount) ctx.mount.innerHTML = '';
    ctx = null;
  }
  function onVisible() { if (document.visibilityState === 'visible' && ctx && Date.now() - lastAt > 60e3) load(); }
  document.addEventListener('visibilitychange', onVisible);

  window.dashStart = function (c) {
    stop();
    ctx = c;
    if (ctx.refresh) ctx.refresh.onclick = () => load();
    load();
    timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60e3);
    tick = setInterval(stamp, 10e3);
  };
  window.dashStop = stop;
  window.dashTheme = function () { if (last && ctx) render(last); };
})();
