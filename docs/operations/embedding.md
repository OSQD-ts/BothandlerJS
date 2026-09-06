# Embedding the dashboard

`<bot-dashboard>` — the operator dashboard as an element you drop into a page you already
have.

← [Documentation](../index.md) · [Operations](index.md)

---

## The whole integration

```ts
// server
import { createDashboardHandler } from "@osqd/bothandlerjs";

const dashboard = createDashboardHandler(detector, {
  basePath: "/_bots",
  auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD! },
});
app.use("/_bots", (req, res) => dashboard(req, res));
```

```html
<!-- your admin page -->
<bot-dashboard src="/_bots"></bot-dashboard>

<script type="module">
  import { defineBotDashboard } from "@osqd/bothandlerjs/element";
  defineBotDashboard();
</script>
```

The data still comes from a mounted handler, because there is nowhere else for it to come
from. What the element removes is having to build, route and style a page around it — the
dashboard now sits inside your own layout, under your own heading, in your own card.

---

## What running it in your page costs you

The element renders into a **shadow root** in your document. That is what makes it flow
with your layout instead of sitting in a frame, and it is worth being exact about what it
does not do.

**What it weighs.** About 50 KB gzipped — the dashboard client, its charts and its
stylesheet, which is most of what the standalone page loads. It is a separate entry point
(`@osqd/bothandlerjs/element`), so importing the library on your server does not pull any
of it, and an `import()` where you mount it keeps it off every other page in your admin
app. On a warm connection it reaches its first render in well under a tenth of a second;
what it renders into is a shadow root of a few hundred nodes, which your page's own layout
never has to walk.

**A shadow root is a styling boundary, not a security boundary.** Any script that can run
on the host page can reach through `element.shadowRoot`, read every client address and
every piece of evidence on screen, and call the dashboard's API with your credentials. On
the standalone page — a different document, and usually a different origin — an injected
script in your application could do none of that.

**The standalone page refuses to be framed; your page has to refuse for itself.** The
dashboard this package serves sends `frame-ancestors 'none'`, so another site cannot frame
it and trick an operator into clicking a control they cannot see. The element renders into
a document this package does not serve and cannot set a header on, so that protection does
not come along with it. The element says so in the console when it finds a cross-origin
ancestor — a page framing its own pages is ordinary and stays quiet — but only your page
can actually stop it.

So:

- Mount it on a page that is **already behind your admin authentication**.
- Treat an XSS on that page as equivalent to handing over the dashboard.
- Send `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) on
  the page you embed it in, the way the standalone page already does.
- If you would rather have the isolation than the layout, serve the standalone page. It is
  the same dashboard, and `createDashboardHandler` already returns it — point a link at
  `/_bots` instead of embedding.

The handler's own safeguards still apply and are worth keeping: it refuses to mount
without an explicit `auth` decision, and it refuses `controls.editPolicy` with `auth:
false` on a server of your own.

---

## Choosing the screens

```html
<bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
  import { defineBotDashboard } from "@osqd/bothandlerjs/element";

  document.getElementById("d").config = {
    tabs: [
      { id: "stats", label: "Overview" },
      { id: "live", label: "Traffic" },
    ],
  };

  defineBotDashboard();
</script>
```

Four screens exist — `live`, `actors`, `stats`, `policy`. Listing them chooses which
appear, in what order, under what labels. A screen left out is not built at all.

**`tabs` and `hide` do not take the same names.** `tabs` names screens — `live`, `actors`,
`stats`, `policy`. `hide` names [sections](dashboard.md), which are finer-grained and
mostly are not screens at all: the four that correspond to screens are `feed`, `registry`,
`statistics` and `policy`. So `hide: { live: true }` hides nothing — the name you want
there is `feed`. TypeScript rejects the wrong name outright; in plain JavaScript the
element says so in the console, and names the one you probably meant.

Where they do meet — `tabs` listing a screen that `hide` switches off — `hide` wins. An
explicit instruction to hide something is not overridden by its appearing in a list.

`config.theme` may be changed after mount and takes effect immediately, which is what a
framework re-rendering its props expects. `tabs`, `panels` and `src` are read once, when
the element first mounts — and changing any of them afterwards says so in the console
rather than doing nothing quietly. Re-assigning an equivalent `config`, which is what a
framework does on every render, says nothing: the comparison is by what the config
describes, not by object identity.

**`src` must be on this origin.** The dashboard sends no CORS headers — that is what stops
another site reading your traffic through a logged-in browser — so it is same-origin only.
Point `src` at a path, not at another host; an absolute cross-origin URL says so rather
than failing as "Failed to fetch".

**Set `config` before `defineBotDashboard()`**, as above. That order is the natural one and
it is also the one that works: the element upgrades when it is defined, and reads its
configuration then.

### Hiding is not withholding

`config.hide` removes parts of the page from the screen. It does **not** stop the server
sending them:

```js
config = { hide: { evidence: true } };   // off the screen, still on the wire
```

The [`sections`](dashboard.md) option on the handler is the one that stops data leaving the
process, and it is the one to use when the point is that somebody should not have it.
`hide` is for tidying a view; `sections` is for withholding.

---

## Theming

```js
config = {
  theme: {
    scheme: "light",              // or "dark"; omit to follow the page and the OS
    density: "compact",           // or "comfortable"
    tokens: {
      accent: "#7c3aed",
      surface: "#ffffff",
      ink: "#1a1a2e",
    },
  },
};
```

Tokens are set on the host element and inherit into the shadow root, which is why every
token block in the stylesheet is written `:root, :host` — `:root` matches nothing inside a
shadow tree, and an element styled only against it renders with no colours at all.

`scheme` and `density` are also attributes, if a template is easier than a script:

```html
<bot-dashboard src="/_bots" scheme="dark" density="compact"></bot-dashboard>
```

Either way they take the two values above and nothing else; anything else is ignored and
says so in the console once, rather than being written onto the element where it would
match no rule and look like a dashboard disregarding its configuration. A token dropped
from `tokens` on a later render is removed from the element, so switching themes gives you
the new theme rather than the union of every theme you have set.

**One caution.** The shipped palette was measured: every ink is at least 4.5:1 on its
surface, and the two series colours clear every colour-vision gate as an adjacent pair.
Replace a token and that measurement is yours to redo. The dashboard is a page people read
all day, sometimes during an incident.

---

## Panels of your own

```js
config = {
  panels: [
    {
      id: "checkout",
      screen: "stats",
      title: "Checkout health",
      source: "/admin/api/checkout",     // → { rows: [{ label, value, note? }] }
      refreshMs: 15_000,
    },
    {
      id: "queue",
      screen: "live",
      title: "Queue depth",
      source: () => ({ rows: [{ label: "Pending", value: pending.length }] }),
    },
  ],
};
```

A `source` is a URL returning `{ rows }` or a function returning the same shape. Rows are
rendered as **text, always** — the rule the rest of the client follows, for the same
reason. A value containing a tag appears as that tag rather than becoming one.

At most 200 rows are drawn, and the panel says how many it left out. A panel is a summary,
and a source that returns everything it has should not be able to lock up your admin page
laying it out.

What a source returns is treated as data rather than as a contract. Anything that is not an
array of rows, a row missing its label or value, a source that throws — each says so in
place instead of drawing something wrong. An object value is shown as JSON rather than as
`[object Object]`, because the second reads like a bug in the dashboard.

A panel whose source fails says so in place, rather than rendering empty and looking like
a quiet system.

---

## Content-Security-Policy

The element needs **nothing added to your policy**. Its stylesheet is a constructable one
adopted into the shadow root rather than an injected `<style>` element, so `style-src
'self'` does not block it — and a strict policy is what an admin page ought to have.

The bundle is an ordinary module you import, so it is covered by whatever already lets your
own scripts run. Verified under `default-src 'self'; script-src 'self'; style-src 'self'`
with every combination of `theme`, `tabs` and `panels`, including a panel whose source
fails: no violations, and nothing rendered differently.

## Accessibility

Audited with axe inside a host page, in both themes and at phone width, on every release —
the same bar the standalone page is held to.

Three things only go wrong once the dashboard is a section of somebody else's page rather
than the page, and the element handles all three:

- **It paints its own ink and surface.** A shadow root has no `body`, so without this
  everything inherits the host page's colour. On a white page that passes for correct; in
  dark mode it was near-black text on a near-black surface.
- **It adds no second `main` landmark.** Its own becomes a labelled region, so a screen
  reader user is not offered two "main" landmarks to choose between.
- **It adds no second banner.** Its header keeps its styling and loses its landmark role.

## Being a guest in your page

The dashboard was written to own a document, and embedding it means it no longer does.
Four things it deliberately stops doing when it is not the page:

**It leaves your keyboard alone.** Its shortcuts — digits for tabs, `/` for the filter —
are bound to its own subtree rather than to the window, so a digit pressed while your page
has focus is your page's business.

**It leaves your URL alone.** The standalone page writes its tab and filter into
`location.hash` so a link lands on a view. Embedded it writes nothing, because that is your
address bar and your back button.

**Its skip link still works.** `href="#view-live"` is inert inside a shadow root —
fragment navigation does not cross the boundary — so the affordance that lets a keyboard
past the header is wired by hand instead.

**It survives a route change.** Unmounting and remounting the element, which is what a
router does on every navigation, keeps the dashboard and the feed history it had built.

**It lets go while it is away.** Removing the element closes the event stream, so a page
that has navigated elsewhere is not holding a server connection and redrawing a dashboard
nobody can see. Mounting again resumes from the last entry it saw and collects whatever
arrived in between.

## Frameworks

It is a custom element, so it works wherever elements do. Three things worth knowing:

**Importing it on the server is safe.** Next, Remix, Astro, Nuxt and the rest evaluate your
top-level imports while rendering on the server, where there is no DOM. This module imports
there without complaint and `defineBotDashboard()` does nothing, so you can write the import
at the top of a component like any other and call it in an effect, or on mount:

```js
import { defineBotDashboard } from "@osqd/bothandlerjs/element";

useEffect(() => {
  defineBotDashboard();
}, []);
```

**React 18 in development mounts, unmounts and mounts again** on every component, and the
element handles that — one dashboard, its history intact, no error.

**A name of your own**, if `bot-dashboard` is taken — by your own code or by another
library, which the element will tell you about rather than quietly doing nothing:

```js
defineBotDashboard("ops-dashboard");
```

## When it does not appear

The element does not fail quietly. If a screen, a panel or the whole dashboard is missing,
the console says which of these it was:

| What you see | What it means |
| --- | --- |
| "could not start: it answered 401 Unauthorized" | The handler has `auth` set and this browser has not signed in. A background fetch cannot raise the prompt a navigation would — open the dashboard's own URL once, or put the page behind the same authentication. |
| "could not start: no `src` was given" | It asked this page's own origin and was handed your HTML. Point `src` at where `createDashboardHandler` is mounted. |
| "could not start: src points at …, which is not this page's origin" | The dashboard sends no CORS headers on purpose. Mount it on this origin and use a path. |
| "A bot dashboard is already running on this page" | Two elements are connected at once. One at a time; the second takes over if the first leaves. |
| "`<bot-dashboard>` is already registered … by something else" | Another library owns the name. Use `defineBotDashboard("your-name")`. |
| "tabs lists `x`, which is not a screen" | The screens are `live`, `actors`, `stats` and `policy`. |
| "tabs lists `x`, but this dashboard's server has the `y` section switched off" | `sections` on the handler, not something this page can override — and deliberately so. |
| "hide.`x` did nothing" | `hide` takes section names, `tabs` takes screen names. The message names the one you meant. |
| "panel `x` asks for screen `y`, which this dashboard does not have" | A typo in `screen`; the message lists the screens that exist. |
| "two panels share the id `x`" | Ids identify a panel. The second was ignored. |
| "`tabs` and `panels` are read once" | They are settled at mount. `theme` is the one that updates live. |
| "scheme `x` is not `light` or `dark`" | Likewise `density`, which takes `comfortable` or `compact`. |
| "src `…` has a query string on it" | The element asks for `<src>/api/bootstrap`, so only the path can mean anything. It used the path. |
| "this page is framed by another origin" | Clickjacking risk your page must close itself — see [above](#what-running-it-in-your-page-costs-you). |

## What it does not do

**Two at once.** The client is a module graph with its own state; two live elements would
share it, and the second would draw the first one's traffic. One at a time is fine — and is
what a router does — so a second element only refuses while another is actually connected.
The refusal is about the moment rather than about the element: one that lost the race takes
over if it is still there when the other leaves, and one whose boot failed — a handler that
had not finished starting, a `src` that was wrong and has since been corrected — tries again
on its next mount rather than staying dead behind the old message.

**It does not replace the standalone page.** Everything in
[the dashboard](dashboard.md) — `sections`, `controls`, `redact`, the auth options and
their refusals — applies unchanged, because the element is a different way of rendering the
same handler rather than a different dashboard. That includes the parts that write:
`controls.editPolicy` lets an operator change the live policy from inside your page, and
the same-origin check that guards it is satisfied because the element is on your origin.

**It is not translated, and it is not laid out for right-to-left.** In a `dir="rtl"` page
it inherits the direction and does not break the layout around it, but its own copy is
English and its columns read left to right.

## Related

- [The dashboard](dashboard.md) — every option, and what it refuses to do
- [Operations](index.md) — events, metrics, the audit
