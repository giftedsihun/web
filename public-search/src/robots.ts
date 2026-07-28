type Rule = { allow: boolean; path: string };

function groupsForAgent(text: string, agent: string) {
  const groups: Array<{ agents: string[]; rules: Rule[]; delay?: number }> = [];
  let current: { agents: string[]; rules: Rule[]; delay?: number } | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length || current.delay !== undefined) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === "allow" || key === "disallow")) {
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else if (current && key === "crawl-delay" && Number.isFinite(Number(value))) current.delay = Number(value);
  }
  const lowerAgent = agent.toLowerCase();
  const exact = groups.filter((group) => group.agents.some((value) => value !== "*" && lowerAgent.startsWith(value)));
  return exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
}

function matches(pathname: string, rule: string) {
  const expression = `^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\$$/, "$")}`;
  return new RegExp(expression).test(pathname);
}

export function robotsPolicy(text: string, url: URL, agent: string) {
  const rules = groupsForAgent(text, agent).flatMap((group) => group.rules);
  const applicable = rules.filter((rule) => matches(url.pathname + url.search, rule.path));
  applicable.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  const delay = groupsForAgent(text, agent).map((group) => group.delay).find((value) => value !== undefined);
  return { allowed: applicable[0]?.allow ?? true, crawlDelayMs: Math.max(0, Math.min((delay ?? 0) * 1000, 30_000)) };
}
