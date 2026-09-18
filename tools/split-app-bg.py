# python tools/split-app-bg.py — пересобирает фоны и логотипы из картинок владельца:
#   logo_dark.png / logo_white.png   → app-bg-*.webp и app-logo-*.webp   (фон приложения, логотип в шапке)
#   logo_dark1.png / logo_white1.png → login-bg-*.webp и login-logo-*.webp (фон и логотип экрана входа)
# Разделяет картинку владельца на фон без логотипа и логотип с прозрачностью.
# Фон под логотипом восстанавливается патчем Кунса по четырём краям рамки (режим 'coons'), а где рядом
# с логотипом есть яркие детали фона — закраской по маске пикселей логотипа (режим 'inpaint', OpenCV Telea):
# маска строится по отличию от устойчивой заплатки, и закрашивается только сам логотип, а не вся рамка;
# логотип — «цвет в прозрачность» относительно восстановленного фона, поэтому
# поверх того же фона он даёт исходные пиксели, а свечение «KG» остаётся полупрозрачным.
from PIL import Image
import numpy as np, json, os  # pip install numpy pillow opencv-python-headless
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
# (исходник, рамка логотипа x0,y0,x1,y1 с запасом на свечение «KG», префикс файлов, левый край — плавный переход между углами,
#  режим восстановления фона)
# Рамки сняты по картинкам; у logo_white.png слева от логотипа сетка точек, поэтому край берётся не с неё.
# У logo_dark1.png ниже и левее лупы проходит светящаяся дуга: прямоугольная заплатка её размазывает или чернит,
# поэтому там 'inpaint'.
JOBS = {'app-dark': ('logo_dark.png', (40, 6, 440, 108), 'app', False, 'coons'), 'app-light': ('logo_white.png', (127, 20, 472, 112), 'app', True, 'coons'),
        'login-dark': ('logo_dark1.png', (140, 62, 632, 181), 'login', False, 'inpaint'), 'login-light': ('logo_white1.png', (96, 58, 566, 182), 'login', False, 'coons')}


def robust_line(E):
    # E — цвета вдоль края (n×3). Прямая по каждому каналу с отбрасыванием выбросов (три прохода, 2,5 MAD);
    # прямой заменяются только выбросы, остальные точки остаются как есть — иначе на шве видна ступенька.
    n = len(E); x = np.arange(n); keep = np.ones(n, bool); out = E.copy()
    for c in range(3):
        k = keep.copy()
        for _ in range(3):
            a, b = np.polyfit(x[k], E[k, c], 1); r = E[:, c] - (a * x + b)
            mad = np.median(np.abs(r[k])) + 1e-6; k = np.abs(r) < 2.5 * 1.4826 * mad
        bad = ~k
        # выброс расширяется на 4 точки в обе стороны: у свечения мягкий край
        bad = np.convolve(bad.astype(int), np.ones(9, int), 'same') > 0
        out[bad, c] = (a * x + b)[bad]
    # сглаживание вдоль края: мелкая текстура фона на краю иначе тянется полосами через всю заплатку
    pad = np.pad(out, ((7, 7), (0, 0)), mode='edge')
    return np.stack([np.convolve(pad[:, c], np.ones(15) / 15, 'valid') for c in range(3)], axis=1)
report = {}
for key, (src, (x0, y0, x1, y1), prefix, smooth_left, mode) in JOBS.items():
    name = key.split('-')[1]
    P = np.asarray(Image.open(ROOT + src).convert('RGB')).astype(np.float64)
    h, w, _ = P.shape
    T = P[y0 - 4:y0 - 1, x0:x1 + 1].mean(axis=0)      # верхний край, среднее трёх строк
    Bm = P[y1 + 1:y1 + 4, x0:x1 + 1].mean(axis=0)     # нижний
    L = P[y0:y1 + 1, x0 - 4:x0 - 1].mean(axis=1)      # левый
    R = P[y0:y1 + 1, x1 + 1:x1 + 4].mean(axis=1)      # правый
    if mode == 'inpaint':
        T, Bm, L, R = robust_line(T), robust_line(Bm), robust_line(L), robust_line(R)
    if smooth_left:
        k = np.linspace(0, 1, y1 - y0 + 1)[:, None]
        L = (1 - k) * T[0] + k * Bm[0]
    ys = np.arange(y0, y1 + 1); xs = np.arange(x0, x1 + 1)
    v = ((ys - y0) / (y1 - y0))[:, None, None]; u = ((xs - x0) / (x1 - x0))[None, :, None]
    Tx, Bx = T[None, :, :], Bm[None, :, :]; Ly, Ry = L[:, None, :], R[:, None, :]
    C = (1 - v) * Tx + v * Bx + (1 - u) * Ly + u * Ry \
        - ((1 - u) * (1 - v) * T[0] + u * (1 - v) * T[-1] + (1 - u) * v * Bm[0] + u * v * Bm[-1])
    C = np.clip(C, 0, 255)
    Bg = P.copy(); Bg[y0:y1 + 1, x0:x1 + 1] = C
    if mode == 'inpaint':
        import cv2
        d = np.abs(P[y0:y1 + 1, x0:x1 + 1] - C).max(axis=2)
        m = np.zeros((h, w), np.uint8); m[y0:y1 + 1, x0:x1 + 1] = (d > 10).astype(np.uint8) * 255
        m = cv2.dilate(m, np.ones((9, 9), np.uint8))
        src8 = np.ascontiguousarray(P[:, :, ::-1].astype(np.uint8))
        Bg = cv2.inpaint(src8, m, 7, cv2.INPAINT_TELEA)[:, :, ::-1].astype(np.float64)
        C = Bg[y0:y1 + 1, x0:x1 + 1]
    # логотип: цвет в прозрачность относительно восстановленного фона (минимальная альфа)
    Pr = P[y0:y1 + 1, x0:x1 + 1]; Br = np.clip(C, 1, 254)
    # допуск 6 уровней: у тёмного фона красный канал ≈ 0, у светлого синий ≈ 255, и без допуска
    # разница в один уровень давала бы полную непрозрачность
    up = np.where(Pr - Br > 6, (Pr - Br) / (255 - Br), 0); dn = np.where(Br - Pr > 6, (Br - Pr) / Br, 0)
    a = np.maximum(up, dn).max(axis=2)
    a = np.where(a < 0.06, 0, a)                      # шум фона — полностью прозрачный
    col = np.where(a[..., None] > 0, (Pr - (1 - a[..., None]) * Br) / np.maximum(a[..., None], 1e-6), 0)
    rgba = np.dstack([np.clip(col, 0, 255), a * 255]).astype(np.uint8)
    ys_, xs_ = np.where(a > 0.08)
    cy0, cy1, cx0, cx1 = ys_.min(), ys_.max(), xs_.min(), xs_.max()
    logo = Image.fromarray(rgba, 'RGBA').crop((max(cx0 - 3, 0), max(cy0 - 3, 0), cx1 + 4, cy1 + 4))
    vy, vx = np.where(a > 0.5)                          # «видимая» часть без слабого свечения
    report[key] = {'logo_size': logo.size, 'crop_in_image': [int(x0 + cx0), int(y0 + cy0), int(x0 + cx1), int(y0 + cy1)],
                    'visible_h': int(vy.max() - vy.min() + 1), 'visible_w': int(vx.max() - vx.min() + 1),
                    'visible_offset_in_logo': [int(vx.min() - cx0 + 3), int(vy.min() - cy0 + 3)]}
    logo.save(ROOT + f'{prefix}-logo-{name}.webp', 'WEBP', lossless=True)
    Image.fromarray(Bg.astype(np.uint8)).save(ROOT + f'{prefix}-bg-{name}.webp', 'WEBP', quality=82, method=6)
    report[key]['bg_kb'] = os.path.getsize(ROOT + f'{prefix}-bg-{name}.webp') // 1024
    report[key]['logo_kb'] = os.path.getsize(ROOT + f'{prefix}-logo-{name}.webp') / 1024
print(json.dumps(report, indent=1))
