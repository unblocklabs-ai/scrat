import { config } from "./config.ts";

export const botName = config.github.botName;
export const withBotName = (text: string) => text.replaceAll("{{bot}}", botName);
