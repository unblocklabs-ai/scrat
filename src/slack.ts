import { config } from "./config.ts";
import { withOperation } from "./logging.ts";
import { assertPublishable } from "./secrets.ts";

const apiUrl = "https://slack.com/api/";

export const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(apiUrl + method, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      if (attempt > 0 || !Number.isFinite(seconds) || seconds < 0 || seconds > config.slack.maxRetryAfterSeconds) {
        throw new Error(`Slack ${method} was rate limited (retry-after ${response.headers.get("retry-after")})`);
      }
      await new Promise((done) => setTimeout(done, seconds * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    if (data.ok !== true) throw Object.assign(new Error(`Slack ${method} failed: ${String(data.error)}`), { slackError: String(data.error) });
    return data;
  }
}

export function postMessage({ channel, text, threadTs }: { channel: string; text: string; threadTs?: string }): Promise<string> {
  return withOperation("slack.post_message", { channel, threadTs }, async (operation) => {
    operation.stage("inspection");
    const capped = text.length > config.slack.maxTextLength ? text.slice(0, config.slack.maxTextLength - 1) + "…" : text;
    assertPublishable(capped);
    operation.stage("request");
    const data = await call("chat.postMessage", {
      channel, text: capped, unfurl_links: false, unfurl_media: false, link_names: false, ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const ts = String(data.ts);
    operation.complete({ ts });
    return ts;
  });
}

export function authTest() {
  return withOperation("slack.auth_test", {}, async (operation) => {
    operation.stage("request");
    const data = await call("auth.test", {});
    operation.complete({ team: data.team, user: data.user });
    return data;
  });
}

export function addReaction({ channel, timestamp, name }: { channel: string; timestamp: string; name: string }) {
  return withOperation("slack.add_reaction", { channel, timestamp, name }, async (operation) => {
    operation.stage("request");
    try { await call("reactions.add", { channel, timestamp, name }); }
    catch (error) { if ((error as { slackError?: string }).slackError !== "already_reacted") throw error; }
    operation.complete({ name });
  });
}
