# -*- coding: utf-8 -*-
"""生成扩展图标：渐变圆角方块 + 白色「译」字。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(OUT, exist_ok=True)

TOP = (88, 101, 242)      # #5865F2
BOTTOM = (139, 92, 246)   # #8B5CF6
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"
SIZE = 512
SS = 4  # 超采样

def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def make(size):
    big = size * SS
    base = gradient(big)
    mask = rounded_mask(big, radius=round(big * 0.22))
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    # 自动选字号，让「译」占高度的 ~62%
    target_h = big * 0.62
    fs = round(target_h)
    font = ImageFont.truetype(FONT_PATH, fs)
    while True:
        bbox = draw.textbbox((0, 0), "译", font=font)
        h = bbox[3] - bbox[1]
        if h <= target_h or fs <= 10:
            break
        fs -= 2
        font = ImageFont.truetype(FONT_PATH, fs)

    bbox = draw.textbbox((0, 0), "译", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (big - w) / 2 - bbox[0]
    y = (big - h) / 2 - bbox[1]
    draw.text((x, y), "译", font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)

for s in (16, 32, 48, 128):
    icon = make(s)
    icon.save(os.path.join(OUT, f"icon{s}.png"))
    print("saved", os.path.join(OUT, f"icon{s}.png"))

# 预览大图
make(256).save(os.path.join(OUT, "preview.png"))
print("done")
