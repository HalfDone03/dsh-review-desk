#!/usr/bin/env node
/**
 * Syntax check every runtime module. No dependencies.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lib = join(root, "lib");
const files = readdirSync(lib)
	.filter((name) => name.endsWith(".js"))
	.sort()
	.map((name) => join(lib, name));

for (const file of files) {
	execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`OK ${files.length} modules`);
