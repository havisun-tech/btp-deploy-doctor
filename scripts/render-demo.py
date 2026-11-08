"""Renders the Deploy Doctor for SAP BTP terminal demo from real CLI output into GIF and MP4.

Usage (needs Pillow and imageio-ffmpeg):
  1. Copy examples/broken-bookshop to a temp folder <work>, and in it save the real output:
       btp-doctor check --no-color > <here>/1-check.txt
       btp-doctor fix --no-color   > <here>/2-fix.txt
       btp-doctor check --no-color > <here>/3-check.txt
       btp-doctor diagnose deploy.log --no-color > <here>/4-diagnose.txt
     where <here> is the folder containing this script.
  2. python render-demo.py <work> packages/vscode/images/icon.png <ffmpeg> <out-dir>
"""
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

D = os.path.dirname(os.path.abspath(__file__))
WORKDIR = sys.argv[1]          # absolute path of the demo project copy, replaced by ~/bookshop
ICON = sys.argv[2]
FFMPEG = sys.argv[3]
OUT = sys.argv[4]

S = 2                          # render scale; GIF is downscaled to 1x
COLS, ROWS = 100, 31
FS = 14 * S
reg = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', FS, index=0)
bold = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', FS, index=1)
CW = round(reg.getlength('M'))
LH = round(FS * 1.45)
PAD = 22 * S
BAR = 34 * S
W = PAD * 2 + CW * COLS
H = BAR + PAD * 2 + LH * ROWS
# Round up so both the 1x GIF and the 2x video have even dimensions (the encoder needs that).
W += (2 * S - W % (2 * S)) % (2 * S)
H += (2 * S - H % (2 * S)) % (2 * S)

BG, BARBG, FG = (30, 30, 30), (45, 45, 48), (212, 212, 212)
RED, YEL, CYAN, GREEN, DIM, WHITE, PROMPT = (241, 76, 76), (220, 180, 50), (41, 184, 219), (35, 209, 139), (128, 128, 128), (255, 255, 255), (86, 182, 194)


def read(name):
    t = open(os.path.join(D, name), encoding='utf8').read()
    return t.replace(WORKDIR, '~/bookshop').rstrip('\n').split('\n')


# ---------- colouring, mirroring the CLI's own palette ----------
def spans(line):
    m = re.match(r'^(✖ error |▲ warning|● info   )  (.*?)  (\S+ \S+)$', line)
    if m:
        col = {'✖': RED, '▲': YEL, '●': CYAN}[m.group(1)[0]]
        return [(m.group(1), col, False), ('  ', FG, False), (m.group(2), WHITE, True), ('  ' + m.group(3), DIM, False)]
    m = re.match(r'^(\s*)(Auto-fix:|Quick fix \(review first\):)(.*)$', line)
    if m:
        return [(m.group(1), FG, False), (m.group(2), CYAN, False), (m.group(3), FG, False)]
    m = re.match(r'^(\s*)(Fix:)(.*)$', line)
    if m:
        return [(m.group(1), FG, False), (m.group(2), GREEN, False), (m.group(3), FG, False)]
    m = re.match(r'^(✔)(.*?)(  \S+ · .*)$', line)
    if m:
        return [(m.group(1), GREEN, False), (m.group(2), FG, False), (m.group(3), DIM, False)]
    m = re.match(r'^(\d+\.)( .*?)(  line .*)$', line)
    if m:
        return [(m.group(1), RED, False), (m.group(2), WHITE, True), (m.group(3), DIM, False)]
    if re.match(r'^\s+> ', line):
        return [(line, DIM, False)]
    if line.startswith('Deploy Doctor for SAP BTP:') or line.startswith('Found ') or line in ('Next:',) or line.startswith('MTA deploy operations'):
        return [(line, WHITE, True)]
    if re.match(r'^\d+ errors?, ', line) or line.startswith('Remaining:'):
        good = line.startswith('0 errors, 0 warnings') or 'Remaining: 0 errors, 0 warnings' in line
        return [(line, GREEN if good else WHITE, True)]
    if re.match(r'^\d+ can be fixed automatically', line):
        return [(line, DIM, False)]
    return [(line, FG, False)]


def wrap(sp):
    """Wraps a span line to COLS, continuing with the line's own indent."""
    text = ''.join(t for t, _, _ in sp)
    if len(text) <= COLS:
        return [sp]
    indent = len(text) - len(text.lstrip(' '))
    if indent == 0:
        indent = 13 if re.match(r'^(✖|▲|●)', text) else 3
    out, cur, n = [], [], 0
    for t, c, b in sp:
        while t:
            room = COLS - n
            if len(t) <= room:
                cur.append((t, c, b)); n += len(t); t = ''
            else:
                cut = t.rfind(' ', 0, room + 1)
                if cut <= 0:
                    cut = room
                cur.append((t[:cut], c, b)); out.append(cur)
                t = t[cut:].lstrip(' ')
                cur, n = [(' ' * indent, FG, False)], indent
    out.append(cur)
    return out


# ---------- drawing ----------
def chrome(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=12 * S, fill=BG)
    d.rounded_rectangle([0, 0, W - 1, BAR + 12 * S], radius=12 * S, fill=BARBG)
    d.rectangle([0, BAR, W - 1, BAR + 12 * S], fill=BG)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        x, y, r = PAD + i * 22 * S, BAR // 2, 6 * S
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)
    title = 'bookshop — btp-doctor'
    tf = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 12 * S, index=0)
    d.text(((W - tf.getlength(title)) / 2, BAR / 2), title, font=tf, fill=(170, 170, 170), anchor='lm')
    return d


def frame(lines, cursor=None):
    img = Image.new('RGB', (W, H), (0, 0, 0))
    # transparent-looking outer corners: fill with page white so the GIF sits on light pages
    img.paste((255, 255, 255), [0, 0, W, H])
    d = chrome(img)
    rows = lines[-ROWS:]
    for r, sp in enumerate(rows):
        x, y = PAD, BAR + PAD + r * LH
        for t, c, b in sp:
            d.text((x, y), t, font=bold if b else reg, fill=c)
            x += CW * len(t)
    if cursor is not None:
        r = min(len(lines), ROWS) - 1
        cx = PAD + CW * cursor
        y = BAR + PAD + r * LH
        d.rectangle([cx, y + 2 * S, cx + CW - 1, y + LH - 4 * S], fill=FG)
    return img


def end_card():
    img = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=12 * S, fill=(11, 24, 52))
    icon = Image.open(ICON).convert('RGBA').resize((150 * S, 150 * S), Image.LANCZOS)
    big = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 32 * S, index=1)
    mid = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16 * S, index=0)
    small = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 14 * S, index=0)
    soft, accent = (200, 212, 240), (110, 200, 255)
    lines = [
        ('Deploy Doctor for SAP BTP', big, WHITE, 58),
        ('Catch SAP BTP deployment mistakes before cf deploy', mid, soft, 32),
        ('Free for VS Code and SAP Business Application Studio', mid, soft, 56),
        ('Search "Deploy Doctor for SAP BTP" in the Extensions view', small, accent, 30),
        ('havisun.com', small, (150, 160, 185), 0),
    ]
    block = icon.height + 36 * S + sum(g for *_, g in lines) * S + LH
    y = (H - block) // 2
    img.paste(icon, ((W - icon.width) // 2, y), icon)
    y += icon.height + 36 * S
    for text, f, c, gap in lines:
        d.text(((W - f.getlength(text)) / 2, y), text, font=f, fill=c)
        y += gap * S
    return img


# ---------- timeline ----------
frames = []  # (image, ms)


def add(img, ms):
    frames.append((img, ms))


PROMPT_TXT = '~/bookshop $ '


def prompt_line(cmd=''):
    return [(PROMPT_TXT, PROMPT, True), (cmd, WHITE, False)]


def scene(cmd, output, hold, keep_before=None):
    screen = list(keep_before or [])
    # idle cursor, then typing
    add(frame(screen + [prompt_line()], cursor=len(PROMPT_TXT)), 500)
    step = 2
    for i in range(step, len(cmd) + step, step):
        add(frame(screen + [prompt_line(cmd[:i])], cursor=len(PROMPT_TXT) + min(i, len(cmd))), 55)
    add(frame(screen + [prompt_line(cmd)], cursor=len(PROMPT_TXT) + len(cmd)), 350)
    screen = screen + [prompt_line(cmd)]
    wrapped = [w for line in output for w in wrap(spans(line))]
    chunk = 3
    for i in range(0, len(wrapped), chunk):
        screen = screen + wrapped[i:i + chunk]
        add(frame(screen), 45)
    add(frame(screen + [prompt_line()], cursor=len(PROMPT_TXT)), hold)
    return screen


check = read('1-check.txt')
# Condensed view of the real check output: each finding's title and its one-click fix.
condensed = [check[0], '']
for l in check[2:]:
    if re.match(r'^(✖|▲|●) ', l) or re.match(r'^\s+Auto-fix:', l):
        condensed.append(l)
condensed += [''] + [l for l in check if re.match(r'^\d+ errors?, |^\d+ can be fixed', l)]

fix = read('2-fix.txt')
recheck = read('3-check.txt')
recheck = [recheck[0], ''] + [l for l in recheck if re.match(r'^(●|▲|✖) ', l)] + ['', recheck[-1]]

diag = read('4-diagnose.txt')
diag_short = [diag[0], '']
for l in diag[2:]:
    if re.match(r'^\d+\. ', l) or re.match(r'^\s+Fix:', l):
        diag_short.append(l)
    if l.startswith('MTA deploy operations'):
        break

scene('btp-doctor check', condensed, 4200)
scene('btp-doctor fix', fix, 4200)
scene('btp-doctor check', recheck, 2200)
scene('btp-doctor diagnose deploy.log', diag_short, 5500)
add(end_card(), 3500)

# ---------- write outputs ----------
os.makedirs(OUT, exist_ok=True)
png_dir = os.path.join(OUT, 'frames')
os.makedirs(png_dir, exist_ok=True)

# GIF at 1x
small = [(im.resize((W // S, H // S), Image.LANCZOS), ms) for im, ms in frames]
pal = [im.convert('P', palette=Image.ADAPTIVE, colors=64) for im, _ in small]
pal[0].save(os.path.join(OUT, 'btp-deploy-doctor-demo.gif'), save_all=True, append_images=pal[1:],
            duration=[ms for _, ms in small], loop=0, optimize=True, disposal=1)

# MP4 at 2x via the concat demuxer (exact per-frame durations)
lst = os.path.join(png_dir, 'list.txt')
with open(lst, 'w') as f:
    for i, (im, ms) in enumerate(frames):
        p = os.path.join(png_dir, f'{i:04d}.png')
        im.save(p)
        f.write(f"file '{p}'\nduration {ms / 1000:.3f}\n")
    f.write(f"file '{os.path.join(png_dir, f'{len(frames) - 1:04d}.png')}'\n")
subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
                '-t', f'{sum(ms for _, ms in frames) / 1000:.2f}',
                '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
                '-movflags', '+faststart', os.path.join(OUT, 'btp-deploy-doctor-demo.mp4')], check=True)
frames[len(frames) // 5][0].resize((W // S, H // S), Image.LANCZOS).save(os.path.join(OUT, 'poster-check.png'))
total = sum(ms for _, ms in frames) / 1000
print(f'{len(frames)} frames, {total:.1f}s, {W // S}x{H // S} GIF, {W}x{H} MP4')
