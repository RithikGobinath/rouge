'use strict';
// Closed vocabularies the voice reflexes choose from. Nothing here is
// generated: every value is something the executor knows how to do.

/** Websites a person names without a domain. Web-only: no app by this name. */
const SITES = {
  youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', google: 'https://www.google.com',
  'google drive': 'https://drive.google.com', 'google docs': 'https://docs.google.com', 'google sheets': 'https://sheets.google.com',
  'google slides': 'https://slides.google.com', 'google calendar': 'https://calendar.google.com', 'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com', github: 'https://github.com', reddit: 'https://www.reddit.com', twitter: 'https://x.com', x: 'https://x.com',
  netflix: 'https://www.netflix.com', amazon: 'https://www.amazon.com', wikipedia: 'https://www.wikipedia.org', linkedin: 'https://www.linkedin.com',
  facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com', canvas: 'https://canvas.instructure.com', 'stack overflow': 'https://stackoverflow.com',
  'hacker news': 'https://news.ycombinator.com', twitch: 'https://www.twitch.tv', pinterest: 'https://www.pinterest.com',
};

/** Search engines and sites with a search URL. `%s` is the encoded query. */
const SEARCH_URLS = {
  google: 'https://www.google.com/search?q=%s', bing: 'https://www.bing.com/search?q=%s', duckduckgo: 'https://duckduckgo.com/?q=%s',
  youtube: 'https://www.youtube.com/results?search_query=%s', amazon: 'https://www.amazon.com/s?k=%s',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=%s', github: 'https://github.com/search?q=%s',
  reddit: 'https://www.reddit.com/search/?q=%s', maps: 'https://www.google.com/maps/search/%s', 'google maps': 'https://www.google.com/maps/search/%s',
};

/** Windows known folders a person names. */
const SYSTEM_FOLDERS = ['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'home'];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2, few: 3,
};

/** Words that start a spoken request for an answer, not an action. */
const QUESTION_START = /^(what|what's|whats|who|who's|why|how|how's|when|where|where's|which|is|are|was|were|do|does|did|can|could|would|should|will|tell|explain|summarize|summarise|define|translate|calculate|compare|describe|give|list|remind|help|suggest|recommend|write\s+me|draft)\b/i;

module.exports = { SITES, SEARCH_URLS, SYSTEM_FOLDERS, NUMBER_WORDS, QUESTION_START };
