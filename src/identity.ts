import { config } from "./config.ts";

export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const botName = config.github.botName;
export const botSlug = slugOf(botName);
export const withBotName = (text: string) => text.replaceAll("{{bot}}", () => botName);
