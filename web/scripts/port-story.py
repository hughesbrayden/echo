"""Port the Echo Story artifact into web/public/story.html and demo.html.

Usage: python3 scripts/port-story.py <artifact.html>

The story is authored as a standalone page, so it is served as-is at "/" (see
next.config.ts) with a few site edits: a real <head>, a Story / Live demo nav,
the recorded walk video in place of its placeholder, and a closing call to
action. The Live demo page at "/demo" shares its nav, styles and footer.
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


# The site nav stays at every width, in the same spot on every page; the chapter links give way on phones.
css = swap(".nav-cta { display: none; }", ".chapters { display: none; }", css)
css += """
/* Site additions: the shared site nav, the recorded walk, the closing call to action and the demo page. */
.site { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--bg-3); }
.site a { display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 500; color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.site a:hover { color: var(--ink); }
.site a[aria-current="page"] { background: var(--ink); color: #FFFFFF; }
.film-video { position: relative; justify-self: center; width: min(100%, 340px); aspect-ratio: 720 / 1564; border-radius: 28px; overflow: hidden; background: var(--ink); }
.film-video video { display: block; width: 100%; height: 100%; object-fit: cover; }
.map-row .film-video { flex: 1; width: 100%; aspect-ratio: auto; min-height: 320px; }
.map-row .film-video video { position: absolute; inset: 0; object-fit: contain; }
@media (max-width: 960px) { .map-row .film-video { flex: none; align-self: center; width: min(100%, 340px); aspect-ratio: 720 / 1564; } }
.cta { margin-top: clamp(112px, 13vw, 180px); padding: clamp(32px, 5vw, 64px); border-radius: 24px; background: var(--ink); color: #FFFFFF; display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; flex-wrap: wrap; }
.cta h2 { color: #FFFFFF; max-width: 14ch; }
.cta p { color: rgba(255, 255, 255, 0.72); max-width: 44ch; margin-top: 16px; }
.cta-btn { display: inline-flex; align-items: center; gap: 10px; padding: 14px 22px; border-radius: 999px; background: #FFFFFF; color: var(--ink); font-size: 16px; font-weight: 500; text-decoration: none; white-space: nowrap; }
.cta-btn:hover { background: var(--bg-3); }
.cta + footer { margin-top: clamp(56px, 7vw, 96px); }
.closer-cta { display: inline-flex; align-items: center; padding: 12px 20px; border-radius: 999px; background: var(--ink); color: #FFFFFF; font-size: 16px; font-weight: 500; text-decoration: none; }
.closer-cta:hover { background: #262A33; }
/* In deck mode the site nav stays on screen at the top, where it sits on the Live demo page;
   the deck's bottom bar carries the chapters. */
html.is-deck .nav { display: block; position: fixed; top: 0; left: 0; right: 0; }
html.is-deck .chapters { display: none; }
html.is-deck .slide { top: 60px; }
html.is-deck .deck-ch .brand { display: none; }
html.is-deck .film .film-video { width: auto; height: calc(100vh - 240px); max-height: 760px; max-width: 100%; }
.demo-page { padding-block: clamp(40px, 5vw, 64px) 0; }
.demo { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: clamp(32px, 5vw, 72px); align-items: center; }
@media (max-width: 860px) { .demo { grid-template-columns: minmax(0, 1fr); } }
.demo .film-video { width: min(100%, 380px); }
.heard { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.heard li { padding: 14px 18px; border-radius: 14px; background: var(--bg-2); border: 1px solid var(--line); font-size: 17px; letter-spacing: -0.01em; }
.heard li span { display: block; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 2px; }
"""


def site_nav(current):
    story = ' aria-current="page"' if current == "story" else ""
    demo = ' aria-current="page"' if current == "demo" else ""
    return f'<nav class="site" aria-label="Site"><a href="/"{story}>Story</a><a href="/demo"{demo}>Live demo</a></nav>'


VIDEO = (
    '<div class="card film-video">\n'
    '          <video controls playsinline preload="metadata" poster="/media/echo-walk-01.jpg" aria-label="Screen recording of Echo running on a phone during a real walk">\n'
    '            <source src="/media/echo-walk-01.mp4" type="video/mp4">\n'
    "          </video>\n"
    "        </div>"
)

body = swap('<a class="nav-cta" href="#film">Watch the walk</a>', site_nav("story"), body)
body = swap(' <span class="tag">Video coming</span>', "", body)
film = one(r'<div class="card film-frame".*?</div>\n        </div>', body).group(0)
body = body.replace(film, VIDEO, 1)
body = swap(
    '<p class="limits">Echo is an early heads-up',
    '<a class="closer-cta" href="/demo">Watch the live demo</a>\n        <p class="limits">Echo is an early heads-up',
    body,
)

# The demo page shares the story's nav and footer. The camera app is switched off for
# now, so the live demo is the recording of a real walk.
header = one(r'<header class="nav">.*?</header>', body).group(0)
header = header.replace(site_nav("story"), site_nav("demo")).replace('href="#', 'href="/#')
limits = one(r'<p class="limits">.*?</p>', body).group(0)
header = header.replace('href="/#top"', 'href="/"')
brand = one(r'<a class="brand" href="/">.*?</a>', header).group(0)
footer = f'<footer>\n    <div class="wrap foot">\n      {brand}\n      {limits}\n    </div>\n  </footer>'
demo_body = f"""{header}

<main id="top">
  <section class="demo-page" aria-labelledby="h-demo">
    <div class="wrap">
      <div class="chapter-head">
        <div class="head-l">
          <span class="eyebrow"><b>Live</b> demo</span>
          <h1 class="chap" id="h-demo">Echo on a real walk.</h1>
        </div>
        <p class="lede">Recorded live on a phone standing in for the glasses, with what Echo heard and said shown on screen.</p>
      </div>
      <div class="demo">
        <div style="display:flex;flex-direction:column;gap:20px">
          <span class="eyebrow">Some of what Echo said</span>
          <ul class="heard">
            <li><span>On your way</span>"Keep walking."</li>
            <li><span>Heads up</span>"A step, about 4 steps ahead. Slow down."</li>
            <li><span>Heads up</span>"Person, about 5 steps ahead. Bear right."</li>
            <li><span>Heads up</span>"Door, about 5 steps ahead."</li>
          </ul>
        </div>
        {VIDEO}
      </div>
    </div>
  </section>

  {footer}
</main>"""


def page(title, body_html):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="/media/echo-walk-01.jpg">
<meta name="theme-color" content="#FFFFFF">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="{fonts}">
<style>
{css}</style>
</head>
<body>
{body_html}
</body>
</html>
"""


for name, html in (("story.html", page("Echo", body)), ("demo.html", page("Echo · Live demo", demo_body))):
    (out.parent / name).write_text(html, encoding="utf-8")
    print(f"wrote {out.parent / name} ({len(html):,} bytes)")
