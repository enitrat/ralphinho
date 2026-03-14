import { access } from "node:fs/promises";

async function main(): Promise<void> {
  await access("src/mdx.d.ts");
}

await main();
