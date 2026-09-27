# dsh-no-phone-home

Stops [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) from phoning home. This is a patch-only bundle: it ships no runtime code, it only disables the shipped plugin rows that send data off your machine for DeepSeek's diagnostics, or that record data so it can be sent later.

## What it disables

| Row | What it does when enabled |
|---|---|
| `session-telemetry-otel` | Exports session-log prefixes to `dsh-otel-collector.deepseeksvc.com` whenever you leave feedback (`/feedback`, or rating a message). In the shipped default mode (`FEEDBACK_ONLY`), a single thumbs-up uploads the session up to that point: message text, tool arguments and results, and workspace paths. |
| `otel` | The shared OTLP transport used by session and product telemetry. |
| `session-log-deepseek` | Attaches an incremental copy of the session log (`dsh_session_log`, up to 8 MiB) to every request sent to the official DeepSeek API. |
| `plugin-package-inventory-deepseek` | Attaches your active plugin list (`dsh_plugin_packages`) to every request sent to the official DeepSeek API. |
| `desktop-product-telemetry`, `product-analytics` | Desktop product analytics and its OTLP exporter. Upstream enables these only in the desktop profile; this bundle disables them in every profile. |
| `command-feedback`, `message-feedback`, `ui-message-feedback` | `/feedback`, message ratings and notes. These records exist to authorize and feed the telemetry upload; with it off they would only pile up for a later upload. Disabling them removes the rating buttons from messages. |

Older dsh releases lack some of these rows (`otel` and the desktop rows arrived after 0.1.7-rc.2). dsh skips a patch for a row it doesn't have, so the bundle works on either.

Patches target row ids only. A patch that also names the package is skipped when upstream moves an id to a different package, which would silently re-enable the row.

## Not covered

- **DeepSeek API request headers.** The DeepSeek model adapter (`llm-deepseek`, `llm-deepseek-account`) sends `x-deepseek-harness-user-id` (a random id stored in `$DSH_HOME/.anonymous-user-id`) and `x-deepseek-harness-session-id` with each model request. These go only to the DeepSeek endpoint you're already sending prompts to, and only when you use a DeepSeek route. Routes through other adapters, such as the OpenAI-compatible `llm-pi-ai`, send no such headers. Removing them would need a code change in dsh itself.
- **Features you use on purpose.** Sign-in to a DeepSeek account and DeepSeek web search talk to DeepSeek when you use them. They are not telemetry, so this bundle leaves them alone.

## Install

```sh
dsh plugin --profile web add github:mattcarvercom/dsh-no-phone-home#v1.0.0
```

This installs the bundle and adds it to the profile's bundle list. With HMR active (the default for `web`), it applies to a running `dsh web` without a restart; otherwise restart dsh. You can also toggle it from the Plugins page.

For defense in depth, also set `DSH_TELEMETRY_DISABLED=1` in the environment that launches dsh. dsh applies that switch after every patch layer, including the profile patch the Plugins page writes, so it keeps `session-telemetry-otel` off even if that row is switched back on in the UI.

## Verify

From a clone of this repo:

```sh
npm run check   # audits ~/.dsh/profiles/web as dsh would compose it right now
npm test        # checks the patch against your installed dsh; run after every dsh upgrade
```

Both find dsh through the `dsh` on your PATH. Set `DSH_PACKAGE_DIR` to an installed `@deepseek-ai/dsh` package, or `DSH_CHECKOUT` to a source checkout, to use a different one. `check` also accepts a profile directory as its argument and honors `DSH_HOME`.

`check` composes the real layers in dsh's order: each bundle, the profile patch, `$DSH_HOME/cordis.patch.yml`, then `DSH_TELEMETRY_DISABLED`. It exits 1 if any denied row is enabled, if the bundle isn't mounted, or if an enabled row's package name looks like telemetry but isn't covered. A row counts as disabled only when `disabled` is literally `true`; a conditional (`!!js`) value doesn't count. Rows your dsh version doesn't have are listed as `absent`.

`npm test` checks the patch against the `base` and `web-app` bundles of your installed dsh. It fails if a denied package moved to a new row id, if the patch stops being id-only, or if the composed result isn't clean. It also confirms the audit really catches the shipped defaults, a later re-enable, and a new telemetry-shaped row.

Tested with dsh 0.1.7-rc.2 from npm and with a source checkout 155 commits past it, on Node 25 and 26.

## License

MIT
