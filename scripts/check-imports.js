// Verifies that every named import between browser modules in public/js refers to a real export.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "js");
const sources = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
const exportsOf = (src) => new Set([...src.matchAll(/export (?:async )?(?:function|const|let|class) (\w+)/g)].map((m) => m[1]));
let problems = 0;
for (const [file, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+\.js)"/g)) {
    const target = sources[m[2]];
    if (!target) {
      console.error(`${file}: imports missing module ${m[2]}`);
      problems++;
      continue;
    }
    const names = exportsOf(target);
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!names.has(name)) {
        console.error(`${file}: ${name} is not exported by ${m[2]}`);
        problems++;
      }
    }
  }
}
if (problems) process.exit(1);
console.log(`Imports OK across ${Object.keys(sources).length} modules.`);
