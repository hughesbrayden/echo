"""Port the Echo Story artifact into web/public/story.html.

Usage: python3 scripts/port-story.py <artifact.html>

The story is authored as a standalone page, so it is served as-is at "/" (see
next.config.ts) with a few site edits: a real <head>, a Live demo button, the
recorded walk video in place of its placeholder, and a closing call to action.
Rerun this whenever the story is revised.
"""
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out = pathlib.Path(__file__).resolve().parent.parent / "public" / "story.html"


def one(pattern, text, flags=re.S):
    m = re.search(pattern, text, flags)
    if not m:
        sys.exit(f"story changed shape, could not find: {pattern}")
    return m


css = one(r"<style>\n(/\* Layout:.*?)</style>", src).group(1)
body = one(r'(<header class="nav">.*?</script>)', src).group(1)
description = one(r'<meta name="description" content="([^"]*)">', src).group(1)
fonts = one(r'<link rel="stylesheet" href="(https://fonts.googleapis.com/[^"]*)">', src).group(1)


def swap(old, new, text):
    if old not in text:
        sys.exit(f"story changed shape, could not find: {old[:80]}")
    return text.replace(old, new, 1)


# Phones are where the demo runs, so the site nav stays at every width and the chapter links give way.
css = swap(".nav-cta { display: none; }", ".chapters { display: none; }", css)
css += """
/* Site additions: the recorded walk, the Live demo button and the closing call to action. */
.site { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--bg-3); }
.site a { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 500; color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.site a:hover { color: var(--ink); }
.site a[aria-current="page"] { background: var(--bg); color: var(--ink); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08); }
.site a[href="/demo"] { background: var(--ink); color: #FFFFFF; }
.site .live, .cta-btn .live { width: 7px; height: 7px; border-radius: 50%; background: #12B76A; box-shadow: 0 0 0 3px rgba(18, 183, 106, 0.22); }
.film-video { position: relative; justify-self: center; width: min(100%, 340px); aspect-ratio: 720 / 1564; border-radius: 28px; overflow: hidden; background: var(--ink); }
.film-video video { display: block; width: 100%; height: 100%; object-fit: cover; }
.cta { margin-top: clamp(112px, 13vw, 180px); padding: clamp(32px, 5vw, 64px); border-radius: 24px; background: var(--ink); color: #FFFFFF; display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; flex-wrap: wrap; }
.cta h2 { color: #FFFFFF; max-width: 14ch; }
.cta p { color: rgba(255, 255, 255, 0.72); max-width: 44ch; margin-top: 16px; }
.cta-btn { display: inline-flex; align-items: center; gap: 10px; padding: 14px 22px; border-radius: 999px; background: #FFFFFF; color: var(--ink); font-size: 16px; font-weight: 500; text-decoration: none; white-space: nowrap; }
.cta-btn:hover { background: var(--bg-3); }
.cta + footer { margin-top: clamp(56px, 7vw, 96px); }
"""

body = swap(
    '<a class="nav-cta" href="#film">Watch the walk</a>',
    '<nav class="site" aria-label="Site"><a href="/" aria-current="page">Story</a>'
    '<a href="/demo"><span class="live" aria-hidden="true"></span>Live demo</a></nav>',
    body,
)
body = swap(' <span class="tag">Video coming</span>', "", body)
film = one(r'<div class="card film-frame".*?</div>\n        </div>', body).group(0)
body = body.replace(
    film,
    '<div class="card film-video">\n'
    '          <video controls playsinline preload="metadata" poster="/media/echo-walk-01.jpg" aria-label="Screen recording of Echo running on a phone during a real walk">\n'
    '            <source src="/media/echo-walk-01.mp4" type="video/mp4">\n'
    "          </video>\n"
    "        </div>",
    1,
)
body = swap(
    "  <footer>",
    '  <section class="wrap" aria-labelledby="h-try">\n'
    '    <div class="cta">\n'
    "      <div>\n"
    '        <h2 id="h-try">Try Echo on your phone.</h2>\n'
    "        <p>The live demo runs the real app in your browser. Allow the camera, hold your phone at chest height, and walk.</p>\n"
    "      </div>\n"
    '      <a class="cta-btn" href="/demo"><span class="live" aria-hidden="true"></span>Open the live demo</a>\n'
    "    </div>\n"
    "  </section>\n\n"
    "  <footer>",
    body,
)

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Echo</title>
<meta name="description" content="{description}">
<meta property="og:title" content="Echo">
<meta property="og:description" content="{description}">
<meta property="og:image" content="/media/echo-walk-01.jpg">
<meta name="theme-color" content="#FFFFFF">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="{fonts}">
<style>
{css}</style>
</head>
<body>
{body}
</body>
</html>
"""
out.write_text(page, encoding="utf-8")
print(f"wrote {out} ({len(page):,} bytes)")
