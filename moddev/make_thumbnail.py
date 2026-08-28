"""
Generates thumbnail.png for the Quant Broker mod.

The image is the mod's thesis in one picture: a price line wandering through a
learned quantile band, buying where it drops below the low quantile and selling
where it pokes above the high one, climbing toward the cookie.

Drawn at 4x and downsampled for antialiasing.

    python dev/make_thumbnail.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT_SIZE = 512
SS = 4                      # supersampling factor
S = OUT_SIZE * SS           # working canvas size

# Cookie Clicker bank palette
BG_DARK    = (11, 14, 7)
BG_LIGHT   = (30, 38, 18)
GREEN      = (121, 198, 0)
GREEN_SOFT = (148, 205, 80)
RED        = (255, 92, 92)
LINE       = (238, 246, 228)
COOKIE     = (196, 145, 84)
COOKIE_RIM = (150, 104, 55)
CHIP       = (68, 40, 24)


def px(v):
    """Normalised 0..1 coordinate -> working-canvas pixels."""
    return v * S


# --- the price path -------------------------------------------------------
# Hand-placed rather than random, so the shape is deliberate: a dip under the
# buy line early, a spike over the sell line in the middle, then a climb.
BUY_Y = 0.715
SELL_Y = 0.345

PATH = [
    (0.045, 0.605), (0.100, 0.660), (0.150, 0.590), (0.200, 0.680),
    (0.250, 0.640), (0.305, 0.775), (0.355, 0.735), (0.405, 0.640),
    (0.450, 0.560), (0.495, 0.470), (0.545, 0.300), (0.590, 0.380),
    (0.635, 0.455), (0.680, 0.415), (0.725, 0.480), (0.770, 0.375),
    (0.815, 0.300),
]

COOKIE_AT = (0.845, 0.243)
COOKIE_R = 0.108

BUY_MARK = (0.305, 0.775)
SELL_MARK = (0.545, 0.300)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vignette_background():
    """Dark base with a soft lighter glow behind the middle of the chart."""
    bg = Image.new("RGB", (S, S), BG_DARK)
    glow = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(glow)
    cx, cy, r = px(0.52), px(0.48), px(0.62)
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=180)
    glow = glow.filter(ImageFilter.GaussianBlur(px(0.16)))
    bg.paste(Image.new("RGB", (S, S), BG_LIGHT), (0, 0), glow)
    return bg


def draw_grid(d):
    step = 1.0 / 7
    for i in range(1, 7):
        v = px(i * step)
        d.line([(px(0.02), v), (px(0.98), v)], fill=(255, 255, 255, 16), width=int(px(0.004)))
        d.line([(v, px(0.02)), (v, px(0.98))], fill=(255, 255, 255, 12), width=int(px(0.004)))


def draw_band(d):
    """The hold zone between the two learned quantiles."""
    d.rectangle([px(0.02), px(SELL_Y), px(0.98), px(BUY_Y)], fill=GREEN + (26,))

    dash = px(0.032)
    gap = px(0.022)
    for y, colour in ((SELL_Y, RED + (200,)), (BUY_Y, GREEN + (215,))):
        x = px(0.03)
        while x < px(0.97):
            d.line([(x, px(y)), (min(x + dash, px(0.97)), px(y))],
                   fill=colour, width=int(px(0.009)))
            x += dash + gap


def draw_price_line(base):
    """Glowing polyline, drawn on its own layer so the glow can be blurred."""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pts = [(px(x), px(y)) for x, y in PATH]
    d.line(pts, fill=LINE + (255,), width=int(px(0.019)), joint="curve")

    glow = layer.filter(ImageFilter.GaussianBlur(px(0.022)))
    tinted = Image.new("RGBA", (S, S), GREEN_SOFT + (0,))
    tinted.putalpha(glow.split()[3].point(lambda a: int(a * 0.75)))

    base.alpha_composite(tinted)
    base.alpha_composite(layer)


def draw_marker(d, at, kind):
    """Buy = green triangle pointing up, sell = red triangle pointing down."""
    x, y = px(at[0]), px(at[1])
    r = px(0.052)
    off = px(0.072)
    if kind == "buy":
        cy = y + off
        pts = [(x, cy - r), (x - r * 0.88, cy + r * 0.72), (x + r * 0.88, cy + r * 0.72)]
        colour = GREEN
    else:
        cy = y - off
        pts = [(x, cy + r), (x - r * 0.88, cy - r * 0.72), (x + r * 0.88, cy - r * 0.72)]
        colour = RED
    d.polygon(pts, fill=colour + (255,))

    # a dotted leader from the marker to the point on the line
    steps = 4
    for i in range(steps):
        t0 = (i + 0.15) / steps
        t1 = (i + 0.65) / steps
        d.line([(x, cy + (y - cy) * t0), (x, cy + (y - cy) * t1)],
               fill=colour + (170,), width=int(px(0.006)))


def draw_cookie(base):
    """The chart's terminal node: a chocolate chip cookie with a warm glow."""
    cx, cy, r = px(COOKIE_AT[0]), px(COOKIE_AT[1]), px(COOKIE_R)

    glow = Image.new("L", (S, S), 0)
    ImageDraw.Draw(glow).ellipse([cx - r * 1.7, cy - r * 1.7, cx + r * 1.7, cy + r * 1.7], fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(px(0.045)))
    warm = Image.new("RGBA", (S, S), (255, 196, 110, 0))
    warm.putalpha(glow)
    base.alpha_composite(warm)

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=COOKIE_RIM + (255,))
    d.ellipse([cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9], fill=COOKIE + (255,))

    # a soft top-left highlight
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse(
        [cx - r * 0.72, cy - r * 0.78, cx + r * 0.18, cy - r * 0.06],
        fill=(255, 220, 170, 60))
    layer.alpha_composite(hl.filter(ImageFilter.GaussianBlur(px(0.012))))

    chips = [(-0.40, -0.34, 0.20), (0.30, -0.42, 0.17), (0.44, 0.20, 0.19),
             (-0.16, 0.30, 0.21), (-0.52, 0.22, 0.15), (0.02, -0.06, 0.16)]
    for dx, dy, cr in chips:
        ccx, ccy, crr = cx + r * dx, cy + r * dy, r * cr
        d.ellipse([ccx - crr, ccy - crr, ccx + crr, ccy + crr], fill=CHIP + (255,))

    base.alpha_composite(layer)


def draw_border(d):
    inset = px(0.012)
    d.rounded_rectangle([inset, inset, S - inset, S - inset],
                        radius=px(0.115), outline=GREEN + (255,), width=int(px(0.014)))


def main():
    base = vignette_background().convert("RGBA")
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    draw_grid(d)
    draw_band(d)
    base.alpha_composite(overlay)

    draw_price_line(base)

    marks = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    md = ImageDraw.Draw(marks)
    draw_marker(md, BUY_MARK, "buy")
    draw_marker(md, SELL_MARK, "sell")
    base.alpha_composite(marks)

    draw_cookie(base)

    frame = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw_border(ImageDraw.Draw(frame))
    base.alpha_composite(frame)

    # round the outer corners so the tile is not a hard square
    base.putalpha(rounded_mask(S, int(px(0.115))))

    out = base.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "thumbnail.png")
    out.save(path, "PNG", optimize=True)
    print("wrote %s (%dx%d, %d bytes)" % (path, OUT_SIZE, OUT_SIZE, os.path.getsize(path)))


if __name__ == "__main__":
    main()
