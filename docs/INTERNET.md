# Internet access

Clippy uses Anthropic's built-in web search and web fetch with the existing
encrypted key. Anthropic is a presenting sponsor of
[Cal Hacks 13.0](https://cal-hacks-13-0.devpost.com/).

A keeps its fast direct-answer/routing request. It delegates current information,
source lookups and URL reading to B or C. Their search/fetch tools run inside the
existing second Messages API request. There is no additional A call or automatic
client continuation. Tool uses and retrieved content are bounded.

Actual provider sources appear as clickable links. Only public HTTP(S) links can
open, and only after the user clicks. Internet access can be disabled in
Preferences. This does not enable background screen watching or change D.

Price comparison on product pages ([SHOPPING.md](SHOPPING.md)) uses the same tools, and only after the user clicks its offer.

Web search currently costs $10 per 1,000 searches plus model tokens. Web fetch
has no additional tool fee; fetched content uses input tokens. Provider account
access and event credits are not assumed.

Other products reviewed were Bright Data SERP API and Apify Website Content
Crawler. They require separate accounts/credentials and are not enabled.

- [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Claude web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [Structured-output compatibility](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Bright Data SERP API](https://docs.brightdata.com/products/serp-api/introduction)
- [Apify crawler](https://apify.com/apify/website-content-crawler)

No sample model requests or interaction tests were run by the agent.
