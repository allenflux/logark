# Report visual design

Layout reference: [NASA Postdoctoral Program — About](https://npp.orau.org/about/index.html).
Identity reference: the user-supplied Allen F image, with white space, gray lettering and restrained red emphasis. The icon uses the user's requested square outline.
The frontend identity is TraceNote. The report continues to display the existing audit content.

## Reference mapping

| Role | Reference | TraceNote treatment |
| --- | --- | --- |
| Page / text | `#ffffff` / `#1b1e20` | White report canvas, dark text |
| Masthead / identity | User-supplied gray/red identity and requested muted light blue navigation | `#d6e3ed` masthead with `#bbccda` lower rule, `#6b6b6b` lettering, report icon with horizontal entries within a light gray square; white report body |
| Links / buttons | `#0160a6` | Blue navigation and actions |
| Brand accent | User-supplied red lettering | `#a61c2b` wordmark accent, square report index mark and thin active navigation rule; neutral audit definition strip |
| Rules / feature surface | `#e7eaec` / `#444b4f` | Fine dividers and report export feature |
| Content | 1200px, 75% main / 25% right rail | 1200px report with right-hand contents and scope |
| Body | Roboto, 16px, line-height 1.6 | Roboto from Google Fonts; system Chinese glyph fallback |
| Headings | Plantin, around 40px H1 | Explicit fallback: Georgia and Songti SC/STSong; Plantin is not bundled |

Observed styles: [main CSS](https://npp.orau.org/assets/css/main.css?v=2.12.0),
[reference font kit](https://use.typekit.net/gkw5ecy.css).
Public body font: [Roboto stylesheet](https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap).
No reference logos, institutional content, photographs or licensed Plantin files are copied.
Authorship appears once in the page footer as small gray text: “allen flux 制作” / “Made by allen flux”.
Exported report titles and filenames use TraceNote. Existing service names, JavaScript globals and stored locale keys retain their internal identifiers for compatibility.

## Statistical figures

- Hourly line chart: counts or error rate, labeled units, zero baseline, exact interval table.
- Status bars: contribution to all non-200 requests, including the omitted remainder when applicable.
- Endpoint scatter: total requests versus endpoint non-200 rate; equal-size points and endpoint key.
- Endpoint Pareto: count bars and cumulative contribution on explicitly labeled axes; the denominator is the full-window failure count, not the sum of displayed endpoints.
- Method composition: HTTP 200 versus non-200 within each returned method, normalized by that method's request total.

The endpoint and method APIs return ranked subsets with failures, not the complete population.
Figure captions state that selection. Inconsistent or absent denominators do not produce invented percentages.
No fitted model, causal claim, confidence interval, percentile or duration distribution is inferred from aggregate fields.

Charts use restrained linework, numeric labels, minimal fills and supporting data tables, following the bar/scatter conventions from diagram-design.
