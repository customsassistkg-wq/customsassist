"""Собирает всю графику бренда из двух исходников в assets/source/.

    python tools/build-logo.py

  logo_mark.png  — вертикальный локап: эмблема, под ней название.
                   Отсюда берётся ТОЛЬКО эмблема: на 48 px подпись — каша.
  logo_wide.png  — горизонтальный локап, целиком.

Что переписывается: assets/icons/*.png, assets/email-logo.jpg и два data-URI внутри
tnved_checker.html (фавиконка в <head> и .auth-logo-img — она встречается
дважды, в герое и в карточке для телефона). Страницу читаем и пишем с
newline='': в ней намеренно смешанные концы строк (см. .gitattributes).
"""
import base64
import io
import os
import re

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Картинки сайта — в assets/, исходники владельца — в assets/source/ (см. CLAUDE.md).
SRC = os.path.join(ROOT, 'assets', 'source')
OUT = os.path.join(ROOT, 'assets')
WHITE = (255, 255, 255)

# Рамки содержимого в исходниках (белые поля отрезаны заранее, по bbox).
MARK_BOX = (198, 191, 1056, 891)   # эмблема внутри logo_mark.png
WIDE_BOX = (53, 283, 1626, 651)    # локап внутри logo_wide.png


def fit(img, w, h):
    r = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * r)), max(1, round(img.height * r))), Image.LANCZOS)


def square(img, size, frac):
    c = Image.new('RGB', (size, size), WHITE)
    s = fit(img, round(size * frac), round(size * frac))
    c.paste(s, ((size - s.width) // 2, (size - s.height) // 2))
    return c


def plate(img, width, pad):
    s = fit(img, width - 2 * pad, 10 ** 5)
    c = Image.new('RGB', (width, s.height + 2 * pad), WHITE)
    c.paste(s, (pad, pad))
    return c


def b64(img, fmt, **kw):
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return base64.b64encode(buf.getvalue()).decode()


mark = Image.open(os.path.join(SRC, 'logo_mark.png')).convert('RGB').crop(MARK_BOX)
wide = Image.open(os.path.join(SRC, 'logo_wide.png')).convert('RGB').crop(WIDE_BOX)

# Иконки. maskable — 62 %: Android режет иконку в круг и гарантирует только
# центральные 80 %. Фон белый, а не тёмно-синий: горы эмблемы сами синие.
for name, size, frac in [('icon-192', 192, .86), ('icon-512', 512, .86),
                         ('apple-touch-icon', 180, .86),
                         ('icon-maskable-192', 192, .62), ('icon-maskable-512', 512, .62)]:
    square(mark, size, frac).save(os.path.join(OUT, 'icons', name + '.png'), optimize=True)

# Логотип для писем: JPEG (WebP в почте до сих пор небезопасен), 220 px @2x.
plate(wide, 440, 12).save(os.path.join(OUT, 'email-logo.jpg'), 'JPEG', quality=90, optimize=True)

auth = plate(wide, 760, 34)
auth_b64 = b64(auth, 'WEBP', quality=88, method=6)
fav_b64 = b64(square(mark, 128, .88), 'PNG', optimize=True)

page = os.path.join(ROOT, 'tnved_checker.html')
src = open(page, encoding='utf-8', newline='').read()
img_tag = ('<img class="auth-logo-img" src="data:image/webp;base64,%s" alt="Customs Assist KG" '
           'width="%d" height="%d" decoding="async">' % (auth_b64, auth.width, auth.height))
src, n_img = re.subn(r'<img class="auth-logo-img" src="data:image/webp;base64,[A-Za-z0-9+/=]+"[^>]*>',
                     lambda m: img_tag, src)
src, n_fav = re.subn(r'<link rel="icon" type="image/png" href="data:image/png;base64,[A-Za-z0-9+/=]+">',
                     lambda m: '<link rel="icon" type="image/png" href="data:image/png;base64,%s">' % fav_b64, src)
assert (n_img, n_fav) == (2, 1), (n_img, n_fav)
open(page, 'w', encoding='utf-8', newline='').write(src)

print('логотип %dx%d, %d КБ base64; assets/icons и assets/email-logo.jpg перезаписаны'
      % (auth.width, auth.height, len(auth_b64) // 1024))
