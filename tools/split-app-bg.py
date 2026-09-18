# python tools/split-app-bg.py — пересобирает app-bg-*.webp и app-logo-*.webp из logo_dark.png / logo_white.png.
# Разделяет картинку владельца на фон без логотипа и логотип с прозрачностью.
# Фон под логотипом восстанавливается патчем Кунса по четырём краям рамки;
# логотип — «цвет в прозрачность» относительно восстановленного фона, поэтому
# поверх того же фона он даёт исходные пиксели, а свечение «KG» остаётся полупрозрачным.
from PIL import Image
import numpy as np, json, os  # pip install numpy pillow
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
JOBS = {'dark': ('logo_dark.png', (40, 6, 440, 108)), 'light': ('logo_white.png', (127, 20, 472, 112))}
report = {}
for name, (src, (x0, y0, x1, y1)) in JOBS.items():
    P = np.asarray(Image.open(ROOT + src).convert('RGB')).astype(np.float64)
    h, w, _ = P.shape
    T = P[y0 - 4:y0 - 1, x0:x1 + 1].mean(axis=0)      # верхний край, среднее трёх строк
    Bm = P[y1 + 1:y1 + 4, x0:x1 + 1].mean(axis=0)     # нижний
    L = P[y0:y1 + 1, x0 - 4:x0 - 1].mean(axis=1)      # левый
    R = P[y0:y1 + 1, x1 + 1:x1 + 4].mean(axis=1)      # правый
    if name == 'light':  # слева у светлой — сетка точек: край берётся плавным переходом между углами
        k = np.linspace(0, 1, y1 - y0 + 1)[:, None]
        L = (1 - k) * T[0] + k * Bm[0]
    ys = np.arange(y0, y1 + 1); xs = np.arange(x0, x1 + 1)
    v = ((ys - y0) / (y1 - y0))[:, None, None]; u = ((xs - x0) / (x1 - x0))[None, :, None]
    Tx, Bx = T[None, :, :], Bm[None, :, :]; Ly, Ry = L[:, None, :], R[:, None, :]
    C = (1 - v) * Tx + v * Bx + (1 - u) * Ly + u * Ry \
        - ((1 - u) * (1 - v) * T[0] + u * (1 - v) * T[-1] + (1 - u) * v * Bm[0] + u * v * Bm[-1])
    C = np.clip(C, 0, 255)
    Bg = P.copy(); Bg[y0:y1 + 1, x0:x1 + 1] = C
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
    report[name] = {'logo_size': logo.size, 'crop_in_image': [int(x0 + cx0), int(y0 + cy0), int(x0 + cx1), int(y0 + cy1)],
                    'visible_h': int(vy.max() - vy.min() + 1), 'visible_w': int(vx.max() - vx.min() + 1),
                    'visible_offset_in_logo': [int(vx.min() - cx0 + 3), int(vy.min() - cy0 + 3)]}
    logo.save(ROOT + f'app-logo-{name}.webp', 'WEBP', lossless=True)
    Image.fromarray(Bg.astype(np.uint8)).save(ROOT + f'app-bg-{name}.webp', 'WEBP', quality=82, method=6)
    report[name]['bg_kb'] = os.path.getsize(ROOT + f'app-bg-{name}.webp') // 1024
    report[name]['logo_kb'] = os.path.getsize(ROOT + f'app-logo-{name}.webp') / 1024
print(json.dumps(report, indent=1))
