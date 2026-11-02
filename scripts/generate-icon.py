"""Render the ZHH monogram and standard multi-resolution Windows icons."""
from pathlib import Path
import struct

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIDE = 1024


def xy(points):
    return [(round((x + 13) * SCALE), round(y * SCALE)) for x, y in points]


z = [(146, 320), (354, 320), (354, 375), (218, 624), (354, 624),
     (354, 680), (140, 680), (140, 625), (277, 376), (146, 376)]
h1 = [(408, 320), (466, 320), (466, 468), (548, 468), (548, 320),
      (606, 320), (606, 680), (548, 680), (548, 532), (466, 532),
      (466, 680), (408, 680)]
h2 = [(660, 320), (718, 320), (718, 468), (800, 468), (800, 320),
      (858, 320), (858, 680), (800, 680), (800, 532), (718, 532),
      (718, 680), (660, 680)]

# Vector geometry is shared by the preview, the raster icon and the SVG source.
gradient = Image.new('RGBA', (1, SIDE * SCALE))
gradient.putdata([
    (round(29 - 15 * y / (SIDE * SCALE - 1)),
     round(83 - 37 * y / (SIDE * SCALE - 1)),
     round(68 - 25 * y / (SIDE * SCALE - 1)), 255)
    for y in range(SIDE * SCALE)
])
image = gradient.resize((SIDE * SCALE, SIDE * SCALE))
glow = Image.new('RGBA', image.size, (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((-150*SCALE, -200*SCALE, 840*SCALE, 510*SCALE), fill=(104, 169, 131, 40))
image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(100*SCALE)))
mask = Image.new('L', image.size)
ImageDraw.Draw(mask).rounded_rectangle((52*SCALE, 52*SCALE, 972*SCALE, 972*SCALE), radius=214*SCALE, fill=255)
image.putalpha(mask)
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((77*SCALE, 77*SCALE, 947*SCALE, 947*SCALE), radius=192*SCALE, outline=(202, 224, 187, 48), width=2*SCALE)
for letter in [z, h1, h2]:
    draw.polygon(xy(letter), fill=(248, 248, 235, 255))
draw.rounded_rectangle((158*SCALE, 753*SCALE, 273*SCALE, 766*SCALE), radius=6*SCALE, fill=(212, 181, 107, 255))
draw.line((306*SCALE, 760*SCALE, 871*SCALE, 760*SCALE), fill=(172, 207, 178, 85), width=2*SCALE)
icon = image.resize((SIDE, SIDE), Image.Resampling.LANCZOS)
icon.save(ROOT / 'build/icon.png')
icon.resize((256, 256), Image.Resampling.LANCZOS).save(ROOT / 'resources/app-icon.png')

sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
frames = []
for size in sizes:
    frame = icon.resize((size, size), Image.Resampling.LANCZOS)
    # BMP/DIB frames work for small shell icons as well as large Explorer icons.
    xor = frame.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes('raw', 'BGRA')
    mask_stride = ((size + 31) // 32) * 4
    and_mask = bytearray(mask_stride * size)
    alpha = frame.getchannel('A')
    for y in range(size):
        for x in range(size):
            if alpha.getpixel((x, size - y - 1)) == 0:
                and_mask[y * mask_stride + x // 8] |= 1 << (7 - x % 8)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    frames.append(header + xor + and_mask)
directory = bytearray(struct.pack('<HHH', 0, 1, len(sizes)))
offset = 6 + 16 * len(sizes)
for size, frame in zip(sizes, frames):
    directory += struct.pack('<BBBBHHII', size if size < 256 else 0, size if size < 256 else 0, 0, 0, 1, 32, len(frame), offset)
    offset += len(frame)
contents = bytes(directory) + b''.join(frames)
for output in [ROOT / 'build/icon.ico', ROOT / 'resources/app-icon.ico']:
    output.write_bytes(contents)

svg_paths = '\n'.join(
    '<path d="M ' + ' L '.join(f'{x},{y}' for x, y in points) + ' Z"/>'
    for points in [z, h1, h2]
)
(ROOT / 'build/icon.svg').write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="bg" x2=".25" y2="1"><stop stop-color="#1d5344"/><stop offset="1" stop-color="#0e2e2b"/></linearGradient></defs>
<rect x="52" y="52" width="920" height="920" rx="214" fill="url(#bg)"/>
<rect x="77" y="77" width="870" height="870" rx="192" fill="none" stroke="#cae0bb" stroke-opacity=".19" stroke-width="2"/>
<g fill="#f8f8eb" transform="translate(13)">{svg_paths}</g>
<rect x="158" y="753" width="115" height="13" rx="6" fill="#d4b56b"/>
<path d="M306 760H871" stroke="#accfb2" stroke-opacity=".33" stroke-width="2"/>
</svg>''')

preview = Image.new('RGB', (1200, 760), '#f3f4ed')
large = icon.resize((620, 620), Image.Resampling.LANCZOS)
preview.paste(large, (30, 50), large)
label_font = None
try:
    from PIL import ImageFont
    label_font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 20)
except OSError:
    pass
preview_draw = ImageDraw.Draw(preview)
for index, size in enumerate([256, 128, 64, 48, 32, 16]):
    x, y = [(730, 45), (730, 355), (935, 355), (1060, 355), (935, 520), (1060, 520)][index]
    frame = icon.resize((size, size), Image.Resampling.LANCZOS)
    preview.paste(frame, (x, y), frame)
    preview_draw.text((x, y + size + 14), f'{size} px', fill='#657369', font=label_font)
(ROOT / 'output').mkdir(exist_ok=True)
preview.save(ROOT / 'output/zhh-icon-preview.png')

# Decode every stored frame independently to verify dimensions and alpha data.
decoded = Image.open(ROOT / 'build/icon.ico')
assert decoded.ico.sizes() == {(size, size) for size in sizes}
for size in sizes:
    actual = decoded.ico.getimage((size, size)).convert('RGBA')
    expected = icon.resize((size, size), Image.Resampling.LANCZOS)
    assert ImageChops.difference(actual, expected).getbbox() is None
print(f'Generated ZHH SVG, PNG and {len(sizes)} verified 32-bit ICO sizes.')
