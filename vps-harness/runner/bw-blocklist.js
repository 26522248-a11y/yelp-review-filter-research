// Hosts that the login/captcha flow never needs. Every request to them is a byte the
// metered proxy pays for, so they are blocked at CDP level (zero bytes leave Chrome).
module.exports = [
  '*://*.doubleclick.net/*', '*://*.googletagmanager.com/*', '*://*.google-analytics.com/*',
  '*://*.googlesyndication.com/*', '*://*.googleadservices.com/*', '*://*.google.com/ads/*',
  '*://*.facebook.net/*', '*://*.facebook.com/tr/*', '*://*.hotjar.com/*', '*://*.hotjar.io/*',
  '*://*.segment.io/*', '*://*.segment.com/*', '*://*.mixpanel.com/*', '*://*.amplitude.com/*',
  '*://*.heap.io/*', '*://*.fullstory.com/*', '*://*.clarity.ms/*', '*://*.newrelic.com/*',
  '*://*.nr-data.net/*', '*://*.sentry.io/*', '*://*.bugsnag.com/*', '*://*.datadoghq-browser-agent.com/*',
  '*://*.optimizely.com/*', '*://*.criteo.com/*', '*://*.criteo.net/*', '*://*.taboola.com/*',
  '*://*.outbrain.com/*', '*://*.adsrvr.org/*', '*://*.branch.io/*', '*://*.appsflyer.com/*',
  '*://*.cloudflareinsights.com/*', '*://*.intercom.io/*', '*://*.zendesk.com/*',
  '*://cdn.cookielaw.org/*', '*://*.onetrust.com/*', '*://accounts.google.com/gsi/*',
  '*://*.bing.com/*', '*://*.tiktok.com/*', '*://*.sc-static.net/*', '*://*.quora.com/*', '*://sb.scorecardresearch.com/*'
];
