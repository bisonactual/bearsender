# Fonts

The fonts BearSender offers in Settings, Options, FONTS. `build.ts` inlines them into `bearsender.html`, so the page looks the same with no internet; the dev server serves them from here.

- **Source:** Google Fonts, the Latin subset of each, as woff2 (3 Nov 2026). `fonts.css` holds their `@font-face` rules, with Google's Latin `unicode-range`.
- **Variable fonts:** a file ending `-variable` covers weights 400 to 700; the others are one weight each.
- **Licence:** every family here is under the SIL Open Font License, Version 1.1: https://openfontlicense.org

| Family | Files | Copyright |
|---|---|---|
| Barlow, Barlow Condensed | `barlow-*.woff2`, `barlow-condensed-*.woff2` | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) |
| Share Tech Mono | `share-tech-mono-400.woff2` | Copyright (c) 2012, Carrois Type Design, Ralph du Carrois (post@carrois.com www.carrois.com), with Reserved Font Name 'Share' |
| IBM Plex Sans, IBM Plex Sans Condensed, IBM Plex Mono | `ibm-plex-*.woff2` | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" |
| Roboto, Roboto Condensed | `roboto-variable.woff2`, `roboto-condensed-variable.woff2` | Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) |
| Roboto Mono | `roboto-mono-variable.woff2` | Copyright 2015 The Roboto Mono Project Authors (https://github.com/googlefonts/robotomono) |
