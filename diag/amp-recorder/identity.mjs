import { createHmac } from "node:crypto";

export function fingerprint(value, key) {
  const fields = {};
  const threadIds = [];
  const hash = (input) => createHmac("sha256", key).update(JSON.stringify(input)).digest("hex");

  function visit(current, path) {
    if (current !== null && typeof current === "object") {
      const entries = Object.entries(current);
      if (entries.length === 0) fields[path] = hash(current);
      for (const [name, child] of entries) {
        visit(child, `${path}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`);
      }
      return;
    }
    fields[path] = hash(current);
    if (typeof current === "string") {
      for (const match of current.matchAll(/T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi)) {
        const lineStart = current.lastIndexOf("\n", match.index) + 1;
        const prefix = current.slice(lineStart, match.index);
        threadIds.push({
          path,
          hash: hash(match[0]),
          ampThreadUrl: prefix === "Amp Thread URL: https://ampcode.com/threads/",
        });
      }
    }
  }

  visit(value, "");
  return { fields, threadIds };
}

export function compareSessions(groups) {
  if (groups.length < 2 || groups.some((group) => group.length < 2)) {
    throw new Error("Compare at least two requests from each of at least two sessions");
  }
  const paths = new Set(groups.flat().flatMap((request) => Object.keys(request.fields)));
  const result = { candidates: [], shared: [], varying: [], missing: [] };
  for (const path of [...paths].sort()) {
    const values = groups.map((group) => group.map((request) => request.fields[path]));
    if (values.flat().includes(undefined)) {
      result.missing.push(path);
    } else if (values.some((group) => new Set(group).size !== 1)) {
      result.varying.push(path);
    } else if (new Set(values.map((group) => group[0])).size === groups.length) {
      result.candidates.push(path);
    } else {
      result.shared.push(path);
    }
  }
  return result;
}
