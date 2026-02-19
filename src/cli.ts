#!/usr/bin/env node
/**
 * ClawRouter CLI
 *
 * Standalone proxy for deployed setups where the proxy needs to survive gateway restarts.
 *
 * Usage:
 *   npx @blockrun/clawrouter              # Start standalone proxy
 *   npx @blockrun/clawrouter --version    # Show version
 *   npx @blockrun/clawrouter --port 8402  # Custom port
 *
 * For production deployments, use with PM2:
 *   pm2 start "npx @blockrun/clawrouter" --name clawrouter
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { startProxy, getProxyPort } from "./proxy.js";
import { resolveOrGenerateWalletKey } from "./auth.js";
import { BalanceMonitor } from "./balance.js";
import { VERSION } from "./version.js";
import type { RoutingConfig } from "./router/index.js";

function printHelp(): void {
  console.log(`
ClawRouter v${VERSION} - Smart LLM Router

Usage:
  clawrouter [options]

Options:
  --version, -v        Show version number
  --help, -h           Show this help message
  --port <number>      Port to listen on (default: ${getProxyPort()})
  --config <path>      Path to JSON config file (default: clawrouter.json)

Config file (clawrouter.json):
  {
    "litellmBaseUrl": "http://localhost:4000",
    "litellmApiKey": "sk-...",
    "tiers": {
      "SIMPLE":    { "primary": "my-model/fast",   "fallback": ["my-model/backup"] },
      "MEDIUM":    { "primary": "my-model/medium",  "fallback": ["my-model/fast"] },
      "COMPLEX":   { "primary": "my-model/large",   "fallback": ["my-model/medium"] },
      "REASONING": { "primary": "my-model/reason",  "fallback": ["my-model/large"] }
    },
    "classifier": {
      "llmModel": "my-model/fast"
    }
  }

Examples:
  # Start with LiteLLM backend
  npx @blockrun/clawrouter --config clawrouter.json

  # Start on custom port
  npx @blockrun/clawrouter --port 9000

  # Production deployment with PM2
  pm2 start "npx @blockrun/clawrouter" --name clawrouter

Environment Variables:
  BLOCKRUN_WALLET_KEY     Private key for x402 payments (auto-generated if not set)
  BLOCKRUN_PROXY_PORT     Default proxy port (default: 8402)
  LITELLM_BASE_URL        LiteLLM base URL (overrides config file)
  LITELLM_API_KEY         LiteLLM API key (overrides config file)

For more info: https://github.com/BlockRunAI/ClawRouter
`);
}

type ClawRouterConfig = {
  litellmBaseUrl?: string;
  litellmApiKey?: string;
  routing?: Partial<RoutingConfig>;
  // Top-level tier shortcuts (merged into routing.tiers etc.)
  tiers?: Partial<RoutingConfig["tiers"]>;
  ecoTiers?: Partial<RoutingConfig["tiers"]>;
  premiumTiers?: Partial<RoutingConfig["tiers"]>;
  agenticTiers?: Partial<RoutingConfig["tiers"]>;
  classifier?: Partial<RoutingConfig["classifier"]>;
  overrides?: Partial<RoutingConfig["overrides"]>;
};

function loadConfig(configPath: string): ClawRouterConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    return {};
  }
  try {
    const raw = readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(raw) as ClawRouterConfig;
    console.log(`[ClawRouter] Loaded config from ${absPath}`);
    return parsed;
  } catch (err) {
    console.error(`[ClawRouter] Failed to parse config file ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function buildRoutingConfig(cfg: ClawRouterConfig): Partial<RoutingConfig> {
  // Allow top-level tiers/classifier/overrides as shortcuts, merged under routing
  const routing: Partial<RoutingConfig> = { ...cfg.routing };
  if (cfg.tiers) routing.tiers = { ...routing.tiers, ...cfg.tiers } as RoutingConfig["tiers"];
  // For profile-specific tiers not explicitly set, fall back to the user's base tiers
  // so agentic/eco/premium requests don't silently use built-in model names.
  const baseTiers = routing.tiers;
  if (cfg.ecoTiers) routing.ecoTiers = { ...baseTiers, ...routing.ecoTiers, ...cfg.ecoTiers } as RoutingConfig["tiers"];
  else if (baseTiers) routing.ecoTiers = baseTiers;
  if (cfg.premiumTiers) routing.premiumTiers = { ...baseTiers, ...routing.premiumTiers, ...cfg.premiumTiers } as RoutingConfig["tiers"];
  else if (baseTiers) routing.premiumTiers = baseTiers;
  if (cfg.agenticTiers) routing.agenticTiers = { ...baseTiers, ...routing.agenticTiers, ...cfg.agenticTiers } as RoutingConfig["tiers"];
  else if (baseTiers) routing.agenticTiers = baseTiers;
  if (cfg.classifier) routing.classifier = { ...routing.classifier, ...cfg.classifier } as RoutingConfig["classifier"];
  if (cfg.overrides) routing.overrides = { ...routing.overrides, ...cfg.overrides } as RoutingConfig["overrides"];
  return routing;
}

function parseArgs(args: string[]): { version: boolean; help: boolean; port?: number; config: string } {
  const result = { version: false, help: false, port: undefined as number | undefined, config: "clawrouter.json" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--config" && args[i + 1]) {
      result.config = args[i + 1];
      i++;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Load config file
  const cfg = loadConfig(args.config);
  const routingConfig = buildRoutingConfig(cfg);

  // LiteLLM: env vars override config file
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? cfg.litellmBaseUrl;
  const litellmApiKey = process.env.LITELLM_API_KEY ?? cfg.litellmApiKey;

  if (litellmBaseUrl) {
    console.log(`[ClawRouter] LiteLLM mode: ${litellmBaseUrl}`);
  }

  // Resolve wallet key (still needed for non-LiteLLM mode)
  const { key: walletKey, address, source } = await resolveOrGenerateWalletKey();

  if (!litellmBaseUrl) {
    if (source === "generated") {
      console.log(`[ClawRouter] Generated new wallet: ${address}`);
    } else if (source === "saved") {
      console.log(`[ClawRouter] Using saved wallet: ${address}`);
    } else {
      console.log(`[ClawRouter] Using wallet from BLOCKRUN_WALLET_KEY: ${address}`);
    }
  }

  // Start the proxy
  const proxy = await startProxy({
    walletKey,
    port: args.port,
    litellmBaseUrl,
    litellmApiKey,
    routingConfig: Object.keys(routingConfig).length > 0 ? routingConfig : undefined,
    onReady: (port) => {
      console.log(`[ClawRouter] Proxy listening on http://127.0.0.1:${port}`);
      console.log(`[ClawRouter] Health check: http://127.0.0.1:${port}/health`);
    },
    onError: (error) => {
      console.error(`[ClawRouter] Error: ${error.message}`);
    },
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      console.log(`[ClawRouter] [${decision.tier}] ${decision.model} $${cost} (saved ${saved}%)`);
    },
    onLowBalance: (info) => {
      console.warn(`[ClawRouter] Low balance: ${info.balanceUSD}. Fund: ${info.walletAddress}`);
    },
    onInsufficientFunds: (info) => {
      console.error(
        `[ClawRouter] Insufficient funds. Balance: ${info.balanceUSD}, Need: ${info.requiredUSD}`,
      );
    },
  });

  // Check balance (skip in LiteLLM mode)
  if (!litellmBaseUrl) {
    const monitor = new BalanceMonitor(address);
    try {
      const balance = await monitor.checkBalance();
      if (balance.isEmpty) {
        console.log(`[ClawRouter] Wallet balance: $0.00 (using FREE model)`);
        console.log(`[ClawRouter] Fund wallet for premium models: ${address}`);
      } else if (balance.isLow) {
        console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD} (low)`);
      } else {
        console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD}`);
      }
    } catch {
      console.log(`[ClawRouter] Wallet: ${address} (balance check pending)`);
    }
  }

  console.log(`[ClawRouter] Ready - Ctrl+C to stop`);

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[ClawRouter] Received ${signal}, shutting down...`);
    try {
      await proxy.close();
      console.log(`[ClawRouter] Proxy closed`);
      process.exit(0);
    } catch (err) {
      console.error(`[ClawRouter] Error during shutdown: ${err}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`[ClawRouter] Fatal error: ${err.message}`);
  process.exit(1);
});
