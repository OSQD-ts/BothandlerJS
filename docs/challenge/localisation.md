# Challenge localisation

Showing the one public-facing page in a language the visitor can read.

← [Documentation](../index.md) · [The challenge](index.md)

---

## Why this exists

The interstitial is the only page this library shows to a member of the public, and it is
shown because a *probabilistic* verdict went against them.

Serving "Checking your browser" in English to somebody whose browser has been asking for
Japanese since the first request is the same unfairness [the guard](../concepts/the-guard.md)
exists to prevent, applied to the one screen where it is most visible: **a person who
cannot read the page cannot find the contact link on it either.** That turns a check into a
wall.

## The library ships no translations, and will not

A machine-translated apology on a page that just turned somebody away is worse than an
honest English one — and only you know which languages your audience actually reads. What
this does is pick between the translations *you* supply.

```ts
new BotHandler({
  challenge: {
    secrets: [process.env.BOT_CHALLENGE_SECRET!],
    contactHtml: '<p>Locked out? <a href="/support">Contact us</a>.</p>',
    translations: {
      ja: {
        title: "ブラウザーを確認しています",
        message: "数秒で完了します。",
        contactHtml: '<p>お困りですか？<a href="/support">サポート</a>へご連絡ください。</p>',
      },
      de: { title: "Browser wird überprüft" },
      "pt-BR": { title: "Verificando seu navegador" },
    },
  },
});
```

Anything omitted from a translation falls back to the default text, so a `title`-only entry
is a perfectly reasonable first step.

## How a language is chosen

`Accept-Language` is parsed, `q` honoured, malformed entries dropped rather than fatal —
this is a client-supplied header and the page it decides is one somebody is already having
a bad time with. `*` is dropped too: it means "anything", which is what the default is for.
Ordering is stable within a `q` value, so a header listing two equally-weighted languages
means the first one.

Then, in order:

1. **Exact tag.** `pt-BR` matches a `pt-BR` key.
2. **Primary subtag.** `pt-BR` matches a `pt` key — European Portuguese is far better than
   English for a Brazilian visitor.
3. **Nothing.** The default English copy.

## Why `pt` never silently becomes `pt-BR`

Matching stops after the primary subtag. A visitor asking for `pt-PT` will **not** be handed
`pt-BR`.

That looks unhelpful until you consider the case it protects: serving Simplified Chinese to
somebody who asked for Traditional is a worse failure than serving English, and no rule can
tell the two situations apart from the header alone. Whether one regional variant stands in
for another is a judgement about *your* audience, so it is made by which keys you write
rather than by a heuristic here.

**Key by the primary tag** — `pt`, `zh`, `de` — unless you genuinely have separate regional
copy.

## The `lang` attribute

Each translation may set `lang`, defaulting to the key it is filed under.

It matters more than it looks. A screen reader picks its voice and its pronunciation rules
from this attribute, so Japanese text announced as `lang="en"` is read aloud by an English
voice and is unintelligible. Getting the copy right and the attribute wrong helps nobody.

```ts
translations: {
  "zh-Hant": { lang: "zh-Hant", title: "正在檢查您的瀏覽器" },
}
```

## Testing it

`parseAcceptLanguage` and `pickTranslation` are pure and exported, so the choice can be
tested by calling it:

```ts
import { parseAcceptLanguage, pickTranslation } from "bothandlerjs";

pickTranslation(translations, parseAcceptLanguage("pt-BR,pt;q=0.9,en;q=0.5"));
// → { tag: "pt-BR", copy: { title: "Verificando seu navegador" } }
```

## Related

- [The challenge](index.md) — what the page is for
- [Configuration](../reference/configuration.md) — the rest of `challenge`
