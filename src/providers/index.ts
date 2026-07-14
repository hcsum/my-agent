import type { ProviderFactoryArgs } from "./types.js";
import type { AgentProvider } from "./types.js";
import { ClaudeProvider } from "./claude/provider.js";
import { OpenCodeProvider } from "./opencode/provider.js";

export function createProvider(args: ProviderFactoryArgs): AgentProvider {
  if (args.config.provider === "claude") {
    return new ClaudeProvider(args.config);
  }
  return new OpenCodeProvider(args.config, args.publicActivity);
}
