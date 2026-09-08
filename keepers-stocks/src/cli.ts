/**
 * CLI for RH → Sui stock wrap attestor.
 *
 *   npx tsx src/cli.ts mint --ticker NVDA --amount <base 18dec> --recipient 0x… --rh-ref <hex|string> [--dry-run]
 *   npx tsx src/cli.ts watch-rh
 *   npx tsx src/cli.ts webhook
 */
import { runMint } from "./mint.ts";
import { runRhWatcher } from "./rhWatcher.ts";
import { runWebhookServer } from "./webhook.ts";

function usage(exit = 1): never {
  console.error(`usage:
  tsx src/cli.ts mint --ticker NVDA --amount <base units 18dec> --recipient 0x… --rh-ref <hex/string> [--dry-run]
  tsx src/cli.ts watch-rh
  tsx src/cli.ts webhook
`);
  process.exit(exit);
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") {
      out["dry-run"] = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const cmd = process.argv[2];
if (!cmd) usage();

if (cmd === "mint") {
  const f = parseFlags(process.argv.slice(3));
  const ticker = String(f.ticker || "");
  const amount = String(f.amount || "");
  const recipient = String(f.recipient || "");
  const rhRef = String(f["rh-ref"] || f.rhRef || f.rh_ref || "");
  if (!ticker || !amount || !recipient || !rhRef) usage();
  const out = await runMint({
    ticker,
    amount,
    recipient,
    rhRef,
    dryRun: f["dry-run"] === true,
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (cmd === "watch-rh") {
  const out = await runRhWatcher();
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (cmd === "webhook") {
  await runWebhookServer();
  await new Promise(() => {});
}

usage();
