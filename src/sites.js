// Sites whose interface is mostly names, counters and buttons get a rule that
// limits translation to what people actually wrote there.
const SITE_RULES = [
  {
    hosts: ['x.com', 'twitter.com'],
    // X marks user-written text with a lang attribute: posts, replies, quotes,
    // bios. Names, handles, counters and the app's own labels have none.
    include: '[data-testid="tweetText"], [data-testid="UserDescription"], div[lang]',
    block: true,
  },
];

export function ruleFor(hostname) {
  return SITE_RULES.find((rule) => rule.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) ?? null;
}
